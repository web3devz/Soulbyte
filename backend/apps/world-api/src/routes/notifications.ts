import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../db.js';

type NotificationQuery = {
    limit?: string;
    before?: string;
    unreadOnly?: string;
};

export async function notificationsRoutes(app: FastifyInstance) {
    app.get('/api/v1/notifications', async (request: FastifyRequest, reply: FastifyReply) => {
        const auth = (request as typeof request & { apiAuth?: { role: string; actorId?: string | null } }).apiAuth;
        if (!auth || auth.role !== 'agent' || !auth.actorId) {
            return reply.code(401).send({ error: 'Unauthorized' });
        }

        const { limit, before, unreadOnly } = request.query as NotificationQuery;
        const take = Math.min(Number(limit ?? 20), 50);
        const where: Record<string, any> = { actorId: auth.actorId };
        if (unreadOnly === 'true') {
            where.readAt = null;
        }
        if (before) {
            const beforeDate = new Date(before);
            if (!Number.isNaN(beforeDate.getTime())) {
                where.createdAt = { lt: beforeDate };
            }
        }

        const items = await prisma.notification.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: take + 1,
        });
        const hasMore = items.length > take;
        const sliced = hasMore ? items.slice(0, take) : items;
        const unreadCount = await prisma.notification.count({
            where: { actorId: auth.actorId, readAt: null },
        });

        return reply.send({
            notifications: sliced,
            hasMore,
            unreadCount,
            nextCursor: sliced[sliced.length - 1]?.createdAt ?? null,
        });
    });

    app.post('/api/v1/notifications/mark-read', async (request: FastifyRequest, reply: FastifyReply) => {
        const auth = (request as typeof request & { apiAuth?: { role: string; actorId?: string | null } }).apiAuth;
        if (!auth || auth.role !== 'agent' || !auth.actorId) {
            return reply.code(401).send({ error: 'Unauthorized' });
        }

        const body = request.body as { ids?: string[]; readAll?: boolean };
        if (body?.readAll) {
            const result = await prisma.notification.updateMany({
                where: { actorId: auth.actorId, readAt: null },
                data: { readAt: new Date() },
            });
            return reply.send({ updated: result.count });
        }

        const ids = Array.isArray(body?.ids) ? body.ids : [];
        if (ids.length === 0) {
            return reply.code(400).send({ error: 'No notification ids provided' });
        }

        const result = await prisma.notification.updateMany({
            where: { actorId: auth.actorId, id: { in: ids } },
            data: { readAt: new Date() },
        });
        return reply.send({ updated: result.count });
    });
}
