import crypto from 'crypto';
import { prisma } from '../../db.js';
import { EventOutcome, EventType } from '../../types/event.types.js';
import { IntentStatus } from '../../types/intent.types.js';
import { IntentHandler, StateUpdate } from '../engine.types.js';
import { fallbackTitleFromContent, generateAgoraContent, generateAgoraTitle } from '../persona/agora.content.js';
import { angelEngine } from '../angel/angel.engine.js';
import { computeNextAgoraCheckTick } from '../agora/agora-schedule.js';
import { extractRomanceSignal } from '../persona/agora.rules.js';
import { logAgoraDebug } from '../agora/agora-debug.service.js';

const ALLOWED_POST_SOURCES = new Set(['agent_autonomy', 'agent_brain', 'persona_engine', 'god', 'angel']);
const MIN_POST_LENGTH = 200;
const MIN_REPLY_LENGTH = 60;

export const handlePostAgora: IntentHandler = async (intent, actor, _agentState, _wallet, tick) => {
    const params = intent.params as {
        content?: string;
        topic?: string;
        stance?: string;
        boardId?: string;
        title?: string;
        source?: string;
    };
    void logAgoraDebug({
        scope: 'agora.intent.post.start',
        actorId: actor.id,
        tick,
        payload: { params }
    });

    if (!isAllowedSource(params?.source)) {
        return fail(actor.id, EventType.EVENT_AGORA_POST_REJECTED, 'Source not allowed');
    }

    const boardId = params.boardId ?? (await resolveDefaultBoardId());
    if (!boardId) return fail(actor.id, EventType.EVENT_AGORA_POST_REJECTED, 'No board available');

    const topic = params.topic ?? 'general';
    const stance = params.stance ?? 'neutral';
    let title = sanitizeTitle(params.title ?? '');
    let content = params.content;
    let llmContext: Record<string, unknown> | null = null;

    const recentPost = await prisma.agoraPost.findFirst({
        where: {
            authorId: actor.id,
            createdAt: { gte: new Date(Date.now() - 6 * 60 * 60 * 1000) },
            deleted: false,
        },
        select: { id: true },
    });
    if (recentPost) {
        const threadId = params.threadId ?? null;
        if (threadId) {
            const recentReply = await prisma.agoraPost.findFirst({
                where: {
                    authorId: actor.id,
                    threadId,
                    createdAt: { gte: new Date(Date.now() - 6 * 60 * 60 * 1000) },
                    deleted: false,
                },
                select: { id: true },
            });
            if (!recentReply) {
                return fail(actor.id, EventType.EVENT_AGORA_POST_REJECTED, 'Posted too recently');
            }
        } else {
            return fail(actor.id, EventType.EVENT_AGORA_POST_REJECTED, 'Posted too recently');
        }
    }

    if (!content) {
        const generated = await generateAgoraContent(actor.id, topic, stance, undefined, 'post');
        content = generated.content;
        llmContext = generated.llmContext;
    }
    if (!title || isGenericTitle(title, topic)) {
        title = await generateAgoraTitle({
            agentId: actor.id,
            topic,
            stance,
            content,
        });
    }
    title = sanitizeTitle(title);
    if (!title || isGenericTitle(title, topic)) {
        title = fallbackTitleFromContent(content, topic, null);
    }
    if (!content) return fail(actor.id, EventType.EVENT_AGORA_POST_REJECTED, 'Missing content');
    if (content.length < MIN_POST_LENGTH) {
        return fail(actor.id, EventType.EVENT_AGORA_POST_REJECTED, 'Content too short', {
            contentLength: content.length,
            minLength: MIN_POST_LENGTH
        });
    }

    const board = await prisma.agoraBoard.findUnique({ where: { id: boardId } });
    const verdict = await angelEngine.classifyContent(content, actor.id);
    if (verdict.action === 'block') {
        await prisma.angelModerationLog.create({
            data: {
                actionType: 'AGORA_POST_BLOCKED',
                targetType: 'agora_post',
                targetId: null,
                aiReasoning: verdict.reasoning,
                classification: verdict.classification,
                sentimentScore: verdict.sentiment,
                escalatedToGod: false,
                tick,
            },
        });
        return fail(actor.id, EventType.EVENT_AGORA_POST_REJECTED, verdict.reasoning);
    }

    const threadId = crypto.randomUUID();
    const postId = crypto.randomUUID();
    const flagged = verdict.action === 'flag';

    const nextAgoraCheckTick = computeNextAgoraCheckTick(tick, actor.id);
    const stateUpdates: StateUpdate[] = [
        {
            table: 'agoraThread',
            operation: 'create',
            data: {
                id: threadId,
                boardId,
                authorId: actor.id,
                title,
                createdAt: new Date(),
                lastPostAt: new Date(),
                llmContext,
            },
        },
        {
            table: 'agoraPost',
            operation: 'create',
            data: {
                id: postId,
                threadId,
                authorId: actor.id,
                content,
                source: params.source ?? 'agent_autonomy',
                topic,
                stance,
                replyToId: null,
                flagged,
                sentiment: verdict.sentiment,
                tick,
                createdAt: new Date(),
                llmContext,
            },
        },
        {
            table: 'agentState',
            operation: 'update',
            where: { actorId: actor.id },
            data: { nextAgoraCheckTick, fun: { increment: 2 }, social: { increment: 4 } },
        },
        {
            table: 'actor',
            operation: 'update',
            where: { id: actor.id },
            data: { reputation: { increment: 2 } },
        },
        {
            table: 'agentState',
            operation: 'update',
            where: { actorId: actor.id },
            data: { reputationScore: { increment: 2 } },
        },
        {
            table: 'agentMemory',
            operation: 'create',
            data: {
                actorId: actor.id,
                tick,
                category: 'agora_post',
                key: postId,
                summary: `Posted in Agora: ${title}`,
            },
        },
    ];
    if (flagged) {
        stateUpdates.push({
            table: 'angelModerationLog',
            operation: 'create',
            data: {
                actionType: 'AGORA_POST_FLAGGED',
                targetType: 'agora_post',
                targetId: postId,
                aiReasoning: verdict.reasoning,
                classification: verdict.classification,
                sentimentScore: verdict.sentiment,
                escalatedToGod: false,
                tick,
            },
        });
    }

    void logAgoraDebug({
        scope: 'agora.intent.post.success',
        actorId: actor.id,
        tick,
        payload: { threadId, postId, boardId }
    });

    return {
        stateUpdates,
        events: [
            {
                actorId: actor.id,
                type: EventType.EVENT_AGORA_POSTED,
                targetIds: [],
                outcome: EventOutcome.SUCCESS,
                sideEffects: { postId, threadId, boardId, boardName: board?.name ?? null, topic, stance, threadTitle: title, isReply: false },
            },
        ],
        intentStatus: IntentStatus.EXECUTED,
    };
};

