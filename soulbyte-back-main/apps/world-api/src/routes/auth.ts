import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../db.js';
import { sendVerificationEmail } from '../services/email.service.js';
import { encryptSecret, decryptSecret } from '../utils/secret-encryption.js';
import { decryptPrivateKey } from '../services/wallet.service.js';
import { authenticateApiKey } from '../middleware/openclaw-auth.js';
import { LLMRouterService } from '../services/llm-router.service.js';
import { getResilientProvider } from '../config/network.js';
import { ethers } from 'ethers';

type RegisterBody = { email?: string };
type VerifyBody = { email?: string; code?: string };
type CompleteSignupBody = {
    email?: string;
    wallet_address?: string;
    agent_name?: string;
    preferred_rpc?: string | null;
    llm_provider?: 'zai';
    llm_api_key?: string;
    llm_model?: string;
    llm_api_base_url?: string | null;
};
type VerifyLlmBody = {
    llm_provider?: 'zai';
    llm_api_key?: string;
    llm_model?: string;
    llm_api_base_url?: string | null;
};
type ExportPkBody = { actor_id?: string; signature?: string; message?: string };

type RateLimitState = { count: number; resetAt: number };
const registerRateLimit = new Map<string, RateLimitState>();
const verifyRateLimit = new Map<string, RateLimitState>();

function redactSensitiveText(value: string | null | undefined) {
    if (!value) return 'unknown';
    return value
        .slice(0, 100)
        .replace(/sk-[a-zA-Z0-9_-]+/g, 'sk-***REDACTED***')
        .replace(/(api[_-]?key=)([^&\s]+)/gi, '$1***REDACTED***');
}

function checkRateLimit(map: Map<string, RateLimitState>, key: string, max: number, windowMs: number) {
    const now = Date.now();
    const state = map.get(key);
    if (!state || now > state.resetAt) {
        map.set(key, { count: 1, resetAt: now + windowMs });
        return true;
    }
    if (state.count >= max) return false;
    state.count += 1;
    return true;
}

function isValidEmail(email: string) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function generateCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

