/**
 * Life Handlers
 * Manages life/career: INTENT_SWITCH_JOB, INTENT_REST
 */

import { IntentStatus, IntentType } from '../../types/intent.types.js';
import { EventType, EventOutcome } from '../../types/event.types.js';
import { IntentHandler, StateUpdate } from '../engine.types.js';
import { prisma } from '../../db.js';
import { SIM_TICKS_PER_HOUR } from '../../config/time.js';
import { getRestProfile } from '../rest.utils.js';
import { debugLog } from '../../utils/debug-log.js';

// Constants
const SWITCH_JOB_ENERGY_COST = 20;
const FORAGE_ENERGY_COST = 8;
const FORAGE_HUNGER_GAIN = 30;
const FORAGE_PURPOSE_GAIN = 1;
const FORAGE_FUN_COST = 2;
const FORAGE_HEALTH_COST = 1;

const CONSUMABLE_EFFECTS: Record<string, { hunger?: number; energy?: number; health?: number; fun?: number; social?: number; purpose?: number }> = {
    CONS_RATION: { hunger: 35 },
    CONS_MEAL: { hunger: 50, fun: 5 },
    CONS_ENERGY_DRINK: { energy: 25 },
    CONS_MEDKIT: { health: 30 }
};

const JOB_WEALTH_REQUIREMENTS: Record<string, string> = {
    'unemployed': 'W0',
    'begging': 'W0',
    'menial': 'W0',
    'labor': 'W1',
    'skilled': 'W2',
    'creative': 'W3',
    'executive': 'W5',
    'investor': 'W7',
};

const WEALTH_ORDER = ['W0', 'W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9'];

function meetsWealthRequirement(current: string, required: string): boolean {
    return WEALTH_ORDER.indexOf(current) >= WEALTH_ORDER.indexOf(required);
}

// ============================================================================
// INTENT_AVOID_GAMES
// ============================================================================

export const handleAvoidGames: IntentHandler = async (intent, actor, agentState, _wallet, tick) => {
    const params = (intent.params as any) ?? {};
    if (!agentState) return fail(actor.id, EventType.EVENT_GAME_RESULT, 'Missing agent state');
    const durationTicks = Number(params.durationTicks ?? 0);
    const durationHours = Number(params.durationHours ?? 0);
    const durationDays = Number(params.durationDays ?? 0);
    const untilTick = Number(params.untilTick ?? 0);
    const derivedTicks = untilTick
        || (durationTicks > 0 ? tick + durationTicks
            : durationHours > 0 ? tick + (durationHours * SIM_TICKS_PER_HOUR)
                : durationDays > 0 ? tick + (durationDays * 24 * SIM_TICKS_PER_HOUR)
                    : 0);
    if (!derivedTicks || derivedTicks <= tick) {
        return fail(actor.id, EventType.EVENT_GAME_RESULT, 'Invalid duration');
    }
    const currentEmotions = (agentState as any).emotions ?? {};
    return {
        stateUpdates: [{
            table: 'agentState',
            operation: 'update',
            where: { actorId: actor.id },
            data: {
                emotions: {
                    ...currentEmotions,
                    noGamesUntilTick: derivedTicks,
                }
            }
        }],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_GAME_RESULT,
            targetIds: [],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { noGamesUntilTick: derivedTicks }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

// ============================================================================
// INTENT_FREEZE
// ============================================================================

export const handleFreeze: IntentHandler = async (intent, actor) => {
    const params = intent.params as { reason?: string };
    if (actor.frozen) {
        return fail(actor.id, EventType.EVENT_FROZEN, 'Actor already frozen');
    }

    return {
        stateUpdates: [{
            table: 'actor',
            operation: 'update',
            where: { id: actor.id },
            data: {
                frozen: true,
                frozenReason: params?.reason ?? 'system_freeze',
            },
        }],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_FROZEN,
            targetIds: [],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { reason: params?.reason ?? 'system_freeze' },
        }],
        intentStatus: IntentStatus.EXECUTED,
    };
};

// ============================================================================
// INTENT_SWITCH_JOB
// ============================================================================

