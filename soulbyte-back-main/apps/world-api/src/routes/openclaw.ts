import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import crypto from 'crypto';
import { prisma } from '../db.js';
import { ethers } from 'ethers';
import { generateApiKey, getKeyPrefix, hashApiKey } from '../utils/api-key.js';
import { authenticateApiKey } from '../middleware/openclaw-auth.js';

type AuthLinkBody = {
    wallet_address?: string;
    signature?: string;
    message?: string;
    nonce?: string;
    openclaw_instance_id?: string;
};

type AuthLinkWithKeyBody = {
    wallet_private_key?: string;
    openclaw_instance_id?: string;
};

type RateLimitState = { count: number; resetAt: number };

const NONCE_EXPIRY_MS = 5 * 60 * 1000;
const NONCE_RATE_LIMIT_MAX = 10;
const NONCE_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const nonceRateLimit = new Map<string, RateLimitState>();

function checkNonceRateLimit(ip: string) {
    const now = Date.now();
    const state = nonceRateLimit.get(ip);
    if (!state || now > state.resetAt) {
        nonceRateLimit.set(ip, { count: 1, resetAt: now + NONCE_RATE_LIMIT_WINDOW_MS });
        return true;
    }
    if (state.count >= NONCE_RATE_LIMIT_MAX) return false;
    state.count += 1;
    return true;
}