export const handleReplyAgora: IntentHandler = async (intent, actor, _agentState, _wallet, tick) => {
    const params = intent.params as {
        threadId?: string;
        replyToId?: string;
        content?: string;
        topic?: string;
        stance?: string;
        source?: string;
    };
    void logAgoraDebug({
        scope: 'agora.intent.reply.start',
        actorId: actor.id,
        tick,
        payload: { params }
    });

    if (!isAllowedSource(params?.source)) {
        return fail(actor.id, EventType.EVENT_AGORA_POST_REJECTED, 'Source not allowed');
    }
    if (!params.threadId) return fail(actor.id, EventType.EVENT_AGORA_POST_REJECTED, 'Missing threadId');

    const thread = await prisma.agoraThread.findUnique({ where: { id: params.threadId } });
    if (!thread) return fail(actor.id, EventType.EVENT_AGORA_POST_REJECTED, 'Thread not found');
    const board = await prisma.agoraBoard.findUnique({ where: { id: thread.boardId } });

    let parentPost: { id: string; authorId: string; content: string; topic: string | null; stance: string | null } | null = null;
    let parentAuthorName: string | null = null;
    if (params.replyToId) {
        parentPost = await prisma.agoraPost.findUnique({
            where: { id: params.replyToId },
            select: { id: true, authorId: true, content: true, topic: true, stance: true },
        });
        if (!parentPost) return fail(actor.id, EventType.EVENT_AGORA_POST_REJECTED, 'Parent post not found');
        const parentAuthor = await prisma.actor.findUnique({
            where: { id: parentPost.authorId },
            select: { name: true },
        });
        parentAuthorName = parentAuthor?.name ?? null;
    }

    const topic = params.topic ?? parentPost?.topic ?? 'general';
    const stance = params.stance ?? parentPost?.stance ?? 'neutral';
    let content = params.content;
    let llmContext: Record<string, unknown> | null = null;
    if (!content) {
        const rootPost = await prisma.agoraPost.findFirst({
            where: { threadId: params.threadId, deleted: false },
            orderBy: { createdAt: 'asc' },
            select: { content: true },
        });
        const threadContext = [
            `Thread: ${thread.title}.`,
            rootPost?.content ? `Original post: ${rootPost.content.slice(0, 240)}` : '',
            parentPost ? `Replying to: ${parentPost.content.slice(0, 200)}` : '',
        ].filter(Boolean).join(' ');
        const generated = await generateAgoraContent(actor.id, topic, stance, threadContext, 'reply');
        content = generated.content;
        llmContext = generated.llmContext;
    }
    if (!content) return fail(actor.id, EventType.EVENT_AGORA_POST_REJECTED, 'Missing content');
    if (content.length < MIN_REPLY_LENGTH) {
        return fail(actor.id, EventType.EVENT_AGORA_POST_REJECTED, 'Content too short', {
            contentLength: content.length,
            minLength: MIN_REPLY_LENGTH
        });
    }

    const verdict = await angelEngine.classifyContent(content, actor.id);
    if (verdict.action === 'block') {
        await prisma.angelModerationLog.create({
            data: {
                actionType: 'AGORA_POST_BLOCKED',
                targetType: 'agora_post',
                targetId: null,
                aiReasoning: verdict.reasoning,
                classification: verdict.classification,
                sentimentScore: verdict.sentiment,
                escalatedToGod: false,
                tick,
            },
        });
        return fail(actor.id, EventType.EVENT_AGORA_POST_REJECTED, verdict.reasoning);
    }

    const postId = crypto.randomUUID();
    const flagged = verdict.action === 'flag';
    const nextAgoraCheckTick = computeNextAgoraCheckTick(tick, actor.id);
    const replyUpdates: StateUpdate[] = [
        {
            table: 'agoraPost',
            operation: 'create',
            data: {
                id: postId,
                threadId: params.threadId,
                authorId: actor.id,
                content,
                source: params.source ?? 'agent_autonomy',
                topic,
                stance,
                replyToId: params.replyToId ?? null,
                flagged,
                sentiment: verdict.sentiment,
                tick,
                createdAt: new Date(),
                llmContext,
            },
        },
        {
            table: 'agoraThread',
            operation: 'update',
            where: { id: params.threadId },
            data: { lastPostAt: new Date() },
        },
        {
            table: 'agentState',
            operation: 'update',
            where: { actorId: actor.id },
            data: { nextAgoraCheckTick, fun: { increment: 3 }, social: { increment: 6 } },
        },
        {
            table: 'actor',
            operation: 'update',
            where: { id: actor.id },
            data: { reputation: { increment: 3 } },
        },
        {
            table: 'agentState',
            operation: 'update',
            where: { actorId: actor.id },
            data: { reputationScore: { increment: 3 } },
        },
        {
            table: 'agentMemory',
            operation: 'create',
            data: {
                actorId: actor.id,
                tick,
                category: 'agora_reply',
                key: postId,
                summary: `Replied in Agora: ${thread.title}`,
                contextActorId: parentPost?.authorId ?? null,
            },
        },
    ];
    if (parentPost) {
        const relationshipUpdates = await buildReplyRelationshipUpdates(actor.id, parentPost.authorId, topic, stance, tick);
        replyUpdates.push(...relationshipUpdates);
    }
    if (flagged) {
        replyUpdates.push({
            table: 'angelModerationLog',
            operation: 'create',
            data: {
                actionType: 'AGORA_POST_FLAGGED',
                targetType: 'agora_post',
                targetId: postId,
                aiReasoning: verdict.reasoning,
                classification: verdict.classification,
                sentimentScore: verdict.sentiment,
                escalatedToGod: false,
                tick,
            },
        });
    }

    void logAgoraDebug({
        scope: 'agora.intent.reply.success',
        actorId: actor.id,
        tick,
        payload: { threadId: params.threadId, replyToId: params.replyToId, postId }
    });

    return {
        stateUpdates: replyUpdates,
        events: [
            {
                actorId: actor.id,
                type: EventType.EVENT_AGORA_POSTED,
                targetIds: parentPost ? [parentPost.authorId] : [],
                outcome: EventOutcome.SUCCESS,
                sideEffects: {
                    postId,
                    threadId: params.threadId,
                    isReply: true,
                    boardId: thread.boardId,
                    boardName: board?.name ?? null,
                    threadTitle: thread.title,
                    replyToAuthorName: parentAuthorName,
                },
            },
        ],
        intentStatus: IntentStatus.EXECUTED,
    };
};

