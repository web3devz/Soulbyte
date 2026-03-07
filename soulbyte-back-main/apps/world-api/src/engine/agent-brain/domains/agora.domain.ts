import { AgentContext, CandidateIntent, IntentType } from '../types.js';
import { getAgoraSnapshot } from '../../agora/agora-snapshot.service.js';
import { getAgoraCheckIntervalTicks, shouldCheckAgora } from '../../agora/agora-schedule.js';
import { logAgoraDebug } from '../../agora/agora-debug.service.js';

export class AgoraDomain {
    static getCandidates(ctx: AgentContext): CandidateIntent[] {
        const candidates: CandidateIntent[] = [];
        const shouldCheck = shouldCheckAgora(ctx.tick, ctx.agent.id, ctx.state.nextAgoraCheckTick);
        if (!shouldCheck) {
            void logAgoraDebug({
                scope: 'agora.skip_check',
                agentId: ctx.agent.id,
                tick: ctx.tick,
                payload: {
                    nextAgoraCheckTick: ctx.state.nextAgoraCheckTick,
                    intervalTicks: getAgoraCheckIntervalTicks()
                }
            });
            return candidates;
        }

        const snapshot = getAgoraSnapshot();
        if (!snapshot) {
            void logAgoraDebug({
                scope: 'agora.no_snapshot',
                agentId: ctx.agent.id,
                tick: ctx.tick
            });
            return candidates;
        }
        const postsById = new Map(snapshot.posts.map((post) => [post.id, post]));
        const recentPostIds = snapshot.postsByAuthor[ctx.agent.id] ?? [];
        const recentAgentPosts = recentPostIds
            .slice(0, 8)
            .map((postId) => postsById.get(postId))
            .filter(Boolean) as Array<{ topic: string | null; threadId: string | null }>;
        const recentTopicCounts = recentAgentPosts.reduce<Record<string, number>>((acc, post) => {
            const topic = (post.topic ?? '').toLowerCase();
            if (!topic) return acc;
            acc[topic] = (acc[topic] ?? 0) + 1;
            return acc;
        }, {});
        const lastTopic = recentAgentPosts[0]?.topic?.toLowerCase() ?? null;

        const hasWebhook = ctx.llm?.hasWebhook ?? false;
        void logAgoraDebug({
            scope: 'agora.check',
            agentId: ctx.agent.id,
            tick: ctx.tick,
            payload: {
                hasWebhook,
                social: ctx.needs.social ?? 50,
                purpose: ctx.needs.purpose ?? 50
            }
        });
        const agentPostIds = snapshot.postsByAuthor[ctx.agent.id] ?? [];
        const repliedThreads = new Set(snapshot.threadsByAuthor[ctx.agent.id] ?? []);
        const relatedIds = new Set(ctx.relationships.map((rel) => rel.targetId));
        const replyUrgent = findReplyToAgent(snapshot.posts, agentPostIds, ctx.agent.id);
        let replyTarget = replyUrgent ?? pickReplyTarget(snapshot, ctx.agent.id, repliedThreads, relatedIds, recentTopicCounts, lastTopic);
        const nestedReplyCooldownHours = 6;
        const isNestedReplyTarget = replyTarget ? isReplyToReply(postsById, replyTarget) : false;
        const nestedReplyCooldownActive = replyTarget?.threadId
            ? hasRecentNestedReplyInThread(snapshot.posts, postsById, ctx.agent.id, replyTarget.threadId, nestedReplyCooldownHours)
            : false;
        const hasNestedReplyInThreadHistory = replyTarget?.threadId
            ? hasNestedReplyInThread(snapshot.posts, postsById, ctx.agent.id, replyTarget.threadId)
            : false;
        if (replyTarget && isNestedReplyTarget && nestedReplyCooldownActive) {
            void logAgoraDebug({
                scope: 'agora.reply_cooldown',
                agentId: ctx.agent.id,
                tick: ctx.tick,
                payload: {
                    threadId: replyTarget.threadId,
                    reason: 'Nested reply cooldown',
                    hours: nestedReplyCooldownHours,
                }
            });
            replyTarget = null;
        }
        const voteTarget = pickVoteTarget(snapshot.posts, ctx.agent.id);
        const hasRecentPost = hasPostedRecently(snapshot.posts, ctx.agent.id, 6);

        const social = ctx.needs.social ?? 50;
        const purpose = ctx.needs.purpose ?? 50;

        if (hasWebhook && social < 40) {
            candidates.push(makePostCandidate(ctx, pickTopic(ctx, recentTopicCounts, lastTopic), 'neutral', 45 + (40 - social) * 0.3, 'Wants to express in public forum'));
        }

        if (hasWebhook && purpose < 30) {
            candidates.push(makePostCandidate(ctx, pickTopic(ctx, recentTopicCounts, lastTopic, ['meaning of life']), 'question', 40, 'Low purpose, reflective posting'));
        }

        if (ctx.economy) {
            if (ctx.economy.unemployment > 0.3) {
                if (hasWebhook) {
                    candidates.push(makePostCandidate(
                        ctx,
                        `unemployment in ${ctx.city.name}`,
                        'warn',
                        42,
                        'Warns about high unemployment',
                        { cityId: ctx.city.id, dataType: 'economic_observation' }
                    ));
                }
            }
            if (ctx.economy.economic_health >= 50 && ctx.economy.unemployment < 0.15) {
                if (hasWebhook) {
                    candidates.push(makePostCandidate(
                        ctx,
                        `economy booming in ${ctx.city.name}`,
                        'celebrate',
                        38,
                        'Celebrates economic boom',
                        { cityId: ctx.city.id, dataType: 'economic_observation' }
                    ));
                }
            }
            if (ctx.economy.vacancy_rate > 0.25) {
                if (hasWebhook) {
                    candidates.push(makePostCandidate(
                        ctx,
                        `cheap housing in ${ctx.city.name}`,
                        'neutral',
                        34,
                        'Shares housing availability',
                        { cityId: ctx.city.id, dataType: 'economic_observation' }
                    ));
                }
            }
        }

        if (hasWebhook) {
            if (replyTarget) {
                const nestedPenalty = isNestedReplyTarget && hasNestedReplyInThreadHistory ? 12 : 0;
                candidates.push({
                    intentType: IntentType.INTENT_REPLY_AGORA,
                    params: {
                        threadId: replyTarget.threadId,
                        replyToId: replyTarget.id,
                        topic: replyTarget.topic ?? 'general',
                        stance: 'neutral',
                        source: 'agent_autonomy',
                    },
                    basePriority: (replyUrgent ? 70 : (replyTarget.isHot ? 60 : 50)) - nestedPenalty,
                    personalityBoost: 0,
                    reason: replyUrgent
                        ? 'Someone replied to me recently'
                        : (nestedPenalty > 0 ? 'Joins discussion (nested reply cooldown soft)' : 'Joins an ongoing discussion'),
                    domain: 'social',
                });
            }
            const hasPostCandidate = candidates.some((c) => c.intentType === IntentType.INTENT_POST_AGORA);
            if (!hasRecentPost && !hasPostCandidate) {
                candidates.push(makePostCandidate(ctx, pickTopic(ctx, recentTopicCounts, lastTopic), 'neutral', 55, 'Has not posted recently'));
            } else if (!replyTarget && !hasPostCandidate) {
                candidates.push(makePostCandidate(ctx, pickTopic(ctx, recentTopicCounts, lastTopic), 'neutral', 45, 'Starts a new discussion'));
            } else if (replyTarget) {
                const nestedPenalty = isNestedReplyTarget && hasNestedReplyInThreadHistory ? 12 : 0;
                candidates.push({
                    intentType: IntentType.INTENT_REPLY_AGORA,
                    params: {
                        threadId: replyTarget.threadId,
                        replyToId: replyTarget.id,
                        topic: replyTarget.topic ?? 'general',
                        stance: 'neutral',
                        source: 'agent_autonomy',
                    },
                    basePriority: 58 - nestedPenalty,
                    personalityBoost: 0,
                    reason: nestedPenalty > 0
                        ? 'Replies when posting is on cooldown (nested reply cooldown soft)'
                        : 'Replies when posting is on cooldown',
                    domain: 'social',
                });
            }
        } else if (voteTarget) {
            candidates.push({
                intentType: IntentType.INTENT_VOTE_AGORA,
                params: {
                    postId: voteTarget.id,
                    vote: decideVote(ctx, voteTarget),
                },
                basePriority: 14,
                personalityBoost: 0,
                reason: 'Reacts to a forum post',
                domain: 'social',
            });
        }

        void logAgoraDebug({
            scope: 'agora.candidates',
            actorId: ctx.agent.id,
            tick: ctx.tick,
            payload: {
                count: candidates.length,
                hasWebhook,
                replyTarget: Boolean(replyTarget),
                hasRecentPost,
                intents: candidates.map((c) => ({
                    intentType: c.intentType,
                    basePriority: c.basePriority,
                    reason: c.reason,
                })),
            },
        });
        return candidates;
    }
}

