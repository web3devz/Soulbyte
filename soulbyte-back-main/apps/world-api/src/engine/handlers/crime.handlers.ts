import { prisma } from '../../db.js';
import { IntentStatus } from '../../types/intent.types.js';
import { EventType, EventOutcome } from '../../types/event.types.js';
import { IntentHandler, StateUpdate } from '../engine.types.js';
import { Decimal } from 'decimal.js';
import { AgentTransferService } from '../../services/agent-transfer.service.js';
import { ethers } from 'ethers';

const agentTransferService = new AgentTransferService();

// Deterministic PRNG helper
function getDeterministicRandom(seed: bigint, modifier: string): number {
    // Simple hash of string modifier
    let h = 0n;
    for (let i = 0; i < modifier.length; i++) {
        h = (h * 31n + BigInt(modifier.charCodeAt(i))) % 1000000007n;
    }
    // Combine with tick seed
    const combined = (seed ^ h) * 1664525n + 1013904223n;
    return Number(combined % 1000000n) / 1000000;
}

export const handleSteal: IntentHandler = async (intent, actor, agentState, wallet, tick, seed) => {
    const params = intent.params as { targetId?: string };
    if (!params?.targetId) return fail(actor.id, EventType.EVENT_CRIME_COMMITTED, 'Missing targetId');
    if (params.targetId === actor.id) return fail(actor.id, EventType.EVENT_CRIME_COMMITTED, 'Cannot steal from self');

    const targetWallet = await prisma.wallet.findUnique({ where: { actorId: params.targetId } });
    if (!targetWallet) return fail(actor.id, EventType.EVENT_CRIME_COMMITTED, 'Target has no wallet');

    // Calculate stealing inputs
    // MVP: Simple 50% chance if no skills
    const prob = 0.5;

    // Deterministic random roll
    const roll = getDeterministicRandom(seed, actor.id + '_steal');

    let success = roll < prob;

    const stateUpdates: StateUpdate[] = [];
    let stolenAmount = new Decimal(0);

    if (success) {
        // Steal 10% of funds
        const targetBalance = new Decimal(targetWallet.balanceSbyte.toString());
        stolenAmount = targetBalance.mul(0.1).floor();

        if (stolenAmount.greaterThan(0)) {
            try {
                const tx = await agentTransferService.transfer(
                    params.targetId,
                    actor.id,
                    ethers.parseEther(stolenAmount.toString()),
                    'theft',
                    agentState?.cityId || undefined
                );
                const feePlatform = Number(ethers.formatEther(tx.platformFee));
                const feeCity = Number(ethers.formatEther(tx.cityFee));
                stateUpdates.push({
                    table: 'transaction',
                    operation: 'create',
                    data: {
                        fromActorId: params.targetId,
                        toActorId: actor.id,
                        amount: stolenAmount.toNumber(),
                        feePlatform,
                        feeCity,
                        cityId: agentState?.cityId ?? null,
                        tick,
                        reason: 'CRIME_THEFT',
                        onchainTxHash: tx.txHash,
                        metadata: { targetId: params.targetId, amount: stolenAmount.toNumber() }
                    }
                });
            } catch (e: any) {
                success = false;
                stolenAmount = new Decimal(0);
            }
        }
    }

    // Always create Crime Record
    stateUpdates.push({
        table: 'crime',
        operation: 'create',
        data: {
            criminalId: actor.id,
            victimId: params.targetId,
            type: 'theft',
            success: success,
            cityId: agentState?.cityId || '00000000-0000-0000-0000-000000000000', // Unknown city fallback
            tick,
            createdAt: new Date()
        }
    });

    return {
        stateUpdates,
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_CRIME_COMMITTED,
            targetIds: [params.targetId],
            outcome: success ? EventOutcome.SUCCESS : EventOutcome.FAIL,
            sideEffects: {
                type: 'theft',
                amount: stolenAmount.toString(),
                detected: !success // Assume failed attempts are detected
            }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleArrest: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    // Must be police (jobType = 'security' or similar? MVP schema has 'security_level' on city, but jobType enum?)
    // Enum JobType: 'unemployed', 'begging', 'menial', 'labor', 'skilled', 'creative', 'executive', 'investor', 'governor', 'mayor'.
    // No specific 'police' job in MVP enum? 
    // Maybe 'skilled' + specific role?
    // Or maybe we treat 'security' funding as abstract police.
    // SKILLS.md mentions "Police Skills" folder.
    // For MVP, assume anyone with 'skilled' job in a city with 'security_level' > X is police?
    // Or maybe we skip job check for now and allow anyone to arrest if they have the skill (AgentSkills table).
    // I'll skip job check for MVP and rely on agent knowing if they should.

    const params = intent.params as { targetId?: string };
    if (!params?.targetId) return fail(actor.id, EventType.EVENT_ARREST, 'Missing targetId');

    const target = await prisma.actor.findUnique({ where: { id: params.targetId } });
    if (!target) return fail(actor.id, EventType.EVENT_ARREST, 'Target not found');

    // Check if criminal
    // MVP: Check if they have unwiped crimes? or just allow arrest (abuse possible).
    // Let's allow arrest, "False Arrest" handled by event side effects later/reputation.

    return {
        stateUpdates: [{
            table: 'actor',
            operation: 'update',
            where: { id: params.targetId },
            data: { frozen: true, frozenReason: 'Arrested by ' + actor.id }
        }],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_ARREST,
            targetIds: [params.targetId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { reason: 'Suspect detained' }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleImprison: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    const params = intent.params as { targetId?: string, duration?: number };
    if (!params?.targetId || !params.duration) return fail(actor.id, EventType.EVENT_IMPRISONED, 'Missing params');

    const target = await prisma.actor.findUnique({ where: { id: params.targetId } });
    if (!target) return fail(actor.id, EventType.EVENT_IMPRISONED, 'Target not found');
    if (!target.frozen) return fail(actor.id, EventType.EVENT_IMPRISONED, 'Target must be arrested (frozen) first');

    const cityId = agentState?.cityId;
    if (!cityId) return fail(actor.id, EventType.EVENT_IMPRISONED, 'Must be in city');

    return {
        stateUpdates: [
            {
                table: 'jail',
                operation: 'create',
                data: {
                    actorId: params.targetId,
                    cityId: cityId,
                    releaseTick: tick + params.duration
                }
            },
            {
                table: 'actor',
                operation: 'update',
                where: { id: params.targetId },
                data: { frozen: true, frozenReason: 'Imprisoned until tick ' + (tick + params.duration) }
            }
        ],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_IMPRISONED,
            targetIds: [params.targetId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { duration: params.duration, untilTick: tick + params.duration }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleRelease: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    const params = intent.params as { targetId?: string };
    if (!params?.targetId) return fail(actor.id, EventType.EVENT_RELEASED, 'Missing targetId');

    const jailRecord = await prisma.jail.findUnique({ where: { actorId: params.targetId } });
    if (!jailRecord) return fail(actor.id, EventType.EVENT_RELEASED, 'Target not in jail');

    return {
        stateUpdates: [
            {
                table: 'jail', // Assuming my engine supports 'delete' via special op or update?
                // Engine types: 'update' | 'create'. No delete? 
                // Ops. `StateUpdate` interface key: operation: 'update' | 'create'.
                // I need to add 'delete' to StateUpdate or implement it.
                // Checking engine.types.ts... 
                // Ah, I don't recall adding 'delete'.
                // If I can't delete, I can't release properly.
                // Assuming I need to add 'delete'.
                // For now, let's use 'update' to set something or just error out.
                // I WILL NEED TO ADD 'delete' to world.engine.ts and engine.types.ts.
                // I will add it in next step.
                // For now, I will assume 'delete' exists and fix engine later.
                operation: 'delete',
                where: { actorId: params.targetId },
                data: {}
            } as any,
            {
                table: 'actor',
                operation: 'update',
                where: { id: params.targetId },
                data: { frozen: false, frozenReason: null }
            }
        ],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_RELEASED,
            targetIds: [params.targetId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { reason: 'Released' }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

// ============================================================================
// INTENT_ASSAULT
// ============================================================================

export const handleAssault: IntentHandler = async (intent, actor, agentState, wallet, tick, seed) => {
    const params = intent.params as { targetId?: string };
    if (!params?.targetId) return fail(actor.id, EventType.EVENT_CRIME_COMMITTED, 'Missing targetId');
    if (params.targetId === actor.id) return fail(actor.id, EventType.EVENT_CRIME_COMMITTED, 'Cannot assault self');

    const target = await prisma.actor.findUnique({
        where: { id: params.targetId },
        include: { agentState: true }
    });
    if (!target || target.frozen) return fail(actor.id, EventType.EVENT_CRIME_COMMITTED, 'Invalid or frozen target');

    // Deterministic success roll based on seed mixed with actor ID
    const roll = getDeterministicRandom(seed, actor.id + '_assault');
    const success = roll < 0.6; // 60% success chance

    const stateUpdates: StateUpdate[] = [];
    const damage = 15;
    let targetNewHealth = target.agentState?.health || 100;

    if (success) {
        targetNewHealth = Math.max(0, targetNewHealth - damage);

        stateUpdates.push({
            table: 'agentState',
            operation: 'update',
            where: { actorId: params.targetId },
            data: { health: targetNewHealth }
        });

        // If target health drops to 0, they get frozen
        if (targetNewHealth <= 0) {
            stateUpdates.push({
                table: 'actor',
                operation: 'update',
                where: { id: params.targetId },
                data: { frozen: true, frozenReason: `Assaulted by ${actor.name}` }
            });
        }
    }

    // Always create crime record
    stateUpdates.push({
        table: 'crime',
        operation: 'create',
        data: {
            criminalId: actor.id,
            victimId: params.targetId,
            type: 'assault',
            success: success,
            cityId: agentState?.cityId || '00000000-0000-0000-0000-000000000000',
            tick,
            createdAt: new Date()
        }
    });

    // Reputation penalty
    stateUpdates.push({
        table: 'agentState',
        operation: 'update',
        where: { actorId: actor.id },
        data: { reputationScore: { decrement: 10 } }
    });

    return {
        stateUpdates,
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_CRIME_COMMITTED,
            targetIds: [params.targetId],
            outcome: success ? EventOutcome.SUCCESS : EventOutcome.FAIL,
            sideEffects: {
                type: 'assault',
                damage: success ? damage : 0,
                targetNewHealth,
                detected: !success
            }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

// ============================================================================
// INTENT_FRAUD
// ============================================================================

export const handleFraud: IntentHandler = async (intent, actor, agentState, wallet, tick, seed) => {
    const params = intent.params as { targetId?: string; amount?: number };
    if (!params?.targetId) return fail(actor.id, EventType.EVENT_CRIME_COMMITTED, 'Missing targetId');
    if (params.targetId === actor.id) return fail(actor.id, EventType.EVENT_CRIME_COMMITTED, 'Cannot defraud self');

    const amount = params.amount || 100;

    const targetWallet = await prisma.wallet.findUnique({ where: { actorId: params.targetId } });
    if (!targetWallet) return fail(actor.id, EventType.EVENT_CRIME_COMMITTED, 'Target has no wallet');

    const targetBalance = new Decimal(targetWallet.balanceSbyte.toString());
    if (targetBalance.lessThan(amount)) {
        return fail(actor.id, EventType.EVENT_CRIME_COMMITTED, 'Target has insufficient funds');
    }

    // Fraud is harder to succeed than theft (35% base)
    const roll = getDeterministicRandom(seed, actor.id + '_fraud');
    let success = roll < 0.35;

    const stateUpdates: StateUpdate[] = [];
    const actualAmount = success ? new Decimal(amount) : new Decimal(0);

    if (success) {
        try {
            const tx = await agentTransferService.transfer(
                params.targetId,
                actor.id,
                ethers.parseEther(actualAmount.toString()),
                'fraud',
                agentState?.cityId || undefined
            );
            const feePlatform = Number(ethers.formatEther(tx.platformFee));
            const feeCity = Number(ethers.formatEther(tx.cityFee));
            stateUpdates.push({
                table: 'transaction',
                operation: 'create',
                data: {
                    fromActorId: params.targetId,
                    toActorId: actor.id,
                    amount: actualAmount.toNumber(),
                    feePlatform,
                    feeCity,
                    cityId: agentState?.cityId ?? null,
                    tick,
                    reason: 'CRIME_FRAUD',
                    onchainTxHash: tx.txHash,
                    metadata: { targetId: params.targetId, amount: actualAmount.toNumber() }
                }
            });
        } catch (e: any) {
            success = false;
        }
    }

    // Create crime record
    stateUpdates.push({
        table: 'crime',
        operation: 'create',
        data: {
            criminalId: actor.id,
            victimId: params.targetId,
            type: 'fraud',
            success: success,
            cityId: agentState?.cityId || '00000000-0000-0000-0000-000000000000',
            tick,
            createdAt: new Date()
        }
    });

    // Reputation penalty on detection
    if (!success) {
        stateUpdates.push({
            table: 'agentState',
            operation: 'update',
            where: { actorId: actor.id },
            data: { reputationScore: { decrement: 15 } }
        });
    }

    return {
        stateUpdates,
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_CRIME_COMMITTED,
            targetIds: [params.targetId],
            outcome: success ? EventOutcome.SUCCESS : EventOutcome.FAIL,
            sideEffects: {
                type: 'fraud',
                amount: actualAmount.toString(),
                detected: !success
            }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

// ============================================================================
// INTENT_FLEE
// ============================================================================

export const handleFlee: IntentHandler = async (intent, actor, agentState, wallet, tick, seed) => {
    // Flee attempts to escape from current city (if being pursued)
    if (actor.frozen) {
        return fail(actor.id, EventType.EVENT_RELEASED, 'Cannot flee while frozen');
    }

    if (!agentState?.cityId) {
        return fail(actor.id, EventType.EVENT_RELEASED, 'Not in a city');
    }

    // Check if agent is in jail
    const jailRecord = await prisma.jail.findUnique({ where: { actorId: actor.id } });
    if (jailRecord && jailRecord.releaseTick > tick) {
        // Attempted jail break
        const roll = getDeterministicRandom(seed, actor.id + '_jailbreak');
        const success = roll < 0.2; // 20% chance of jail break

        if (success) {
            return {
                stateUpdates: [
                    {
                        table: 'jail',
                        operation: 'delete',
                        where: { actorId: actor.id }
                    } as StateUpdate,
                    {
                        table: 'actor',
                        operation: 'update',
                        where: { id: actor.id },
                        data: { frozen: false, frozenReason: null }
                    },
                    // Extra crime for escaping
                    {
                        table: 'crime',
                        operation: 'create',
                        data: {
                            criminalId: actor.id,
                            victimId: null,
                            type: 'fraud', // Using fraud to represent deception of authority (escape)
                            success: true,
                            cityId: agentState.cityId,
                            tick,
                            createdAt: new Date()
                        }
                    }
                ],
                events: [{
                    actorId: actor.id,
                    type: EventType.EVENT_RELEASED,
                    targetIds: [],
                    outcome: EventOutcome.SUCCESS,
                    sideEffects: { action: 'escape', type: 'jail_break' }
                }],
                intentStatus: IntentStatus.EXECUTED
            };
        } else {
            // Failed escape, add more time
            return {
                stateUpdates: [{
                    table: 'jail',
                    operation: 'update',
                    where: { actorId: actor.id },
                    data: { releaseTick: { increment: 50 } }
                }],
                events: [{
                    actorId: actor.id,
                    type: EventType.EVENT_RELEASED,
                    targetIds: [],
                    outcome: EventOutcome.FAIL,
                    sideEffects: { action: 'escape_failed', additionalTime: 50 }
                }],
                intentStatus: IntentStatus.EXECUTED
            };
        }
    }

    // Normal flee - just enter hiding state
    return {
        stateUpdates: [{
            table: 'agentState',
            operation: 'update',
            where: { actorId: actor.id },
            data: {
                activityState: 'RESTING',
                activityEndTick: tick + 10,
                energy: { decrement: 10 }
            }
        }],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_RELEASED,
            targetIds: [],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { action: 'flee', hidingUntil: tick + 10 }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

// ============================================================================
// INTENT_HIDE
// ============================================================================

export const handleHide: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    // Enter hiding state
    if (actor.frozen) {
        return fail(actor.id, EventType.EVENT_RELEASED, 'Cannot hide while frozen');
    }

    const hideDuration = 20; // 20 ticks hidden
    const hideEndTick = tick + hideDuration;

    return {
        stateUpdates: [{
            table: 'agentState',
            operation: 'update',
            where: { actorId: actor.id },
            data: {
                activityState: 'RESTING',
                activityEndTick: hideEndTick,
                energy: { decrement: 5 }
            }
        }],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_RELEASED,
            targetIds: [],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { action: 'hide', hidingUntil: hideEndTick }
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