export const handleVoteAgora: IntentHandler = async (intent, actor, _agentState, _wallet, tick) => {
    const params = intent.params as { postId?: string; vote?: 'up' | 'down' };
    if (!params.postId || !params.vote) {
        return fail(actor.id, EventType.EVENT_AGORA_VOTED, 'Missing postId or vote');
    }
    const field = params.vote === 'up' ? 'upvotes' : 'downvotes';
    const nextAgoraCheckTick = computeNextAgoraCheckTick(tick, actor.id);
    return {
        stateUpdates: [
            {
                table: 'agoraPost',
                operation: 'update',
                where: { id: params.postId },
                data: { [field]: { increment: 1 } },
            },
            {
                table: 'agentState',
                operation: 'update',
                where: { actorId: actor.id },
                data: { nextAgoraCheckTick, fun: { increment: 1 } },
            },
            {
                table: 'actor',
                operation: 'update',
                where: { id: actor.id },
                data: { reputation: { increment: 0.5 } },
            },
            {
                table: 'agentState',
                operation: 'update',
                where: { actorId: actor.id },
                data: { reputationScore: { increment: 0.5 } },
            },
        ],
        events: [],
        intentStatus: IntentStatus.EXECUTED,
    };
};

export const handleReportAgora: IntentHandler = async (intent, actor, _agentState, _wallet, tick) => {
    const params = intent.params as { postId?: string; reason?: string };
    if (!params.postId || !params.reason) {
        return fail(actor.id, EventType.EVENT_AGORA_REPORTED, 'Missing postId or reason');
    }

    const post = await prisma.agoraPost.update({
        where: { id: params.postId },
        data: { reportCount: { increment: 1 } },
    });

    const stateUpdates: StateUpdate[] = [];
    if (post.reportCount >= 3 && !post.flagged) {
        stateUpdates.push({
            table: 'agoraPost',
            operation: 'update',
            where: { id: params.postId },
            data: { flagged: true },
        });
        stateUpdates.push({
            table: 'angelModerationLog',
            operation: 'create',
            data: {
                actionType: 'AGORA_POST_REPORTED',
                targetType: 'agora_post',
                targetId: params.postId,
                aiReasoning: `${post.reportCount} agents reported this post. Reason: ${params.reason}`,
                escalatedToGod: false,
                tick,
            },
        });
    }

    return {
        stateUpdates,
        events: [
            {
                actorId: actor.id,
                type: EventType.EVENT_AGORA_REPORTED,
                targetIds: [params.postId],
                outcome: EventOutcome.SUCCESS,
                sideEffects: { postId: params.postId, reason: params.reason },
            },
        ],
        intentStatus: IntentStatus.EXECUTED,
    };
};