export async function authRoutes(app: FastifyInstance) {
    const llmRouter = new LLMRouterService();

    app.post('/api/v1/auth/register', async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as RegisterBody;
        const email = body?.email?.trim().toLowerCase();
        if (!email || !isValidEmail(email)) {
            return reply.code(400).send({ error: 'Invalid email' });
        }

        const max = Number(process.env.AUTH_REGISTER_RATE_LIMIT ?? 5);
        if (!checkRateLimit(registerRateLimit, request.ip, max, 60 * 60 * 1000)) {
            return reply.code(429).send({ error: 'Rate limit exceeded' });
        }

        const existing = await prisma.userAccount.findUnique({ where: { email } });
        if (existing?.emailVerified) {
            return reply.code(409).send({ error: 'Email already registered' });
        }

        const code = generateCode();
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
        if (existing) {
            await prisma.userAccount.update({
                where: { email },
                data: {
                    verificationCode: code,
                    verificationExpiresAt: expiresAt,
                    verificationAttempts: 0,
                    emailVerified: false,
                },
            });
        } else {
            await prisma.userAccount.create({
                data: {
                    email,
                    verificationCode: code,
                    verificationExpiresAt: expiresAt,
                    verificationAttempts: 0,
                    emailVerified: false,
                },
            });
        }

        try {
            await sendVerificationEmail(email, code);
        } catch (err: any) {
            console.error('[AUTH] Email send failed:', err.message);
            return reply.code(503).send({ error: 'Failed to send verification email. Please try again later.' });
        }
        return reply.send({ success: true, message: `Verification code sent to ${email}` });
    });

    app.post('/api/v1/auth/verify-email', async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as VerifyBody;
        const email = body?.email?.trim().toLowerCase();
        const code = body?.code?.trim();
        if (!email || !code) {
            return reply.code(400).send({ error: 'Email and code are required' });
        }
        if (!isValidEmail(email)) {
            return reply.code(400).send({ error: 'Invalid email' });
        }

        const max = Number(process.env.AUTH_VERIFY_RATE_LIMIT ?? 3);
        if (!checkRateLimit(verifyRateLimit, email, max, 10 * 60 * 1000)) {
            return reply.code(429).send({ error: 'Rate limit exceeded' });
        }

        const account = await prisma.userAccount.findUnique({ where: { email } });
        if (!account || !account.verificationCode) {
            return reply.code(404).send({ error: 'Verification not initiated' });
        }
        if ((account.verificationAttempts ?? 0) >= 5) {
            await prisma.userAccount.update({
                where: { email },
                data: {
                    verificationCode: null,
                    verificationExpiresAt: null,
                    verificationAttempts: 0,
                },
            });
            return reply.code(429).send({ error: 'Verification attempts exceeded. Please request a new code.' });
        }
        if (account.walletPkRevealedAt) {
            return reply.code(409).send({ error: 'Wallet already generated' });
        }
        if (account.verificationExpiresAt && account.verificationExpiresAt < new Date()) {
            await prisma.userAccount.update({
                where: { email },
                data: {
                    verificationCode: null,
                    verificationExpiresAt: null,
                    verificationAttempts: 0,
                },
            });
            return reply.code(400).send({ error: 'Verification code expired' });
        }
        if (account.verificationCode !== code) {
            const nextAttempts = (account.verificationAttempts ?? 0) + 1;
            const shouldInvalidate = nextAttempts >= 5;
            await prisma.userAccount.update({
                where: { email },
                data: {
                    verificationAttempts: shouldInvalidate ? 0 : nextAttempts,
                    verificationCode: shouldInvalidate ? null : account.verificationCode,
                    verificationExpiresAt: shouldInvalidate ? null : account.verificationExpiresAt,
                },
            });
            return reply.code(400).send({
                error: shouldInvalidate
                    ? 'Verification attempts exceeded. Please request a new code.'
                    : 'Invalid verification code',
            });
        }

        const wallet = ethers.Wallet.createRandom();
        const encrypted = encryptSecret(wallet.privateKey);
        await prisma.userAccount.update({
            where: { email },
            data: {
                emailVerified: true,
                verificationCode: null,
                verificationExpiresAt: null,
                verificationAttempts: 0,
                walletAddress: wallet.address,
                walletPrivateKeyEncrypted: encrypted.encrypted,
                walletPrivateKeyNonce: encrypted.nonce,
                walletPkRevealedAt: new Date(),
            },
        });

        return reply.send({
            success: true,
            wallet_address: wallet.address,
            private_key: wallet.privateKey,
            message: 'Save your private key securely. Fund this wallet with MON and SBYTE.',
        });
    });

    app.post('/api/v1/auth/complete-signup', async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as CompleteSignupBody;
        const email = body?.email?.trim().toLowerCase();
        if (!email || !body.wallet_address || !body.agent_name) {
            return reply.code(400).send({ error: 'email, wallet_address, and agent_name are required' });
        }

        const account = await prisma.userAccount.findUnique({ where: { email } });
        if (!account || !account.emailVerified) {
            return reply.code(400).send({ error: 'Email not verified' });
        }
        if (!account.walletAddress || account.walletAddress.toLowerCase() !== body.wallet_address.toLowerCase()) {
            return reply.code(400).send({ error: 'Wallet address mismatch' });
        }
        if (!account.walletPrivateKeyEncrypted || !account.walletPrivateKeyNonce) {
            return reply.code(400).send({ error: 'Wallet private key unavailable' });
        }

        const existingName = await prisma.actor.findFirst({
            where: { name: { equals: body.agent_name.trim(), mode: 'insensitive' } },
        });
        if (existingName) {
            return reply.code(409).send({ error: 'Name already taken' });
        }

        if (body.llm_provider || body.llm_api_key || body.llm_model) {
            if (!body.llm_provider || !body.llm_api_key || !body.llm_model) {
                return reply.code(400).send({ error: 'LLM provider, key, and model are required' });
            }
            const llmResult = await llmRouter.request({
                provider: body.llm_provider,
                apiKey: body.llm_api_key,
                model: body.llm_model,
                apiBaseUrl: body.llm_api_base_url ?? undefined,
                systemPrompt: 'Respond ONLY with valid JSON.',
                userPrompt: JSON.stringify({ message: 'Soulbyte webhook test' }),
                maxTokens: 50,
                temperature: 0.2,
                responseFormat: 'json',
                timeoutMs: 10000,
            });
            if (!llmResult.success) {
                console.error('[AUTH] LLM validation failed', {
                    provider: body.llm_provider,
                    model: body.llm_model,
                    error: redactSensitiveText(llmResult.error),
                });
                return reply.code(400).send({
                    error: 'LLM configuration test failed. Please verify your API key and model name.',
                });
            }
        }

        const decryptedPk = decryptSecret(account.walletPrivateKeyEncrypted, account.walletPrivateKeyNonce);
        const birthResponse = await app.inject({
            method: 'POST',
            url: '/api/v1/agents/birth',
            payload: {
                name: body.agent_name,
                wallet_private_key: decryptedPk,
                preferred_rpc: body.preferred_rpc ?? undefined,
            },
        });
        if (birthResponse.statusCode >= 400) {
            return reply.code(birthResponse.statusCode).send(birthResponse.json());
        }

        const birthData = birthResponse.json() as {
            actorId: string;
            apiKey: string;
            name: string;
            cityName?: string;
        };

        if (body.llm_provider && body.llm_api_key && body.llm_model) {
            const encrypted = encryptSecret(body.llm_api_key);
            await prisma.webhookSubscription.upsert({
                where: { actorId: birthData.actorId },
                create: {
                    actorId: birthData.actorId,
                    provider: body.llm_provider,
                    apiKeyEncrypted: encrypted.encrypted,
                    apiKeyNonce: encrypted.nonce,
                    model: body.llm_model,
                    apiBaseUrl: body.llm_api_base_url ?? null,
                    isActive: true,
                },
                update: {
                    provider: body.llm_provider,
                    apiKeyEncrypted: encrypted.encrypted,
                    apiKeyNonce: encrypted.nonce,
                    model: body.llm_model,
                    apiBaseUrl: body.llm_api_base_url ?? null,
                    isActive: true,
                },
            });
        }

        await prisma.userAccount.update({
            where: { email },
            data: {
                actorId: birthData.actorId,
                walletPrivateKeyEncrypted: null,
                walletPrivateKeyNonce: null,
            },
        });

        return reply.send({
            success: true,
            api_key: birthData.apiKey,
            actor_id: birthData.actorId,
            actor_name: birthData.name,
            city_name: birthData.cityName ?? null,
        });
    });

    app.post('/api/v1/auth/verify-llm-config', async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as VerifyLlmBody;
        if (!body?.llm_provider || !body.llm_api_key || !body.llm_model) {
            return reply.code(400).send({ error: 'LLM provider, key, and model are required' });
        }

        const llmResult = await llmRouter.request({
            provider: body.llm_provider,
            apiKey: body.llm_api_key,
            model: body.llm_model,
            apiBaseUrl: body.llm_api_base_url ?? undefined,
            systemPrompt: 'Respond ONLY with valid JSON.',
            userPrompt: JSON.stringify({ message: 'Soulbyte webhook test' }),
            maxTokens: 50,
            temperature: 0.2,
            responseFormat: 'json',
            timeoutMs: 10000,
        });

        if (!llmResult.success) {
            console.error('[AUTH] LLM config test failed', {
                provider: body.llm_provider,
                model: body.llm_model,
                error: redactSensitiveText(llmResult.error),
            });
            return reply.code(400).send({
                error: 'LLM configuration test failed. Please verify your API key and model name.',
            });
        }

        return reply.send({ success: true });
    });

    app.post('/api/v1/auth/verify-funding', async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { wallet_address?: string };
        if (!body.wallet_address) {
            return reply.code(400).send({ error: 'wallet_address is required' });
        }

        try {
            // Check MON balance
            // Use admin RPC if configured, otherwise fallback to default RPCs
            const provider = await getResilientProvider(process.env.MONAD_RPC_URL);

            const balanceWei = await provider.getBalance(body.wallet_address);
            const balanceMon = parseFloat(ethers.formatEther(balanceWei));

            // Check SBYTE balance
            // SBYTE Contract: 0x0767C203B0BbB7A69a72d6aBCfa7191227Eb7777
            // Using minimal ABI for balanceOf
            const sbyteAddress = process.env.SBYTE_CONTRACT_ADDRESS || '0x0767C203B0BbB7A69a72d6aBCfa7191227Eb7777';
            const sbyteAbi = ['function balanceOf(address owner) view returns (uint256)'];
            let sbyteBalance = 0;
            try {
                const sbyteContract = new ethers.Contract(sbyteAddress, sbyteAbi, provider);
                const sbyteBalanceWei = await sbyteContract.balanceOf(body.wallet_address);
                sbyteBalance = parseFloat(ethers.formatEther(sbyteBalanceWei));
            } catch (error: any) {
                const message = 'Failed to read SBYTE balance. Ensure the contract address and network are correct.';
                request.log.error({ error, sbyteAddress }, message);
                return reply.send({
                    success: false,
                    balances: { mon: balanceMon, sbyte: 0 },
                    requirements: { mon: 10, sbyte: 500 },
                    message,
                });
            }

            const hasMinMon = balanceMon >= 10;
            const hasMinSbyte = sbyteBalance >= 500;

            return reply.send({
                success: hasMinMon && hasMinSbyte,
                balances: {
                    mon: balanceMon,
                    sbyte: sbyteBalance
                },
                requirements: {
                    mon: 10,
                    sbyte: 500
                },
                message: (hasMinMon && hasMinSbyte)
                    ? 'Funding verified'
                    : 'Insufficient funds. Please ensure you have at least 10 MON and 500 SBYTE.'
            });

        } catch (error: any) {
            request.log.error('Funding verification failed', error);
            return reply.code(500).send({ error: 'Failed to verify funding', details: error.message });
        }
    });

    app.get('/api/v1/auth/me', async (request: FastifyRequest, reply: FastifyReply) => {
        const auth = await authenticateApiKey(request.headers.authorization as string | undefined);
        if (!auth) return reply.code(401).send({ error: 'Unauthorized' });

        const actor = auth.actorId
            ? await prisma.actor.findUnique({
                where: { id: auth.actorId },
                select: { id: true, name: true },
            })
            : null;
        const account = auth.actorId
            ? await prisma.userAccount.findFirst({
                where: { actorId: auth.actorId },
                select: { email: true },
            })
            : null;

        return reply.send({
            actor_id: auth.actorId,
            actor_name: actor?.name ?? null,
            email: account?.email ?? null,
            role: auth.role,
        });
    });

    app.post('/api/v1/auth/export-pk', async (request: FastifyRequest, reply: FastifyReply) => {
        const auth = await authenticateApiKey(request.headers.authorization as string | undefined);
        if (!auth || auth.role !== 'agent') {
            return reply.code(401).send({ error: 'Unauthorized' });
        }

        const body = request.body as ExportPkBody;
        const actorId = body.actor_id ?? auth.actorId;
        if (!actorId || actorId !== auth.actorId) {
            return reply.code(403).send({ error: 'Forbidden' });
        }

        const wallet = await prisma.agentWallet.findUnique({ where: { actorId } });
        if (!wallet) {
            return reply.code(404).send({ error: 'Wallet not found' });
        }

        const message = body.message || `Soulbyte Export PK: ${wallet.walletAddress}`;
        if (!body.signature) {
            return reply.code(400).send({ error: 'signature is required' });
        }
        const recovered = ethers.verifyMessage(message, body.signature);
        if (recovered.toLowerCase() !== wallet.walletAddress.toLowerCase()) {
            return reply.code(401).send({ error: 'Invalid signature' });
        }

        const privateKey = decryptPrivateKey(wallet.encryptedPk, wallet.pkNonce);
        return reply.send({
            actor_id: actorId,
            wallet_address: wallet.walletAddress,
            private_key: privateKey,
            message: 'Private key revealed. Store it securely.',
        });
    });
}
