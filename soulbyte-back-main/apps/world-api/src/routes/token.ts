/**
 * Token public endpoints
 *
 * GET /api/v1/token/ausd-buyers
 *   Returns wallets that bought SBYTE, with AUSD activity flag.
 *   No auth required (public endpoint).
 */
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../db.js';
import Decimal from 'decimal.js';
import { ethers } from 'ethers';

type AusdBuyersQuery = {
  ausd_only?: string;
  phase?: string;
  limit?: string;
  offset?: string;
  sort?: string;
  order?: string;
};

type TokenHoldersQuery = {
  limit?: string;
  cursor?: string;
};

type NftHoldersQuery = {
  limit?: string;
  cursor?: string;
};

export async function tokenRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/token/ausd-buyers', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = request.query as AusdBuyersQuery;
      const ausdOnly = query.ausd_only === 'true';
      const phaseParam = query.phase ?? 'all';
      const limit = Math.min(Number(query.limit ?? 100), 100);
      const offset = Number(query.offset ?? 0);
      const sort = query.sort ?? 'mon_spent';
      const order = query.order === 'asc' ? 'asc' : 'desc';

      if (Number.isNaN(limit) || Number.isNaN(offset) || limit < 1 || offset < 0) {
        return reply.code(400).send({ error: 'Invalid pagination parameters' });
      }

      const validSorts = ['trades', 'mon_spent', 'sbyte_received', 'first_seen'];
      if (!validSorts.includes(sort)) {
        return reply.code(400).send({ error: `Invalid sort. Options: ${validSorts.join(', ')}` });
      }

      const validPhases = ['bonding_curve', 'dex', 'all'];
      if (!validPhases.includes(phaseParam)) {
        return reply.code(400).send({ error: `Invalid phase. Options: ${validPhases.join(', ')}` });
      }

      const sortFieldMap: Record<string, string> = {
        trades: 'tradeCount',
        mon_spent: 'totalMonSpent',
        sbyte_received: 'totalSbyteReceived',
        first_seen: 'firstSeenAt',
      };
      const orderByField = sortFieldMap[sort];

      const where: Record<string, unknown> = {};
      if (ausdOnly) where.hadAusd = true;
      if (phaseParam !== 'all') where.phase = phaseParam;

      const [records, total] = await Promise.all([
        prisma.sbyteBuyerRecord.findMany({
          where,
          orderBy: { [orderByField]: order },
          take: limit,
          skip: offset,
          select: {
            walletAddress: true,
            phase: true,
            hadAusd: true,
            totalMonSpent: true,
            totalSbyteReceived: true,
            tradeCount: true,
            firstBuyBlock: true,
            lastBuyBlock: true,
            firstBuyTxHash: true,
            lastBuyTxHash: true,
            firstSeenAt: true,
            updatedAt: true,
          },
        }),
        prisma.sbyteBuyerRecord.count({ where }),
      ]);

      const syncState = await prisma.tokenSyncState.findUnique({
        where: { id: 'sbyte_sync' },
        select: { isGraduated: true, lastScannedBlock: true, syncedAt: true },
      });

      const serialized = records.map(record => ({
        wallet_address: record.walletAddress,
        phase: record.phase,
        had_ausd: record.hadAusd,
        total_mon_spent: new Decimal(record.totalMonSpent.toString()).toFixed(0),
        total_sbyte_received: new Decimal(record.totalSbyteReceived.toString()).toFixed(0),
        total_mon_spent_mon: new Decimal(record.totalMonSpent.toString()).div(1e18).toFixed(),
        total_sbyte_received_formatted: new Decimal(record.totalSbyteReceived.toString()).div(1e18).toFixed(),
        trade_count: record.tradeCount,
        first_buy_block: record.firstBuyBlock.toString(),
        last_buy_block: record.lastBuyBlock.toString(),
        first_buy_tx_hash: record.firstBuyTxHash ?? null,
        last_buy_tx_hash: record.lastBuyTxHash ?? null,
        first_seen_at: record.firstSeenAt,
        updated_at: record.updatedAt,
      }));

      return reply.send({
        data: serialized,
        meta: {
          total,
          limit,
          offset,
          has_more: offset + limit < total,
          token: {
            address: '0x0767C203B0BbB7A69a72d6aBCfa7191227Eb7777',
            is_graduated: syncState?.isGraduated ?? false,
            current_phase: syncState?.isGraduated ? 'dex' : 'bonding_curve',
            last_scanned_block: syncState?.lastScannedBlock?.toString() ?? '0',
            last_synced_at: syncState?.syncedAt ?? null,
          },
        },
      });
    } catch (error) {
      console.error('[GET /api/v1/token/ausd-buyers]', error);
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  app.get('/api/v1/token/holders', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = request.query as TokenHoldersQuery;
      const limit = Math.min(Number(query.limit ?? 100), 200);
      const cursorValue = query.cursor ? Number(query.cursor) : 0;
      const cursor = Number.isFinite(cursorValue) && cursorValue >= 0 ? cursorValue : 0;

      if (Number.isNaN(limit) || limit < 1) {
        return reply.code(400).send({ error: 'Invalid limit' });
      }
      const [rows, total] = await Promise.all([
        prisma.holderBalance.findMany({
          where: { sbyteBalance: { gt: 0 } },
          orderBy: { sbyteBalance: 'desc' },
          take: limit,
          skip: cursor,
          select: {
            walletAddress: true,
            sbyteBalance: true,
            lastUpdatedAt: true,
            lastBlockNumber: true
          }
        }),
        prisma.holderBalance.count({
          where: { sbyteBalance: { gt: 0 } }
        })
      ]);

      const serialized = rows.map(row => ({
        address: row.walletAddress,
        balance: row.sbyteBalance.toString(),
        balanceFormatted: ethers.formatUnits(row.sbyteBalance.toString(), 18),
        lastUpdatedAt: row.lastUpdatedAt,
        lastBlockNumber: row.lastBlockNumber.toString()
      }));

      return reply.send({
        holders: serialized,
        meta: {
          total,
          limit,
          cursor,
          has_more: cursor + limit < total
        },
      });
    } catch (error) {
      console.error('[GET /token/holders]', error);
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  app.get('/api/v1/nft/holders', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = request.query as NftHoldersQuery;
      const limit = Math.min(Number(query.limit ?? 100), 200);
      const cursorValue = query.cursor ? Number(query.cursor) : 0;
      const cursor = Number.isFinite(cursorValue) && cursorValue >= 0 ? cursorValue : 0;

      if (Number.isNaN(limit) || limit < 1) {
        return reply.code(400).send({ error: 'Invalid limit' });
      }

      const [rows, total] = await Promise.all([
        prisma.holderNftBalance.findMany({
          where: { passCount: { gt: 0 } },
          orderBy: { passCount: 'desc' },
          take: limit,
          skip: cursor,
          select: {
            walletAddress: true,
            passCount: true,
            lastUpdatedAt: true,
            lastBlockNumber: true
          }
        }),
        prisma.holderNftBalance.count({
          where: { passCount: { gt: 0 } }
        })
      ]);

      const serialized = rows.map(row => ({
        address: row.walletAddress,
        passCount: row.passCount,
        lastUpdatedAt: row.lastUpdatedAt,
        lastBlockNumber: row.lastBlockNumber.toString()
      }));

      return reply.send({
        holders: serialized,
        meta: {
          total,
          limit,
          cursor,
          has_more: cursor + limit < total
        }
      });
    } catch (error) {
      console.error('[GET /nft/holders]', error);
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });
}
