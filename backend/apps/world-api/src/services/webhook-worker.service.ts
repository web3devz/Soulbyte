import type { PrismaClient } from '../../../generated/prisma/index.js';
import { prisma as defaultPrisma } from '../db.js';
import { decryptSecret } from '../utils/secret-encryption.js';
import { LLMRouterService } from './llm-router.service.js';

type WebhookPayload = {
    task?: string;
    key_event_id?: string;
    event_type?: string;
    fallback_headline?: string | null;
    actor_name?: string;
    target_names?: string[];
    business_names?: string[];
    city_name?: string | null;
    context?: Record<string, unknown>;
};

type SanitizedWebhookResponse = {
    headline: string | null;
    subheadline?: string | null;
    fallbackUsed: boolean;
    error?: string;
    latencyMs?: number;
    tokensUsed?: number;
};

const DEFAULT_PROMPTS = {
    enhance_headline: {
        system: 'You are a newspaper editor for a city simulation. Write a short, dramatic headline for the given event. Max 120 characters. Respond ONLY with valid JSON.',
    },
    key_event_headline: {
        system: [
            'You are the headline writer for a scandalous city simulation newspaper.',
            'Your headlines are punchy, dramatic, and read like breaking tabloid news.',
            '',
            'RULES:',
            '- Length: 10–20 words, 90–140 characters.',
            '- Include every agent/business name provided — exactly once, verbatim.',
            '- Lead with the most shocking element. Front-load the drama.',
            '- Use active voice and present tense. ("SEIZES", "COLLAPSES", "BETRAYS")',
            '- Forbidden: passive voice, quotes,  filler words like "local" or "city".',
            '',
            'STYLE EXAMPLES (do not copy, use as tone reference):',
            '- "RENZOID BURNS LAST ALLY AS STEEL EMPIRE CRUMBLES OVERNIGHT"',
            '- "SHADOW PACT EXPOSED: THREE FIRMS VANISH, ONE MAN WALKS FREE"',
            '- "VELOX CORP DEVOURS RIVALS WHILE COUNCIL SLEEPS"',
            '',
            'Return ONLY valid JSON: {"headline":"..."}',
        ].join('\n'),
    },
    name_business: {
        system: 'You are a creative naming assistant for a city simulation game. Generate a realistic, thematic business name. Respond ONLY with valid JSON.',
    },
};

// Fixed model ID - removed erroneous leading/trailing slashes
const KEY_EVENT_MODEL = 'openai/gpt-4.1-mini';

function getEnvNumber(key: string, fallback: number) {
    const value = Number(process.env[key]);
    return Number.isFinite(value) ? value : fallback;
}

function getBackoffSeconds(attempts: number) {
    if (attempts <= 1) return 5;
    if (attempts === 2) return 15;
    return 45;
}

function redactSensitiveText(value: string | null | undefined) {
    if (!value) return 'unknown';
    return value
        .slice(0, 100)
        .replace(/sk-[a-zA-Z0-9_-]+/g, 'sk-***REDACTED***')
        .replace(/(api[_-]?key=)([^&\s]+)/gi, '$1***REDACTED***');
}

function sanitizeWebhookResponse(input: SanitizedWebhookResponse): SanitizedWebhookResponse {
    const output: SanitizedWebhookResponse = {
        headline: input.headline ?? null,
        fallbackUsed: input.fallbackUsed,
    };
    if (typeof input.subheadline === 'string') {
        output.subheadline = input.subheadline;
    }
    if (typeof input.error === 'string' && input.error.trim().length > 0) {
        output.error = input.error.trim();
    }
    if (Number.isFinite(input.latencyMs)) {
        output.latencyMs = input.latencyMs;
    }
    if (Number.isFinite(input.tokensUsed)) {
        output.tokensUsed = input.tokensUsed;
    }
    return output;
}

function normalizeHeadline(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const tryParse = (value: string) => {
        const parsed = safeJsonParse(value);
        if (parsed && typeof parsed === 'object' && typeof (parsed as any).headline === 'string') {
            return (parsed as any).headline.trim();
        }
        if (typeof parsed === 'string') {
            const nested = safeJsonParse(parsed);
            if (nested && typeof nested === 'object' && typeof (nested as any).headline === 'string') {
                return (nested as any).headline.trim();
            }
        }
        return null;
    };
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        const parsedHeadline = tryParse(trimmed);
        if (parsedHeadline) return parsedHeadline;
    }
    return trimmed.replace(/^"+|"+$/g, '').trim();
}

export class WebhookWorker {
    private timer: NodeJS.Timeout | null = null;
    private isRunning = false;
    private router = new LLMRouterService();

    constructor(private prisma: PrismaClient = defaultPrisma) {}

