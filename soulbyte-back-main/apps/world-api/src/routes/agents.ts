import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../db.js';
import { ethers } from 'ethers';
import { CONTRACTS } from '../config/contracts.js';
import { generateApiKey, getKeyPrefix, hashApiKey } from '../utils/api-key.js';
import { WalletService } from '../services/wallet.service.js';
import { generateTraitsFromWallet } from '../services/personality-generator.js';
import { initializePersona } from '../engine/persona/persona.service.js';
import { selectBirthCity } from '../services/city-selection.service.js';
import { getResilientProvider } from '../config/network.js';
import { isRateLimitError, isRetryableRpcError, withRpcRetry } from '../utils/rpc-retry.js';
import { EventType, EventOutcome } from '../types/event.types.js';
import { FEE_CONFIG } from '../config/fees.js';
import { authenticateApiKey } from '../middleware/openclaw-auth.js';
import { encryptSecret } from '../utils/secret-encryption.js';

type BirthRequestBody = {
    name?: string;
    wallet_private_key?: string;
    personality_prefs?: Record<string, number>;
    preferred_rpc?: string;
    referral_code?: string;
    llm_provider?: 'zai';
    llm_api_key?: string;
    llm_model?: string;
    llm_api_base_url?: string | null;
};

type RateLimitState = {
    count: number;
    resetAt: number;
};

const birthRateLimits = new Map<string, RateLimitState>();
const MAX_BIRTH_PER_HOUR = 5;
const RATE_WINDOW_MS = 60 * 60 * 1000;

function checkBirthRateLimit(ip: string): boolean {
    const now = Date.now();
    const state = birthRateLimits.get(ip);
    if (!state || now > state.resetAt) {
        birthRateLimits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
        return true;
    }
    if (state.count >= MAX_BIRTH_PER_HOUR) return false;
    state.count += 1;
    return true;
}