export async function openclawRoutes(app: FastifyInstance) {
    app.get('/api/v1/auth/nonce', async (request: FastifyRequest, reply: FastifyReply) => {
        const ip = request.ip;
        if (!checkNonceRateLimit(ip)) {
            return reply.code(429).send({ error: 'Too many requests' });
        }

        const nonce = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + NONCE_EXPIRY_MS);

        await prisma.authNonce.create({
            data: {
                nonce,
                expiresAt,
                ipAddress: ip,
            },
        });

        return reply.send({ nonce, expiresAt: expiresAt.toISOString() });
    });

    app.post('/api/v1/auth/link', async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as AuthLinkBody;
        if (!body?.wallet_address || !body?.signature) {
            return reply.code(400).send({ error: 'wallet_address and signature are required' });
        }

        let walletAddress: string;
        try {
            walletAddress = ethers.getAddress(body.wallet_address);
        } catch {
            return reply.code(400).send({ error: 'Invalid wallet_address' });
        }

        const message = body.message || `Soulbyte Login: ${walletAddress}`;

        if (body.nonce) {
            const nonceRecord = await prisma.authNonce.findUnique({ where: { nonce: body.nonce } });
            if (!nonceRecord) {
                return reply.code(401).send({ error: 'Invalid nonce' });
            }
            if (nonceRecord.consumed) {
                return reply.code(401).send({ error: 'Nonce already used' });
            }
            if (nonceRecord.expiresAt < new Date()) {
                return reply.code(401).send({ error: 'Nonce expired' });
            }
            if (!message.includes(body.nonce)) {
                return reply.code(401).send({ error: 'Nonce not found in signed message' });
            }

            const updateResult = await prisma.authNonce.updateMany({
                where: { nonce: body.nonce, consumed: false },
                data: {
                    consumed: true,
                    consumedAt: new Date(),
                    walletAddress,
                },
            });
            if (updateResult.count === 0) {
                return reply.code(401).send({ error: 'Nonce already used' });
            }
        }

        const recovered = ethers.verifyMessage(message, body.signature);
        if (recovered.toLowerCase() !== walletAddress.toLowerCase()) {
            return reply.code(401).send({ error: 'Invalid signature' });
        }

        const userAccount = await prisma.userAccount.findFirst({
            where: { walletAddress: { equals: walletAddress, mode: 'insensitive' } },
        });

        if (userAccount && !userAccount.actorId) {
            return reply.code(200).send({
                status: 'incomplete',
                api_key: null,
                actor_id: null,
                actor_name: null,
                city_name: null,
                email: userAccount.email,
                wallet_address: walletAddress,
            });
        }

        const agentWallet = await prisma.agentWallet.findFirst({
            where: { walletAddress },
        });

        const actorId = userAccount?.actorId ?? agentWallet?.actorId ?? null;
        if (!actorId) {
            return reply.code(404).send({ error: 'No account linked to this wallet' });
        }

        const actor = await prisma.actor.findUnique({
            where: { id: actorId },
            include: { agentState: { include: { city: true } } },
        });

        if (!actor) {
            return reply.code(404).send({ error: 'Actor not found for wallet' });
        }

        const apiKey = generateApiKey('sk_agent_');
        await prisma.apiKey.create({
            data: {
                keyHash: hashApiKey(apiKey),
                keyPrefix: getKeyPrefix(apiKey),
                actorId: actor.id,
                role: 'agent',
                permissions: ['read_state', 'submit_intent', 'wallet_ops'],
                openclawInstanceId: body.openclaw_instance_id || null,
            },
        });

        const host = request.headers.host || 'localhost';
        const protocol = request.protocol || 'http';
        const rpcEndpoint = `${protocol}://${host}/rpc/agent`;

        return reply.code(200).send({
            status: 'active',
            api_key: apiKey,
            actor_id: actor.id,
            actor_name: actor.name,
            city_name: actor.agentState?.city?.name ?? null,
            email: userAccount?.email ?? null,
            wallet_address: walletAddress,
            rpc_endpoint: rpcEndpoint,
        });
    });

    app.post('/api/v1/auth/link-with-key', async (request: FastifyRequest, reply: FastifyReply) => {
        const allowUnsafe =
            process.env.ALLOW_OPENCLAW_LINK_WITH_KEY === 'true' || process.env.NODE_ENV !== 'production';
        if (!allowUnsafe) {
            return reply.code(403).send({ error: 'Link-with-key is disabled' });
        }

        const body = request.body as AuthLinkWithKeyBody;
        if (!body?.wallet_private_key) {
            return reply.code(400).send({ error: 'wallet_private_key is required' });
        }
        if (!body.wallet_private_key.match(/^(0x)?[0-9a-fA-F]{64}$/)) {
            return reply.code(400).send({ error: 'Invalid private key format' });
        }

        const wallet = new ethers.Wallet(body.wallet_private_key);
        const walletAddress = wallet.address;

        const agentWallet = await prisma.agentWallet.findFirst({
            where: { walletAddress },
        });

        if (!agentWallet) {
            return reply.code(404).send({ error: 'No agent linked to this wallet' });
        }

        const actor = await prisma.actor.findUnique({
            where: { id: agentWallet.actorId },
            include: { agentState: { include: { city: true } } },
        });

        if (!actor) {
            return reply.code(404).send({ error: 'Actor not found for wallet' });
        }

        const apiKey = generateApiKey('sk_agent_');
        await prisma.apiKey.create({
            data: {
                keyHash: hashApiKey(apiKey),
                keyPrefix: getKeyPrefix(apiKey),
                actorId: actor.id,
                role: 'agent',
                permissions: ['read_state', 'submit_intent', 'wallet_ops'],
                openclawInstanceId: body.openclaw_instance_id || null,
            },
        });

        const host = request.headers.host || 'localhost';
        const protocol = request.protocol || 'http';
        const rpcEndpoint = `${protocol}://${host}/rpc/agent`;

        return reply.code(200).send({
            actor_id: actor.id,
            actor_name: actor.name,
            city: actor.agentState?.city?.name ?? null,
            api_key: apiKey,
            rpc_endpoint: rpcEndpoint,
        });
    });

    app.get('/api/v1/actors/:actorId/events', async (request: FastifyRequest, reply: FastifyReply) => {
        const auth = await authenticateApiKey(request.headers.authorization as string | undefined);
        if (!auth) return reply.code(401).send({ error: 'Unauthorized' });

        const { actorId } = request.params as { actorId: string };
        if (auth.role === 'agent' && auth.actorId !== actorId) {
            return reply.code(403).send({ error: 'Forbidden' });
        }

        const { since_tick, limit = '20' } = request.query as { since_tick?: string; limit?: string };
        const take = Math.min(parseInt(limit, 10) || 20, 100);

        const events = await prisma.event.findMany({
            where: {
                actorId,
                tick: since_tick ? { gt: parseInt(since_tick, 10) } : undefined,
            },
            orderBy: { tick: 'desc' },
            take,
        });

        const worldState = await prisma.worldState.findFirst({ where: { id: 1 } });

        return reply.code(200).send({
            events: events.map((event) => ({
                event_id: event.eventId,
                type: event.type,
                tick: event.tick,
                created_at: event.createdAt,
                outcome: event.outcome,
                side_effects: event.sideEffects,
            })),
            latest_tick: worldState?.tick ?? 0,
            has_more: events.length === take,
        });
    });
}
