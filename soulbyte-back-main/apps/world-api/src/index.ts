/**
 * Soulbyte World API
 * Main entry point for the World Engine, Intent Gateway, and God Service
 */
import 'dotenv/config';
import Fastify from 'fastify';
import fs from 'fs';
import path from 'path';
import cors from '@fastify/cors';
import { connectDB, disconnectDB, prisma } from './db.js';
import { intentsRoutes } from './routes/intents.js';
import { worldRoutes } from './routes/world.js';
import { citiesRoutes } from './routes/cities.js';
import { agentsRoutes } from './routes/agents.js';
import { actorsRoutes } from './routes/actors.js';
import { eventsRoutes } from './routes/events.js';
import { walletRoutes } from './routes/wallet.js';
import { businessRoutes } from './routes/businesses.js';
import { economyRoutes } from './routes/economy.js';
import { governanceRoutes } from './routes/governance.js';
import { marketRoutes } from './routes/market.js';
import { narrativeRoutes } from './routes/narrative.js';
import { leaderboardsRoutes } from './routes/leaderboards.js';
import { feedRoutes } from './routes/feed.js';
import { constructionRoutes } from './routes/construction.js';
import { agoraRoutes } from './routes/agora.js';
import { pnlRoutes } from './routes/pnl.js';
import { propertyRoutes } from './routes/property.js';
import { openclawRoutes } from './routes/openclaw.js';
import { rpcRoutes } from './routes/rpc.js';
import { adminKeysRoutes } from './routes/admin-keys.js';
import { authRoutes } from './routes/auth.js';
import { webhookRoutes } from './routes/webhook.js';
import { tokenRoutes } from './routes/token.js';
import { notificationsRoutes } from './routes/notifications.js';
import { startTickRunner, stopTickRunner, runSingleTick } from './engine/tick-runner.js';
import { startGodRunner, stopGodRunner, runSingleGodCycle } from './services/god-runner.js';
import { verifyContractConfig } from './config/contracts.js';
import { BlockchainListenerService } from './services/blockchain-listener.service.js';
import { GodOnchainService } from './services/god-onchain.service.js';
import { startOnchainWorker, stopOnchainWorker } from './services/onchain-worker.service.js';
import { authenticateApiKey } from './middleware/openclaw-auth.js';
import { isRateLimitError, isRetryableRpcError } from './utils/rpc-retry.js';
import { getErrorLogPath, logErrorToFile } from './utils/error-log.js';
import { getDebugLogPath, isDebugEnabled } from './utils/debug-log.js';
import { WebhookWorker } from './services/webhook-worker.service.js';
import { tokenStatsService } from './services/token-stats.service.js';

const app = Fastify({
  logger: true,
  trustProxy: true,
});

const LOG_MODE_ENABLED = process.env.LOG_MODE === 'YES';
const SOULBYTE_LOG_FILE = process.env.SOULBYTE_LOG_FILE
  ? path.resolve(process.env.SOULBYTE_LOG_FILE)
  : path.join(process.cwd(), 'logs', 'soulbyte-endpoints.log');

const PUBLIC_NON_GET_PATHS = new Set([
  '/api/v1/auth/link',
  '/api/v1/auth/link-with-key',
  '/api/v1/auth/register',
  '/api/v1/auth/verify-email',
  '/api/v1/auth/verify-funding',
  '/api/v1/auth/verify-llm-config',
  '/api/v1/auth/complete-signup',
  '/api/v1/agents/birth',
]);

const SENSITIVE_GET_PREFIXES = [
  '/api/v1/admin',
  '/api/v1/wallet',
  '/api/v1/actors/me',
  '/api/v1/notifications',
];

const NONCE_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const NONCE_CLEANUP_RETENTION_MS = 60 * 60 * 1000;

let authNonceCleanupTimer: NodeJS.Timeout | null = null;
let tokenStatsTimer: NodeJS.Timeout | null = null;

function requiresAuthForRequest(method: string, pathname: string): boolean {
  if (method === 'OPTIONS') return false;
  if (method !== 'GET') {
    return !PUBLIC_NON_GET_PATHS.has(pathname);
  }
  if (pathname.endsWith('/me')) return true;
  return SENSITIVE_GET_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

async function cleanupAuthNonces() {
  const now = new Date();
  const cutoff = new Date(Date.now() - NONCE_CLEANUP_RETENTION_MS);
  await prisma.authNonce.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: now }, consumed: false },
        { consumedAt: { lt: cutoff } },
      ],
    },
  });
}