export async function agentsRoutes(app: FastifyInstance) {
    app.get('/api/v1/agents/check-name', async (request: FastifyRequest, reply: FastifyReply) => {
        const { name } = request.query as { name?: string };
        if (!name || name.length < 2) {
            return reply.code(400).send({ error: 'Name too short' });
        }
        const exists = await prisma.actor.findFirst({
            where: { name: { equals: name, mode: 'insensitive' } },
        });
        return reply.send({ available: !exists, name });
    });

    app.post('/api/v1/agents/birth', async (request: FastifyRequest, reply: FastifyReply) => {
        if (!checkBirthRateLimit(request.ip)) {
            return reply.code(429).send({ error: 'Rate limit exceeded' });
        }

        const body = request.body as BirthRequestBody;
        const name = body?.name?.trim();
        const privateKey = body?.wallet_private_key;
        const llmProvided = Boolean(body?.llm_provider || body?.llm_api_key || body?.llm_model);
        if (llmProvided) {
            if (!body.llm_provider || !body.llm_api_key || !body.llm_model) {
                return reply.code(400).send({ error: 'llm_provider, llm_api_key, and llm_model are required' });
            }
            if (!['zai'].includes(body.llm_provider)) {
                return reply.code(400).send({ error: 'Invalid llm_provider. Only "zai" is supported.' });
            }
        }

        if (!name || name.length < 2 || name.length > 24) {
            return reply.code(400).send({ error: 'Name must be 2-24 characters' });
        }
        if (!privateKey?.match(/^(0x)?[0-9a-fA-F]{64}$/)) {
            return reply.code(400).send({ error: 'Invalid private key format' });
        }

        const wallet = new ethers.Wallet(privateKey);
        const walletAddress = wallet.address;

        const existingWallet = await prisma.agentWallet.findUnique({
            where: { walletAddress },
        });
        if (existingWallet) {
            return reply.code(409).send({ error: 'Wallet already linked to an agent' });
        }

        const existingName = await prisma.actor.findFirst({
            where: { name: { equals: name, mode: 'insensitive' } },
        });
        if (existingName) {
            return reply.code(409).send({ error: 'Name already taken' });
        }

        let monBalance: bigint;
        let sbyteBalance: bigint;
        const preferredRpc = body.preferred_rpc?.trim();
        if (preferredRpc && !/^https?:\/\//i.test(preferredRpc)) {
            return reply.code(400).send({ error: 'preferred_rpc must be a valid http(s) URL' });
        }

        let provider;
        try {
            provider = await getResilientProvider(preferredRpc);
        } catch (error: any) {
            if (isRetryableRpcError(error)) {
                const statusCode = isRateLimitError(error) ? 429 : 503;
                return reply.code(statusCode).send({
                    error: 'RPC temporarily unavailable',
                    message: 'RPC provider initialization failed. Try again later or use a premium RPC endpoint.',
                });
            }
            throw error;
        }
        const sbyteContract = new ethers.Contract(
            CONTRACTS.SBYTE_TOKEN,
            ['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'],
            provider
        );
        try {
            monBalance = await withRpcRetry(
                () => provider.getBalance(walletAddress),
                'birthMonBalance'
            );
            sbyteBalance = await withRpcRetry(
                () => sbyteContract.balanceOf(walletAddress),
                'birthSbyteBalance'
            );
        } catch (error: any) {
            if (isRetryableRpcError(error)) {
                const statusCode = isRateLimitError(error) ? 429 : 503;
                return reply.code(statusCode).send({
                    error: 'RPC temporarily unavailable',
                    message: 'RPC request failed after retries. Try again later or use a premium RPC endpoint.',
                    note:
                        'If this persists, configure a dedicated RPC URL (Alchemy/QuickNode) to avoid shared limits.',
                });
            }
            throw error;
        }

        const MIN_MON = ethers.parseEther('10');
        const MIN_SBYTE = ethers.parseEther('500');
        const note =
            'Send funds on Monad network. If transactions fail, your RPC may be overloaded. Consider a premium RPC provider like Alchemy or QuickNode for Monad.';

        if (monBalance < MIN_MON) {
            return reply.code(402).send({
                error: 'Insufficient MON',
                required: '10 MON',
                current: ethers.formatEther(monBalance),
                wallet_address: walletAddress,
                note,
            });
        }
        if (sbyteBalance < MIN_SBYTE) {
            return reply.code(402).send({
                error: 'Insufficient SBYTE',
                required: '500 SBYTE',
                current: ethers.formatEther(sbyteBalance),
                wallet_address: walletAddress,
                note,
            });
        }

        const agentSigner = new ethers.Wallet(privateKey, provider);
        const sbyteWithSigner = sbyteContract.connect(agentSigner);
        const platformFee = (sbyteBalance * BigInt(FEE_CONFIG.PLATFORM_FEE_BPS)) / 10000n;
        if (platformFee > 0n && process.env.SKIP_ONCHAIN_EXECUTION !== 'true') {
            try {
                const feeTx = await withRpcRetry(
                    () => sbyteWithSigner.transfer(CONTRACTS.PLATFORM_FEE_VAULT, platformFee),
                    'birthPlatformFeeTransfer'
                );
                await withRpcRetry(() => feeTx.wait(), 'birthPlatformFeeWait');
            } catch (error: any) {
                if (isRetryableRpcError(error)) {
                    const statusCode = isRateLimitError(error) ? 429 : 503;
                    return reply.code(statusCode).send({
                        error: 'RPC temporarily unavailable',
                        message: 'Platform fee transfer failed after retries. Try again later.',
                        note:
                            'If this persists, configure a dedicated RPC URL (Alchemy/QuickNode) to avoid shared limits.',
                    });
                }
                throw error;
            }
        }

        let remainingSbyte: bigint;
        try {
            remainingSbyte = process.env.SKIP_ONCHAIN_EXECUTION === 'true'
                ? sbyteBalance - platformFee
                : await withRpcRetry(
                    () => sbyteContract.balanceOf(walletAddress),
                    'birthRemainingSbyteBalance'
                );
        } catch (error: any) {
            if (isRetryableRpcError(error)) {
                const statusCode = isRateLimitError(error) ? 429 : 503;
                return reply.code(statusCode).send({
                    error: 'RPC temporarily unavailable',
                    message: 'Balance refresh failed after retries. Try again later.',
                });
            }
            throw error;
        }
        const initialBalance = ethers.formatEther(remainingSbyte);
        const initialBalanceNumber = Number(initialBalance);

        const traits = generateTraitsFromWallet(walletAddress, name, body.personality_prefs as any);
        let citySelection;
        try {
            citySelection = await selectBirthCity({
                ambition: traits.ambition,
                riskTolerance: traits.riskTolerance,
                sociability: traits.sociability,
            });
        } catch (error: any) {
            return reply.code(503).send({
                error: 'City selection unavailable',
                message: error?.message || 'Unable to select a birth city',
            });
        }
        const city = await prisma.city.findUnique({ where: { id: citySelection.cityId } });
        if (!city) {
            return reply.code(500).send({ error: 'City selection failed' });
        }

        const apiKey = generateApiKey('sb_k_');
        const keyHash = hashApiKey(apiKey);
        const keyPrefix = getKeyPrefix(apiKey);

        const walletService = new WalletService();

        const result = await prisma.$transaction(async (tx) => {
            const actor = await tx.actor.create({
                data: {
                    name,
                    kind: 'agent',
                    dead: false,
                    frozen: false,
                    reputation: 100,
                },
            });

            await tx.agentState.create({
                data: {
                    actorId: actor.id,
                    cityId: citySelection.cityId,
                    health: 100,
                    hunger: 100,
                    energy: 100,
                    social: 50,
                    fun: 50,
                    purpose: 50,
                    housingTier: 'street',
                    jobType: 'unemployed',
                    wealthTier: 'W2',
                    activityState: 'IDLE',
                    personality: traits,
                    emotions: {},
                    markers: {},
                },
            });

            await tx.city.update({
                where: { id: citySelection.cityId },
                data: { population: { increment: 1 } },
            });

            const persona = initializePersona(actor.id, traits, 'W2');
            await tx.personaState.create({
                data: {
                    ...persona,
                    lastWealthBalance: initialBalanceNumber,
                    previousWealthBalance: initialBalanceNumber,
                },
            });

            await tx.personaModifiersCache.create({
                data: {
                    actorId: actor.id,
                    modifiers: {
                        survivalBias: 0,
                        economyBias: 0,
                        socialBias: 0,
                        crimeBias: 0,
                        leisureBias: 0,
                        governanceBias: 0,
                        businessBias: 0,
                        intentBoosts: {},
                        avoidActors: [],
                        preferActors: [],
                        activeGoalIntents: [],
                    },
                    computedAtTick: 0,
                },
            });

            await tx.apiKey.create({
                data: {
                    keyHash,
                    keyPrefix,
                    actorId: actor.id,
                    role: 'agent',
                    permissions: ['read_state', 'submit_intent', 'wallet_ops'],
                },
            });

            if (llmProvided && body.llm_provider && body.llm_api_key && body.llm_model) {
                const encrypted = encryptSecret(body.llm_api_key);
                await tx.webhookSubscription.create({
                    data: {
                        actorId: actor.id,
                        provider: body.llm_provider,
                        apiKeyEncrypted: encrypted.encrypted,
                        apiKeyNonce: encrypted.nonce,
                        model: body.llm_model,
                        apiBaseUrl: body.llm_api_base_url ?? null,
                        isActive: true,
                    },
                });
            }

            await tx.event.create({
                data: {
                    type: EventType.EVENT_AGENT_BORN,
                    actorId: actor.id,
                    targetIds: [citySelection.cityId],
                    tick: (await tx.worldState.findFirst({ where: { id: 1 } }))?.tick ?? 0,
                    outcome: EventOutcome.SUCCESS,
                    sideEffects: {
                        name,
                        cityId: citySelection.cityId,
                        cityName: city.name,
                        walletAddress,
                        initialBalance,
                        traits,
                        citySelectionScore: citySelection.score,
                        citySelectionReasons: citySelection.reasons,
                        referralCode: body.referral_code ?? null,
                    },
                },
            });

            return {
                actorId: actor.id,
                name,
                cityId: citySelection.cityId,
                cityName: city.name,
            };
        });

        const imported = await walletService.importWallet(result.actorId, privateKey);
        if (preferredRpc) {
            await prisma.agentWallet.update({
                where: { actorId: result.actorId },
                data: { preferredRpc },
            });
        }

        return reply.code(201).send({
            actorId: result.actorId,
            apiKey,
            walletAddress: imported.address,
            name: result.name,
            cityId: result.cityId,
            cityName: result.cityName,
            citySelectionReasons: citySelection.reasons,
            traits,
            initialBalance,
        });
    });

    app.put('/api/v1/agents/:actorId/rpc', async (request: FastifyRequest, reply: FastifyReply) => {
        const auth = await authenticateApiKey(request.headers.authorization as string | undefined);
        if (!auth) return reply.code(401).send({ error: 'Unauthorized' });

        const { actorId } = request.params as { actorId: string };
        if (auth.role === 'agent' && auth.actorId !== actorId) {
            return reply.code(403).send({ error: 'Forbidden' });
        }

        const { preferred_rpc } = request.body as { preferred_rpc?: string | null };
        const preferred = preferred_rpc?.trim();
        if (!preferred) {
            return reply.code(400).send({ error: 'preferred_rpc is required' });
        }
        if (!/^https?:\/\//i.test(preferred)) {
            return reply.code(400).send({ error: 'preferred_rpc must be a valid http(s) URL' });
        }

        const wallet = await prisma.agentWallet.findUnique({ where: { actorId } });
        if (!wallet) {
            return reply.code(404).send({ error: 'Agent wallet not found' });
        }

        await prisma.agentWallet.update({
            where: { actorId },
            data: { preferredRpc: preferred },
        });

        return reply.send({ ok: true, actorId, preferred_rpc: preferred });
    });
}
