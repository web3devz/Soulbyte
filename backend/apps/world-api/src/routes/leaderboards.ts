/**
 * Leaderboard Routes
 */
import { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { networthService, type NetworthPeriod } from '../services/networth.service.js';

const normalizeWealthRanking = (entry: Record<string, any>) => {
    const actorId = entry.actor_id ?? entry.actorId ?? entry.actorID ?? entry.id ?? null;
    const actorName = entry.actor_name ?? entry.actorName ?? entry.name ?? null;
    const wealthTier = entry.wealth_tier ?? entry.wealthTier ?? null;
    const balanceRaw = entry.balance_sbyte ?? entry.balanceSbyte ?? entry.balance ?? entry.net_worth ?? 0;
    const balance = Number(balanceRaw);
    const normalizedBalance = Number.isFinite(balance) ? Math.max(balance, 0) : 0;

    return {
        ...entry,
        actorId,
        actorName: actorName ?? 'Unknown',
        wealthTier: wealthTier ?? 'W0',
        balance: normalizedBalance.toFixed(2),
        rank: Number(entry.rank ?? 0)
    };
};

export async function leaderboardsRoutes(app: FastifyInstance) {
    app.get('/api/v1/leaderboard/networth', async (request, reply) => {
        const {
            period = 'all_time',
            page = 1,
            limit = 20,
            include_negative = 'false',
        } = request.query as {
            period?: string;
            page?: number | string;
            limit?: number | string;
            include_negative?: string | boolean;
        };

        if (!['all_time', '7d', '30d'].includes(period)) {
            return reply.code(400).send({ error: 'Invalid period. Use all_time, 7d, or 30d.' });
        }

        const includeNegative = include_negative === true || include_negative === 'true';
        const parsedPage = Number(page);
        const parsedLimit = Number(limit);

        const data = await networthService.getLeaderboard({
            period: period as NetworthPeriod,
            page: Number.isFinite(parsedPage) ? parsedPage : 1,
            limit: Number.isFinite(parsedLimit) ? parsedLimit : 20,
            includeNegative,
        });

        return reply.send(data);
    });

    app.get('/api/v1/leaderboards/wealth', async (_request, reply) => {
        const latest = await prisma.leaderboard.findFirst({
            where: { leaderboardType: 'wealth' },
            orderBy: { tick: 'desc' }
        });

        let rankings = (latest?.rankings ?? []) as Array<Record<string, any>>;

        if (rankings.length === 0) {
            const agents = await prisma.actor.findMany({
                where: { kind: 'agent' },
                include: { wallet: true, agentState: true }
            });
            const sorted = [...agents].sort(
                (a, b) => Number(b.wallet?.balanceSbyte ?? 0) - Number(a.wallet?.balanceSbyte ?? 0)
            );
            rankings = sorted.slice(0, 50).map((agent, index) => ({
                rank: index + 1,
                actor_id: agent.id,
                name: agent.name,
                wealth_tier: agent.agentState?.wealthTier ?? 'W0',
                balance_sbyte: Number(agent.wallet?.balanceSbyte ?? 0)
            }));
        }

        return reply.send({ leaderboard: rankings.map(normalizeWealthRanking) });
    });

    app.get('/api/v1/hall-of-fame', async (_request, reply) => {
        const entries = await prisma.hallOfFame.findMany({
            orderBy: { inductedAtTick: 'desc' },
            take: 50
        });
        return reply.send({ hall_of_fame: entries });
    });
}