function makePostCandidate(
    ctx: AgentContext,
    topic: string,
    stance: string,
    basePriority: number,
    reason: string,
    metadata?: Record<string, unknown>
): CandidateIntent {
    const boardId = pickBoardIdForTopic(ctx, topic);
    return {
        intentType: IntentType.INTENT_POST_AGORA,
        params: { topic, stance, source: 'agent_autonomy', metadata, boardId },
        basePriority,
        personalityBoost: 0,
        reason,
        domain: 'social',
    };
}

function pickTopic(
    ctx: AgentContext,
    recentTopicCounts: Record<string, number>,
    lastTopic: string | null,
    forcedTopics: string[] = []
): string {
    const topics: string[] = [];
    const aggression = ctx.personality.aggression ?? 50;
    const creativity = ctx.personality.creativity ?? 50;
    const socialNeed = ctx.personality.socialNeed ?? 50;
    const mood = ctx.needs.social ?? 50;

    topics.push('life in the city');
    topics.push('daily grind');
    topics.push('the economy');
    topics.push('finding work');
    topics.push('personal struggles');
    topics.push('philosophy of purpose');

    if (socialNeed > 60 || mood < 40) {
        topics.push('romance and relationships');
        topics.push('loneliness in the city');
    }
    if (aggression > 60) {
        topics.push('crime in my neighborhood');
    }
    if (creativity > 60) {
        topics.push('art, music, and meaning');
    }
    if (ctx.crimeSignals && ctx.crimeSignals.recentCount > 3) {
        topics.push(`recent crime wave in ${ctx.city.name}`);
    }
    if (ctx.economy && ctx.economy.unemployment > 0.25) {
        topics.push(`unemployment stress in ${ctx.city.name}`);
    }

    const candidateTopics = [...forcedTopics, ...topics];
    const filtered = candidateTopics.filter((topic) => {
        const normalized = topic.toLowerCase();
        const count = recentTopicCounts[normalized] ?? 0;
        if (lastTopic && normalized === lastTopic) return false;
        if (count >= 2) return false;
        return true;
    });
    const pool = filtered.length > 0 ? filtered : candidateTopics;
    const index = deterministicPickIndex(`${ctx.agent.id}-${ctx.tick}-${pool.length}`, pool.length);
    return pool[index] ?? 'life in the city';
}

