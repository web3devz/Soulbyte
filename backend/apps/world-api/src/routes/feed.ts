/**
 * Feed Routes
 */
import { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';

export async function feedRoutes(app: FastifyInstance) {
    app.get('/api/v1/feed/live', async (request, reply) => {
        const { city_id, severity_min, tags } = request.query as { city_id?: string; severity_min?: string; tags?: string };
        const tagList = tags ? tags.split(',') : undefined;
        const events = await prisma.narrativeEvent.findMany({
            where: {
                cityId: city_id ?? undefined,
                severity: severity_min ? { gte: Number(severity_min) } : undefined,
                tags: tagList ? { hasSome: tagList } : undefined
            },
            orderBy: { tick: 'desc' },
            take: 100
        });
        return reply.send({ events });
    });
}
