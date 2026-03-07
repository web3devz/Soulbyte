import { prisma } from '../../db.js';

export interface AgoraSnapshot {
    tick: number;
    boards: Array<{
        id: string;
        name: string;
    }>;
    threads: Array<{
        id: string;
        boardId: string;
        authorId: string;
        title: string;
        lastPostAt: Date;
        createdAt: Date;
    }>;
    posts: Array<{
        id: string;
        threadId: string | null;
        authorId: string;
        content: string;
        createdAt: Date;
        topic: string | null;
        stance: string | null;
        replyToId: string | null;
        upvotes: number;
        downvotes: number;
    }>;
    postsByAuthor: Record<string, string[]>;
    threadsByAuthor: Record<string, string[]>;
    threadActivityById: Record<string, number>;
}

const SNAPSHOT_CACHE: { data: AgoraSnapshot | null } = { data: null };
const THREAD_LIMIT = 50;
const POST_LIMIT = 200;

export async function refreshAgoraSnapshot(tick: number): Promise<AgoraSnapshot> {
    if (SNAPSHOT_CACHE.data?.tick === tick) {
        return SNAPSHOT_CACHE.data;
    }

    const [boards, threads, posts] = await Promise.all([
        prisma.agoraBoard.findMany({
            orderBy: { sortOrder: 'asc' },
            select: { id: true, name: true },
        }),
        prisma.agoraThread.findMany({
            orderBy: { lastPostAt: 'desc' },
            take: THREAD_LIMIT,
            select: {
                id: true,
                boardId: true,
                authorId: true,
                title: true,
                lastPostAt: true,
                createdAt: true,
            },
        }),
        prisma.agoraPost.findMany({
            where: { deleted: false },
            orderBy: { createdAt: 'desc' },
            take: POST_LIMIT,
            select: {
                id: true,
                threadId: true,
                authorId: true,
                content: true,
                createdAt: true,
                topic: true,
                stance: true,
                replyToId: true,
                upvotes: true,
                downvotes: true,
            },
        }),
    ]);

    const postsByAuthor: Record<string, string[]> = {};
    const threadsByAuthor: Record<string, string[]> = {};
    const threadActivityById: Record<string, number> = {};
    for (const post of posts) {
        if (!postsByAuthor[post.authorId]) postsByAuthor[post.authorId] = [];
        postsByAuthor[post.authorId].push(post.id);
        if (post.threadId) {
            if (!threadsByAuthor[post.authorId]) threadsByAuthor[post.authorId] = [];
            threadsByAuthor[post.authorId].push(post.threadId);
            threadActivityById[post.threadId] = (threadActivityById[post.threadId] ?? 0) + 1;
        }
    }

    SNAPSHOT_CACHE.data = {
        tick,
        boards,
        threads,
        posts,
        postsByAuthor,
        threadsByAuthor,
        threadActivityById,
    };

    return SNAPSHOT_CACHE.data;
}

export function getAgoraSnapshot(): AgoraSnapshot | null {
    return SNAPSHOT_CACHE.data;
}
