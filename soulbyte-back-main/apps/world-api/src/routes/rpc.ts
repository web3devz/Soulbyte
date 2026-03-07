import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../db.js';
import { authenticateApiKey } from '../middleware/openclaw-auth.js';
import { calculateAcceptanceProbability } from '../utils/openclaw-acceptance.js';
import { debugLog } from '../utils/debug-log.js';
import { IntentStatus, IntentType } from '../types/intent.types.js';
import { godController } from '../controllers/god-rpc.controller.js';
import { angelController } from '../controllers/angel-rpc.controller.js';
import { WalletService } from '../services/wallet.service.js';

type RpcRequestBody = {
    method?: string;
    params?: Record<string, any>;
};

type RpcResponse = {
    ok: boolean;
    result?: any;
    error?: string;
};

const BRAIN_ONLY_INTENTS = [
    IntentType.INTENT_WORK,
    IntentType.INTENT_BUSINESS_WITHDRAW,
    IntentType.INTENT_CLOSE_BUSINESS,
    IntentType.INTENT_POST_AGORA,
    IntentType.INTENT_REPLY_AGORA,
    'INTENT_COMMIT_CRIME',
];

const walletService = new WalletService();

type RateLimitScope = 'key' | 'ip';

function getRateLimitMax(role: string, scope: RateLimitScope): number {
    if (scope === 'ip') return 400;
    if (role === 'god') return 1000;
    if (role === 'angel') return 500;
    if (role === 'admin') return 1000;
    return 100;
}

