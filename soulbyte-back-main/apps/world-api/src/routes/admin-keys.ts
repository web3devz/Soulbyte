import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../db.js';
import { authenticateApiKey } from '../middleware/openclaw-auth.js';
import { generateApiKey, getKeyPrefix, hashApiKey } from '../utils/api-key.js';

function requireAdmin(role?: string | null) {
    return role === 'god' || role === 'admin';
}

export async function adminKeysRoutes(app: FastifyInstance) {
    app.get('/api/v1/admin/api-keys', async (request: FastifyRequest, reply: FastifyReply) => {
        const auth = await authenticateApiKey(request.headers.authorization as string | undefined);
        if (!auth || !requireAdmin(auth.role)) {
            return reply.code(403).send({ error: 'Forbidden' });
        }

        const query = request.query as { role?: string; actor_id?: string; limit?: string };
        const take = Math.min(parseInt(query.limit || '50', 10), 200);

        const keys = await prisma.apiKey.findMany({
            where: {
                role: query.role || undefined,
                actorId: query.actor_id || undefined,
            },
            orderBy: { createdAt: 'desc' },
            take,
        });

        return reply.send({
            ok: true,
            keys: keys.map((key) => ({
                id: key.id,
                keyPrefix: key.keyPrefix,
                role: key.role,
                actorId: key.actorId,
                createdAt: key.createdAt,
                lastUsedAt: key.lastUsedAt,
                revokedAt: key.revokedAt,
            })),
        });
    });

    app.post('/api/v1/admin/api-keys/:id/revoke', async (request: FastifyRequest, reply: FastifyReply) => {
        const auth = await authenticateApiKey(request.headers.authorization as string | undefined);
        if (!auth || !requireAdmin(auth.role)) {
            return reply.code(403).send({ error: 'Forbidden' });
        }

        const { id } = request.params as { id: string };
        const key = await prisma.apiKey.update({
            where: { id },
            data: { revokedAt: new Date() },
        });

        return reply.send({ ok: true, revoked: key.id });
    });

    app.post('/api/v1/admin/api-keys/:id/rotate', async (request: FastifyRequest, reply: FastifyReply) => {
        const auth = await authenticateApiKey(request.headers.authorization as string | undefined);
        if (!auth || !requireAdmin(auth.role)) {
            return reply.code(403).send({ error: 'Forbidden' });
        }

        const { id } = request.params as { id: string };
        const current = await prisma.apiKey.findUnique({ where: { id } });
        if (!current) return reply.code(404).send({ error: 'API key not found' });

        await prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });

        const prefix = current.role === 'god' ? 'sk_god_' : current.role === 'angel' ? 'sk_angel_' : current.role === 'admin' ? 'sk_admin_' : 'sk_agent_';
        const newKey = generateApiKey(prefix);

        const created = await prisma.apiKey.create({
            data: {
                keyHash: hashApiKey(newKey),
                keyPrefix: getKeyPrefix(newKey),
                actorId: current.actorId,
                role: current.role,
                permissions: current.permissions,
                openclawInstanceId: current.openclawInstanceId,
            },
        });

        return reply.send({
            ok: true,
            key: newKey,
            id: created.id,
            role: created.role,
            actorId: created.actorId,
        });
    });
}