function requireAdminRole(role?: string | null) {
  return role === 'god' || role === 'admin';
}

if (LOG_MODE_ENABLED) {
  fs.mkdirSync(path.dirname(SOULBYTE_LOG_FILE), { recursive: true });
}
fs.mkdirSync(path.dirname(getErrorLogPath()), { recursive: true });

// Register CORS
const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
  : [
      'https://soulbyte.fun',
      'https://www.soulbyte.fun',
      ...(process.env.NODE_ENV !== 'production' ? ['http://localhost:5173', 'http://localhost:3000'] : []),
    ];
await app.register(cors, {
  origin: corsOrigins.length > 0 ? corsOrigins : true,
});

app.addHook('preHandler', async (request, reply) => {
  const method = request.method.toUpperCase();
  const pathname = new URL(request.url, 'http://localhost').pathname;

  if (!requiresAuthForRequest(method, pathname)) return;

  const authHeader = request.headers.authorization as string | undefined;
  const auth = await authenticateApiKey(authHeader);
  if (!auth) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }

  (request as typeof request & { apiAuth?: typeof auth }).apiAuth = auth;
});

app.addHook('onResponse', async (request, reply) => {
  if (!LOG_MODE_ENABLED) return;

  let actorId: string | null = null;
  let isSoulbyte = false;

  const authHeader = request.headers.authorization as string | undefined;
  if (authHeader) {
    const auth = await authenticateApiKey(authHeader);
    if (auth?.role === 'agent') {
      isSoulbyte = true;
      actorId = auth.actorId ?? null;
    }
  }

  if (!isSoulbyte) {
    const url = request.url || '';
    if (request.method === 'POST' && url.startsWith('/api/v1/agents/birth')) {
      isSoulbyte = true;
    } else if (url.startsWith('/api/v1/auth/link')) {
      isSoulbyte = true;
    }
  }

  if (!isSoulbyte) return;

  const entry = {
    ts: new Date().toISOString(),
    method: request.method,
    url: request.url,
    status: reply.statusCode,
    actorId,
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  };

  fs.appendFile(SOULBYTE_LOG_FILE, `${JSON.stringify(entry)}\n`, () => {});
});

// Health check
app.get('/health', async () => {
  const worldState = await prisma.worldState.findFirst({ where: { id: 1 } });
  return {
    status: 'ok',
    tick: worldState?.tick ?? 0,
    timestamp: new Date().toISOString(),
  };
});

// Register API routes
await app.register(intentsRoutes);
await app.register(worldRoutes);
await app.register(citiesRoutes);
await app.register(agentsRoutes);
await app.register(actorsRoutes);
await app.register(eventsRoutes);
await app.register(walletRoutes);
await app.register(businessRoutes);
await app.register(economyRoutes);
await app.register(marketRoutes);
await app.register(governanceRoutes);
await app.register(narrativeRoutes);
await app.register(leaderboardsRoutes);
await app.register(feedRoutes);
await app.register(constructionRoutes);
await app.register(agoraRoutes);
await app.register(pnlRoutes);
    await app.register(propertyRoutes);
await app.register(notificationsRoutes);
  await app.register(openclawRoutes);
  await app.register(rpcRoutes);
  await app.register(adminKeysRoutes);
await app.register(authRoutes);
await app.register(webhookRoutes);
await app.register(tokenRoutes);

