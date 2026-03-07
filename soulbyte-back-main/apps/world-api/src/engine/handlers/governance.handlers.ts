import { prisma } from '../../db.js';
import { IntentStatus } from '../../types/intent.types.js';
import { EventType, EventOutcome } from '../../types/event.types.js';
import { IntentHandler, StateUpdate } from '../engine.types.js';
import { Decimal } from 'decimal.js';

export const handleVote: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    const params = intent.params as { candidateId?: string, electionId?: string };
    if (!params?.candidateId || !params.electionId) return fail(actor.id, EventType.EVENT_VOTE_CAST, 'Missing params');

    // Check Eligibility (Wealth Tier >= W2)
    // Assuming simple check: default is W0
    if (!agentState || agentState.wealthTier === 'W0' || agentState.wealthTier === 'W1') {
        return fail(actor.id, EventType.EVENT_VOTE_CAST, 'Insufficient wealth tier');
    }

    const election = await prisma.election.findUnique({ where: { id: params.electionId } });
    if (!election) return fail(actor.id, EventType.EVENT_VOTE_CAST, 'Election not found');
    if (election.status !== 'voting') return fail(actor.id, EventType.EVENT_VOTE_CAST, 'Election not in voting phase');
    if (tick < election.startTick || tick > election.endTick) return fail(actor.id, EventType.EVENT_VOTE_CAST, 'Election not active');

    // Check if duplicate vote
    const existingVote = await prisma.vote.findUnique({
        where: { electionId_voterId: { electionId: election.id, voterId: actor.id } }
    });

    if (existingVote) return fail(actor.id, EventType.EVENT_VOTE_CAST, 'Already voted');

    return {
        stateUpdates: [
            {
                table: 'vote',
                operation: 'create',
                data: {
                    electionId: election.id,
                    voterId: actor.id,
                    candidateId: params.candidateId,
                    tick
                }
            },
            {
                table: 'actor',
                operation: 'update',
                where: { id: actor.id },
                data: { reputation: { increment: 2 } }
            }
        ],
        events: [
            {
                actorId: actor.id,
                type: EventType.EVENT_REPUTATION_UPDATED,
                targetIds: [],
                outcome: EventOutcome.SUCCESS,
                sideEffects: { delta: 2, reason: 'vote_cast' }
            },
            {
                actorId: actor.id,
                type: EventType.EVENT_VOTE_CAST,
                targetIds: [params.candidateId],
                outcome: EventOutcome.SUCCESS,
                sideEffects: { electionId: election.id }
            }
        ],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleAllocateSpending: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    // Only Mayor can do this
    if (!agentState?.cityId) return fail(actor.id, EventType.EVENT_SPENDING_ALLOCATED, 'Not in a city');

    const city = await prisma.city.findUnique({
        where: { id: agentState.cityId },
        include: { vault: true }
    });

    if (!city) return fail(actor.id, EventType.EVENT_SPENDING_ALLOCATED, 'City not found');
    if (city.mayorId !== actor.id) return fail(actor.id, EventType.EVENT_SPENDING_ALLOCATED, 'Not the mayor');

    const params = intent.params as { amount?: number, target?: string, reason?: string };
    if (!params?.amount || !params.target) return fail(actor.id, EventType.EVENT_SPENDING_ALLOCATED, 'Missing params');

    // Validate target (e.g., 'security', 'social', 'infrastructure' - generic for now)
    // Or target could be an Actor ID if paying someone?
    // "Spending Allocation" usually implies budget category.
    // Let's assume params.target is a category string for MVP event logging, 
    // BUT if we want to actually move money, we need a destination.
    // The previous code had specific intents like INTENT_CITY_SOCIAL_AID which used handleGovernance.
    // This intent seems to be a generic spending one.
    // If it's a transfer to a system wallet or similar, we need to know where.
    // Use-case: Mayor paying for an event or specialized service?
    // For MVP, let's treat it as burning/paying to "System" for a service.

    const amount = new Decimal(params.amount);
    const vaultBalance = new Decimal(city.vault?.balanceSbyte.toString() || '0');

    if (vaultBalance.lessThan(amount)) return fail(actor.id, EventType.EVENT_SPENDING_ALLOCATED, 'Insufficient city funds');

    return {
        stateUpdates: [{
            table: 'cityVault',
            operation: 'update',
            where: { cityId: city.id },
            data: { balanceSbyte: { decrement: amount.toNumber() } }
        }],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_SPENDING_ALLOCATED,
            targetIds: [],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                amount: amount.toString(),
                target: params.target,
                reason: params.reason
            }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

// Helper
function fail(actorId: string, type: EventType, reason: string) {
    return {
        stateUpdates: [],
        events: [{
            actorId,
            type,
            targetIds: [],
            outcome: EventOutcome.BLOCKED,
            sideEffects: { reason }
        }],
        intentStatus: IntentStatus.BLOCKED
    };
}

// Existing governance handler logic from world.engine.ts will be moved here properly later
// For now stubs for new intents
