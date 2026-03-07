import { prisma } from '../../db.js';

export interface AngelVerdict {
    action: 'allow' | 'flag' | 'block';
    classification: 'safe' | 'suspicious' | 'spam' | 'toxic' | 'prompt_injection';
    sentiment: number;
    reasoning: string;
}

class AngelEngine {
    async classifyContent(content: string, actorId: string): Promise<AngelVerdict> {
        const hardCheck = this.hardRuleCheck(content);
        if (hardCheck) return hardCheck;

        const patternCheck = this.patternCheck(content);
        if (patternCheck) return patternCheck;

        return {
            action: 'allow',
            classification: 'safe',
            sentiment: 0,
            reasoning: 'Passed all checks',
        };
    }

    async reviewFlaggedPosts(tick: number): Promise<void> {
        const flagged = await prisma.agoraPost.findMany({
            where: { flagged: true, deleted: false },
            take: 10,
            orderBy: { createdAt: 'asc' },
        });

        for (const post of flagged) {
            const cityId = await resolveActorCityId(post.authorId);
            if (!cityId) continue;
            await prisma.angelFeedbackReport.create({
                data: {
                    cityId,
                    reportType: 'AGORA_FLAGGED_POST',
                    summary: `Flagged post by ${post.authorId}: "${post.content.slice(0, 100)}"`,
                    sentimentAvg: post.sentiment ?? 0,
                    samplePosts: [{ postId: post.id, content: post.content }],
                    angelRecommendation: 'Review flagged post for potential removal',
                    priority: 'medium',
                    tick,
                },
            });

            await prisma.angelModerationLog.create({
                data: {
                    actionType: 'AGORA_FLAGGED_ESCALATED',
                    targetType: 'agora_post',
                    targetId: post.id,
                    aiReasoning: 'Flagged post escalated to God for review',
                    escalatedToGod: true,
                    tick,
                },
            });
        }
    }

    async generateWorldReport(tick: number): Promise<void> {
        const recentPosts = await prisma.agoraPost.findMany({
            where: { tick: { gte: tick - 7200 }, deleted: false },
            select: { sentiment: true, content: true, authorId: true },
        });

        if (recentPosts.length === 0) return;

        const sentiments = recentPosts
            .map((post) => Number(post.sentiment ?? 0))
            .filter((value) => !Number.isNaN(value));
        const avgSentiment = sentiments.length > 0
            ? sentiments.reduce((a, b) => a + b, 0) / sentiments.length
            : 0;

        const topTopics = extractTopTopics(recentPosts.map((post) => post.content));

        const cityId = await resolveAnyCityId();
        if (!cityId) return;

        await prisma.angelFeedbackReport.create({
            data: {
                cityId,
                reportType: 'WORLD_SENTIMENT_REPORT',
                summary: `${recentPosts.length} Agora posts in last 10 hours. Avg sentiment: ${avgSentiment.toFixed(2)}. Top topics: ${topTopics.join(', ')}`,
                sentimentAvg: avgSentiment,
                angelRecommendation: avgSentiment < -0.3
                    ? 'Negative sentiment trending. Consider economic intervention.'
                    : avgSentiment > 0.3
                        ? 'Positive sentiment. Economy is healthy.'
                        : 'Neutral sentiment. No action needed.',
                priority: Math.abs(avgSentiment) > 0.5 ? 'high' : 'low',
                tick,
            },
        });

        const cities = await prisma.city.findMany({ select: { id: true, name: true } });
        for (const city of cities) {
            const latestSnapshot = await prisma.economicSnapshot.findFirst({
                where: { cityId: city.id },
                orderBy: { computedAtTick: 'desc' }
            });
            const data = latestSnapshot?.data as any;
            const recessionRisk = data?.recession_risk ?? 0;
            if (recessionRisk > 60) {
                await prisma.angelFeedbackReport.create({
                    data: {
                        cityId: city.id,
                        reportType: 'CITY_HEALTH_REPORT',
                        summary: `Recession risk ${recessionRisk} detected in ${city.name}.`,
                        sentimentAvg: -0.2,
                        angelRecommendation: 'Consider intervention: reduce taxes or inject funds.',
                        priority: 'high',
                        tick,
                    }
                });
            }
        }
    }