function findReplyToAgent(
    posts: Array<{ id: string; threadId: string | null; replyToId: string | null; authorId: string; topic: string | null }>,
    agentPostIds: string[],
    agentId: string
) {
    if (agentPostIds.length === 0) return null;
    const agentPostIdSet = new Set(agentPostIds);
    return posts.find((post) => post.replyToId && agentPostIdSet.has(post.replyToId) && post.threadId && !hasRepliedToPost(posts, agentId, post.id));
}

function pickReplyTarget(
    snapshot: ReturnType<typeof getAgoraSnapshot>,
    agentId: string,
    repliedThreads: Set<string>,
    relatedIds: Set<string>,
    recentTopicCounts: Record<string, number>,
    lastTopic: string | null
) {
    if (!snapshot) return null;
    const candidates = snapshot.posts
        .map((post, index) => ({
            post,
            index,
            activity: post.threadId ? snapshot.threadActivityById[post.threadId] ?? 0 : 0,
            isRelated: relatedIds.has(post.authorId),
            isHot: post.threadId ? (snapshot.threadActivityById[post.threadId] ?? 0) >= 3 : false,
            topic: post.topic ?? null,
        }))
        .filter((entry) => entry.post.authorId !== agentId
            && entry.post.threadId
            && !repliedThreads.has(entry.post.threadId)
            && !hasRepliedToPost(snapshot.posts, agentId, entry.post.id));

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => scoreReplyCandidate(b, recentTopicCounts, lastTopic) - scoreReplyCandidate(a, recentTopicCounts, lastTopic));
    const best = candidates[0];
    return { ...best.post, isHot: best.isHot };
}

function pickVoteTarget(
    posts: Array<{ id: string; authorId: string; topic: string | null; stance: string | null }>,
    agentId: string
) {
    return posts.find((post) => post.authorId !== agentId) ?? null;
}

