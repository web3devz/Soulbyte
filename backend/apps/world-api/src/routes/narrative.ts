/**
 * Narrative Routes
 */
import { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';

export async function narrativeRoutes(app: FastifyInstance) {
    app.get('/api/v1/narrative/events', async (request, reply) => {
        const { city_id, limit } = request.query as { city_id?: string; limit?: string };
        const events = await prisma.narrativeEvent.findMany({
            where: { cityId: city_id ?? undefined },
            orderBy: { tick: 'desc' },
            take: Math.min(Number(limit ?? 100), 200)
        });
        return reply.send({ events });
    });

    app.get('/api/v1/narrative/scandals', async (_request, reply) => {
        const scandals = await prisma.scandal.findMany({
            where: { status: 'active' },
            orderBy: { createdAt: 'desc' }
        });
        return reply.send({ scandals });
    });

    app.get('/api/v1/narrative/story-arcs', async (_request, reply) => {
        const arcs = await prisma.storyArc.findMany({
            orderBy: { createdAt: 'desc' }
        });
        return reply.send({ arcs });
    });

    app.get('/api/v1/narrative/daily-highlights', async (_request, reply) => {
        const highlights = await prisma.narrativeEvent.findMany({
            orderBy: { tick: 'desc' },
            take: 10
        });
        return reply.send({ highlights });
    });

    app.get('/api/v1/actors/:id/biography', async (request, reply) => {
        const { id } = request.params as { id: string };
        const events = await prisma.narrativeEvent.findMany({
            where: { actorIds: { has: id } },
            orderBy: { tick: 'desc' },
            take: 50
        });
        return reply.send({ biography: events });
    });
}
