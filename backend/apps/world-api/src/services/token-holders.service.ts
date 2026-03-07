import Decimal from 'decimal.js';
import { prisma } from '../db.js';

const BLOCKVISION_BASE_URL = 'https://api.blockvision.org/v2/blockchain';
const SBYTE_TOKEN_ADDRESS = '0x0767C203B0BbB7A69a72d6aBCfa7191227Eb7777';
const DEFAULT_LIMIT = 50;

type BlockVisionHolder = {
  holder: string;
  percentage: string;
  amount: string;
  isContract: boolean;
};

type BlockVisionResponse = {
  code: number;
  message: string;
  result?: {
    data: BlockVisionHolder[];
    nextPageCursor?: string;
  };
};

function getBlockVisionApiKey(): string {
  const key = process.env.BLOCKVISION_API_KEY;
  if (!key) {
    throw new Error('BLOCKVISION_API_KEY is not set');
  }
  return key;
}

function getRequestLimit(): number {
  const raw = Number(process.env.BLOCKVISION_HOLDERS_LIMIT ?? DEFAULT_LIMIT);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(raw), 50);
}

function getDelayMs(): number {
  const raw = Number(process.env.BLOCKVISION_DELAY_MS ?? 0);
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return Math.floor(raw);
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise(resolve => setTimeout(resolve, ms));
}

export class TokenHoldersService {
  async sync(): Promise<void> {
    const apiKey = getBlockVisionApiKey();
    const limit = getRequestLimit();
    const delayMs = getDelayMs();

    const agentWallets = await prisma.agentWallet.findMany({
      select: { walletAddress: true, actorId: true },
    });
    const businessWallets = await prisma.businessWallet.findMany({
      select: { walletAddress: true, businessId: true, business: { select: { ownerId: true } } },
    });

    const agentByWallet = new Map(
      agentWallets.map(wallet => [wallet.walletAddress.toLowerCase(), wallet.actorId])
    );
    const businessByWallet = new Map(
      businessWallets.map(wallet => [
        wallet.walletAddress.toLowerCase(),
        { businessId: wallet.businessId, ownerId: wallet.business?.ownerId ?? null },
      ])
    );

    let cursor: string | undefined;
    let totalFetched = 0;

    while (true) {
      const params = new URLSearchParams({
        contractAddress: SBYTE_TOKEN_ADDRESS,
        limit: String(limit),
      });
      if (cursor) {
        params.set('cursor', cursor);
      }

      const response = await fetch(`${BLOCKVISION_BASE_URL}/token/holders?${params.toString()}`, {
        headers: {
          accept: 'application/json',
          'x-api-key': apiKey,
        },
      });

      if (!response.ok) {
        const body = await response.text();
        await this.updateSyncState(cursor ?? null, totalFetched, `HTTP ${response.status}: ${body}`);
        throw new Error(`BlockVision error ${response.status}`);
      }

      const payload = (await response.json()) as BlockVisionResponse;
      if (payload.code !== 0 || !payload.result) {
        await this.updateSyncState(cursor ?? null, totalFetched, payload.message ?? 'Invalid response');
        throw new Error(`BlockVision response error: ${payload.message}`);
      }

      const data = payload.result.data ?? [];
      totalFetched += data.length;

      for (const holder of data) {
        const walletAddress = holder.holder.toLowerCase();
        const business = businessByWallet.get(walletAddress);
        const actorId = agentByWallet.get(walletAddress) ?? business?.ownerId ?? null;

        let category: 'business_wallet' | 'soulbyte' | 'not_soulbyte' = 'not_soulbyte';
        let businessId: string | null = null;
        if (business) {
          category = 'business_wallet';
          businessId = business.businessId;
        } else if (actorId) {
          category = 'soulbyte';
        }

        await prisma.tokenHolderRecord.upsert({
          where: { holder: walletAddress },
          create: {
            holder: walletAddress,
            accountAddress: walletAddress,
            amount: new Decimal(holder.amount).toFixed(0),
            percentageOnchain: holder.percentage ? new Decimal(holder.percentage).toFixed(6) : null,
            isContract: holder.isContract,
            category,
            actorId,
            businessId,
          },
          update: {
            accountAddress: walletAddress,
            amount: new Decimal(holder.amount).toFixed(0),
            percentageOnchain: holder.percentage ? new Decimal(holder.percentage).toFixed(6) : null,
            isContract: holder.isContract,
            category,
            actorId,
            businessId,
          },
        });
      }

      cursor = payload.result.nextPageCursor || undefined;
      if (!cursor) break;

      await sleep(delayMs);
    }

    await this.updateSyncState(null, totalFetched, null);
  }

  private async updateSyncState(cursor: string | null, total: number, error: string | null) {
    await prisma.tokenHoldersSyncState.upsert({
      where: { id: 'sbyte_holders_sync' },
      create: {
        id: 'sbyte_holders_sync',
        lastCursor: cursor,
        totalHolders: total,
        lastError: error,
      },
      update: {
        lastCursor: cursor,
        totalHolders: total,
        lastError: error,
      },
    });
  }
}

export const tokenHoldersService = new TokenHoldersService();
