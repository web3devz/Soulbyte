import { prisma } from '../db.js';
import { AgentTransferService } from './agent-transfer.service.js';
import { BusinessWalletService } from './business-wallet.service.js';
import { WalletService } from './wallet.service.js';
import { CONTRACTS, ERC20_ABI } from '../config/contracts.js';
import { debugLog } from '../utils/debug-log.js';
import { ethers } from 'ethers';

type OnchainJobRow = {
  id: string;
  jobType: string;
  status: string;
  payload: unknown;
  actorId: string | null;
  relatedIntentId: string | null;
  relatedTxId: string | null;
  txHash?: string | null;
  retryCount: number | null;
};

const agentTransferService = new AgentTransferService();
const businessWalletService = new BusinessWalletService();
const walletService = new WalletService();

let running = false;
let pollTimer: NodeJS.Timeout | null = null;

const DEFAULT_POLL_MS = 1000;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BACKOFF_MS = 5000;
const DEFAULT_RPC_URL = 'https://rpc.monad.xyz';

export async function startOnchainWorker(): Promise<void> {
  if (running) {
    console.log('Onchain worker already running');
    return;
  }
  running = true;
  const pollMs = Number(process.env.ONCHAIN_QUEUE_POLL_MS || DEFAULT_POLL_MS);
  console.log(`✓ Onchain worker started (interval: ${pollMs}ms)`);
  pollTimer = setInterval(() => {
    pollOnce().catch((error) => {
      console.error('Onchain worker poll error:', error);
    });
  }, pollMs);
}

export function stopOnchainWorker(): void {
  running = false;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  console.log('Onchain worker stopped');
}

async function pollOnce(): Promise<void> {
  if (!running) return;
  const job = await claimJob();
  if (!job) return;
  await executeJob(job);
}

async function claimJob(): Promise<OnchainJobRow | null> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<OnchainJobRow[]>`
      SELECT
        j.id,
        j.job_type as "jobType",
        j.status,
        j.payload,
        j.actor_id as "actorId",
        j.related_intent_id as "relatedIntentId",
        j.related_tx_id as "relatedTxId",
        j.tx_hash as "txHash",
        j.retry_count as "retryCount"
      FROM "onchain_jobs" j
      WHERE j."status" = 'queued'
        AND j."next_attempt_at" <= NOW()
      ORDER BY
        CASE
          WHEN EXISTS (
            SELECT 1
            FROM "agent_wallets" aw
            WHERE aw.actor_id = j.actor_id
              AND aw.preferred_rpc IS NOT NULL
              AND BTRIM(aw.preferred_rpc) <> ''
              AND aw.preferred_rpc <> ${DEFAULT_RPC_URL}
          ) THEN 1
          ELSE 0
        END DESC,
        j."created_at" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `;
    if (!rows || rows.length === 0) return null;
    const job = rows[0];
    await tx.onchainJob.update({
      where: { id: job.id },
      data: { status: 'processing' },
    });
    debugLog('onchain_queue.claim', { jobId: job.id, jobType: job.jobType });
    return job;
  });
}

