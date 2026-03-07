type BraveWebResult = {
    title?: string;
    url?: string;
    description?: string;
};

type BraveWebResponse = {
    web?: {
        results?: BraveWebResult[];
    };
};

const DEFAULT_DAILY_LIMIT = 2;
const DEFAULT_RESULT_LIMIT = 3;
const SEARCH_TIMEOUT_MS = 8000;

const dailyUsage = new Map<string, { dayKey: string; count: number }>();

function getDayKey(date = new Date()): string {
    return date.toISOString().slice(0, 10);
}

function getDailyLimit(): number {
    const raw = Number(process.env.AGORA_WEB_SEARCH_DAILY_LIMIT ?? DEFAULT_DAILY_LIMIT);
    return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : DEFAULT_DAILY_LIMIT;
}

function shouldUseWebSearch(): boolean {
    return Boolean(process.env.BRAVE_SEARCH_API_KEY);
}

export function consumeWebSearchBudget(agentId: string): boolean {
    const limit = getDailyLimit();
    if (limit <= 0) return false;
    const dayKey = getDayKey();
    const record = dailyUsage.get(agentId);
    if (!record || record.dayKey !== dayKey) {
        dailyUsage.set(agentId, { dayKey, count: 1 });
        return true;
    }
    if (record.count >= limit) return false;
    record.count += 1;
    return true;
}

export async function searchWeb(query: string, limit = DEFAULT_RESULT_LIMIT): Promise<BraveWebResult[]> {
    if (!shouldUseWebSearch()) return [];
    const apiKey = process.env.BRAVE_SEARCH_API_KEY as string;
    if (!apiKey) return [];
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.max(1, Math.min(limit, 5))}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                'X-Subscription-Token': apiKey,
            },
            signal: controller.signal,
        });
        if (!response.ok) return [];
        const data = (await response.json().catch(() => ({}))) as BraveWebResponse;
        return data.web?.results ?? [];
    } catch {
        return [];
    } finally {
        clearTimeout(timeout);
    }
}

export function summarizeSearchResults(results: BraveWebResult[]): string {
    if (!results.length) return '';
    const lines = results.map((result) => {
        const title = result.title ?? 'Untitled';
        const description = result.description ? ` — ${result.description}` : '';
        return `- ${title}${description}`;
    });
    return lines.join('\n');
}