export const handleSwitchJob: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    const params = intent.params as { newJobType?: string };

    if (!params?.newJobType) {
        return fail(actor.id, EventType.EVENT_JOB_SWITCHED, 'Missing newJobType');
    }

    if (actor.frozen) return fail(actor.id, EventType.EVENT_JOB_SWITCHED, 'Agent is frozen');
    if (!agentState || agentState.energy < SWITCH_JOB_ENERGY_COST) {
        return fail(actor.id, EventType.EVENT_JOB_SWITCHED, 'Insufficient energy');
    }

    const validJobTypes = ['unemployed', 'begging', 'menial', 'labor', 'skilled', 'creative', 'executive', 'investor'];
    if (!validJobTypes.includes(params.newJobType)) {
        return fail(actor.id, EventType.EVENT_JOB_SWITCHED, `Invalid job type: ${params.newJobType}`);
    }

    if (agentState.jobType === params.newJobType) {
        return fail(actor.id, EventType.EVENT_JOB_SWITCHED, 'Already has this job type');
    }

    const requiredWealth = JOB_WEALTH_REQUIREMENTS[params.newJobType] || 'W0';
    if (!meetsWealthRequirement(agentState.wealthTier || 'W0', requiredWealth)) {
        return fail(actor.id, EventType.EVENT_JOB_SWITCHED, `Job requires wealth tier ${requiredWealth}`);
    }

    if (['governor', 'mayor'].includes(params.newJobType)) {
        return fail(actor.id, EventType.EVENT_JOB_SWITCHED, 'Cannot switch to elected positions');
    }

    const previousJobType = agentState.jobType;

    return {
        stateUpdates: [{
            table: 'agentState',
            operation: 'update',
            where: { actorId: actor.id },
            data: {
                energy: { decrement: SWITCH_JOB_ENERGY_COST },
                jobType: params.newJobType
            }
        }],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_JOB_SWITCHED,
            targetIds: [],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { previousJobType, newJobType: params.newJobType }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

// ============================================================================
// INTENT_REST
// ============================================================================

export const handleRest: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    if (!agentState) return fail(actor.id, EventType.EVENT_RESTED, 'No agent state');

    if (agentState.activityState === 'RESTING') {
        return {
            stateUpdates: [],
            events: [],
            intentStatus: IntentStatus.BLOCKED
        };
    }

    if (agentState.activityState === 'WORKING') {
        return fail(actor.id, EventType.EVENT_RESTED, 'Cannot rest while working');
    }

    const ownedItems = await prisma.inventoryItem.findMany({
        where: { actorId: actor.id, quantity: { gt: 0 } },
        include: { itemDef: true }
    });
    const ownedItemNames = ownedItems.map((item) => item.itemDef.name);
    const restProfile = getRestProfile(agentState.housingTier || 'street', ownedItemNames);
    const restEndTick = tick + (restProfile.restHours * SIM_TICKS_PER_HOUR);

    debugLog('life.handle_rest', {
        actorId: actor.id,
        tick,
        restHours: restProfile.restHours,
        restEndTick,
        housingTier: agentState.housingTier,
        energyBefore: agentState.energy,
        healthBefore: agentState.health,
    });

    return {
        stateUpdates: [{
            table: 'agentState',
            operation: 'update',
            where: { actorId: actor.id },
            data: {
                activityState: 'RESTING',
                activityEndTick: restEndTick,
                energy: Math.min(100, (agentState.energy ?? 0) + 8),
                health: Math.min(100, (agentState.health ?? 0) + 6)
            }
        }],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_RESTED,
            targetIds: [],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                restHours: restProfile.restHours,
                restEndTick,
                housingTier: agentState.housingTier,
                energyRecoveryMult: restProfile.energyMult,
                healthRecoveryMult: restProfile.healthMult
            }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

// ============================================================================
// INTENT_CONSUME_ITEM
// ============================================================================

export const handleConsumeItem: IntentHandler = async (intent, actor, agentState) => {
    const params = intent.params as { itemDefId?: string; quantity?: number };
    if (!params?.itemDefId) return fail(actor.id, EventType.EVENT_ITEM_CONSUMED, 'Missing itemDefId');
    if (!agentState) return fail(actor.id, EventType.EVENT_ITEM_CONSUMED, 'No agent state');
    const qty = params.quantity ?? 1;
    if (qty <= 0) return fail(actor.id, EventType.EVENT_ITEM_CONSUMED, 'Invalid quantity');

    const invItem = await prisma.inventoryItem.findFirst({
        where: { actorId: actor.id, itemDefId: params.itemDefId }
    });
    if (!invItem || invItem.quantity < qty) return fail(actor.id, EventType.EVENT_ITEM_CONSUMED, 'Insufficient item quantity');

    const itemDef = await prisma.itemDefinition.findUnique({ where: { id: params.itemDefId } });
    if (!itemDef || itemDef.category !== 'consumable') return fail(actor.id, EventType.EVENT_ITEM_CONSUMED, 'Item not consumable');

    const effects = CONSUMABLE_EFFECTS[itemDef.name] ?? { hunger: 20 };
    debugLog('life.consume_item', {
        actorId: actor.id,
        item: itemDef.name,
        quantity: qty,
        effects,
    });

    const updates: Record<string, any> = {};
    if (effects.hunger) updates.hunger = Math.min(agentState.hunger + effects.hunger * qty, 100);
    if (effects.energy) updates.energy = Math.min(agentState.energy + effects.energy * qty, 100);
    if (effects.health) updates.health = Math.min(agentState.health + effects.health * qty, 100);
    if (effects.fun) updates.fun = Math.min(agentState.fun + effects.fun * qty, 100);
    if (effects.social) updates.social = Math.min(agentState.social + effects.social * qty, 100);
    if (effects.purpose) updates.purpose = Math.min(agentState.purpose + effects.purpose * qty, 100);

    const inventoryUpdate: StateUpdate = invItem.quantity === qty ? {
        table: 'inventoryItem',
        operation: 'delete',
        where: { id: invItem.id }
    } : {
        table: 'inventoryItem',
        operation: 'update',
        where: { id: invItem.id },
        data: { quantity: { decrement: qty } }
    };

    return {
        stateUpdates: [
            inventoryUpdate,
            {
                table: 'agentState',
                operation: 'update',
                where: { actorId: actor.id },
                data: updates
            }
        ],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_ITEM_CONSUMED,
            targetIds: [params.itemDefId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { quantity: qty, item: itemDef.name }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

// ============================================================================
// INTENT_FORAGE
// ============================================================================

export const handleForage: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    if (!agentState) return fail(actor.id, EventType.EVENT_FORAGED, 'No agent state');
    if (agentState.activityState === 'WORKING') {
        return fail(actor.id, EventType.EVENT_FORAGED, 'Cannot forage while working');
    }
    if (agentState.activityState === 'RESTING') {
        return fail(actor.id, EventType.EVENT_FORAGED, 'Cannot forage while resting');
    }

    const nextHunger = Math.min(100, (agentState.hunger ?? 0) + FORAGE_HUNGER_GAIN);
    const nextEnergy = Math.max(0, (agentState.energy ?? 0) - FORAGE_ENERGY_COST);
    const nextFun = Math.max(0, (agentState.fun ?? 0) - FORAGE_FUN_COST);
    const nextHealth = Math.max(0, (agentState.health ?? 0) - FORAGE_HEALTH_COST);
    const nextPurpose = Math.min(100, (agentState.purpose ?? 0) + FORAGE_PURPOSE_GAIN);

    return {
        stateUpdates: [{
            table: 'agentState',
            operation: 'update',
            where: { actorId: actor.id },
            data: {
                hunger: nextHunger,
                energy: nextEnergy,
                fun: nextFun,
                health: nextHealth,
                purpose: nextPurpose
            }
        }],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_FORAGED,
            targetIds: [],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                hungerGain: FORAGE_HUNGER_GAIN,
                energyCost: FORAGE_ENERGY_COST,
                funCost: FORAGE_FUN_COST,
                healthCost: FORAGE_HEALTH_COST,
                purposeGain: FORAGE_PURPOSE_GAIN
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