async function executeJob(job: OnchainJobRow): Promise<void> {
  try {
    const payload = job.payload as Record<string, any>;
    const skipOnchain = process.env.SKIP_ONCHAIN_EXECUTION === 'true';
    let txHash: string | null = null;

    switch (job.jobType) {
      case 'AGENT_TRANSFER_SBYTE': {
        const result = await agentTransferService.transfer(
          payload.fromActorId,
          payload.toActorId ?? null,
          BigInt(payload.amountWei),
          payload.reason,
          payload.cityId ?? undefined,
          payload.toAddressOverride ?? undefined,
          typeof payload.cityFeeMultiplier === 'number' ? payload.cityFeeMultiplier : 1
        );
        txHash = result.txHash;
        break;
      }
      case 'AGENT_TRANSFER_MON': {
        const result = await agentTransferService.transferMon(
          payload.fromActorId,
          payload.toAddress,
          BigInt(payload.amountWei),
          payload.reason,
          payload.cityId ?? undefined
        );
        txHash = result.txHash;
        break;
      }
      case 'BUSINESS_TRANSFER_SBYTE': {
        if (skipOnchain) {
          txHash = `0x${Math.random().toString(16).slice(2).padStart(64, '0')}`;
        } else {
          const result = await businessWalletService.transferFromBusiness(
            payload.businessId,
            payload.toAddress,
            BigInt(payload.amountWei)
          );
          txHash = result.txHash;
        }
        break;
      }
      case 'BUSINESS_TRANSFER_MON': {
        if (skipOnchain) {
          txHash = `0x${Math.random().toString(16).slice(2).padStart(64, '0')}`;
        } else {
          const result = await businessWalletService.transferMonFromBusiness(
            payload.businessId,
            payload.toAddress,
            BigInt(payload.amountWei)
          );
          txHash = result.txHash;
        }
        break;
      }
      case 'RAW_SBYTE_TRANSFER': {
        const signer = await walletService.getSignerWallet(payload.fromActorId);
        if (skipOnchain) {
          txHash = `0x${Math.random().toString(16).slice(2).padStart(64, '0')}`;
          await prisma.onchainTransaction.create({
            data: {
              txHash,
              blockNumber: BigInt(0),
              fromAddress: signer.address,
              toAddress: payload.toAddress,
              tokenAddress: CONTRACTS.SBYTE_TOKEN,
              amount: ethers.formatEther(BigInt(payload.amountWei)),
              fromActorId: payload.fromActorId ?? null,
              toActorId: payload.toActorId ?? null,
              txType: payload.txType ?? 'AGENT_TO_AGENT',
              platformFee: String(payload.platformFee ?? '0'),
              cityFee: String(payload.cityFee ?? '0'),
              cityId: payload.cityId ?? null,
              status: 'confirmed',
              confirmedAt: new Date(),
            },
          });
        } else {
          const sbyteContract = new ethers.Contract(CONTRACTS.SBYTE_TOKEN, ERC20_ABI, signer);
          const tx = await sbyteContract.transfer(payload.toAddress, BigInt(payload.amountWei));
          const receipt = await tx.wait();
          txHash = tx.hash;
          await prisma.onchainTransaction.create({
            data: {
              txHash,
              blockNumber: BigInt(receipt?.blockNumber || 0),
              fromAddress: signer.address,
              toAddress: payload.toAddress,
              tokenAddress: CONTRACTS.SBYTE_TOKEN,
              amount: ethers.formatEther(BigInt(payload.amountWei)),
              fromActorId: payload.fromActorId ?? null,
              toActorId: payload.toActorId ?? null,
              txType: payload.txType ?? 'AGENT_TO_AGENT',
              platformFee: String(payload.platformFee ?? '0'),
              cityFee: String(payload.cityFee ?? '0'),
              cityId: payload.cityId ?? null,
              status: 'confirmed',
              confirmedAt: new Date(),
            },
          });
        }
        break;
      }
      default:
        throw new Error(`Unknown jobType ${job.jobType}`);
    }

    await prisma.$transaction(async (tx) => {
      await tx.onchainJob.update({
        where: { id: job.id },
        data: { status: 'confirmed', txHash },
      });
      if (job.relatedTxId && txHash) {
        await tx.transaction.update({
          where: { id: job.relatedTxId },
          data: { onchainTxHash: txHash },
        });
      }
      if (job.relatedIntentId) {
        await tx.intent.update({
          where: { id: job.relatedIntentId },
          data: { status: 'executed' },
        });
      }
    });
    debugLog('onchain_queue.confirm', { jobId: job.id, txHash });
  } catch (error: any) {
    const errorMessage = String(error?.message ?? error);
    const normalizedMessage = errorMessage.toLowerCase();
    const isPermanentFailure = (
      normalizedMessage.includes('insufficient balance')
      || normalizedMessage.includes('insufficient funds')
      || normalizedMessage.includes('on-chain balance insufficient')
      || normalizedMessage.includes('signer had insufficient balance')
    );
    const maxRetriesRaw = Number(process.env.ONCHAIN_QUEUE_MAX_RETRIES || DEFAULT_MAX_RETRIES);
    const backoffMsRaw = Number(process.env.ONCHAIN_QUEUE_BACKOFF_MS || DEFAULT_BACKOFF_MS);
    const maxRetries = Number.isFinite(maxRetriesRaw) ? maxRetriesRaw : DEFAULT_MAX_RETRIES;
    const backoffMs = Number.isFinite(backoffMsRaw) ? backoffMsRaw : DEFAULT_BACKOFF_MS;
    const currentRetry = Number.isFinite(Number(job.retryCount)) ? Number(job.retryCount) : 0;
    const nextRetry = isPermanentFailure ? maxRetries : currentRetry + 1;
    const isDead = nextRetry >= maxRetries;
    const status = isDead ? 'deadletter' : 'queued';
    const nextAttemptAt = isDead ? new Date() : new Date(Date.now() + backoffMs * nextRetry);

    await prisma.$transaction(async (tx) => {
      await tx.onchainJob.update({
        where: { id: job.id },
        data: {
          status,
          retryCount: nextRetry,
          nextAttemptAt,
          lastError: errorMessage,
        },
      });
      if (isDead && job.relatedIntentId) {
        const existing = await tx.intent.findUnique({
          where: { id: job.relatedIntentId },
          select: { params: true },
        });
        const params = (existing?.params as Record<string, unknown> | null) ?? {};
        await tx.intent.update({
          where: { id: job.relatedIntentId },
          data: {
            status: 'blocked',
            params: { ...params, blockReason: `onchain_job_deadlettered:${errorMessage}` },
          },
        });
      }
      if (isDead) {
        await tx.onchainFailure.create({
          data: {
            actorId: job.actorId ?? null,
            jobId: job.id,
            relatedIntentId: job.relatedIntentId ?? null,
            txHash: job.txHash ?? null,
            jobType: job.jobType,
            errorMessage,
          },
        });
      }
    });
    debugLog('onchain_queue.fail', {
      jobId: job.id,
      status,
      retryCount: nextRetry,
      error: errorMessage,
      permanent: isPermanentFailure,
    });
  }
}