// Admin: Manual tick (for testing)
app.post('/api/v1/admin/tick', async (_request, reply) => {
  try {
    const auth = await authenticateApiKey(_request.headers.authorization as string | undefined);
    if (!auth || !requireAdminRole(auth.role)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const result = await runSingleTick();
    return reply.send({
      ok: true,
      ...result,
    });
  } catch (error) {
    console.error('Error running tick:', error);
    return reply.code(500).send({ error: 'Failed to run tick' });
  }
});

// Admin: Manual God cycle (for testing)
app.post('/api/v1/admin/god/cycle', async (_request, reply) => {
  try {
    const auth = await authenticateApiKey(_request.headers.authorization as string | undefined);
    if (!auth || !requireAdminRole(auth.role)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const result = await runSingleGodCycle();
    return reply.send({
      ok: true,
      ...result,
    });
  } catch (error) {
    console.error('Error running god cycle:', error);
    return reply.code(500).send({ error: 'Failed to run god cycle' });
  }
});

// Admin: Manual God Action (e.g., spawn_disaster, distribute_welfare)
app.post('/api/v1/admin/god/action', async (request, reply) => {
  const auth = await authenticateApiKey(request.headers.authorization as string | undefined);
  if (!auth || !requireAdminRole(auth.role)) {
    return reply.code(403).send({ error: 'Forbidden' });
  }

  const { action, payload } = request.body as { action: string; payload?: any };

  try {
    const godActor = await prisma.actor.findFirst({ where: { isGod: true } });
    if (!godActor) {
      return reply.code(400).send({ error: 'No God actor found' });
    }

    // Log the action (Logic to be implemented in God Service later)
    await prisma.adminLog.create({
      data: {
        godId: godActor.id,
        action: action.toUpperCase(),
        payload: payload || {},
      },
    });

    console.log(`[God Action] ${action} invoked by admin`);

    return reply.send({
      ok: true,
      action,
      status: 'queued',
      message: 'God action logged and queued for processing',
    });
  } catch (error) {
    console.error('Error executing god action:', error);
    return reply.code(500).send({ error: 'Failed to execute god action' });
  }
});

// Admin: Audit log
app.get('/api/v1/admin/audit', async (request, reply) => {
  const auth = await authenticateApiKey(request.headers.authorization as string | undefined);
  if (!auth || !requireAdminRole(auth.role)) {
    return reply.code(403).send({ error: 'Forbidden' });
  }

  const { limit = 50 } = request.query as { limit?: number };

  try {
    const logs = await prisma.adminLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: Number(limit),
    });
    return reply.send({ logs });
  } catch (error) {
    console.error('Error fetching audit logs:', error);
    return reply.code(500).send({ error: 'Failed to fetch audit logs' });
  }
});

// Admin: Update city fee configuration (God only)
app.post('/api/v1/admin/god/fee-config', async (request, reply) => {
  const auth = await authenticateApiKey(request.headers.authorization as string | undefined);
  if (!auth || !requireAdminRole(auth.role)) {
    return reply.code(403).send({ error: 'Forbidden' });
  }

  const { city_id, city_fee_bps, min_city_fee_bps, max_city_fee_bps } = request.body as {
    city_id: string;
    city_fee_bps: number;
    min_city_fee_bps?: number;
    max_city_fee_bps?: number;
  };

  try {
    const godOnchainService = new GodOnchainService();
    await godOnchainService.updateCityFeeConfig(
      city_id,
      city_fee_bps,
      min_city_fee_bps,
      max_city_fee_bps
    );

    return reply.send({ ok: true, status: 'updated' });
  } catch (error: any) {
    console.error('Error updating fee config:', error);
    return reply.code(400).send({ error: error.message });
  }
});

// Admin: Force sync all wallet balances
app.post('/api/v1/admin/sync-balances', async (_request, reply) => {
  try {
    const auth = await authenticateApiKey(_request.headers.authorization as string | undefined);
    if (!auth || !requireAdminRole(auth.role)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const listener = new BlockchainListenerService();
    const result = await listener.syncAllBalances();
    return reply.send({ ok: true, ...result });
  } catch (error: any) {
    console.error('Error syncing balances:', error);
    if (isRetryableRpcError(error)) {
      const statusCode = isRateLimitError(error) ? 429 : 503;
      return reply.code(statusCode).send({
        error: 'RPC temporarily unavailable',
        message: 'Balance sync failed after RPC retries. Try again later.',
      });
    }
    return reply.code(500).send({ error: error.message });
  }
});

// Blockchain listener instance
let blockchainListener: BlockchainListenerService | null = null;
let webhookWorker: WebhookWorker | null = null;

// Graceful shutdown
const shutdown = async () => {
  console.log('\nShutting down...');
  if (authNonceCleanupTimer) {
    clearInterval(authNonceCleanupTimer);
    authNonceCleanupTimer = null;
  }
  if (tokenStatsTimer) {
    clearInterval(tokenStatsTimer);
    tokenStatsTimer = null;
  }
  stopTickRunner();
  stopGodRunner();
  stopOnchainWorker();
  webhookWorker?.stop();
  blockchainListener?.stopListening();
  await app.close();
  await disconnectDB();
  console.log('Goodbye!');
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  logErrorToFile('unhandledRejection', reason);
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  logErrorToFile('uncaughtException', error);
});

