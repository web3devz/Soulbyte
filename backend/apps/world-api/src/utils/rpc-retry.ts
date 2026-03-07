import { RPC_CONFIG } from '../config/network.js';

const MIN_RETRY_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 600;
const DEFAULT_MAX_DELAY_MS = 8000;

export type RpcRetryOptions = {
    attempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
};

function getRetryAttempts(options?: RpcRetryOptions): number {
    const configured = Number.isFinite(options?.attempts)
        ? Number(options?.attempts)
        : Number(RPC_CONFIG.retryAttempts);
    const fallback = Number.isFinite(configured) ? configured : MIN_RETRY_ATTEMPTS;
    return Math.max(MIN_RETRY_ATTEMPTS, fallback);
}

function getRetryDelayMs(options?: RpcRetryOptions): number {
    const configured = Number.isFinite(options?.baseDelayMs)
        ? Number(options?.baseDelayMs)
        : Number(RPC_CONFIG.retryDelayMs);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_BASE_DELAY_MS;
}

function getMaxDelayMs(options?: RpcRetryOptions): number {
    const configured = Number.isFinite(options?.maxDelayMs)
        ? Number(options?.maxDelayMs)
        : DEFAULT_MAX_DELAY_MS;
    return configured > 0 ? configured : DEFAULT_MAX_DELAY_MS;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function isRateLimitError(error: any): boolean {
    const message = String(error?.message || error);
    const code = error?.info?.error?.code ?? error?.error?.code ?? error?.code;
    return code === -32007 || /rate limit|request limit|too many requests/i.test(message);
}

export function isRetryableRpcError(error: any): boolean {
    if (!error) return false;
    if (isRateLimitError(error)) return true;

    const code = error?.code ?? error?.info?.error?.code ?? error?.error?.code;
    if (typeof code === 'string') {
        if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code)) {
            return true;
        }
    }

    const status = error?.status ?? error?.statusCode ?? error?.info?.status;
    if (status === 429 || status === 502 || status === 503 || status === 504) {
        return true;
    }

    const message = String(error?.message || error);
    return /timeout|timed out|temporarily unavailable|bad gateway|gateway timeout/i.test(message);
}

export async function withRpcRetry<T>(
    fn: () => Promise<T>,
    label: string,
    options?: RpcRetryOptions
): Promise<T> {
    const attempts = getRetryAttempts(options);
    const baseDelayMs = getRetryDelayMs(options);
    const maxDelayMs = getMaxDelayMs(options);

    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await fn();
        } catch (error: any) {
            lastError = error;
            if (attempt >= attempts || !isRetryableRpcError(error)) {
                throw error;
            }
            const backoff = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
            const jitter = Math.floor(Math.random() * 200);
            const waitMs = backoff + jitter;
            console.warn(`[RPC] ${label} failed (attempt ${attempt}/${attempts}); retrying in ${waitMs}ms`);
            await sleep(waitMs);
        }
    }

    throw lastError;
}
