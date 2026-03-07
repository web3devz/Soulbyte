import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../db.js';
import { authenticateApiKey } from '../middleware/openclaw-auth.js';
import { encryptSecret, decryptSecret } from '../utils/secret-encryption.js';
import { LLMRouterService } from '../services/llm-router.service.js';

type SubscribeBody = {
    provider?: 'openai' | 'anthropic' | 'openrouter';
    api_key?: string;
    model?: string;
    api_base_url?: string | null;
};

export async function webhookRoutes(app: FastifyInstance) {
    const router = new LLMRouterService();

    app.post('/api/v1/webhook/subscribe', async (request: FastifyRequest, reply: FastifyReply) => {
        const auth = await authenticateApiKey(request.headers.authorization as string | undefined);
        if (!auth || auth.role !== 'agent') {
            return reply.code(401).send({ error: 'Unauthorized' });
        }
        const body = request.body as SubscribeBody;
        if (!body?.provider || !body.api_key || !body.model) {
            return reply.code(400).send({ error: 'provider, api_key, and model are required' });
        }
        if (!['openai', 'anthropic', 'openrouter'].includes(body.provider)) {
            return reply.code(400).send({ error: 'Invalid provider' });
        }

        const encrypted = encryptSecret(body.api_key);
        const subscription = await prisma.webhookSubscription.upsert({
            where: { actorId: auth.actorId! },
            create: {
                actorId: auth.actorId!,
                provider: body.provider,
                apiKeyEncrypted: encrypted.encrypted,
                apiKeyNonce: encrypted.nonce,
                model: body.model,
                apiBaseUrl: body.api_base_url ?? null,
                isActive: true,
            },
            update: {
                provider: body.provider,
                apiKeyEncrypted: encrypted.encrypted,
                apiKeyNonce: encrypted.nonce,
                model: body.model,
                apiBaseUrl: body.api_base_url ?? null,
                isActive: true,
                lastError: null,
            },
        });

        return reply.send({
            ok: true,
            actorId: subscription.actorId,
            provider: subscription.provider,
            model: subscription.model,
            apiBaseUrl: subscription.apiBaseUrl,
            isActive: subscription.isActive,
        });
    });

    app.get('/api/v1/webhook/status/:actorId', async (request: FastifyRequest, reply: FastifyReply) => {
        const auth = await authenticateApiKey(request.headers.authorization as string | undefined);
        if (!auth) return reply.code(401).send({ error: 'Unauthorized' });

        const { actorId } = request.params as { actorId: string };
        if (auth.role === 'agent' && auth.actorId !== actorId) {
            return reply.code(403).send({ error: 'Forbidden' });
        }

        const subscription = await prisma.webhookSubscription.findUnique({
            where: { actorId },
        });
        if (!subscription) {
            return reply.send({ active: false });
        }

        return reply.send({
            active: subscription.isActive,
            provider: subscription.provider,
            model: subscription.model,
            apiBaseUrl: subscription.apiBaseUrl,
            lastCalledAt: subscription.lastCalledAt,
            lastError: subscription.lastError,
            totalCalls: subscription.totalCalls,
            totalErrors: subscription.totalErrors,
        });
    });

    app.delete('/api/v1/webhook/unsubscribe', async (request: FastifyRequest, reply: FastifyReply) => {
        const auth = await authenticateApiKey(request.headers.authorization as string | undefined);
        if (!auth || auth.role !== 'agent') {
            return reply.code(401).send({ error: 'Unauthorized' });
        }
        await prisma.webhookSubscription.updateMany({
            where: { actorId: auth.actorId! },
            data: { isActive: false },
        });
        return reply.send({ ok: true });
    });

    app.post('/api/v1/webhook/test', async (request: FastifyRequest, reply: FastifyReply) => {
        const auth = await authenticateApiKey(request.headers.authorization as string | undefined);
        if (!auth || auth.role !== 'agent') {
            return reply.code(401).send({ error: 'Unauthorized' });
        }
        const subscription = await prisma.webhookSubscription.findUnique({
            where: { actorId: auth.actorId! },
        });
        if (!subscription) {
            return reply.code(404).send({ error: 'Webhook subscription not found' });
        }
        if (!subscription.isActive) {
            return reply.code(400).send({ error: 'Webhook subscription inactive' });
        }

        const apiKey = decryptSecret(subscription.apiKeyEncrypted, subscription.apiKeyNonce);
        const result = await router.request({
            provider: subscription.provider as any,
            apiKey,
            model: subscription.model,
            apiBaseUrl: subscription.apiBaseUrl ?? undefined,
            systemPrompt: 'Respond ONLY with valid JSON.',
            userPrompt: JSON.stringify({ message: 'Hello Soulbyte' }),
            maxTokens: 50,
            temperature: 0.2,
            responseFormat: 'json',
            timeoutMs: 10000,
        });

        if (!result.success) {
            await prisma.webhookSubscription.update({
                where: { id: subscription.id },
                data: { lastError: result.error ?? 'Test failed', totalErrors: { increment: 1 } },
            });
            return reply.code(400).send({ ok: false, error: result.error });
        }

        await prisma.webhookSubscription.update({
            where: { id: subscription.id },
            data: { lastCalledAt: new Date(), lastError: null, totalCalls: { increment: 1 } },
        });

        return reply.send({ ok: true, response: result.parsedJson ?? result.content });
    });
}
