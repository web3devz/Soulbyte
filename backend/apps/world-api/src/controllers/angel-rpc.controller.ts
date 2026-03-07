import { prisma } from '../db.js';

export const angelController = {
    async getRecentAgoraPosts({ limit = 50 }: { limit?: number }) {
        const posts = await prisma.agoraPost.findMany({
            where: { deleted: false },
            orderBy: { createdAt: 'desc' },
            take: limit,
            include: {
                author: { select: { id: true, name: true, kind: true } },
                thread: { select: { id: true, title: true } },
            },
        });
        return { success: true, posts };
    },

    async moderateAgoraPost({
        post_id,
        action,
        reason,
    }: {
        post_id: string;
        action: 'DELETE' | 'FLAG' | 'IGNORE';
        reason: string;
    }) {
        if (action === 'DELETE') {
            await prisma.agoraPost.update({
                where: { id: post_id },
                data: {
                    deleted: true,
                    deletedReason: reason,
                    deletedBy: 'angel',
                    deletedAt: new Date(),
                },
            });
        } else if (action === 'FLAG') {
            await prisma.agoraPost.update({
                where: { id: post_id },
                data: { flagged: true },
            });
        }

        return { success: true, action, post_id };
    },

    async deletePost({ post_id, reason }: { post_id: string; reason: string }) {
        await prisma.agoraPost.update({
            where: { id: post_id },
            data: {
                deleted: true,
                deletedReason: reason,
                deletedBy: 'angel',
                deletedAt: new Date(),
            },
        });
        return { success: true, deleted: post_id };
    },

    async flagActor({ actor_id, reason }: { actor_id: string; reason: string }) {
        await prisma.angelModerationLog.create({
            data: {
                actionType: 'FLAG_ACTOR',
                targetType: 'actor',
                targetId: actor_id,
                aiReasoning: reason,
                classification: 'FLAGGED',
                actionResult: 'FLAGGED',
            },
        });

        return { success: true, flagged: actor_id };
    },

    async generateFeedbackReport({ city_id }: { city_id: string }) {
        await prisma.angelFeedbackReport.create({
            data: {
                cityId: city_id,
                reportType: 'FEEDBACK',
                summary: 'Report generation queued (placeholder)',
                priority: 'LOW',
            },
        });
        return { success: true, message: 'Report generation queued' };
    },
};