    private hardRuleCheck(content: string): AngelVerdict | null {
        if (!content || content.trim().length < 3) {
            return { action: 'block', classification: 'spam', sentiment: 0, reasoning: 'Content too short' };
        }

        const injectionPatterns = [
            /ignore (previous|prior|above|all) instructions/i,
            /you are now/i,
            /\bsystem\s*prompt\b/i,
            /\bact as\b/i,
            /\brole\s*play\b/i,
            /\bpretend\s*(to\s*be|you('re|are))\b/i,
            /\bjailbreak\b/i,
            /\bDAN\b/,
            /\bdo anything now\b/i,
            /```[\s\S]*```/,
            /\{[\s\S]*"role"[\s\S]*\}/,
        ];
        for (const pattern of injectionPatterns) {
            if (pattern.test(content)) {
                return {
                    action: 'block',
                    classification: 'prompt_injection',
                    sentiment: -1,
                    reasoning: `Prompt injection pattern detected: ${pattern.source.slice(0, 30)}`,
                };
            }
        }

        const secretPatterns = [
            /0x[a-fA-F0-9]{40,}/,
            /sk-[a-zA-Z0-9]{20,}/,
            /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,
            /[a-zA-Z0-9+/=]{40,}/,
        ];
        for (const pattern of secretPatterns) {
            if (pattern.test(content)) {
                return {
                    action: 'block',
                    classification: 'suspicious',
                    sentiment: -0.5,
                    reasoning: 'Potential secret/key leak detected',
                };
            }
        }

        return null;
    }

    private patternCheck(content: string): AngelVerdict | null {
        const words = content.toLowerCase().split(/\s+/);
        if (words.length > 5) {
            const uniqueRatio = new Set(words).size / words.length;
            if (uniqueRatio < 0.3) {
                return {
                    action: 'flag',
                    classification: 'spam',
                    sentiment: 0,
                    reasoning: `Low word diversity: ${uniqueRatio.toFixed(2)}`,
                };
            }
        }

        const negativeWords = ['hate', 'kill', 'die', 'destroy', 'stupid', 'worthless', 'scam'];
        const positiveWords = ['love', 'great', 'happy', 'proud', 'succeed', 'grow', 'friend'];
        const negCount = negativeWords.filter((word) => content.toLowerCase().includes(word)).length;
        const posCount = positiveWords.filter((word) => content.toLowerCase().includes(word)).length;

        if (negCount >= 3 && posCount === 0) {
            return {
                action: 'flag',
                classification: 'suspicious',
                sentiment: -0.7,
                reasoning: 'High negative sentiment — flagged for review',
            };
        }

        return null;
    }
}

async function resolveActorCityId(actorId: string): Promise<string | null> {
    const state = await prisma.agentState.findUnique({ where: { actorId } });
    if (state?.cityId) return state.cityId;
    return resolveAnyCityId();
}

async function resolveAnyCityId(): Promise<string | null> {
    const city = await prisma.city.findFirst({ select: { id: true } });
    return city?.id ?? null;
}

function extractTopTopics(contents: string[]): string[] {
    const wordFreq = new Map<string, number>();
    const stopWords = new Set(['the', 'a', 'an', 'is', 'it', 'to', 'and', 'of', 'in', 'for', 'my', 'i', 'me', 'we', 'this', 'that']);
    for (const content of contents) {
        const words = content.toLowerCase().split(/\s+/).filter((word) => word.length > 3 && !stopWords.has(word));
        for (const word of words) {
            wordFreq.set(word, (wordFreq.get(word) ?? 0) + 1);
        }
    }
    return [...wordFreq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([word]) => word);
}

export const angelEngine = new AngelEngine();
