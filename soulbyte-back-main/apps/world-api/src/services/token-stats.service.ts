/**
 * TokenStatsService
 * Scans on-chain events for SBYTE buys and AUSD activity.
 * Results are stored in sbyte_buyer_records for fast API reads.
 *
 * Handles two phases automatically:
 *   - bonding_curve: reads Trade events from nad.fun BondingCurve contract
 *   - dex:           reads Swap events from Uniswap V3 pool after graduation
 */
import { ethers } from 'ethers';
import Decimal from 'decimal.js';
import { prisma } from '../db.js';
import { CONTRACTS } from '../config/contracts.js';

// ─── nad.fun Contract Addresses ─────────────────────────────────────────────
const BONDING_CURVE_ADDRESS = '0xA7283d07812a02AFB7C09B60f8896bCEA3F90aCE';
const AUSD_TOKEN_ADDRESS = '0x00000000efe302beaa2b3e6e1b18d08d69a9012a';

// ─── ABIs (minimal) ─────────────────────────────────────────────────────────
const BONDING_CURVE_ABI = [
  'event CurveBuy(address indexed sender, address indexed token, uint256 amountIn, uint256 amountOut)',
  'event CurveSell(address indexed sender, address indexed token, uint256 amountIn, uint256 amountOut)',
  'event CurveGraduate(address indexed token, address indexed pool)',
];

const ERC20_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

const UNISWAP_V3_POOL_ABI = [
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
];

const LOG_RANGE_LIMIT = 100;
const DEFAULT_DELAY_MS = 2000;
const DEFAULT_RATE_LIMIT_DELAY_MS = 5000;
const DEFAULT_RPC_URL = 'https://rpc.blockchain.xyz';
const DEFAULT_MAX_BLOCKS_PER_SYNC = 200;

function getLogsChunkSize(): bigint {
  const raw = Number(process.env.SBYTE_LOGS_CHUNK_SIZE ?? LOG_RANGE_LIMIT);
  if (!Number.isFinite(raw) || raw < 1) {
    return BigInt(LOG_RANGE_LIMIT);
  }
  const size = Math.floor(raw);
  return BigInt(Math.min(size, LOG_RANGE_LIMIT));
}

function getLogsDelayMs(): number {
  const raw = Number(process.env.SBYTE_LOGS_DELAY_MS ?? DEFAULT_DELAY_MS);
  if (!Number.isFinite(raw) || raw < 0) {
    return DEFAULT_DELAY_MS;
  }
  return Math.floor(raw);
}

function getRateLimitDelayMs(): number {
  const raw = Number(process.env.SBYTE_RATE_LIMIT_DELAY_MS ?? DEFAULT_RATE_LIMIT_DELAY_MS);
  if (!Number.isFinite(raw) || raw < 0) {
    return DEFAULT_RATE_LIMIT_DELAY_MS;
  }
  return Math.floor(raw);
}

function getMaxBlocksPerSync(): bigint {
  const raw = Number(process.env.SBYTE_MAX_BLOCKS_PER_SYNC ?? DEFAULT_MAX_BLOCKS_PER_SYNC);
  if (!Number.isFinite(raw) || raw < 1) return BigInt(DEFAULT_MAX_BLOCKS_PER_SYNC);
  return BigInt(Math.floor(raw));
}

function getStartBlock(): bigint | null {
  const raw = process.env.SBYTE_START_BLOCK;
  if (!raw) return null;
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 0) return null;
  return BigInt(Math.floor(num));
}

function getTokenStatsRpcUrls(): string[] {
  const urls = [
    process.env.SBYTE_RPC_URL,
    process.env.BLOCKCHAIN_RPC_URL,
    process.env.BLOCKCHAIN_RPC_FALLBACK_1,
    process.env.BLOCKCHAIN_RPC_FALLBACK_2,
    DEFAULT_RPC_URL,
  ]
    .map((url) => (url ?? '').trim())
    .filter(Boolean);
  const deduped = Array.from(new Set(urls));
  return deduped.length > 0 ? deduped : [DEFAULT_RPC_URL];
}

function redactRpcUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}/…`;
  } catch {
    return '<invalid-url>';
  }
}

function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const anyErr = error as { error?: { code?: number; message?: string }; message?: string };
  const code = anyErr.error?.code;
  const msg = (anyErr.error?.message ?? anyErr.message ?? '').toLowerCase();
  return code === -32007 || msg.includes('rate limit') || msg.includes('request limit');
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class TokenStatsService {
  private provider!: ethers.JsonRpcProvider;
  private readonly chunkSize = getLogsChunkSize();
  private readonly delayMs = getLogsDelayMs();
  private readonly rateLimitDelayMs = getRateLimitDelayMs();
  private readonly maxBlocksPerSync = getMaxBlocksPerSync();
  private readonly rpcUrls = getTokenStatsRpcUrls();
  private rpcIndex = 0;
  private rateLimited = false;

  async init(): Promise<void> {
    await this.selectProvider(this.rpcIndex);
  }

  private async selectProvider(startIndex: number): Promise<void> {
    const total = this.rpcUrls.length;
    for (let offset = 0; offset < total; offset += 1) {
      const index = (startIndex + offset) % total;
      const url = this.rpcUrls[index];
      try {
        const provider = new ethers.JsonRpcProvider(url);
        await provider.getBlockNumber();
        this.provider = provider;
        this.rpcIndex = index;
        return;
      } catch (error) {
        console.warn(`[TokenStats] RPC ${redactRpcUrl(url)} failed:`, error);
      }
    }
    throw new Error('All TokenStats RPC endpoints failed');
  }

  private async rotateProvider(reason: string): Promise<void> {
    if (this.rpcUrls.length < 2) return;
    const nextIndex = (this.rpcIndex + 1) % this.rpcUrls.length;
    await this.selectProvider(nextIndex);
    console.warn(`[TokenStats] Switched RPC to ${redactRpcUrl(this.rpcUrls[this.rpcIndex])} (${reason})`);
  }

  /**
   * Main sync — call this on a schedule (e.g. every 5 minutes).
   * Resumes from last scanned block.
   */
  async sync(): Promise<void> {
    await this.init();
    this.rateLimited = false;

    const syncState = await prisma.tokenSyncState.upsert({
      where: { id: 'sbyte_sync' },
      create: { id: 'sbyte_sync', lastScannedBlock: 0n, isGraduated: false },
      update: {},
    });

    const currentBlock = BigInt(await this.provider.getBlockNumber());
    const startBlock = getStartBlock();
    const fromBlock =
      syncState.lastScannedBlock === 0n && startBlock && startBlock > 0n
        ? startBlock
        : syncState.lastScannedBlock + 1n;

    if (fromBlock > currentBlock) return;

    const toBlock = fromBlock + this.maxBlocksPerSync - 1n > currentBlock
      ? currentBlock
      : fromBlock + this.maxBlocksPerSync - 1n;

    const isGraduated = syncState.isGraduated;
    if (startBlock && currentBlock > startBlock && fromBlock <= currentBlock) {
      const scanned = Number(fromBlock - startBlock);
      const total = Number(currentBlock - startBlock);
      const percent = total > 0 ? ((scanned / total) * 100).toFixed(2) : '0.00';
      console.log(`[TokenStats] Progress ${scanned}/${total} blocks (${percent}%)`);
    }
    console.log(
      `[TokenStats] Syncing blocks ${fromBlock}-${toBlock} (phase: ${isGraduated ? 'dex' : 'bonding_curve'}, chunk: ${this.chunkSize}, delay: ${this.delayMs}ms, rateDelay: ${this.rateLimitDelayMs}ms, maxBatch: ${this.maxBlocksPerSync}, rpc: ${redactRpcUrl(this.rpcUrls[this.rpcIndex])})`
    );

    let lastProcessed = fromBlock - 1n;

    if (!isGraduated) {
      lastProcessed = await this.scanBondingCurve(fromBlock, toBlock);
    } else {
      const dexPoolAddress = process.env.SBYTE_DEX_POOL_ADDRESS;
      if (dexPoolAddress) {
        lastProcessed = await this.scanDexPool(fromBlock, toBlock, dexPoolAddress);
      }
    }

    if (!this.rateLimited) {
      lastProcessed = await this.scanAusdActivity(fromBlock, toBlock);
    }

    if (this.rateLimited) {
      if (lastProcessed > syncState.lastScannedBlock) {
        await prisma.tokenSyncState.update({
          where: { id: 'sbyte_sync' },
          data: { lastScannedBlock: lastProcessed },
        });
      }
      console.warn(`[TokenStats] Rate limited; saved progress at block ${lastProcessed}.`);
      return;
    }

    await prisma.tokenSyncState.update({
      where: { id: 'sbyte_sync' },
      data: { lastScannedBlock: toBlock },
    });

    console.log(`[TokenStats] Sync complete. Last block: ${toBlock}`);
  }

  /**
   * Check if the token has graduated from bonding curve to DEX.
   * Looks for the Listing event on the BondingCurve contract.
   */
  async checkGraduation(): Promise<boolean> {
    await this.init();

    if (process.env.SBYTE_SKIP_GRADUATION_CHECK === 'true') {
      return false;
    }

    const bondingCurve = new ethers.Contract(BONDING_CURVE_ADDRESS, BONDING_CURVE_ABI, this.provider);
    const filter = bondingCurve.filters.CurveGraduate(CONTRACTS.SBYTE_TOKEN);

    const syncState = await prisma.tokenSyncState.upsert({
      where: { id: 'sbyte_sync' },
      create: { id: 'sbyte_sync', lastScannedBlock: 0n, isGraduated: false },
      update: {},
    });

    const currentBlock = BigInt(await this.provider.getBlockNumber());
    const fromBlock = syncState.lastScannedBlock + 1n;

    if (fromBlock > currentBlock) {
      return false;
    }

    let graduated = false;

    for (let chunk = fromBlock; chunk <= currentBlock; chunk += this.chunkSize) {
      const chunkEnd =
        chunk + this.chunkSize - 1n > currentBlock ? currentBlock : chunk + this.chunkSize - 1n;

      let events: Array<ethers.Log | ethers.EventLog>;
      try {
        events = await bondingCurve.queryFilter(filter, chunk, chunkEnd);
      } catch (error) {
        console.warn(`[TokenStats] Listing chunk ${chunk}-${chunkEnd} failed:`, error);
        if (isRateLimitError(error)) {
          await this.rotateProvider('rate_limited');
          await sleep(this.rateLimitDelayMs);
          this.rateLimited = true;
          return;
        } else {
          await sleep(this.delayMs);
        }
        continue;
      }

      if (events.length > 0) {
        graduated = true;
        break;
      }

      await sleep(this.delayMs);
    }

    if (graduated) {
      await prisma.tokenSyncState.upsert({
        where: { id: 'sbyte_sync' },
        create: { id: 'sbyte_sync', lastScannedBlock: 0n, isGraduated: true },
        update: { isGraduated: true },
      });
      console.log('[TokenStats] SBYTE has GRADUATED from bonding curve to DEX.');
      return true;
    }

    return false;
  }

  // ─── Private: Bonding Curve Scanner ────────────────────────────────────────
  private async scanBondingCurve(fromBlock: bigint, toBlock: bigint): Promise<bigint> {
    const bondingCurve = new ethers.Contract(BONDING_CURVE_ADDRESS, BONDING_CURVE_ABI, this.provider);
    let lastProcessed = fromBlock - 1n;

    for (let chunk = fromBlock; chunk <= toBlock; chunk += this.chunkSize) {
      const chunkEnd = chunk + this.chunkSize - 1n > toBlock ? toBlock : chunk + this.chunkSize - 1n;

      let logs: Array<ethers.Log | ethers.EventLog>;
      try {
        // Only indexed args can be filtered (sender, token).
        const filter = bondingCurve.filters.CurveBuy(null, CONTRACTS.SBYTE_TOKEN);
        logs = await bondingCurve.queryFilter(filter, chunk, chunkEnd);
      } catch (error) {
        console.warn(`[TokenStats] Chunk ${chunk}-${chunkEnd} failed:`, error);
        if (isRateLimitError(error)) {
          await this.rotateProvider('rate_limited');
          await sleep(this.rateLimitDelayMs);
          this.rateLimited = true;
          return lastProcessed;
        } else {
          await sleep(this.delayMs);
        }
        continue;
      }

      for (const log of logs) {
        const args = log.args as unknown as {
          sender: string;
          token: string;
          amountIn: bigint;
          amountOut: bigint;
        };
        const sender = args.sender.toLowerCase();
        const monAmount = args.amountIn;
        const tokenAmount = args.amountOut;
        const blockNumber = BigInt(log.blockNumber);

        await this.upsertBuyer({
          walletAddress: sender,
          phase: 'bonding_curve',
          monAmount,
          tokenAmount,
          blockNumber,
          txHash: log.transactionHash,
        });
      }

      lastProcessed = chunkEnd;
      await sleep(this.delayMs);
    }

    return lastProcessed;
  }

  // ─── Private: DEX Pool Scanner (post-graduation) ───────────────────────────
  private async scanDexPool(fromBlock: bigint, toBlock: bigint, poolAddress: string): Promise<bigint> {
    const pool = new ethers.Contract(poolAddress, UNISWAP_V3_POOL_ABI, this.provider);
    let lastProcessed = fromBlock - 1n;

    for (let chunk = fromBlock; chunk <= toBlock; chunk += this.chunkSize) {
      const chunkEnd = chunk + this.chunkSize - 1n > toBlock ? toBlock : chunk + this.chunkSize - 1n;

      let logs: Array<ethers.Log | ethers.EventLog>;
      try {
        logs = await pool.queryFilter(pool.filters.Swap(), chunk, chunkEnd);
      } catch (error) {
        console.warn(`[TokenStats] DEX chunk ${chunk}-${chunkEnd} failed:`, error);
        if (isRateLimitError(error)) {
          await this.rotateProvider('rate_limited');
          await sleep(this.rateLimitDelayMs);
          this.rateLimited = true;
          return lastProcessed;
        } else {
          await sleep(this.delayMs);
        }
        continue;
      }

      for (const log of logs) {
        const args = log.args as unknown as {
          recipient: string;
          amount0: bigint;
          amount1: bigint;
        };
        const recipient = args.recipient.toLowerCase();
        const amount0 = args.amount0;
        const amount1 = args.amount1;

        const isBuy = amount1 > 0n;
        if (!isBuy) continue;

        const monSpent = amount0 < 0n ? -amount0 : amount0;
        const sbyteReceived = amount1 > 0n ? amount1 : -amount1;

        await this.upsertBuyer({
          walletAddress: recipient,
          phase: 'dex',
          monAmount: monSpent,
          tokenAmount: sbyteReceived,
          blockNumber: BigInt(log.blockNumber),
          txHash: log.transactionHash,
        });
      }

      lastProcessed = chunkEnd;
      await sleep(this.delayMs);
    }

    return lastProcessed;
  }

  // ─── Private: AUSD Activity Cross-Reference ────────────────────────────────
  private async scanAusdActivity(fromBlock: bigint, toBlock: bigint): Promise<bigint> {
    const ausd = new ethers.Contract(AUSD_TOKEN_ADDRESS, ERC20_ABI, this.provider);

    const allBuyers = await prisma.sbyteBuyerRecord.findMany({
      select: { walletAddress: true },
    });
    const buyerSet = new Set(allBuyers.map(buyer => buyer.walletAddress.toLowerCase()));

    if (buyerSet.size === 0) return toBlock;

    const ausdWalletsFound = new Set<string>();
    let lastProcessed = fromBlock - 1n;

    for (let chunk = fromBlock; chunk <= toBlock; chunk += this.chunkSize) {
      const chunkEnd = chunk + this.chunkSize - 1n > toBlock ? toBlock : chunk + this.chunkSize - 1n;

      let logs: Array<ethers.Log | ethers.EventLog>;
      try {
        logs = await ausd.queryFilter(ausd.filters.Transfer(), chunk, chunkEnd);
      } catch (error) {
        if (isRateLimitError(error)) {
          await this.rotateProvider('rate_limited');
          await sleep(this.rateLimitDelayMs);
          this.rateLimited = true;
          return lastProcessed;
        } else {
          await sleep(this.delayMs);
        }
        continue;
      }

      for (const log of logs) {
        const args = log.args as unknown as {
          from: string;
          to: string;
        };
        const from = args.from.toLowerCase();
        const to = args.to.toLowerCase();
        if (buyerSet.has(from)) ausdWalletsFound.add(from);
        if (buyerSet.has(to)) ausdWalletsFound.add(to);
      }

      lastProcessed = chunkEnd;
      await sleep(this.delayMs);
    }

    if (ausdWalletsFound.size > 0) {
      await prisma.sbyteBuyerRecord.updateMany({
        where: { walletAddress: { in: Array.from(ausdWalletsFound) } },
        data: { hadAusd: true },
      });
      console.log(`[TokenStats] Marked ${ausdWalletsFound.size} wallets as AUSD-active`);
    }

    return lastProcessed;
  }

  // ─── Private: Upsert Helper ────────────────────────────────────────────────
  private async upsertBuyer(params: {
    walletAddress: string;
    phase: 'bonding_curve' | 'dex';
    monAmount: bigint;
    tokenAmount: bigint;
    blockNumber: bigint;
    txHash: string;
  }): Promise<void> {
    const { walletAddress, phase, monAmount, tokenAmount, blockNumber, txHash } = params;

    const existing = await prisma.sbyteBuyerRecord.findUnique({
      where: { walletAddress },
    });

    if (!existing) {
      await prisma.sbyteBuyerRecord.create({
        data: {
          walletAddress,
          phase,
          totalMonSpent: monAmount.toString(),
          totalSbyteReceived: tokenAmount.toString(),
          tradeCount: 1,
          firstBuyBlock: blockNumber,
          lastBuyBlock: blockNumber,
          firstBuyTxHash: txHash,
          lastBuyTxHash: txHash,
        },
      });
    } else {
      const isNewer = blockNumber >= existing.lastBuyBlock;
      const totalMonSpent = new Decimal(existing.totalMonSpent.toString())
        .plus(monAmount.toString())
        .toFixed(0);
      const totalSbyteReceived = new Decimal(existing.totalSbyteReceived.toString())
        .plus(tokenAmount.toString())
        .toFixed(0);
      await prisma.sbyteBuyerRecord.update({
        where: { walletAddress },
        data: {
          phase,
          totalMonSpent,
          totalSbyteReceived,
          tradeCount: existing.tradeCount + 1,
          lastBuyBlock: blockNumber > existing.lastBuyBlock ? blockNumber : existing.lastBuyBlock,
          lastBuyTxHash: isNewer ? txHash : existing.lastBuyTxHash,
          firstBuyTxHash: existing.firstBuyTxHash ?? txHash,
        },
      });
    }
  }
}

export const tokenStatsService = new TokenStatsService();
