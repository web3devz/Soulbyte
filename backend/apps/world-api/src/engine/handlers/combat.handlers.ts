/**
 * Combat Handlers
 * Manages combat between agents: ATTACK, DEFEND, RETREAT
 * 
 * Combat Rules:
 * - Damage based on attacker strength vs defender defense
 * - Energy cost for combat actions
 * - Health reduction on damage
 * - Reputation changes based on outcomes
 * - Random seed for deterministic outcomes
 */

import { prisma } from '../../db.js';
import { IntentStatus } from '../../types/intent.types.js';
import { EventType, EventOutcome } from '../../types/event.types.js';
import { IntentHandler, StateUpdate } from '../engine.types.js';

// Combat constants
const ATTACK_ENERGY_COST = 20;
const DEFEND_ENERGY_COST = 10;
const RETREAT_ENERGY_COST = 5;
const BASE_DAMAGE = 10;
const REPUTATION_ATTACK_PENALTY = -5;
const REPUTATION_DEFEND_BONUS = 2;

// ============================================================================
// INTENT_ATTACK
// ============================================================================

export const handleAttack: IntentHandler = async (intent, actor, agentState, wallet, tick, seed) => {
    const params = intent.params as { targetId?: string };

    if (!params?.targetId) {
        return fail(actor.id, EventType.EVENT_COMBAT_RESULT, 'Missing targetId');
    }

    // Check frozen state
    if (actor.frozen) {
        return fail(actor.id, EventType.EVENT_COMBAT_RESULT, 'Attacker is frozen');
    }

    // Check energy
    if (!agentState || agentState.energy < ATTACK_ENERGY_COST) {
        return fail(actor.id, EventType.EVENT_COMBAT_RESULT, 'Insufficient energy for attack');
    }

    // Check if attacker is in jail
    const jailRecord = await prisma.jail.findUnique({
        where: { actorId: actor.id }
    });
    if (jailRecord && jailRecord.releaseTick > tick) {
        return fail(actor.id, EventType.EVENT_COMBAT_RESULT, 'Attacker is in jail');
    }

    // Get target
    const target = await prisma.actor.findUnique({
        where: { id: params.targetId },
        include: { agentState: true }
    });
    if (!target || target.frozen) {
        return fail(actor.id, EventType.EVENT_COMBAT_RESULT, 'Invalid or frozen target');
    }

    // Calculate damage using deterministic seed
    const damageRoll = Number(seed % 100n);
    const damage = Math.floor(BASE_DAMAGE + (damageRoll / 10));
    const targetHealth = target.agentState?.health || 100;
    const newTargetHealth = Math.max(0, targetHealth - damage);

    const stateUpdates: StateUpdate[] = [
        // Attacker energy cost
        {
            table: 'agentState',
            operation: 'update',
            where: { actorId: actor.id },
            data: { energy: { decrement: ATTACK_ENERGY_COST } }
        },
        // Target health reduction
        {
            table: 'agentState',
            operation: 'update',
            where: { actorId: params.targetId },
            data: { health: newTargetHealth }
        },
        // Attacker reputation penalty
        {
            table: 'agentState',
            operation: 'update',
            where: { actorId: actor.id },
            data: { reputationScore: { increment: REPUTATION_ATTACK_PENALTY } }
        }
    ];

    // If target health drops to 0, they get frozen
    if (newTargetHealth <= 0) {
        stateUpdates.push({
            table: 'actor',
            operation: 'update',
            where: { id: params.targetId },
            data: {
                frozen: true,
                frozenReason: `Defeated by ${actor.name} at tick ${tick}`
            }
        });
    }

    return {
        stateUpdates,
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_COMBAT_RESULT,
            targetIds: [params.targetId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                action: 'attack',
                damage,
                targetNewHealth: newTargetHealth,
                targetDefeated: newTargetHealth <= 0
            }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

// ============================================================================
// INTENT_DEFEND
// ============================================================================

export const handleDefend: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    // Check frozen state
    if (actor.frozen) {
        return fail(actor.id, EventType.EVENT_COMBAT_RESULT, 'Agent is frozen');
    }

    // Check energy
    if (!agentState || agentState.energy < DEFEND_ENERGY_COST) {
        return fail(actor.id, EventType.EVENT_COMBAT_RESULT, 'Insufficient energy for defense');
    }

    // Defend stance lasts 1 tick, provides temporary buff
    // We use activityState to track this
    const defendEndTick = tick + 1;

    return {
        stateUpdates: [
            {
                table: 'agentState',
                operation: 'update',
                where: { actorId: actor.id },
                data: {
                    energy: { decrement: DEFEND_ENERGY_COST },
                    activityState: 'RESTING', // Use resting as defensive stance
                    activityEndTick: defendEndTick
                }
            },
            // Small reputation boost for defensive posture
            {
                table: 'agentState',
                operation: 'update',
                where: { actorId: actor.id },
                data: { reputationScore: { increment: REPUTATION_DEFEND_BONUS } }
            }
        ],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_COMBAT_RESULT,
            targetIds: [],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                action: 'defend',
                defendEndTick
            }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

// ============================================================================
// INTENT_RETREAT
// ============================================================================

export const handleRetreat: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    // Check frozen state
    if (actor.frozen) {
        return fail(actor.id, EventType.EVENT_COMBAT_RESULT, 'Agent is frozen');
    }

    // Check energy
    if (!agentState || agentState.energy < RETREAT_ENERGY_COST) {
        return fail(actor.id, EventType.EVENT_COMBAT_RESULT, 'Insufficient energy for retreat');
    }

    // Retreat puts agent in a temporary hidden state
    const hideEndTick = tick + 3; // Hidden for 3 ticks

    return {
        stateUpdates: [{
            table: 'agentState',
            operation: 'update',
            where: { actorId: actor.id },
            data: {
                energy: { decrement: RETREAT_ENERGY_COST },
                activityState: 'RESTING',
                activityEndTick: hideEndTick
            }
        }],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_COMBAT_RESULT,
            targetIds: [],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                action: 'retreat',
                hideEndTick
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