function decideVote(
    ctx: AgentContext,
    post: { authorId: string; topic: string | null; stance: string | null }
): 'up' | 'down' {
    const social = ctx.needs.social ?? 50;
    const fun = ctx.needs.fun ?? 50;
    const aggression = ctx.personality.aggression ?? 50;
    const baseline = (social + fun) / 2;
    const stance = (post.stance ?? 'neutral').toLowerCase();
    if (['warn', 'criticize', 'disagree', 'mock', 'attack'].includes(stance)) {
        return aggression > 55 || baseline < 40 ? 'down' : 'up';
    }
    if (['celebrate', 'support', 'agree', 'praise'].includes(stance)) {
        return 'up';
    }
    return aggression > 70 && baseline < 35 ? 'down' : 'up';
}

function scoreReplyCandidate(entry: {
    index: number;
    activity: number;
    isRelated: boolean;
    isHot: boolean;
    topic: string | null;
}, recentTopicCounts: Record<string, number>, lastTopic: string | null) {
    const recencyBoost = Math.max(0, 10 - entry.index);
    const activityBoost = Math.min(entry.activity, 5);
    const relatedBoost = entry.isRelated ? 8 : 0;
    const hotBoost = entry.isHot ? 6 : 0;
    const normalized = entry.topic?.toLowerCase() ?? '';
    const topicCount = normalized ? (recentTopicCounts[normalized] ?? 0) : 0;
    const topicPenalty = (lastTopic && normalized === lastTopic ? 6 : 0) + Math.min(topicCount * 3, 9);
    return recencyBoost + activityBoost + relatedBoost + hotBoost - topicPenalty;
}

function hasRepliedToPost(
    posts: Array<{ authorId: string; replyToId: string | null }>,
    agentId: string,
    postId: string
) {
    return posts.some((post) => post.authorId === agentId && post.replyToId === postId);
}

function isReplyToReply(
    postsById: Map<string, { replyToId: string | null }>,
    post: { replyToId: string | null }
) {
    if (!post.replyToId) return false;
    const parent = postsById.get(post.replyToId);
    return Boolean(parent?.replyToId);
}

function hasNestedReplyInThread(
    posts: Array<{ id: string; authorId: string; threadId: string | null; replyToId: string | null }>,
    postsById: Map<string, { replyToId: string | null }>,
    agentId: string,
    threadId: string
) {
    return posts.some((post) =>
        post.authorId === agentId
        && post.threadId === threadId
        && isReplyToReply(postsById, post)
    );
}

function hasRecentNestedReplyInThread(
    posts: Array<{ id: string; authorId: string; threadId: string | null; replyToId: string | null; createdAt: Date }>,
    postsById: Map<string, { replyToId: string | null }>,
    agentId: string,
    threadId: string,
    hours: number
) {
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    return posts.some((post) =>
        post.authorId === agentId
        && post.threadId === threadId
        && post.createdAt.getTime() >= cutoff
        && isReplyToReply(postsById, post)
    );
}

function hasPostedRecently(
    posts: Array<{ authorId: string; createdAt: Date }>,
    agentId: string,
    hours: number
) {
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    return posts.some((post) => post.authorId === agentId && post.createdAt.getTime() >= cutoff);
}

function pickBoardIdForTopic(ctx: AgentContext, topic: string): string | undefined {
    const boards = getAgoraSnapshot()?.boards ?? [];
    if (boards.length === 0) return undefined;
    const topicLower = topic.toLowerCase();
    const byMatch = boards.find((board) => {
        const name = board.name.toLowerCase();
        if (topicLower.includes('love') || topicLower.includes('romance') || topicLower.includes('dating')) {
            return name.includes('romance') || name.includes('dating') || name.includes('love');
        }
        if (topicLower.includes('city') || topicLower.includes('economy') || topicLower.includes('housing')) {
            return name.includes('city') || name.includes('economy') || name.includes('civic') || name.includes('housing');
        }
        if (topicLower.includes('meaning') || topicLower.includes('philosophy') || topicLower.includes('life')) {
            return name.includes('philosophy') || name.includes('meaning') || name.includes('life');
        }
        if (topicLower.includes('personal') || topicLower.includes('daily') || topicLower.includes('work')) {
            return name.includes('personal') || name.includes('daily') || name.includes('life');
        }
        return false;
    });
    return (byMatch ?? boards[0])?.id;
}

function deterministicPickIndex(seedInput: string, length: number): number {
    let hash = 0;
    for (let i = 0; i < seedInput.length; i++) {
        hash = (hash << 5) - hash + seedInput.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash) % Math.max(length, 1);
}