// Helper
function fail(actorId: string, type: EventType, reason: string, extra?: Record<string, unknown>) {
    void logAgoraDebug({
        scope: 'agora.intent.fail',
        actorId,
        payload: { type, reason, ...(extra ?? {}) }
    });
    return {
        stateUpdates: [],
        events: [{
            actorId,
            type,
            targetIds: [],
            outcome: EventOutcome.BLOCKED,
            sideEffects: { reason, ...(extra ?? {}) }
        }],
        intentStatus: IntentStatus.BLOCKED
    };
}

async function resolveDefaultBoardId(): Promise<string | null> {
    const board = await prisma.agoraBoard.findFirst({ orderBy: { sortOrder: 'asc' } });
    return board?.id ?? null;
}

function sanitizeTitle(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return '';
    return trimmed.length > 120 ? trimmed.slice(0, 120) : trimmed;
}

function isGenericTitle(title: string, topic: string): boolean {
    if (!title) return true;
    const normalized = title.trim().toLowerCase();
    if (!normalized) return true;
    if (normalized === topic.toLowerCase()) return true;
    if (['general', 'discussion', 'update', 'thoughts', 'topic', 'post'].includes(normalized)) return true;
    if (/^(general|discussion|update|thoughts|topic)\b/.test(normalized)) return true;
    return false;
}