// Start server
const start = async () => {
  try {
    // Connect to database
    await connectDB();

    // Verify contract configuration
    await verifyContractConfig();

    // Start background services
    const enableTickRunner = process.env.ENABLE_TICK_RUNNER !== 'false';
    const enableGodRunner = process.env.ENABLE_GOD_RUNNER !== 'false';
    const enableBlockchainListener = process.env.ENABLE_BLOCKCHAIN_LISTENER === 'true';
    const enableOnchainQueue = process.env.ENABLE_ONCHAIN_QUEUE === 'true';
    const enableWebhookWorker = process.env.WEBHOOK_WORKER_ENABLED === 'true';

    if (enableTickRunner) {
      await startTickRunner();
    } else {
      console.log('⚠ Tick runner disabled (ENABLE_TICK_RUNNER=false)');
    }

    if (enableGodRunner) {
      await startGodRunner();
    } else {
      console.log('⚠ God runner disabled (ENABLE_GOD_RUNNER=false)');
    }

    if (enableBlockchainListener) {
      blockchainListener = new BlockchainListenerService();
      await blockchainListener.startListening();
    } else {
      console.log('⚠ Blockchain listener disabled (ENABLE_BLOCKCHAIN_LISTENER=false)');
    }

    if (enableOnchainQueue) {
      await startOnchainWorker();
    } else {
      console.log('⚠ Onchain queue disabled (ENABLE_ONCHAIN_QUEUE=false)');
    }

    if (enableWebhookWorker) {
      webhookWorker = new WebhookWorker(prisma);
      webhookWorker.start();
      console.log('[WEBHOOK] Worker started');
    }

    authNonceCleanupTimer = setInterval(() => {
      cleanupAuthNonces().catch((error) => {
        console.error('[AUTH] Nonce cleanup failed', error);
      });
    }, NONCE_CLEANUP_INTERVAL_MS);

    // Start listening
    const port = parseInt(process.env.PORT || '3000', 10);
    await app.listen({ port, host: '0.0.0.0' });

    console.log(`
╔══════════════════════════════════════════════════╗
║         Soulbyte World API v1.0.0                ║
║         Running on http://0.0.0.0:${port}            ║
╠══════════════════════════════════════════════════╣
║  Endpoints:                                      ║
║    POST /api/v1/intents        Submit intent     ║
║    GET  /api/v1/world/state    World snapshot    ║
║    GET  /api/v1/cities/:id     City details      ║
║    POST /api/v1/admin/tick     Manual tick       ║
║    POST /api/v1/admin/god/cycle Manual God       ║
║    GET  /api/v1/admin/audit    Audit logs        ║
╚══════════════════════════════════════════════════╝
    `);
    console.log(`Error log: ${getErrorLogPath()}`);
    if (isDebugEnabled()) {
      console.log(`Debug log: ${getDebugLogPath()}`);
    }

    const tokenStatsEnabled = process.env.TOKEN_STATS_ENABLED !== 'false';
    const tokenStatsIntervalMs = Number(process.env.TOKEN_STATS_INTERVAL_MS ?? 30 * 60 * 1000);
    const tokenStatsStartupDelayMs = Number(process.env.TOKEN_STATS_STARTUP_DELAY_MS ?? 10 * 1000);
    if (tokenStatsEnabled) {
      console.log('[TokenStats] Scheduler initialized');
      setTimeout(async () => {
        console.log('[TokenStats] Startup sync triggered');
        try {
          await tokenStatsService.checkGraduation();
        } catch (error) {
          console.error('[TokenStats] Graduation check failed:', error);
        }
        try {
          await tokenStatsService.sync();
        } catch (error) {
          console.error('[TokenStats] Startup sync failed:', error);
        }
      }, tokenStatsStartupDelayMs);

      tokenStatsTimer = setInterval(async () => {
        console.log('[TokenStats] Interval sync triggered');
        try {
          await tokenStatsService.checkGraduation();
        } catch (error) {
          console.error('[TokenStats] Graduation check failed:', error);
        }
        try {
          await tokenStatsService.sync();
        } catch (error) {
          console.error('[TokenStats] Sync error:', error);
        }
      }, tokenStatsIntervalMs);
    } else {
      console.log('[TokenStats] Scheduler disabled by TOKEN_STATS_ENABLED=false');
    }

    console.log('[TokenHolders] Scheduler disabled (replaced by on-chain listener)');
  } catch (error: any) {
    if (error?.code === 'EADDRINUSE') {
      console.error(
        `Failed to start server: port ${error.port ?? 'unknown'} is already in use. ` +
          'Stop the other process or set PORT to a free value.'
      );
    } else {
      console.error('Failed to start server:', error);
    }
    process.exit(1);
  }
};

start();
