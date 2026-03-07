import { prisma } from '../../db.js';
import { IntentStatus } from '../../types/intent.types.js';
import { EventType, EventOutcome } from '../../types/event.types.js';
import { IntentHandler, StateUpdate } from '../engine.types.js';
import { Decimal } from 'decimal.js';
import { AgentTransferService } from '../../services/agent-transfer.service.js';
import { ethers } from 'ethers';
import { CONTRACTS } from '../../config/contracts.js';
import { debugLog } from '../../utils/debug-log.js';

const agentTransferService = new AgentTransferService();

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const SOCIALIZE_COST_BASE = 5;

export const handleSocialize: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    const params = intent.params as { targetId?: string; intensity?: number };
    if (!agentState || agentState.activityState !== 'IDLE') {
        return fail(actor.id, EventType.EVENT_SOCIALIZED, 'Actor is busy');
    }
    if (!agentState?.cityId) return fail(actor.id, EventType.EVENT_SOCIALIZED, 'Missing city');
    const targetId = await resolveSocialTarget(actor.id, agentState, params?.targetId);
    if (!targetId) return fail(actor.id, EventType.EVENT_SOCIALIZED, 'No nearby social target');

    const resolveTarget = async (candidateId: string | null) => {
        if (!candidateId) return null;
        const candidate = await prisma.actor.findUnique({
            where: { id: candidateId },
            include: { agentState: true }
        });
        if (!candidate || candidate.kind !== 'agent') return null;
        if (candidate.dead || candidate.frozen) return null;
        if (!candidate.agentState?.cityId || candidate.agentState.cityId !== agentState.cityId) return null;
        return candidate;
    };

    let target = await resolveTarget(targetId);
    if (!target) {
        const fallbackId = await resolveSocialTarget(actor.id, agentState, undefined);
        target = await resolveTarget(fallbackId);
        if (!target) return fail(actor.id, EventType.EVENT_SOCIALIZED, 'No nearby social target');
    }
    const resolvedTargetId = target.id;

    debugLog('social.handle_socialize.start', {
        actorId: actor.id,
        tick,
        targetId: resolvedTargetId,
        intensity: params?.intensity ?? 1,
    });
    const targetCityId = target.agentState?.cityId ?? null;
    const crossCity = Boolean(targetCityId && agentState.cityId && targetCityId !== agentState.cityId);

    const directRel = await prisma.relationship.findUnique({
        where: { actorAId_actorBId: { actorAId: actor.id, actorBId: resolvedTargetId } }
    });
    const reverseRel = !directRel
        ? await prisma.relationship.findUnique({
            where: { actorAId_actorBId: { actorAId: resolvedTargetId, actorBId: actor.id } }
        })
        : null;
    const relationship = directRel ?? reverseRel;
    const actorPersona = await prisma.personaState.findUnique({ where: { actorId: actor.id } });
    const targetPersona = await prisma.personaState.findUnique({ where: { actorId: resolvedTargetId } });
    const intensity = clamp(Number(params?.intensity ?? 1), 1, 3);
    const socializeCost = SOCIALIZE_COST_BASE * intensity;
    if (!wallet) return fail(actor.id, EventType.EVENT_SOCIALIZED, 'Missing wallet');
    const agentWallet = await prisma.agentWallet.findUnique({ where: { actorId: actor.id } });
    if (!agentWallet) return fail(actor.id, EventType.EVENT_SOCIALIZED, 'Missing on-chain wallet');
    const walletBalance = new Decimal(wallet.balanceSbyte.toString());
    if (walletBalance.lessThan(socializeCost)) {
        return fail(actor.id, EventType.EVENT_SOCIALIZED, 'Insufficient balance to socialize');
    }
    const onchainSbyte = new Decimal(agentWallet.balanceSbyte.toString());
    if (onchainSbyte.lessThan(socializeCost)) {
        return fail(actor.id, EventType.EVENT_SOCIALIZED, 'Insufficient on-chain balance to socialize');
    }
    const onchainMon = new Decimal(agentWallet.balanceMon.toString());
    if (onchainMon.lte(0)) {
        return fail(actor.id, EventType.EVENT_SOCIALIZED, 'Insufficient MON for socialize gas');
    }
    const deltaStrength = 3 * intensity;
    const deltaTrust = 2 * intensity;
    const deltaRomance = 0;
    const socialGain = 10 * intensity;
    const funGain = 4 * intensity;
    const purposeGain = 2 * intensity;

    const stateUpdates: StateUpdate[] = [];
    stateUpdates.push({
        table: 'agentState',
        operation: 'update',
        where: { actorId: actor.id },
        data: {
            social: clamp((agentState.social ?? 0) + socialGain, 0, 100),
            fun: clamp((agentState.fun ?? 0) + funGain, 0, 100),
            purpose: clamp((agentState.purpose ?? 0) + purposeGain, 0, 100),
        }
    });
    if (target.agentState) {
        stateUpdates.push({
            table: 'agentState',
            operation: 'update',
            where: { actorId: resolvedTargetId },
            data: {
                social: { increment: Math.floor(socialGain * 0.5) },
            }
        });
    }
    const nextActorLoneliness = clamp((actorPersona?.loneliness ?? 30) - (15 * intensity), 0, 100);
    if (actorPersona) {
        stateUpdates.push({
            table: 'personaState',
            operation: 'update',
            where: { actorId: actor.id },
            data: { loneliness: nextActorLoneliness }
        });
    } else {
        stateUpdates.push({
            table: 'personaState',
            operation: 'create',
            data: { actorId: actor.id, loneliness: nextActorLoneliness }
        });
    }
    const nextTargetLoneliness = clamp((targetPersona?.loneliness ?? 30) - (10 * intensity), 0, 100);
    if (targetPersona) {
        stateUpdates.push({
            table: 'personaState',
            operation: 'update',
            where: { actorId: resolvedTargetId },
            data: { loneliness: nextTargetLoneliness }
        });
    } else {
        stateUpdates.push({
            table: 'personaState',
            operation: 'create',
            data: { actorId: resolvedTargetId, loneliness: nextTargetLoneliness }
        });
    }
    if (!relationship) {
        stateUpdates.push({
            table: 'relationship',
            operation: 'create',
            data: {
                actorAId: actor.id,
                actorBId: resolvedTargetId,
                relationshipType: 'FRIENDSHIP',
                strength: clamp(20 + deltaStrength, 0, 100),
                trust: clamp(15 + deltaTrust, 0, 100),
                romance: 0,
                betrayal: 0,
                formedAtTick: tick
            }
        });
    } else {
        stateUpdates.push({
            table: 'relationship',
            operation: 'update',
            where: {
                actorAId_actorBId: {
                    actorAId: relationship.actorAId,
                    actorBId: relationship.actorBId
                }
            },
            data: {
                strength: clamp(Number(relationship.strength ?? 0) + deltaStrength, 0, 100),
                trust: clamp(Number(relationship.trust ?? 0) + deltaTrust, 0, 100),
                romance: clamp(Number(relationship.romance ?? 0), 0, 100),
                betrayal: clamp(Number(relationship.betrayal ?? 0) - 1, 0, 100)
            }
        });
    }

    let socializeTxHash: string | null = null;
    if (socializeCost > 0) {
        try {
            const transfer = await agentTransferService.transfer(
                actor.id,
                resolvedTargetId,
                ethers.parseEther(socializeCost.toString()),
                'socialize',
                targetCityId ?? agentState.cityId ?? undefined,
                undefined,
                crossCity ? 2 : 1
            );
            socializeTxHash = transfer.txHash;
        } catch (error: any) {
            debugLog('social.handle_socialize.payment_failed', {
                actorId: actor.id,
                targetId: resolvedTargetId,
                error: String(error?.message || error)
            });
            return fail(actor.id, EventType.EVENT_SOCIALIZED, 'Socialize payment failed');
        }
    }

    debugLog('social.handle_socialize.success', {
        actorId: actor.id,
        tick,
        targetId: resolvedTargetId,
        deltaStrength,
        deltaTrust,
        deltaRomance,
        socialGain,
        funGain,
        purposeGain,
    });

    return {
        stateUpdates,
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_SOCIALIZED,
            targetIds: [resolvedTargetId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                targetId: resolvedTargetId,
                action: 'socialize',
                deltaStrength,
                deltaTrust,
                cost: socializeCost,
                txHash: socializeTxHash
            }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleFlirt: IntentHandler = async (intent, actor, agentState, _wallet, tick) => {
    const params = intent.params as { targetId?: string };
    if (!agentState?.cityId) return fail(actor.id, EventType.EVENT_FLIRTED, 'Missing city');
    const targetId = await resolveSocialTarget(actor.id, agentState, params?.targetId);
    if (!targetId) return fail(actor.id, EventType.EVENT_FLIRTED, 'No nearby flirt target');

    const resolveTarget = async (candidateId: string | null) => {
        if (!candidateId) return null;
        const candidate = await prisma.actor.findUnique({
            where: { id: candidateId },
            include: { agentState: true }
        });
        if (!candidate || candidate.kind !== 'agent') return null;
        if (candidate.dead || candidate.frozen) return null;
        if (!candidate.agentState?.cityId || candidate.agentState.cityId !== agentState.cityId) return null;
        return candidate;
    };

    let target = await resolveTarget(targetId);
    if (!target) {
        const fallbackId = await resolveSocialTarget(actor.id, agentState, undefined);
        target = await resolveTarget(fallbackId);
        if (!target) return fail(actor.id, EventType.EVENT_FLIRTED, 'No nearby flirt target');
    }
    const resolvedTargetId = target.id;

    debugLog('social.handle_flirt.start', {
        actorId: actor.id,
        tick,
        targetId: resolvedTargetId,
    });

    const directRel = await prisma.relationship.findUnique({
        where: { actorAId_actorBId: { actorAId: actor.id, actorBId: resolvedTargetId } }
    });
    const reverseRel = !directRel
        ? await prisma.relationship.findUnique({
            where: { actorAId_actorBId: { actorAId: resolvedTargetId, actorBId: actor.id } }
        })
        : null;
    const relationship = directRel ?? reverseRel;
    // V6: Flirting can START a relationship — no prior relationship required.
    // If none exists, we seed a new FRIENDSHIP with a small romance spark.
    const deltaRomance = 5;
    const deltaTrust = 1;
    const deltaStrength = 2;

    const stateUpdates: StateUpdate[] = [];
    if (!relationship) {
        // First contact — create relationship triggered by flirt
        stateUpdates.push({
            table: 'relationship',
            operation: 'create',
            data: {
                actorAId: actor.id,
                actorBId: resolvedTargetId,
                relationshipType: 'FRIENDSHIP',
                strength: 20 + deltaStrength,
                trust: 15 + deltaTrust,
                romance: deltaRomance,
                betrayal: 0,
                formedAtTick: tick
            }
        });
    } else if (Number(relationship.strength ?? 0) < 15) {
        return fail(actor.id, EventType.EVENT_FLIRTED, 'Relationship too hostile to flirt');
    } else {

        stateUpdates.push({
            table: 'relationship',
            operation: 'update',
            where: {
                actorAId_actorBId: {
                    actorAId: relationship.actorAId,
                    actorBId: relationship.actorBId
                }
            },
            data: {
                romance: clamp(Number(relationship.romance ?? 0) + deltaRomance, 0, 100),
                trust: clamp(Number(relationship.trust ?? 0) + deltaTrust, 0, 100),
                strength: clamp(Number(relationship.strength ?? 0) + deltaStrength, 0, 100),
            }
        });
    }

    debugLog('social.handle_flirt.success', {
        actorId: actor.id,
        tick,
        targetId: resolvedTargetId,
        deltaRomance,
        deltaTrust,
        deltaStrength,
    });

    return {
        stateUpdates,
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_FLIRTED,
            targetIds: [resolvedTargetId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                targetId: resolvedTargetId,
                action: 'flirt',
                deltaRomance,
                deltaTrust,
                deltaStrength
            }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleRomanticInteraction: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    const params = intent.params as { targetId?: string; intensity?: number };
    if (!agentState || agentState.activityState !== 'IDLE') {
        return fail(actor.id, EventType.EVENT_ROMANTIC_INTERACTION, 'Actor is busy');
    }
    if (!agentState?.cityId) return fail(actor.id, EventType.EVENT_ROMANTIC_INTERACTION, 'Missing city');
    const targetId = await resolveSocialTarget(actor.id, agentState, params?.targetId);
    if (!targetId) return fail(actor.id, EventType.EVENT_ROMANTIC_INTERACTION, 'No romantic target');

    const resolveTarget = async (candidateId: string | null) => {
        if (!candidateId) return null;
        const candidate = await prisma.actor.findUnique({
            where: { id: candidateId },
            include: { agentState: true }
        });
        if (!candidate || candidate.kind !== 'agent') return null;
        if (candidate.dead || candidate.frozen) return null;
        if (!candidate.agentState?.cityId || candidate.agentState.cityId !== agentState.cityId) return null;
        return candidate;
    };

    let target = await resolveTarget(targetId);
    if (!target) {
        const fallbackId = await resolveSocialTarget(actor.id, agentState, undefined);
        target = await resolveTarget(fallbackId);
        if (!target) return fail(actor.id, EventType.EVENT_ROMANTIC_INTERACTION, 'No romantic target');
    }
    const resolvedTargetId = target.id;

    debugLog('social.handle_romantic.start', {
        actorId: actor.id,
        tick,
        targetId: resolvedTargetId,
        intensity: params?.intensity ?? 1,
    });

    const directRel = await prisma.relationship.findUnique({
        where: { actorAId_actorBId: { actorAId: actor.id, actorBId: resolvedTargetId } }
    });
    const reverseRel = !directRel
        ? await prisma.relationship.findUnique({
            where: { actorAId_actorBId: { actorAId: resolvedTargetId, actorBId: actor.id } }
        })
        : null;
    const relationship = directRel ?? reverseRel;
    // V6: Romantic interaction can also bootstrap a new relationship if none exists.
    // Minimum thresholds lowered to match domain changes (strength<15, trust<10).
    if (!relationship) {
        // No prior relationship — seed one. Romantic interaction at first meeting is bold but allowed.
        const intensity = clamp(Number(params?.intensity ?? 1), 1, 3);
        const romanticCost = SOCIALIZE_COST_BASE * intensity;
        if (!wallet) return fail(actor.id, EventType.EVENT_ROMANTIC_INTERACTION, 'Missing wallet');
        const agentWallet = await prisma.agentWallet.findUnique({ where: { actorId: actor.id } });
        if (!agentWallet) return fail(actor.id, EventType.EVENT_ROMANTIC_INTERACTION, 'Missing on-chain wallet');
        const walletBalance = new Decimal(wallet.balanceSbyte.toString());
        if (walletBalance.lessThan(romanticCost)) {
            return fail(actor.id, EventType.EVENT_ROMANTIC_INTERACTION, 'Insufficient balance for romance');
        }
        // Create a new relationship seeded by romantic interest
        const stateUpdates: StateUpdate[] = [{
            table: 'relationship',
            operation: 'create',
            data: {
                actorAId: actor.id,
                actorBId: resolvedTargetId,
                relationshipType: 'FRIENDSHIP',
                strength: 18 + (3 * intensity),
                trust: 12 + (2 * intensity),
                romance: 8 * intensity,
                betrayal: 0,
                formedAtTick: tick
            }
        },
        {
            table: 'agentState',
            operation: 'update',
            where: { actorId: actor.id },
            data: {
                social: clamp((agentState.social ?? 0) + (4 * intensity), 0, 100),
                fun: clamp((agentState.fun ?? 0) + (3 * intensity), 0, 100),
            }
        }];
        return {
            stateUpdates,
            events: [{
                actorId: actor.id,
                type: EventType.EVENT_ROMANTIC_INTERACTION,
                targetIds: [resolvedTargetId],
                outcome: EventOutcome.SUCCESS,
                sideEffects: { targetId: resolvedTargetId, action: 'romantic_first_contact', newRelationship: true }
            }],
            intentStatus: IntentStatus.EXECUTED
        };
    }
    if (Number(relationship.strength ?? 0) < 15 || Number(relationship.trust ?? 0) < 10) {
        return fail(actor.id, EventType.EVENT_ROMANTIC_INTERACTION, 'Relationship too hostile for romance');
    }

    const intensity = clamp(Number(params?.intensity ?? 1), 1, 3);
    const romanticCost = SOCIALIZE_COST_BASE * intensity;
    if (!wallet) return fail(actor.id, EventType.EVENT_ROMANTIC_INTERACTION, 'Missing wallet');
    const agentWallet = await prisma.agentWallet.findUnique({ where: { actorId: actor.id } });
    if (!agentWallet) return fail(actor.id, EventType.EVENT_ROMANTIC_INTERACTION, 'Missing on-chain wallet');
    const walletBalance = new Decimal(wallet.balanceSbyte.toString());
    if (walletBalance.lessThan(romanticCost)) {
        return fail(actor.id, EventType.EVENT_ROMANTIC_INTERACTION, 'Insufficient balance for romance');
    }
    const onchainSbyte = new Decimal(agentWallet.balanceSbyte.toString());
    if (onchainSbyte.lessThan(romanticCost)) {
        return fail(actor.id, EventType.EVENT_ROMANTIC_INTERACTION, 'Insufficient on-chain balance for romance');
    }
    const onchainMon = new Decimal(agentWallet.balanceMon.toString());
    if (onchainMon.lte(0)) {
        return fail(actor.id, EventType.EVENT_ROMANTIC_INTERACTION, 'Insufficient MON for romance gas');
    }

    const deltaRomance = 5 * intensity;
    const deltaTrust = 2 * intensity;
    const deltaStrength = 1 * intensity;
    const socialGain = 4 * intensity;
    const funGain = 3 * intensity;
    const purposeGain = 1 * intensity;

    const stateUpdates: StateUpdate[] = [];
    stateUpdates.push({
        table: 'agentState',
        operation: 'update',
        where: { actorId: actor.id },
        data: {
            social: clamp((agentState.social ?? 0) + socialGain, 0, 100),
            fun: clamp((agentState.fun ?? 0) + funGain, 0, 100),
            purpose: clamp((agentState.purpose ?? 0) + purposeGain, 0, 100),
        }
    });
    if (target.agentState) {
        stateUpdates.push({
            table: 'agentState',
            operation: 'update',
            where: { actorId: resolvedTargetId },
            data: {
                social: { increment: Math.floor(socialGain * 0.5) },
                fun: { increment: Math.floor(funGain * 0.5) },
            }
        });
    }

    const actorPersona = await prisma.personaState.findUnique({ where: { actorId: actor.id } });
    const targetPersona = await prisma.personaState.findUnique({ where: { actorId: resolvedTargetId } });
    const nextActorLoneliness = clamp((actorPersona?.loneliness ?? 30) - (10 * intensity), 0, 100);
    if (actorPersona) {
        stateUpdates.push({
            table: 'personaState',
            operation: 'update',
            where: { actorId: actor.id },
            data: { loneliness: nextActorLoneliness }
        });
    } else {
        stateUpdates.push({
            table: 'personaState',
            operation: 'create',
            data: { actorId: actor.id, loneliness: nextActorLoneliness }
        });
    }
    const nextTargetLoneliness = clamp((targetPersona?.loneliness ?? 30) - (8 * intensity), 0, 100);
    if (targetPersona) {
        stateUpdates.push({
            table: 'personaState',
            operation: 'update',
            where: { actorId: resolvedTargetId },
            data: { loneliness: nextTargetLoneliness }
        });
    } else {
        stateUpdates.push({
            table: 'personaState',
            operation: 'create',
            data: { actorId: resolvedTargetId, loneliness: nextTargetLoneliness }
        });
    }

    stateUpdates.push({
        table: 'relationship',
        operation: 'update',
        where: {
            actorAId_actorBId: {
                actorAId: relationship.actorAId,
                actorBId: relationship.actorBId
            }
        },
        data: {
            romance: clamp(Number(relationship.romance ?? 0) + deltaRomance, 0, 100),
            trust: clamp(Number(relationship.trust ?? 0) + deltaTrust, 0, 100),
            strength: clamp(Number(relationship.strength ?? 0) + deltaStrength, 0, 100),
            betrayal: clamp(Number(relationship.betrayal ?? 0) - 1, 0, 100)
        }
    });

    const targetCityId = target.agentState?.cityId ?? null;
    const crossCity = Boolean(targetCityId && agentState.cityId && targetCityId !== agentState.cityId);
    let romanticTxHash: string | null = null;
    if (romanticCost > 0) {
        try {
            const transfer = await agentTransferService.transfer(
                actor.id,
                resolvedTargetId,
                ethers.parseEther(romanticCost.toString()),
                'romantic_interaction',
                targetCityId ?? agentState.cityId ?? undefined,
                undefined,
                crossCity ? 2 : 1
            );
            romanticTxHash = transfer.txHash;
        } catch (error: any) {
            debugLog('social.handle_romantic.payment_failed', {
                actorId: actor.id,
                targetId,
                error: String(error?.message || error)
            });
            return fail(actor.id, EventType.EVENT_ROMANTIC_INTERACTION, 'Romance payment failed');
        }
    }

    debugLog('social.handle_romantic.success', {
        actorId: actor.id,
        tick,
        targetId: resolvedTargetId,
        deltaRomance,
        deltaTrust,
        deltaStrength,
        socialGain,
        funGain,
        purposeGain,
    });

    return {
        stateUpdates,
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_ROMANTIC_INTERACTION,
            targetIds: [resolvedTargetId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                targetId: resolvedTargetId,
                action: 'romantic_interaction',
                deltaRomance,
                deltaTrust,
                deltaStrength,
                cost: romanticCost,
                txHash: romanticTxHash,
                crossCity,
                targetCityId
            }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleProposeDating: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    const params = intent.params as { targetId?: string };
    const targetId = await resolveSocialTarget(actor.id, agentState, params?.targetId);
    if (!targetId) return fail(actor.id, EventType.EVENT_DATING_PROPOSED, 'No nearby social target');

    // Check if self
    if (targetId === actor.id) return fail(actor.id, EventType.EVENT_DATING_PROPOSED, 'Cannot date self');

    // Check for existing dating/marriage
    const existing = await prisma.consent.findFirst({
        where: {
            OR: [
                { partyAId: actor.id, partyBId: targetId },
                { partyAId: targetId, partyBId: actor.id }
            ],
            type: { in: ['dating', 'marriage'] },
            status: { in: ['active', 'pending'] }
        }
    });

    if (existing) return fail(actor.id, EventType.EVENT_DATING_PROPOSED, 'Already dating/married or pending');

    // Create Consent
    return {
        stateUpdates: [{
            table: 'consent',
            operation: 'create',
            data: {
                type: 'dating',
                partyAId: actor.id,
                partyBId: params.targetId,
                status: 'pending',
                cityId: agentState?.cityId ?? null
            }
        }],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_DATING_PROPOSED,
            targetIds: [targetId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { targetId }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleProposeAlliance: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    const params = intent.params as { targetId?: string; allianceType?: string; terms?: Record<string, unknown>; formationFee?: number; cityId?: string };
    if (!params?.allianceType) return fail(actor.id, EventType.EVENT_ALLIANCE_PROPOSED, 'Missing allianceType');
    const targetId = await resolveSocialTarget(actor.id, agentState, params.targetId);
    if (!targetId) return fail(actor.id, EventType.EVENT_ALLIANCE_PROPOSED, 'No nearby social target');
    if (targetId === actor.id) return fail(actor.id, EventType.EVENT_ALLIANCE_PROPOSED, 'Cannot ally self');

    return {
        stateUpdates: [{
            table: 'alliance',
            operation: 'create',
            data: {
                allianceType: params.allianceType,
                memberIds: [actor.id, targetId],
                leaderId: actor.id,
                terms: params.terms ?? {},
                formedAtTick: tick,
                status: 'pending'
            }
        }],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_ALLIANCE_PROPOSED,
            targetIds: [targetId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { allianceType: params.allianceType, formationFee: params.formationFee ?? 0 }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleAcceptAlliance: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    const params = intent.params as { allianceId?: string; formationFee?: number; cityId?: string };
    if (!params?.allianceId) return fail(actor.id, EventType.EVENT_ALLIANCE_RESOLVED, 'Missing allianceId');
    const alliance = await prisma.alliance.findUnique({ where: { id: params.allianceId } });
    if (!alliance || alliance.status !== 'pending') return fail(actor.id, EventType.EVENT_ALLIANCE_RESOLVED, 'Invalid alliance');
    if (!alliance.memberIds.includes(actor.id)) return fail(actor.id, EventType.EVENT_ALLIANCE_RESOLVED, 'Not a member');

    if (params.formationFee && params.formationFee > 0 && params.cityId) {
        await agentTransferService.transfer(
            actor.id,
            null,
            ethers.parseEther(params.formationFee.toString()),
            'alliance_fee',
            params.cityId,
            CONTRACTS.PUBLIC_VAULT_AND_GOD
        );
    }

    return {
        stateUpdates: [{
            table: 'alliance',
            operation: 'update',
            where: { id: alliance.id },
            data: { status: 'active' }
        }],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_ALLIANCE_RESOLVED,
            targetIds: alliance.memberIds,
            outcome: EventOutcome.SUCCESS,
            sideEffects: { allianceId: alliance.id, action: 'accept' }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleRejectAlliance: IntentHandler = async (intent, actor) => {
    const params = intent.params as { allianceId?: string };
    if (!params?.allianceId) return fail(actor.id, EventType.EVENT_ALLIANCE_RESOLVED, 'Missing allianceId');
    return {
        stateUpdates: [{
            table: 'alliance',
            operation: 'update',
            where: { id: params.allianceId },
            data: { status: 'dissolved' }
        }],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_ALLIANCE_RESOLVED,
            targetIds: [],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { allianceId: params.allianceId, action: 'reject' }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleBetrayAlliance: IntentHandler = async (intent, actor) => {
    const params = intent.params as { allianceId?: string };
    if (!params?.allianceId) return fail(actor.id, EventType.EVENT_ALLIANCE_BETRAYED, 'Missing allianceId');
    return {
        stateUpdates: [{
            table: 'alliance',
            operation: 'update',
            where: { id: params.allianceId },
            data: { status: 'dissolved' }
        }],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_ALLIANCE_BETRAYED,
            targetIds: [],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { allianceId: params.allianceId }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleEndRivalry: IntentHandler = async (intent, actor) => {
    const params = intent.params as { relationshipId?: string };
    if (!params?.relationshipId) return fail(actor.id, EventType.EVENT_RELATIONSHIP_CHANGED, 'Missing relationshipId');
    return {
        stateUpdates: [{
            table: 'relationship',
            operation: 'update',
            where: { id: params.relationshipId },
            data: { strength: 0 }
        }],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_RELATIONSHIP_CHANGED,
            targetIds: [],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { action: 'end_rivalry', relationshipId: params.relationshipId }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleForgiveGrudge: IntentHandler = async (intent, actor) => {
    const params = intent.params as { relationshipId?: string };
    if (!params?.relationshipId) return fail(actor.id, EventType.EVENT_RELATIONSHIP_CHANGED, 'Missing relationshipId');
    return {
        stateUpdates: [{
            table: 'relationship',
            operation: 'update',
            where: { id: params.relationshipId },
            data: { strength: 0 }
        }],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_RELATIONSHIP_CHANGED,
            targetIds: [],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { action: 'forgive_grudge', relationshipId: params.relationshipId }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleAcceptDating: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    const params = intent.params as { consentId?: string };
    if (!params?.consentId) return fail(actor.id, EventType.EVENT_DATING_RESOLVED, 'Missing consentId');

    const consent = await prisma.consent.findUnique({ where: { id: params.consentId } });
    if (!consent) return fail(actor.id, EventType.EVENT_DATING_RESOLVED, 'Consent not found');
    if (consent.type !== 'dating') return fail(actor.id, EventType.EVENT_DATING_RESOLVED, 'Not a dating consent');
    if (consent.status !== 'pending') return fail(actor.id, EventType.EVENT_DATING_RESOLVED, 'Not pending');
    if (consent.partyBId !== actor.id) return fail(actor.id, EventType.EVENT_DATING_RESOLVED, 'Not the target of proposal');

    return {
        stateUpdates: [{
            table: 'consent',
            operation: 'update',
            where: { id: consent.id },
            data: { status: 'active' }
        }],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_DATING_RESOLVED,
            targetIds: [consent.partyAId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                action: 'accept',
                consentId: consent.id
            }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleEndDating: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    const params = intent.params as { targetId?: string };
    if (!params?.targetId) return fail(actor.id, EventType.EVENT_DATING_ENDED, 'Missing targetId');

    const consent = await prisma.consent.findFirst({
        where: {
            OR: [
                { partyAId: actor.id, partyBId: params.targetId },
                { partyAId: params.targetId, partyBId: actor.id }
            ],
            type: 'dating',
            status: 'active'
        }
    });

    if (!consent) return fail(actor.id, EventType.EVENT_DATING_ENDED, 'No active dating found');

    return {
        stateUpdates: [{
            table: 'consent',
            operation: 'update',
            where: { id: consent.id },
            data: { status: 'ended', expiresAt: new Date() }
        }],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_DATING_ENDED,
            targetIds: [params.targetId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { targetId: params.targetId }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleProposeMarriage: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    const params = intent.params as { targetId?: string };
    if (!params?.targetId) return fail(actor.id, EventType.EVENT_MARRIAGE_PROPOSED, 'Missing targetId');

    // Must be dating first (MVP rule?)
    const dating = await prisma.consent.findFirst({
        where: {
            OR: [
                { partyAId: actor.id, partyBId: params.targetId },
                { partyAId: params.targetId, partyBId: actor.id }
            ],
            type: 'dating',
            status: 'active'
        }
    });

    if (!dating) return fail(actor.id, EventType.EVENT_MARRIAGE_PROPOSED, 'Must be dating first');

    // Check existing marriage
    const married = await prisma.consent.findFirst({
        where: {
            OR: [
                { partyAId: actor.id },
                { partyBId: actor.id },
                { partyAId: params.targetId },
                { partyBId: params.targetId }
            ],
            type: 'marriage',
            status: 'active'
        }
    });

    if (married) return fail(actor.id, EventType.EVENT_MARRIAGE_PROPOSED, 'One party is already married');

    return {
        stateUpdates: [{
            table: 'consent',
            operation: 'create',
            data: {
                type: 'marriage',
                partyAId: actor.id,
                partyBId: params.targetId,
                status: 'pending',
                cityId: agentState?.cityId ?? null
            }
        }],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_MARRIAGE_PROPOSED,
            targetIds: [params.targetId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { targetId: params.targetId }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleAcceptMarriage: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    const params = intent.params as { consentId?: string };
    if (!params?.consentId) return fail(actor.id, EventType.EVENT_MARRIAGE_RESOLVED, 'Missing consentId');

    const consent = await prisma.consent.findUnique({ where: { id: params.consentId } });
    if (!consent) return fail(actor.id, EventType.EVENT_MARRIAGE_RESOLVED, 'Consent not found');
    if (consent.type !== 'marriage') return fail(actor.id, EventType.EVENT_MARRIAGE_RESOLVED, 'Not a marriage consent');
    if (consent.status !== 'pending') return fail(actor.id, EventType.EVENT_MARRIAGE_RESOLVED, 'Not pending');
    if (consent.partyBId !== actor.id) return fail(actor.id, EventType.EVENT_MARRIAGE_RESOLVED, 'Not the target');

    // Upgrade dating to ended? Or keep as history? 
    // Let's end the dating consent formally as they are now married? Or just leave it. 
    // Usually 'dating' implies pre-marriage. Let's find and end the dating consent.
    const dating = await prisma.consent.findFirst({
        where: {
            OR: [
                { partyAId: consent.partyAId, partyBId: consent.partyBId },
                { partyAId: consent.partyBId, partyBId: consent.partyAId }
            ],
            type: 'dating',
            status: 'active'
        }
    });

    const stateUpdates: StateUpdate[] = [
        {
            table: 'consent',
            operation: 'update',
            where: { id: consent.id },
            data: { status: 'active' }
        },
        {
            table: 'actor',
            operation: 'update',
            where: { id: consent.partyAId },
            data: { reputation: { increment: 25 } }
        },
        {
            table: 'actor',
            operation: 'update',
            where: { id: consent.partyBId },
            data: { reputation: { increment: 25 } }
        }
    ];

    if (dating) {
        stateUpdates.push({
            table: 'consent',
            operation: 'update',
            where: { id: dating.id },
            data: { status: 'ended' } // Replaced by marriage
        });
    }

    const spouseMoveExists = await prisma.consent.findFirst({
        where: {
            type: 'spouse_move',
            status: { in: ['pending', 'active'] },
            OR: [
                { partyAId: consent.partyAId, partyBId: consent.partyBId },
                { partyAId: consent.partyBId, partyBId: consent.partyAId }
            ]
        }
    });
    if (!spouseMoveExists) {
        const spouseAState = await prisma.agentState.findUnique({ where: { actorId: consent.partyAId }, select: { cityId: true } });
        const spouseBState = await prisma.agentState.findUnique({ where: { actorId: consent.partyBId }, select: { cityId: true } });
        const fromCityId = spouseAState?.cityId ?? null;
        const targetCityId = spouseBState?.cityId ?? null;
        if (fromCityId && targetCityId && fromCityId !== targetCityId) {
            stateUpdates.push({
                table: 'consent',
                operation: 'create',
                data: {
                    type: 'spouse_move',
                    partyAId: consent.partyAId,
                    partyBId: consent.partyBId,
                    status: 'pending',
                    cityId: fromCityId,
                    terms: { targetCityId, fromCityId, reason: 'marriage_cohabitation' }
                }
            });
        }
    }

    return {
        stateUpdates,
        events: [
            {
                actorId: actor.id,
                type: EventType.EVENT_REPUTATION_UPDATED,
                targetIds: [],
                outcome: EventOutcome.SUCCESS,
                sideEffects: { delta: 25, reason: 'marriage' }
            },
            {
                actorId: actor.id,
                type: EventType.EVENT_MARRIAGE_RESOLVED,
                targetIds: [consent.partyAId],
                outcome: EventOutcome.SUCCESS,
                sideEffects: {
                    action: 'accept',
                    consentId: consent.id
                }
            }
        ],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleAcceptSpouseMove: IntentHandler = async (intent, actor) => {
    const params = intent.params as { consentId?: string };
    if (!params?.consentId) return fail(actor.id, EventType.EVENT_SPOUSE_MOVE_CONSENT, 'Missing consentId');

    const consent = await prisma.consent.findUnique({ where: { id: params.consentId } });
    if (!consent) return fail(actor.id, EventType.EVENT_SPOUSE_MOVE_CONSENT, 'Consent not found');
    if (consent.type !== 'spouse_move') return fail(actor.id, EventType.EVENT_SPOUSE_MOVE_CONSENT, 'Not a spouse move consent');
    if (consent.status !== 'pending') return fail(actor.id, EventType.EVENT_SPOUSE_MOVE_CONSENT, 'Not pending');
    if (consent.partyBId !== actor.id) return fail(actor.id, EventType.EVENT_SPOUSE_MOVE_CONSENT, 'Not the target');

    return {
        stateUpdates: [{
            table: 'consent',
            operation: 'update',
            where: { id: consent.id },
            data: { status: 'active' }
        }],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_SPOUSE_MOVE_CONSENT,
            targetIds: [consent.partyAId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { action: 'accept', consentId: consent.id }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleRejectSpouseMove: IntentHandler = async (intent, actor) => {
    const params = intent.params as { consentId?: string };
    if (!params?.consentId) return fail(actor.id, EventType.EVENT_SPOUSE_MOVE_CONSENT, 'Missing consentId');

    const consent = await prisma.consent.findUnique({ where: { id: params.consentId } });
    if (!consent) return fail(actor.id, EventType.EVENT_SPOUSE_MOVE_CONSENT, 'Consent not found');
    if (consent.type !== 'spouse_move') return fail(actor.id, EventType.EVENT_SPOUSE_MOVE_CONSENT, 'Not a spouse move consent');
    if (consent.status !== 'pending') return fail(actor.id, EventType.EVENT_SPOUSE_MOVE_CONSENT, 'Not pending');
    if (consent.partyBId !== actor.id) return fail(actor.id, EventType.EVENT_SPOUSE_MOVE_CONSENT, 'Not the target');

    return {
        stateUpdates: [{
            table: 'consent',
            operation: 'update',
            where: { id: consent.id },
            data: { status: 'ended', expiresAt: new Date() }
        }],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_SPOUSE_MOVE_CONSENT,
            targetIds: [consent.partyAId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { action: 'reject', consentId: consent.id }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleDivorce: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    const params = intent.params as { targetId?: string };
    if (!params?.targetId) return fail(actor.id, EventType.EVENT_DIVORCE, 'Missing targetId');

    const marriage = await prisma.consent.findFirst({
        where: {
            OR: [
                { partyAId: actor.id, partyBId: params.targetId },
                { partyAId: params.targetId, partyBId: actor.id }
            ],
            type: 'marriage',
            status: 'active'
        }
    });

    if (!marriage) return fail(actor.id, EventType.EVENT_DIVORCE, 'No active marriage found');

    // Split assets? For MVP, we'll just end the status. 
    // Complex asset splitting requires holding "Household" balance or analyzing history.
    // We'll skip complex financial splitting for now.

    return {
        stateUpdates: [
            {
                table: 'consent',
                operation: 'update',
                where: { id: marriage.id },
                data: { status: 'ended', expiresAt: new Date() }
            },
            {
                table: 'actor',
                operation: 'update',
                where: { id: actor.id },
                data: { reputation: { increment: -15 } }
            }
        ],
        events: [
            {
                actorId: actor.id,
                type: EventType.EVENT_REPUTATION_UPDATED,
                targetIds: [],
                outcome: EventOutcome.SUCCESS,
                sideEffects: { delta: -15, reason: 'divorce' }
            },
            {
                actorId: actor.id,
                type: EventType.EVENT_DIVORCE,
                targetIds: [params.targetId],
                outcome: EventOutcome.SUCCESS,
                sideEffects: { targetId: params.targetId }
            }
        ],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleHouseholdTransfer: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    const params = intent.params as { targetId?: string, amount?: number };
    if (!params?.targetId || !params.amount) return fail(actor.id, EventType.EVENT_HOUSEHOLD_TRANSFER, 'Missing params');
    if (params.amount <= 0) return fail(actor.id, EventType.EVENT_HOUSEHOLD_TRANSFER, 'Invalid amount');

    // Verify marriage
    const marriage = await prisma.consent.findFirst({
        where: {
            OR: [
                { partyAId: actor.id, partyBId: params.targetId },
                { partyAId: params.targetId, partyBId: actor.id }
            ],
            type: 'marriage',
            status: 'active'
        }
    });

    if (!marriage) return fail(actor.id, EventType.EVENT_HOUSEHOLD_TRANSFER, 'Not married to target');

    const balance = new Decimal(wallet?.balanceSbyte.toString() || '0');
    const amount = new Decimal(params.amount);

    if (balance.lessThan(amount)) return fail(actor.id, EventType.EVENT_HOUSEHOLD_TRANSFER, 'Insufficient funds');

    return {
        stateUpdates: [
            {
                table: 'wallet',
                operation: 'update',
                where: { actorId: actor.id },
                data: { balanceSbyte: { decrement: amount.toNumber() } }
            },
            {
                table: 'wallet',
                operation: 'update',
                where: { actorId: params.targetId },
                data: { balanceSbyte: { increment: amount.toNumber() } }
            }
        ],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_HOUSEHOLD_TRANSFER,
            targetIds: [params.targetId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { amount: amount.toString() }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

// ============================================================================
// BLACKLIST HANDLER
// ============================================================================

export const handleBlacklist: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    const params = intent.params as { targetId?: string; action?: 'add' | 'remove' };
    if (!params?.targetId) return fail(actor.id, EventType.EVENT_BLACKLIST_UPDATED, 'Missing targetId');

    // Check if self
    if (params.targetId === actor.id) return fail(actor.id, EventType.EVENT_BLACKLIST_UPDATED, 'Cannot blacklist self');

    const action = params.action || 'add';

    // Check if target exists
    const target = await prisma.actor.findUnique({ where: { id: params.targetId } });
    if (!target) return fail(actor.id, EventType.EVENT_BLACKLIST_UPDATED, 'Target not found');

    // Find or create relationship
    const relationship = await prisma.relationship.findUnique({
        where: {
            actorAId_actorBId: {
                actorAId: actor.id,
                actorBId: params.targetId
            }
        }
    });

    const stateUpdates: StateUpdate[] = [];

    if (action === 'add') {
        // Blacklisting: set betrayal to 100, trust to 0
        if (relationship) {
            stateUpdates.push({
                table: 'relationship',
                operation: 'update',
                where: {
                    actorAId_actorBId: {
                        actorAId: actor.id,
                        actorBId: params.targetId
                    }
                },
                data: { trust: 0, betrayal: 100 }
            });
        } else {
            stateUpdates.push({
                table: 'relationship',
                operation: 'create',
                data: {
                    actorAId: actor.id,
                    actorBId: params.targetId,
                    trust: 0,
                    betrayal: 100,
                    romance: 0
                }
            });
        }
    } else {
        // Removing from blacklist: reset betrayal but keep low trust
        if (relationship) {
            stateUpdates.push({
                table: 'relationship',
                operation: 'update',
                where: {
                    actorAId_actorBId: {
                        actorAId: actor.id,
                        actorBId: params.targetId
                    }
                },
                data: { betrayal: 0, trust: 10 }
            });
        }
    }

    return {
        stateUpdates,
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_BLACKLIST_UPDATED,
            targetIds: [params.targetId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                action,
                targetId: params.targetId
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

async function resolveSocialTarget(actorId: string, agentState: { cityId?: string | null } | null, targetId?: string) {
    if (targetId) return targetId;
    if (!agentState?.cityId) return null;
    const candidate = await prisma.actor.findFirst({
        where: {
            id: { not: actorId },
            kind: 'agent',
            dead: false,
            frozen: false,
            agentState: {
                cityId: agentState.cityId,
                health: { gt: 0 }
            }
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true }
    });
    if (candidate?.id) return candidate.id;
    const crossCityCandidate = await prisma.actor.findFirst({
        where: {
            id: { not: actorId },
            kind: 'agent',
            dead: false,
            frozen: false,
            agentState: {
                cityId: { not: agentState.cityId },
                health: { gt: 0 }
            }
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true }
    });
    return crossCityCandidate?.id ?? null;
}

