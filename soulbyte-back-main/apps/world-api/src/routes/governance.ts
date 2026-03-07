/**
 * Governance Routes
 */
import { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';

export async function governanceRoutes(app: FastifyInstance) {
    /**
     * GET /api/v1/governance/:cityId/proposals
     */
    app.get('/api/v1/governance/:cityId/proposals', async (request, reply) => {
        const { cityId } = request.params as { cityId: string };
        const { status, limit = 50 } = request.query as { status?: string; limit?: number };

        const proposals = await prisma.cityProposal.findMany({
            where: { cityId, ...(status ? { status } : {}) },
            orderBy: { createdAt: 'desc' },
            take: Math.min(Number(limit), 200),
            include: { mayor: { select: { id: true, name: true } } }
        });

        return reply.send({
            proposals: proposals.map((proposal) => ({
                id: proposal.id,
                cityId: proposal.cityId,
                mayor: proposal.mayor,
                type: proposal.type,
                status: proposal.status,
                payload: proposal.payload,
                createdAt: proposal.createdAt,
                updatedAt: proposal.updatedAt
            }))
        });
    });

    /**
     * GET /api/v1/governance/:cityId/elections
     * Returns election history and current candidates
     */
    app.get('/api/v1/governance/:cityId/elections', async (request, reply) => {
        const { cityId } = request.params as { cityId: string };
        const { limit = 10 } = request.query as { limit?: number };

        const elections = await prisma.election.findMany({
            where: { cityId },
            orderBy: { cycle: 'desc' },
            take: Math.min(Number(limit), 50),
            include: {
                candidates: {
                    include: {
                        _count: { select: { votes: true } }
                    }
                }
            }
        });

        const actorIds = new Set<string>();
        for (const election of elections) {
            for (const candidate of election.candidates) {
                actorIds.add(candidate.actorId);
            }
            if (election.winnerId) actorIds.add(election.winnerId);
        }

        const actors = await prisma.actor.findMany({
            where: { id: { in: Array.from(actorIds) } },
            select: { id: true, name: true }
        });
        const actorNameById = new Map(actors.map((actor) => [actor.id, actor.name]));

        const formatted = elections.map((election) => {
            const candidates = election.candidates.map((candidate) => ({
                id: candidate.id,
                actorId: candidate.actorId,
                name: actorNameById.get(candidate.actorId) ?? 'Unknown',
                status: candidate.status,
                platform: candidate.platform,
                voteCount: candidate._count.votes
            }));

            const totalVotes = candidates.reduce((sum, c) => sum + c.voteCount, 0);
            return {
                id: election.id,
                cityId: election.cityId,
                cycle: election.cycle,
                startTick: election.startTick,
                endTick: election.endTick,
                status: election.status,
                winnerId: election.winnerId,
                winnerName: election.winnerId ? actorNameById.get(election.winnerId) ?? null : null,
                totalVotes,
                candidates
            };
        });

        const current = formatted.find((election) => ['nomination', 'voting'].includes(election.status));
        const history = formatted.filter((election) => election.status === 'completed');

        return reply.send({ current, history, elections: formatted });
    });

    /**
     * GET /api/v1/governance/:cityId/donations
     * Returns vault audit log entries (positive deltas) as a proxy for donations
     */
    app.get('/api/v1/governance/:cityId/donations', async (request, reply) => {
        const { cityId } = request.params as { cityId: string };
        const { limit = 50 } = request.query as { limit?: number };

        const logs = await prisma.vaultAuditLog.findMany({
            where: {
                vaultId: cityId,
                changeAmount: { gt: 0 }
            },
            orderBy: { changedAt: 'desc' },
            take: Math.min(Number(limit), 200)
        });

        return reply.send({
            donations: logs.map((log) => ({
                id: log.id,
                cityId: log.vaultId,
                amount: log.changeAmount.toString(),
                operation: log.operation,
                oldBalance: log.oldBalance.toString(),
                newBalance: log.newBalance.toString(),
                changedAt: log.changedAt
            }))
        });
    });
}
