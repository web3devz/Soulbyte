/**
 * Intent Gateway Routes
 * POST /api/v1/intents - Submit intent from agent
 */
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../db.js';
import { IntentPayload, IntentType, IntentStatus } from '../types/intent.types.js';

export async function intentsRoutes(app: FastifyInstance) {
    /**
     * POST /api/v1/intents
     * Submit an intent from an agent
     */
    app.post('/api/v1/intents', async (request: FastifyRequest, reply: FastifyReply) => {
        const payload = request.body as IntentPayload;

        // Validate required fields
        if (!payload.actorId || !payload.type) {
            return reply.code(400).send({
                error: 'Missing required fields',
                details: 'actorId and type are required',
            });
        }

        // Validate intent type
        if (!Object.values(IntentType).includes(payload.type)) {
            return reply.code(400).send({
                error: 'Invalid intent type',
                details: `Unknown intent type: ${payload.type}`,
            });
        }

        try {
            // Get the actor
            const actor = await prisma.actor.findUnique({
                where: { id: payload.actorId },
                include: { jail: true },
            });

            if (!actor) {
                return reply.code(404).send({
                    error: 'Actor not found',
                    details: `No actor with id: ${payload.actorId}`,
                });
            }

            // Validate actor can emit intents
            if (actor.kind !== 'agent') {
                return reply.code(403).send({
                    error: 'Only agents can emit intents',
                    details: `Actor ${payload.actorId} is type: ${actor.kind}`,
                });
            }

            // MVP: Reject frozen actors
            if (actor.frozen) {
                return reply.code(403).send({
                    error: 'Frozen actors cannot emit intents',
                    details: `Actor is frozen: ${actor.frozenReason || 'unknown reason'}`,
                });
            }

            // Reject jailed actors
            if (actor.jail) {
                return reply.code(403).send({
                    error: 'Jailed actors cannot emit intents',
                    details: `Actor is jailed until tick: ${actor.jail.releaseTick}`,
                });
            }

            // Get current world tick
            const worldState = await prisma.worldState.findFirst({
                where: { id: 1 },
            });
            const currentTick = worldState?.tick ?? 0;

            // Create intent with pending status
            const intent = await prisma.intent.create({
                data: {
                    actorId: payload.actorId,
                    type: payload.type,
                    targetId: payload.targetId || null,
                    params: payload.params || {},
                    priority: payload.priority ?? 0,
                    expectedCost: payload.expectedCost ?? 0,
                    expectedReward: payload.expectedReward ?? 0,
                    tick: currentTick,
                    status: IntentStatus.PENDING,
                },
            });

            return reply.code(201).send({
                ok: true,
                intent: {
                    id: intent.id,
                    type: intent.type,
                    status: intent.status,
                    tick: intent.tick,
                },
            });
        } catch (error) {
            console.error('Error creating intent:', error);
            return reply.code(500).send({
                error: 'Internal server error',
                details: error instanceof Error ? error.message : 'Unknown error',
            });
        }
    });

    /**
     * GET /api/v1/intents/:id
     * Get intent status
     */
    app.get('/api/v1/intents/:id', async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string };

        try {
            const intent = await prisma.intent.findUnique({
                where: { id },
            });

            if (!intent) {
                return reply.code(404).send({ error: 'Intent not found' });
            }

            return reply.send({ intent });
        } catch (error) {
            console.error('Error fetching intent:', error);
            return reply.code(500).send({ error: 'Internal server error' });
        }
    });
}
