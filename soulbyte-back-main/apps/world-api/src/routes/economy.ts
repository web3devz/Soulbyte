/**
 * Economy Routes
 */
import { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { computeEconomicSnapshots, computeGodEconomicReport, getGlobalReport } from '../services/economy-snapshot.service.js';
import { distributionService } from '../services/distribution.service.js';

export async function economyRoutes(app: FastifyInstance) {
    /**
     * GET /api/v1/economy/global
     * Returns latest GodEconomicReport (admin use)
     */
    app.get('/api/v1/economy/global', async (_request, reply) => {
        let report = getGlobalReport();
        if (!report) {
            const worldState = await prisma.worldState.findFirst({ where: { id: 1 } });
            const currentTick = worldState?.tick ?? 0;
            await computeEconomicSnapshots(currentTick);
            report = await computeGodEconomicReport(currentTick);
        }
        return reply.send({ report });
    });

    /**
     * GET /api/v1/economy/transactions/count
     * Query params: start_date, end_date, city_id
     */
    app.get('/api/v1/economy/transactions/count', async (request, reply) => {
        const { start_date, end_date, city_id } = request.query as {
            start_date?: string;
            end_date?: string;
            city_id?: string;
        };

        const parseDate = (value?: string) => {
            if (!value) return null;
            const date = new Date(value);
            return Number.isNaN(date.getTime()) ? null : date;
        };

        const start = parseDate(start_date);
        const end = parseDate(end_date);

        if (start_date && !start) {
            return reply.code(400).send({ error: 'Invalid start_date' });
        }
        if (end_date && !end) {
            return reply.code(400).send({ error: 'Invalid end_date' });
        }

        const where: Record<string, unknown> = {
            ...(city_id ? { cityId: city_id } : {})
        };

        if (start || end) {
            where.createdAt = {};
            if (start) (where.createdAt as Record<string, Date>).gte = start;
            if (end) (where.createdAt as Record<string, Date>).lte = end;
        }

        const count = await prisma.transaction.count({ where });

        return reply.send({
            count,
            period: {
                start: start?.toISOString() ?? null,
                end: end?.toISOString() ?? null
            }
        });
    });

    /**
     * GET /api/v1/economy/distribution/preview
     * Public preview of next distribution
     */
    app.get('/api/v1/economy/distribution/preview', async (request, reply) => {
        try {
            const { holder, limit, offset } = request.query as { holder?: string; limit?: string; offset?: string };
            const parsedLimit = limit ? Number(limit) : undefined;
            const parsedOffset = offset ? Number(offset) : undefined;
            if (parsedLimit !== undefined && (Number.isNaN(parsedLimit) || parsedLimit < 1)) {
                return reply.code(400).send({ error: 'Invalid limit' });
            }
            if (parsedOffset !== undefined && (Number.isNaN(parsedOffset) || parsedOffset < 0)) {
                return reply.code(400).send({ error: 'Invalid offset' });
            }
            const preview = await distributionService.generatePreview(holder, parsedLimit, parsedOffset);
            return reply.send(preview);
        } catch (error) {
            console.error('[GET /economy/distribution/preview]', error);
            return reply.code(500).send({ error: 'Failed to generate distribution preview' });
        }
    });

    /**
     * GET /api/v1/economy/distribution/history
     * Public distribution history
     */
    app.get('/api/v1/economy/distribution/history', async (request, reply) => {
        try {
            const { holder, limit } = request.query as { holder?: string; limit?: string };
            const parsedLimit = Math.min(Number(limit ?? 10), 50);
            if (Number.isNaN(parsedLimit) || parsedLimit < 1) {
                return reply.code(400).send({ error: 'Invalid limit' });
            }
            const history = await distributionService.getHistory(holder, parsedLimit);
            return reply.send(history);
        } catch (error) {
            console.error('[GET /economy/distribution/history]', error);
            return reply.code(500).send({ error: 'Failed to fetch distribution history' });
        }
    });
}
