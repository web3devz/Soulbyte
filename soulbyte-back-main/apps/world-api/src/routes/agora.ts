import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../db.js';

export async function agoraRoutes(app: FastifyInstance) {
    const fetchThreads = async (boardId: string, page: string, limit: string) => {
        const pageNum = Math.max(1, parseInt(page, 10) || 1);
        const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);

        const threads = await prisma.agoraThread.findMany({
            where: { boardId },
            orderBy: { lastPostAt: 'desc' },
            skip: (pageNum - 1) * limitNum,
            take: limitNum,
            include: {
                author: { select: { id: true, name: true, reputation: true } },
                _count: { select: { posts: true } },
            },
        });

        const threadIds = threads.map((thread) => thread.id);
        const lastPosts = threadIds.length > 0
            ? await prisma.agoraPost.findMany({
                where: { threadId: { in: threadIds }, deleted: false },
                orderBy: { createdAt: 'desc' },
                distinct: ['threadId'],
                include: { author: { select: { name: true } } }
            })
            : [];
        const lastPostByThread = new Map(lastPosts.map((post) => [post.threadId, post]));

        return threads.map((thread) => {
            const lastPost = lastPostByThread.get(thread.id);
            return ({
                id: thread.id,
                boardId: thread.boardId,
                title: thread.title,
                authorId: thread.authorId,
                authorName: thread.author?.name ?? null,
                replyCount: Math.max((thread._count?.posts ?? 0) - 1, 0),
                viewCount: 0,
                lastPostAt: thread.lastPostAt,
                lastPostAuthorName: lastPost?.author?.name ?? null,
                pinned: thread.pinned,
                locked: thread.locked
            });
        });
    };

    app.get('/api/v1/agora/boards', async (_request: FastifyRequest, reply: FastifyReply) => {
        const boards = await prisma.agoraBoard.findMany({
            orderBy: { sortOrder: 'asc' },
            include: { _count: { select: { threads: true } } },
        });
        return reply.send(boards.map((board) => ({
            id: board.id,
            name: board.name,
            description: board.description ?? '',
            cityId: board.cityId,
            sortOrder: board.sortOrder,
        })));
    });

    app.get('/api/v1/agora/threads', async (request: FastifyRequest, reply: FastifyReply) => {
        const { boardId } = request.query as { boardId?: string };
        const { page = '1', limit = '20' } = request.query as { page?: string; limit?: string };
        if (!boardId) {
            return reply.code(400).send({ error: 'Missing boardId' });
        }
        const threads = await fetchThreads(boardId, page, limit);
        return reply.send({ threads });
    });

    app.get('/api/v1/agora/threads/:boardId', async (request: FastifyRequest, reply: FastifyReply) => {
        const { boardId } = request.params as { boardId: string };
        const { page = '1', limit = '20' } = request.query as { page?: string; limit?: string };
        const threads = await fetchThreads(boardId, page, limit);
        return reply.send(threads);
    });

    app.get('/api/v1/agora/thread/:threadId/posts', async (request: FastifyRequest, reply: FastifyReply) => {
        const { threadId } = request.params as { threadId: string };
        const { page = '1', limit = '50' } = request.query as { page?: string; limit?: string };
        const pageNum = Math.max(1, parseInt(page, 10) || 1);
        const limitNum = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);

        const posts = await prisma.agoraPost.findMany({
            where: { threadId, deleted: false },
            orderBy: { createdAt: 'asc' },
            skip: (pageNum - 1) * limitNum,
            take: limitNum,
            include: {
                author: { select: { id: true, name: true, reputation: true } },
            },
        });
        const replyToIds = Array.from(
            new Set(posts.map((post) => post.replyToId).filter((id): id is string => Boolean(id)))
        );
        const replyTargets = replyToIds.length > 0
            ? await prisma.agoraPost.findMany({
                where: { id: { in: replyToIds } },
                select: { id: true, author: { select: { id: true, name: true } } },
            })
            : [];
        const replyTargetById = new Map(replyTargets.map((post) => [post.id, post]));
        return reply.send(posts.map((post) => ({
            id: post.id,
            threadId: post.threadId,
            authorId: post.authorId,
            authorName: post.author?.name ?? null,
            content: post.content,
            source: post.source,
            topic: post.topic,
            stance: post.stance,
            replyToId: post.replyToId ?? null,
            replyToAuthorId: post.replyToId ? replyTargetById.get(post.replyToId)?.author?.id ?? null : null,
            replyToAuthorName: post.replyToId ? replyTargetById.get(post.replyToId)?.author?.name ?? null : null,
            upvotes: post.upvotes,
            downvotes: post.downvotes,
            deleted: post.deleted,
            deletedReason: post.deletedReason ?? null,
            flagged: post.flagged,
            sentiment: post.sentiment ? Number(post.sentiment) : null,
            createdAt: post.createdAt
        })));
    });

    app.get('/api/v1/agora/recent', async (request: FastifyRequest, reply: FastifyReply) => {
        const { limit = '20', offset = '0', sort = 'recent' } = request.query as { limit?: string; offset?: string; sort?: 'recent' | 'hot' };
        const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
        const offsetNum = Math.max(parseInt(offset, 10) || 0, 0);

        const total = await prisma.agoraPost.count({
            where: { deleted: false, replyToId: null },
        });

        if (sort === 'hot') {
            const hotWindow = Math.min(Math.max(limitNum * 10, 200), 500);
            const recentPosts = await prisma.agoraPost.findMany({
                where: { deleted: false, replyToId: null },
                orderBy: { createdAt: 'desc' },
                take: hotWindow,
                include: {
                    author: { select: { id: true, name: true } },
                    thread: { select: { id: true, title: true, boardId: true } },
                },
            });
            const threadIds = recentPosts
                .map((post) => post.threadId)
                .filter((id): id is string => Boolean(id));
            const messageCounts = threadIds.length > 0
                ? await prisma.agoraPost.groupBy({
                    by: ['threadId'],
                    where: {
                        deleted: false,
                        threadId: { in: threadIds },
                    },
                    _count: { _all: true },
                })
                : [];
            const messageCountByThreadId = new Map(
                messageCounts
                    .filter((row) => row.threadId)
                    .map((row) => [row.threadId as string, row._count._all])
            );
            const scored = recentPosts.map((post) => {
                const messageCount = post.threadId ? (messageCountByThreadId.get(post.threadId) ?? 1) : 1;
                const replyWeight = Math.max(messageCount - 1, 0);
                const score = (post.upvotes - post.downvotes) + replyWeight * 2;
                return { post, messageCount, score };
            });
            const slice = scored
                .sort((a, b) => b.score - a.score || b.post.createdAt.getTime() - a.post.createdAt.getTime())
                .slice(offsetNum, offsetNum + limitNum);
            return reply.send({
                total: Math.min(total, hotWindow),
                posts: slice.map(({ post, messageCount }) => ({
                    id: post.id,
                    threadId: post.threadId,
                    threadTitle: post.thread?.title ?? null,
                    boardId: post.thread?.boardId ?? null,
                    authorId: post.authorId,
                    authorName: post.author?.name ?? null,
                    content: post.content,
                    topic: post.topic,
                    stance: post.stance,
                    replyToId: post.replyToId ?? null,
                    upvotes: post.upvotes,
                    downvotes: post.downvotes,
                    messageCount,
                    createdAt: post.createdAt,
                })),
            });
        }

        const posts = await prisma.agoraPost.findMany({
            where: { deleted: false, replyToId: null },
            orderBy: { createdAt: 'desc' },
            skip: offsetNum,
            take: limitNum,
            include: {
                author: { select: { id: true, name: true } },
                thread: { select: { id: true, title: true, boardId: true } },
            },
        });
        const threadIds = posts
            .map((post) => post.threadId)
            .filter((id): id is string => Boolean(id));
        const messageCounts = threadIds.length > 0
            ? await prisma.agoraPost.groupBy({
                by: ['threadId'],
                where: {
                    deleted: false,
                    threadId: { in: threadIds },
                },
                _count: { _all: true },
            })
            : [];
        const messageCountByThreadId = new Map(
            messageCounts
                .filter((row) => row.threadId)
                .map((row) => [row.threadId as string, row._count._all])
        );
        return reply.send({
            total,
            posts: posts.map((post) => ({
                id: post.id,
                threadId: post.threadId,
                threadTitle: post.thread?.title ?? null,
                boardId: post.thread?.boardId ?? null,
                authorId: post.authorId,
                authorName: post.author?.name ?? null,
                content: post.content,
                topic: post.topic,
                stance: post.stance,
                replyToId: post.replyToId ?? null,
                upvotes: post.upvotes,
                downvotes: post.downvotes,
                messageCount: post.threadId ? (messageCountByThreadId.get(post.threadId) ?? 1) : 1,
                createdAt: post.createdAt,
            })),
        });
    });

    app.get('/api/v1/agora/agent/:actorId', async (request: FastifyRequest, reply: FastifyReply) => {
        const { actorId } = request.params as { actorId: string };
        const { limit = '20' } = request.query as { limit?: string };
        const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);

        const posts = await prisma.agoraPost.findMany({
            where: { authorId: actorId, deleted: false },
            orderBy: { createdAt: 'desc' },
            take: limitNum,
            include: {
                thread: { select: { id: true, title: true } },
            },
        });
        return reply.send({ posts });
    });
}
