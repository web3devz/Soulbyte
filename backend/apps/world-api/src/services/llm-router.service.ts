export interface LLMRequest {
    provider: 'zai';
    apiKey: string;
    model: string;
    apiBaseUrl?: string;
    systemPrompt: string;
    userPrompt: string;
    maxTokens: number;
    temperature: number;
    responseFormat?: 'json';
    timeoutMs?: number;
}

export interface LLMResponse {
    success: boolean;
    content: string | null;
    parsedJson: any | null;
    error: string | null;
    tokensUsed: number;
    latencyMs: number;
}

const ZAI_BASE_URL = 'https://api.z.ai/api/paas/v4';

function safeJsonParse(raw: string | null) {
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

export class LLMRouterService {
    async request(payload: LLMRequest): Promise<LLMResponse> {
        const start = Date.now();
        const controller = new AbortController();
        const timeoutMs = payload.timeoutMs ?? 15000;
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const baseUrl = payload.apiBaseUrl || ZAI_BASE_URL;

            const { url, headers, body } = this.buildRequest(baseUrl, payload);
            const response = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                return {
                    success: false,
                    content: null,
                    parsedJson: null,
                    error: data?.error?.message || data?.message || `HTTP ${response.status}`,
                    tokensUsed: 0,
                    latencyMs: Date.now() - start,
                };
            }
            const content = this.extractContent(data);
            const parsedJson = payload.responseFormat === 'json' ? safeJsonParse(content) : null;
            const tokensUsed = Number(data?.usage?.total_tokens ?? 0);
            return {
                success: true,
                content,
                parsedJson,
                error: null,
                tokensUsed,
                latencyMs: Date.now() - start,
            };
        } catch (error: any) {
            const message = error?.name === 'AbortError' ? 'LLM request timed out' : (error?.message || String(error));
            return {
                success: false,
                content: null,
                parsedJson: null,
                error: message,
                tokensUsed: 0,
                latencyMs: Date.now() - start,
            };
        } finally {
            clearTimeout(timeout);
        }
    }

    private buildRequest(baseUrl: string, payload: LLMRequest) {
        const responseFormat = payload.responseFormat === 'json'
            ? { type: 'json_object' }
            : undefined;
        return {
            url: `${baseUrl}/chat/completions`,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${payload.apiKey}`,
            },
            body: {
                model: payload.model,
                messages: [
                    { role: 'system', content: payload.systemPrompt },
                    { role: 'user', content: payload.userPrompt },
                ],
                max_tokens: payload.maxTokens,
                temperature: payload.temperature,
                ...(responseFormat ? { response_format: responseFormat } : {}),
            },
        };
    }

    private extractContent(data: any): string | null {
        return data?.choices?.[0]?.message?.content ?? null;
    }
}