    start() {
        if (this.timer) return;
        this.isRunning = true;
        const interval = getEnvNumber('WEBHOOK_POLL_INTERVAL_MS', 5000);
        this.timer = setInterval(() => {
            if (!this.isRunning) return;
            this.runCycle().catch((error) => {
                console.error('[WEBHOOK] Worker cycle error', error);
            });
        }, interval);
        this.runCycle().catch((error) => {
            console.error('[WEBHOOK] Worker cycle error', error);
        });
    }

    stop() {
        this.isRunning = false;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    private async runCycle() {
        const batchSize = getEnvNumber('WEBHOOK_BATCH_SIZE', 10);
        const items = await this.prisma.webhookQueue.findMany({
            where: { status: 'pending' },
            orderBy: { createdAt: 'asc' },
            take: batchSize,
        });
        if (items.length === 0) return;

        const maxConcurrency = getEnvNumber('WEBHOOK_MAX_CONCURRENCY', 3);
        await this.runWithConcurrency(items, maxConcurrency, (item) => this.processItem(item.id));
    }

    private async runWithConcurrency<T>(
        items: T[],
        limit: number,
        handler: (item: T) => Promise<void>
    ) {
        let index = 0;
        const workers = Array.from({ length: Math.min(limit, items.length) }).map(async () => {
            while (index < items.length) {
                const current = items[index++];
                await handler(current);
            }
        });
        await Promise.all(workers);
    }

    private async processItem(itemId: string) {
        const item = await this.prisma.webhookQueue.findUnique({ where: { id: itemId } });
        if (!item || item.status !== 'pending') return;

        const processedAt = item.processedAt ?? null;
        if (processedAt) {
            const delaySeconds = getBackoffSeconds(item.attempts);
            const elapsed = (Date.now() - processedAt.getTime()) / 1000;
            if (elapsed < delaySeconds) return;
        }

        await this.prisma.webhookQueue.update({
            where: { id: itemId },
            data: { status: 'processing', attempts: { increment: 1 } },
        });

        try {
            const payload = item.payload as WebhookPayload;
            const task = payload.task || 'enhance_headline';
            const isKeyEventHeadline = task === 'key_event_headline';
            const subscription = !isKeyEventHeadline && item.actorId
                ? await this.prisma.webhookSubscription.findUnique({ where: { actorId: item.actorId } })
                : null;

            if (!isKeyEventHeadline) {
                if (!subscription || !subscription.isActive) {
                    await this.markSkipped(item, 'No active webhook subscription', payload);
                    return;
                }
            }

            const rateLimit = getEnvNumber('WEBHOOK_RATE_LIMIT_PER_HOUR', 60);
            const since = new Date(Date.now() - 60 * 60 * 1000);
            const recentCount = await this.prisma.webhookQueue.count({
                where: {
                    actorId: item.actorId ?? undefined,
                    status: { in: ['completed', 'failed'] },
                    processedAt: { gte: since },
                },
            });
            if (recentCount >= rateLimit) {
                await this.markSkipped(item, 'Rate limit exceeded', payload);
                return;
            }

            const requestBody = {
                task,
                key_event_id: payload.key_event_id,
                event_type: payload.event_type,
                fallback_headline: payload.fallback_headline,
                actor_name: payload.actor_name,
                target_names: payload.target_names,
                business_names: payload.business_names,
                city_name: payload.city_name,
                context: payload.context ?? {},
            };
            const systemPrompt = DEFAULT_PROMPTS[task as keyof typeof DEFAULT_PROMPTS]?.system
                || DEFAULT_PROMPTS.enhance_headline.system;

            const apiKey = isKeyEventHeadline
                ? process.env.OPENROUTER_API_KEY
                : decryptSecret(subscription.apiKeyEncrypted, subscription.apiKeyNonce);
            if (!apiKey) {
                await this.markSkipped(item, 'Missing OPENROUTER_API_KEY', payload);
                return;
            }

            const result = await this.router.request({
                provider: isKeyEventHeadline ? 'openrouter' : (subscription.provider as any),
                apiKey,
                model: isKeyEventHeadline ? KEY_EVENT_MODEL : subscription.model,
                apiBaseUrl: isKeyEventHeadline ? undefined : (subscription.apiBaseUrl ?? undefined),
                systemPrompt,
                userPrompt: JSON.stringify(requestBody),
                maxTokens: 200,
                temperature: isKeyEventHeadline ? 0.95 : 0.7,
                responseFormat: 'json',
                timeoutMs: getEnvNumber('WEBHOOK_TIMEOUT_MS', 15000),
            });

            if (!result.success) {
                throw new Error(result.error || 'LLM request failed');
            }

            const parsed = result.parsedJson || {};
            const rawHeadline = typeof parsed.headline === 'string' && parsed.headline.trim().length > 0
                ? parsed.headline.trim()
                : null;
            const normalizedHeadline = normalizeHeadline(rawHeadline);
            const headline = normalizedHeadline ?? payload.fallback_headline ?? null;
            const subheadline = typeof parsed.subheadline === 'string' && parsed.subheadline.trim().length > 0
                ? parsed.subheadline.trim()
                : null;
            const fallbackUsed = headline === payload.fallback_headline;
            const sanitizedResponse = sanitizeWebhookResponse({
                headline,
                subheadline,
                fallbackUsed,
                latencyMs: result.latencyMs,
                tokensUsed: result.tokensUsed,
            });

            if (isKeyEventHeadline) {
                await this.updateKeyEventHeadline(payload.key_event_id, headline, {
                    provider: 'openrouter',
                    model: KEY_EVENT_MODEL,
                    latencyMs: result.latencyMs,
                    tokensUsed: result.tokensUsed,
                });
            }

            if (item.eventId) {
                await this.prisma.event.update({
                    where: { id: item.eventId },
                    data: {
                        keyEventHeadline: headline,
                        webhookSent: true,
                        webhookResponse: sanitizedResponse,
                    },
                });
            }

            await this.prisma.webhookQueue.update({
                where: { id: itemId },
                data: {
                    status: 'completed',
                    response: parsed,
                    processedAt: new Date(),
                    errorMessage: null,
                },
            });

            if (!isKeyEventHeadline && subscription) {
                await this.prisma.webhookSubscription.update({
                    where: { id: subscription.id },
                    data: {
                        lastCalledAt: new Date(),
                        lastError: null,
                        totalCalls: { increment: 1 },
                    },
                });
            }
        } catch (error: any) {
            const itemLatest = await this.prisma.webhookQueue.findUnique({ where: { id: itemId } });
            const attempts = itemLatest?.attempts ?? 1;
            const maxAttempts = itemLatest?.maxAttempts ?? 3;
            const rawErrorMessage = error?.message || String(error);
            const errorMessage = redactSensitiveText(rawErrorMessage);

            if (attempts >= maxAttempts) {
                const payloadLatest = itemLatest?.payload as WebhookPayload | undefined;
                if (itemLatest?.eventId) {
                    await this.prisma.event.update({
                        where: { id: itemLatest.eventId },
                        data: {
                            webhookSent: true,
                            webhookResponse: sanitizeWebhookResponse({
                                headline: null,
                                fallbackUsed: true,
                                error: errorMessage,
                            }),
                        },
                    });
                }
                if (payloadLatest?.task === 'key_event_headline') {
                    await this.updateKeyEventHeadline(payloadLatest.key_event_id, null, {
                        provider: 'openrouter',
                        model: KEY_EVENT_MODEL,
                        error: errorMessage,
                    });
                }
                await this.prisma.webhookQueue.update({
                    where: { id: itemId },
                    data: {
                        status: 'failed',
                        processedAt: new Date(),
                        errorMessage,
                    },
                });
            } else {
                await this.prisma.webhookQueue.update({
                    where: { id: itemId },
                    data: {
                        status: 'pending',
                        processedAt: new Date(),
                        errorMessage,
                    },
                });
            }

            if (itemLatest?.actorId) {
                await this.prisma.webhookSubscription.updateMany({
                    where: { actorId: itemLatest.actorId },
                    data: {
                        lastError: errorMessage,
                        totalErrors: { increment: 1 },
                    },
                });
            }
        }
    }

    private async markSkipped(item: { id: string; eventId: string | null }, reason: string, payload?: WebhookPayload) {
        if (item.eventId) {
            await this.prisma.event.update({
                where: { id: item.eventId },
                data: {
                    webhookSent: true,
                    webhookResponse: sanitizeWebhookResponse({
                        headline: null,
                        fallbackUsed: true,
                        error: reason,
                    }),
                },
            });
        }
        if (payload?.task === 'key_event_headline') {
            await this.updateKeyEventHeadline(payload.key_event_id, null, {
                provider: 'openrouter',
                model: KEY_EVENT_MODEL,
                error: reason,
            });
        }
        await this.prisma.webhookQueue.update({
            where: { id: item.id },
            data: {
                status: 'skipped',
                processedAt: new Date(),
                errorMessage: reason,
            },
        });
    }

    private async updateKeyEventHeadline(
        keyEventId: string | undefined,
        headline: string | null,
        meta: { provider: string; model: string; latencyMs?: number; tokensUsed?: number; error?: string }
    ) {
        if (!keyEventId) return;
        const existing = await this.prisma.keyEvent.findUnique({
            where: { id: keyEventId },
            select: { metadata: true },
        });
        const metadata = (existing?.metadata ?? {}) as Record<string, unknown>;
        const llmMeta = {
            provider: meta.provider,
            model: meta.model,
            latencyMs: meta.latencyMs ?? null,
            tokensUsed: meta.tokensUsed ?? null,
            error: meta.error ?? null,
            updatedAt: new Date().toISOString(),
        };
        await this.prisma.keyEvent.update({
            where: { id: keyEventId },
            data: {
                headline: headline ?? undefined,
                metadata: {
                    ...metadata,
                    llm: llmMeta,
                },
            },
        });
    }
}