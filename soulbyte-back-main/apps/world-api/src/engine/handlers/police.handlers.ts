/**
 * Police Handlers
 * Manages police-specific actions: PATROL
 * 
 * Note: ARREST, IMPRISON, RELEASE are in crime.handlers.ts
 */

import { prisma } from '../../db.js';
import { IntentStatus } from '../../types/intent.types.js';
import { EventType, EventOutcome } from '../../types/event.types.js';
import { IntentHandler, StateUpdate } from '../engine.types.js';
import { getWorkStatusCost, getWorkStrainTierForPublicRole } from '../work.utils.js';

// Patrol constants
const PATROL_DURATION_TICKS = 6; // 6 minutes of patrol
const PATROL_REPUTATION_BONUS = 1;

// ============================================================================
// INTENT_PATROL
// ============================================================================

export const handlePatrol: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    // Check frozen state
    if (actor.frozen) {
        return fail(actor.id, EventType.EVENT_PATROL_LOGGED, 'Agent is frozen');
    }

    if (!agentState) return fail(actor.id, EventType.EVENT_PATROL_LOGGED, 'Missing agent state');

    // Check if agent is a police officer
    const employment = await prisma.publicEmployment.findUnique({
        where: { actorId: actor.id }
    });
    if (!employment || employment.role !== 'POLICE_OFFICER') {
        return fail(actor.id, EventType.EVENT_PATROL_LOGGED, 'Only police officers can patrol');
    }

    // Check if job is active
    if (employment.endedAtTick !== null) {
        return fail(actor.id, EventType.EVENT_PATROL_LOGGED, 'Employment has ended');
    }

    // Check agent is in a city
    if (!agentState.cityId) {
        return fail(actor.id, EventType.EVENT_PATROL_LOGGED, 'Must be in a city to patrol');
    }

    // Check if currently working (patrol is a work activity)
    if (agentState.activityState === 'WORKING') {
        return fail(actor.id, EventType.EVENT_PATROL_LOGGED, 'Already on duty');
    }

    const ownedItems = await prisma.inventoryItem.findMany({
        where: { actorId: actor.id, quantity: { gt: 0 } },
        include: { itemDef: true }
    });
    const ownedItemNames = ownedItems.map((item) => item.itemDef.name);
    const workCost = getWorkStatusCost(
        getWorkStrainTierForPublicRole('POLICE_OFFICER'),
        ownedItemNames,
        false
    );
    if (agentState.energy < workCost.energy) {
        return fail(actor.id, EventType.EVENT_PATROL_LOGGED, 'Insufficient energy for patrol');
    }

    const patrolEndTick = tick + PATROL_DURATION_TICKS;

    // Get city security level for calculating patrol effectiveness
    const city = await prisma.city.findUnique({
        where: { id: agentState.cityId }
    });

    return {
        stateUpdates: [
            {
                table: 'agentState',
                operation: 'update',
                where: { actorId: actor.id },
                data: {
                    energy: { decrement: workCost.energy },
                    hunger: { decrement: workCost.hunger },
                    health: { decrement: workCost.health },
                    fun: { decrement: workCost.fun },
                    activityState: 'WORKING',
                    activityEndTick: patrolEndTick,
                    reputationScore: { increment: PATROL_REPUTATION_BONUS }
                }
            }
        ],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_PATROL_LOGGED,
            targetIds: [agentState.cityId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                cityId: agentState.cityId,
                cityName: city?.name,
                patrolDuration: PATROL_DURATION_TICKS,
                patrolEndTick,
                citySecurityLevel: city?.securityLevel
            }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

// ============================================================================
// Helper Functions
// ============================================================================

function fail(actorId: string, type: EventType, reason: string) {
    return {
        stateUpdates: [] as StateUpdate[],
        events: [{
            actorId,
            type,
            targetIds: [] as string[],
            outcome: EventOutcome.BLOCKED,
            sideEffects: { reason }
        }],
        intentStatus: IntentStatus.BLOCKED
    };
}