function formatIntentLabel(intentType: string) {
    return intentType
        .replace(/^INTENT_/, '')
        .toLowerCase()
        .split('_')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

async function checkRateLimit(
    role: string,
    keyHash?: string | null,
    ipAddress?: string,
    scope: RateLimitScope = 'key'
): Promise<boolean> {
    const now = new Date();
    const windowMs = 60_000;
    const limit = getRateLimitMax(role, scope);
    const effectiveKey = keyHash ?? 'anonymous';
    const effectiveIp = ipAddress ?? 'unknown';
    const resetAt = new Date(now.getTime() + windowMs);

    const existing = await prisma.rpcRateLimit.findUnique({
        where: { scope_role_keyHash_ipAddress: { scope, role, keyHash: effectiveKey, ipAddress: effectiveIp } },
    });

    if (!existing || existing.resetAt <= now) {
        await prisma.rpcRateLimit.upsert({
            where: { scope_role_keyHash_ipAddress: { scope, role, keyHash: effectiveKey, ipAddress: effectiveIp } },
            update: { count: 1, resetAt },
            create: { scope, role, keyHash: effectiveKey, ipAddress: effectiveIp, count: 1, resetAt },
        });
        return true;
    }

    if (existing.count >= limit) {
        return false;
    }

    await prisma.rpcRateLimit.update({
        where: { id: existing.id },
        data: { count: { increment: 1 } },
    });
    return true;
}

async function auditRpc(
    method: string,
    params: Record<string, any>,
    role: string,
    keyHash: string | null | undefined,
    ipAddress: string | undefined,
    success: boolean,
    errorMessage?: string
) {
    await prisma.rpcAuditLog.create({
        data: {
            keyHash: keyHash ?? null,
            role,
            method,
            params,
            ipAddress,
            success,
            errorMessage: errorMessage ?? null,
        },
    });
}

function buildAgentState(actor: any) {
    return {
        actor_id: actor.id,
        name: actor.name,
        city: actor.agentState?.city
            ? { id: actor.agentState.city.id, name: actor.agentState.city.name }
            : null,
        housing_tier: actor.agentState?.housingTier,
        job_type: actor.agentState?.jobType,
        wealth_tier: actor.agentState?.wealthTier,
        balance_sbyte: actor.wallet?.balanceSbyte?.toString() ?? '0',
        health: actor.agentState?.health,
        energy: actor.agentState?.energy,
        hunger: actor.agentState?.hunger,
        social: actor.agentState?.social,
        fun: actor.agentState?.fun,
        purpose: actor.agentState?.purpose,
        activity_state: actor.agentState?.activityState,
        activity_end_tick: actor.agentState?.activityEndTick,
        reputation_score: actor.agentState?.reputationScore,
        frozen: actor.frozen,
        frozen_reason: actor.frozenReason,
        dead: actor.dead,
    };
}

async function handleAgentMethod(method: string, params: Record<string, any>, authActorId?: string | null) {
    switch (method) {
        case 'getAgentState': {
            const actorId = params.actor_id;
            if (!actorId) throw new Error('actor_id is required');
            if (authActorId && actorId !== authActorId) throw new Error('Forbidden');
            const actor = await prisma.actor.findUnique({
                where: { id: actorId },
                include: {
                    agentState: { include: { city: true } },
                    wallet: true,
                },
            });
            if (!actor) throw new Error('Actor not found');
            return buildAgentState(actor);
        }
        case 'getWallet': {
            const actorId = params.actor_id;
            if (!actorId) throw new Error('actor_id is required');
            if (authActorId && actorId !== authActorId) throw new Error('Forbidden');
            const wallet = await prisma.wallet.findUnique({
                where: { actorId },
            });
            if (!wallet) throw new Error('Wallet not found');
            return {
                actor_id: actorId,
                balance_sbyte: wallet.balanceSbyte.toString(),
                locked_sbyte: wallet.lockedSbyte?.toString?.() ?? '0',
            };
        }
        case 'refreshWallet': {
            const actorId = params.actor_id;
            if (!actorId) throw new Error('actor_id is required');
            if (authActorId && actorId !== authActorId) throw new Error('Forbidden');
            await walletService.syncWalletBalances(actorId);
            const wallet = await walletService.getWalletInfo(actorId);
            if (!wallet) throw new Error('Wallet not found');
            return {
                actor_id: actorId,
                wallet_address: wallet.walletAddress,
                balance_mon: wallet.balanceMon.toString(),
                balance_sbyte: wallet.balanceSbyte.toString(),
                last_synced_at: wallet.lastSyncedAt,
                last_synced_block: wallet.lastSyncedBlock?.toString(),
            };
        }
        case 'getCityState': {
            const cityId = params.city_id;
            if (!cityId) throw new Error('city_id is required');
            const city = await prisma.city.findUnique({
                where: { id: cityId },
                include: { policies: true, vault: true },
            });
            if (!city) throw new Error('City not found');
            return {
                id: city.id,
                name: city.name,
                population: city.population,
                population_cap: city.populationCap,
                vault_balance: city.vault?.balanceSbyte?.toString?.() ?? '0',
                policies: city.policies,
            };
        }
        case 'getRecentEvents': {
            const actorId = params.actor_id;
            if (!actorId) throw new Error('actor_id is required');
            if (authActorId && actorId !== authActorId) throw new Error('Forbidden');
            const sinceTick = params.since_tick ? Number(params.since_tick) : undefined;
            const limit = Math.min(Number(params.limit ?? 20), 100);
            const events = await prisma.event.findMany({
                where: {
                    actorId,
                    tick: sinceTick ? { gt: sinceTick } : undefined,
                },
                orderBy: { tick: 'desc' },
                take: limit,
            });
            const worldState = await prisma.worldState.findFirst({ where: { id: 1 } });
            return {
                events: events.map((event) => ({
                    event_id: event.eventId,
                    type: event.type,
                    tick: event.tick,
                    created_at: event.createdAt,
                    outcome: event.outcome,
                    side_effects: event.sideEffects,
                })),
                latest_tick: worldState?.tick ?? 0,
                has_more: events.length === limit,
            };
        }
        case 'submitIntent': {
            const actorId = params.actor_id;
            const type = params.type;
            if (!actorId || !type) throw new Error('actor_id and type are required');
            if (authActorId && actorId !== authActorId) throw new Error('Forbidden');
            if (!Object.values(IntentType).includes(type)) throw new Error(`Invalid intent type: ${type}`);

            const actor = await prisma.actor.findUnique({
                where: { id: actorId },
                include: { jail: true, agentState: true },
            });
            if (!actor) throw new Error('Actor not found');
            if (actor.kind !== 'agent') throw new Error('Only agents can emit intents');
            if (actor.frozen) throw new Error('Frozen actors cannot emit intents');
            if (actor.jail) throw new Error('Jailed actors cannot emit intents');

            const source = 'owner_suggestion';
            if (BRAIN_ONLY_INTENTS.includes(type)) {
                throw new Error('This action can only be decided by the agent autonomously');
            }

            const worldState = await prisma.worldState.findFirst({ where: { id: 1 } });
            const currentTick = worldState?.tick ?? 0;

            const intent = await prisma.intent.create({
                data: {
                    actorId,
                    type,
                    targetId: params.target_id || null,
                    params: { ...(params.params || {}), source, ownerOverride: true },
                    priority: params.priority ?? 0.5,
                    tick: currentTick,
                    status: IntentStatus.PENDING,
                },
            });

            await prisma.notification.create({
                data: {
                    actorId,
                    type: 'owner_request_submitted',
                    title: 'Request submitted',
                    body: `Request submitted: ${formatIntentLabel(type)}.`,
                    data: { intentId: intent.id, intentType: type },
                    sourceIntentId: intent.id,
                },
            });

            const acceptanceProbability = calculateAcceptanceProbability(actor.agentState, type);

            return {
                intent_id: intent.id,
                status: intent.status,
                acceptance_probability: acceptanceProbability,
                message: 'Suggestion submitted. Your agent will consider it based on personality and current needs.',
            };
        }
        default:
            throw new Error(`Unknown method: ${method}`);
    }
}

const ANGEL_METHODS = new Set([
    'getAgentState',
    'getCityState',
    'getRecentAgoraPosts',
    'moderateAgoraPost',
    'deletePost',
    'flagActor',
    'generateFeedbackReport',
]);

const GOD_METHODS = new Set([
    'analyzeEconomicConditions',
    'executeEmergencyExpansion',
    'adjustPublicSalaries',
    'approveProposal',
    'createHousing',
]);

async function handleAdminMethod(method: string, params: Record<string, any>, role: string) {
    if (role === 'angel' && !ANGEL_METHODS.has(method)) {
        throw new Error('Forbidden');
    }
    if ((role === 'god' || role === 'admin') && !ANGEL_METHODS.has(method) && !GOD_METHODS.has(method)) {
        throw new Error('Forbidden');
    }
    switch (method) {
        case 'getAgentState': {
            const actorId = params.actor_id;
            if (!actorId) throw new Error('actor_id is required');
            const actor = await prisma.actor.findUnique({
                where: { id: actorId },
                include: {
                    agentState: { include: { city: true } },
                    wallet: true,
                },
            });
            if (!actor) throw new Error('Actor not found');
            return buildAgentState(actor);
        }
        case 'getCityState': {
            const cityId = params.city_id;
            if (!cityId) throw new Error('city_id is required');
            const city = await prisma.city.findUnique({
                where: { id: cityId },
                include: { policies: true, vault: true },
            });
            if (!city) throw new Error('City not found');
            return {
                id: city.id,
                name: city.name,
                population: city.population,
                population_cap: city.populationCap,
                vault_balance: city.vault?.balanceSbyte?.toString?.() ?? '0',
                policies: city.policies,
            };
        }
        case 'analyzeEconomicConditions':
            return await godController.analyzeEconomicConditions(params);
        case 'executeEmergencyExpansion':
            return await godController.executeEmergencyExpansion(params);
        case 'adjustPublicSalaries':
            return await godController.adjustPublicSalaries(params);
        case 'approveProposal':
            return await godController.approveProposal(params);
        case 'createHousing':
            return await godController.createHousing(params);
        case 'getRecentAgoraPosts':
            return await angelController.getRecentAgoraPosts(params);
        case 'moderateAgoraPost':
            return await angelController.moderateAgoraPost(params);
        case 'deletePost':
            return await angelController.deletePost(params);
        case 'flagActor':
            return await angelController.flagActor(params);
        case 'generateFeedbackReport':
            return await angelController.generateFeedbackReport(params);
        default:
            throw new Error(`Unknown method: ${method}`);
    }
}

export async function rpcRoutes(app: FastifyInstance) {
    app.post('/rpc/agent', async (request: FastifyRequest, reply: FastifyReply) => {
        const auth = await authenticateApiKey(request.headers.authorization as string | undefined);
        if (!auth || auth.role !== 'agent') {
            return reply.code(401).send({ ok: false, error: 'Unauthorized' } as RpcResponse);
        }

        const rateAllowed = await checkRateLimit(auth.role, auth.keyHash, request.ip, 'key');
        const ipAllowed = await checkRateLimit('anonymous', null, request.ip, 'ip');
        if (!rateAllowed || !ipAllowed) {
            return reply.code(429).send({ ok: false, error: 'Rate limit exceeded' } as RpcResponse);
        }

        const body = request.body as RpcRequestBody;
        const method = body?.method;
        const params = body?.params || {};
        if (!method) {
            return reply.code(400).send({ ok: false, error: 'Missing method' } as RpcResponse);
        }

        try {
            debugLog('openclaw.rpc.request', {
                method,
                actorId: params.actor_id ?? null,
                params,
                ip: request.ip,
            });
            const result = await handleAgentMethod(method, params, auth.actorId);
            await auditRpc(method, params, auth.role, auth.keyHash, request.ip, true);
            debugLog('openclaw.rpc.response', {
                method,
                actorId: params.actor_id ?? null,
                ok: true,
                result,
            });
            return reply.code(200).send({ ok: true, result } as RpcResponse);
        } catch (error) {
            await auditRpc(method, params, auth.role, auth.keyHash, request.ip, false, error instanceof Error ? error.message : 'Unknown error');
            debugLog('openclaw.rpc.response', {
                method,
                actorId: params.actor_id ?? null,
                ok: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            });
            return reply.code(400).send({
                ok: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            } as RpcResponse);
        }
    });

    app.post('/rpc/admin', async (request: FastifyRequest, reply: FastifyReply) => {
        const auth = await authenticateApiKey(request.headers.authorization as string | undefined);
        if (!auth || (auth.role !== 'god' && auth.role !== 'angel' && auth.role !== 'admin')) {
            return reply.code(401).send({ ok: false, error: 'Unauthorized' } as RpcResponse);
        }

        const rateAllowed = await checkRateLimit(auth.role, auth.keyHash, request.ip, 'key');
        const ipAllowed = await checkRateLimit('anonymous', null, request.ip, 'ip');
        if (!rateAllowed || !ipAllowed) {
            return reply.code(429).send({ ok: false, error: 'Rate limit exceeded' } as RpcResponse);
        }

        const body = request.body as RpcRequestBody;
        const method = body?.method;
        const params = body?.params || {};
        if (!method) {
            return reply.code(400).send({ ok: false, error: 'Missing method' } as RpcResponse);
        }

        try {
            const result = await handleAdminMethod(method, params, auth.role);
            await auditRpc(method, params, auth.role, auth.keyHash, request.ip, true);
            return reply.code(200).send({ ok: true, result } as RpcResponse);
        } catch (error) {
            await auditRpc(method, params, auth.role, auth.keyHash, request.ip, false, error instanceof Error ? error.message : 'Unknown error');
            return reply.code(400).send({
                ok: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            } as RpcResponse);
        }
    });
}