function isAllowedSource(source?: string): boolean {
    return source ? ALLOWED_POST_SOURCES.has(source) : false;
}

async function buildReplyRelationshipUpdates(
    actorId: string,
    targetId: string,
    topic: string,
    stance: string,
    tick: number
): Promise<StateUpdate[]> {
    if (actorId === targetId) return [];
    const direct = await prisma.relationship.findUnique({
        where: { actorAId_actorBId: { actorAId: actorId, actorBId: targetId } }
    });
    const reverse = direct
        ? null
        : await prisma.relationship.findUnique({
            where: { actorAId_actorBId: { actorAId: targetId, actorBId: actorId } }
        });
    const existing = direct ?? reverse;
    const { strengthDelta, trustDelta, romanceDelta } = getStanceRelationshipDelta(stance, topic);
    if (!existing) {
        return [{
            table: 'relationship',
            operation: 'create',
            data: {
                actorAId: actorId,
                actorBId: targetId,
                relationshipType: 'FRIENDSHIP',
                strength: clamp(50 + strengthDelta, 0, 100),
                trust: clamp(50 + trustDelta, 0, 100),
                romance: clamp(romanceDelta, 0, 100),
                betrayal: 0,
                formedAtTick: tick,
            },
        }];
    }
    return [{
        table: 'relationship',
        operation: 'update',
        where: { actorAId_actorBId: { actorAId: existing.actorAId, actorBId: existing.actorBId } },
        data: {
            strength: clamp(Number(existing.strength ?? 0) + strengthDelta, 0, 100),
            trust: clamp(Number(existing.trust ?? 0) + trustDelta, 0, 100),
            romance: clamp(Number(existing.romance ?? 0) + romanceDelta, 0, 100),
        },
    }];
}

function getStanceRelationshipDelta(stance: string, topic: string) {
    const normalized = stance.toLowerCase();
    let strengthDelta = 2;
    let trustDelta = 1;
    if (['warn', 'criticize', 'disagree', 'mock', 'attack'].includes(normalized)) {
        strengthDelta = -4;
        trustDelta = -3;
    } else if (['celebrate', 'support', 'agree', 'praise'].includes(normalized)) {
        strengthDelta = 4;
        trustDelta = 3;
    }
    const romanceDelta = extractRomanceSignal(topic, null) ? Math.max(1, Math.floor(strengthDelta / 2)) : 0;
    return { strengthDelta, trustDelta, romanceDelta };
}

function clamp(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, value));
}
