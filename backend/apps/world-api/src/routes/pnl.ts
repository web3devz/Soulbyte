import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pnlService } from '../services/pnl.service.js';
import { pnlEngine } from '../engine/pnl.engine.js';
import { prisma } from '../db.js';

export async function pnlRoutes(app: FastifyInstance) {
    app.get('/api/v1/pnl/actors/:actor_id', async (request: FastifyRequest, reply: FastifyReply) => {
        const { actor_id } = request.params as { actor_id: string };
        const { history_limit } = request.query as { history_limit?: string };
        const limit = Math.min(Math.max(parseInt(history_limit || '168', 10), 1), 500);

        try {
            const data = await pnlService.getAgentPnl(actor_id, limit);
            return reply.send(data);
        } catch (error: any) {
            const message = error?.message ?? 'Failed to fetch PNL';
            const code = message === 'Agent not found' ? 404 : 500;
            return reply.code(code).send({ error: message });
        }
    });

    app.get('/api/v1/pnl/leaderboard', async (request: FastifyRequest, reply: FastifyReply) => {
        const { period = 'day' } = request.query as { period?: string };
        if (!['day', 'week', 'all_time'].includes(period)) {
            return reply.code(400).send({ error: 'Invalid period. Use day, week, or all_time.' });
        }

        let leaderboard = await pnlService.getLeaderboard(period as 'day' | 'week' | 'all_time');
        if (leaderboard.length === 0) {
            const worldState = await prisma.worldState.findFirst({ where: { id: 1 } });
            const currentTick = worldState?.tick ?? 0;
            await pnlEngine.takeSnapshots(currentTick);
            leaderboard = await pnlService.getLeaderboard(period as 'day' | 'week' | 'all_time');
        }
        return reply.send(leaderboard.map((entry) => ({
            actorId: entry.actor_id,
            actorName: entry.actor_name,
            pnl: entry.pnl,
            netWorth: entry.net_worth,
            rank: entry.rank,
        })));
    });
}
