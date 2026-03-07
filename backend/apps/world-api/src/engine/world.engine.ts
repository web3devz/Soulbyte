/**
 * World Engine - Main tick processor
 * Processes pending intents deterministically
 * 
 * Input: (state_snapshot, intent, seed)
 * Output: (state_updates, events)
 * 
 * Engine commits state_updates atomically in DB transaction.
 */
import { prisma } from '../db.js';
import crypto from 'crypto';
import { IntentStatus, IntentType } from '../types/intent.types.js';
import { EventType, EventOutcome } from '../types/event.types.js';
import { Decimal } from 'decimal.js';
import { calculateFees, getCachedVaultHealth, getDynamicFeeBps } from '../config/fees.js';
import { recordIntentOutcome } from './memory.engine.js';
import { MemoryManager } from './agent-brain/memory-manager.js';
import {
    IntentRecord,
    ActorRecord,
    AgentStateRecord,
    WalletRecord,
    StateUpdate,
    EventData,
    IntentHandler
} from './engine.types.js';
import { AgentTransferService } from '../services/agent-transfer.service.js';
import { ethers } from 'ethers';
import { PRIVATE_WORK_HOURS_MULTIPLIER, WORK_SEGMENTS_PER_DAY } from '../config/work.js';
import { validateGovernanceProposal } from '../services/governance-validation.js';
import { createOnchainJobUpdate } from '../services/onchain-queue.service.js';
import { classifyKeyEvent, classifyKeyEventPriority } from './key-events.engine.js';
import {
    canStartWorkSegment,
    getWorkSegmentDurationTicks,
    registerWorkSegmentCompletion,
    getWorkStrainTierForJobType,
    getWorkStatusCost
} from './work.utils.js';
import { isIntentAllowedWhileBusy } from './intent-guards.js';

// Import Handlers
import * as EconomyHandlers from './handlers/economy.handlers.js';
import * as SocialHandlers from './handlers/social.handlers.js';
import * as ConstructionHandlers from './handlers/construction.handlers.js';
import * as GovernanceHandlers from './handlers/governance.handlers.js';
import * as CrimeHandlers from './handlers/crime.handlers.js';
import * as AgoraHandlers from './handlers/agora.handlers.js';
import * as PublicEmploymentHandlers from './handlers/public-employment.handlers.js';
import * as PropertyHandlers from './handlers/property.handlers.js';
import * as CombatHandlers from './handlers/combat.handlers.js';
import * as PoliceHandlers from './handlers/police.handlers.js';
import * as GamingHandlers from './handlers/gaming.handlers.js';
import * as CraftingHandlers from './handlers/crafting.handlers.js';
import * as LifeHandlers from './handlers/life.handlers.js';
import * as BusinessHandlers from './handlers/business.handlers.js';
import { logAgoraDebug } from './agora/agora-debug.service.js';
import { WalletService } from '../services/wallet.service.js';

const agentTransferService = new AgentTransferService();
const walletService = new WalletService();

const SBYTE_SPEND_INTENTS = new Set<IntentType>([
    IntentType.INTENT_BUY_PROPERTY,
    IntentType.INTENT_MAINTAIN_PROPERTY,
    IntentType.INTENT_FOUND_BUSINESS,
    IntentType.INTENT_CONVERT_BUSINESS,
    IntentType.INTENT_UPGRADE_BUSINESS,
    IntentType.INTENT_BUY_BUSINESS,
    IntentType.INTENT_INJECT_BUSINESS_FUNDS,
    IntentType.INTENT_BUSINESS_INJECT,
    IntentType.INTENT_BUY_ITEM,
    IntentType.INTENT_BUY,
    IntentType.INTENT_VISIT_BUSINESS,
    IntentType.INTENT_PAY_RENT,
    IntentType.INTENT_CHALLENGE_GAME,
    IntentType.INTENT_ACCEPT_GAME,
    IntentType.INTENT_PLAY_GAME,
    IntentType.INTENT_BET,
    IntentType.INTENT_HOUSEHOLD_TRANSFER,
    IntentType.INTENT_SOCIALIZE,
]);

function buildKeyEventContext(input: {
    actorName: string;
    cityName: string | null;
    targetNames: string[];
    sideEffects?: Record<string, unknown>;
    outcome: EventOutcome;
}) {
    const sideEffects = input.sideEffects ?? {};
    const targetName = input.targetNames[0] ?? 'Unknown';
    return {
        ...sideEffects,
        outcome: input.outcome,
        actor: input.actorName,
        actorA: input.actorName,
        actorB: targetName,
        targetName,
        city: input.cityName ?? 'Unknown',
        businessType: sideEffects.businessType ?? sideEffects.business_type ?? sideEffects.category,
        crimeType: sideEffects.type ?? sideEffects.crimeType,
        proposalType: sideEffects.proposalType ?? sideEffects.proposal_type,
        reason: sideEffects.reason ?? sideEffects.blockReason,
        newHousingTier: sideEffects.newHousingTier ?? sideEffects.housingTier,
    };
}

function buildWebhookPayload(input: {
    eventType: string;
    fallbackHeadline: string | null;
    actorName: string;
    cityName: string | null;
    targetNames: string[];
    sideEffects?: Record<string, unknown>;
}) {
    return {
        task: 'enhance_headline',
        event_type: input.eventType,
        fallback_headline: input.fallbackHeadline,
        actor_name: input.actorName,
        target_names: input.targetNames,
        city_name: input.cityName,
        context: input.sideEffects ?? {},
    };
}

function formatIntentLabel(intentType: string) {
    return String(intentType)
        .replace(/^INTENT_/, '')
        .toLowerCase()
        .split('_')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

function formatEventLabel(eventType: string, targetNames: string[], sideEffects?: Record<string, unknown>) {
    const target = targetNames[0] ?? 'someone';
    if (eventType === 'EVENT_SOCIALIZED') return `Socialized with ${target}.`;
    if (eventType === 'EVENT_FLIRTED') return `Flirted with ${target}.`;
    if (eventType === 'EVENT_DATING_RESOLVED') return `Dating outcome with ${target}.`;
    if (eventType === 'EVENT_PROPOSAL_ACCEPTED') return `Proposal accepted by ${target}.`;
    if (eventType === 'EVENT_PROPOSAL_REJECTED') return `Proposal rejected by ${target}.`;
    if (eventType === 'EVENT_BUSINESS_FOUNDED' || eventType === 'EVENT_BUSINESS_CONVERTED') {
        const businessType = String((sideEffects as any)?.businessType ?? (sideEffects as any)?.business_type ?? 'business');
        return `Business opened: ${businessType}.`;
    }
    return eventType
        .replace(/^EVENT_/, '')
        .toLowerCase()
        .split('_')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

/**
 * Process a single world tick
 */
export async function processTick(currentTick: number, seed: bigint): Promise<{
    processedIntents: number;
    events: EventData[];
}> {
    const events: EventData[] = [];
    let processedIntents = 0;

    // Get pending intents for this tick (or earlier unprocessed)
    const pendingIntents = await prisma.intent.findMany({
        where: {
            status: 'pending',
            tick: { lte: currentTick },
        },
        orderBy: [
            { priority: 'desc' },
            { createdAt: 'asc' }, // Stable tie-break
        ],
    });

    // Group by actor - only one intent per actor per tick
    const intentsByActor = new Map<string, typeof pendingIntents>();
    for (const intent of pendingIntents) {
        if (!intentsByActor.has(intent.actorId)) {
            intentsByActor.set(intent.actorId, []);
        }
        intentsByActor.get(intent.actorId)!.push(intent);
    }

    // Process one intent per actor
    for (const [actorId, actorIntents] of intentsByActor) {
        const result = await processActorIntents(actorId, actorIntents, currentTick, seed);
        events.push(...result.events);
        processedIntents += result.processedCount;
    }

    return { processedIntents, events };
}

/**
 * Process intents for a single actor
 */
async function processActorIntents(
    actorId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    actorIntents: any[], // using any to avoid type complexity with Prisma return types in separate function
    currentTick: number,
    seed: bigint
): Promise<{ processedCount: number; events: EventData[] }> {
    const events: EventData[] = [];
    let processedCount = 0;

    const actionableIntents = actorIntents;
    if (actionableIntents.length === 0) {
        return { processedCount, events };
    }
    // Pick highest priority intent (already sorted)
    const intent = actionableIntents[0];
    if (isAgoraIntent(intent.type)) {
        void logAgoraDebug({
            scope: 'agora.intent.selected',
            actorId,
            tick: currentTick,
            payload: { intentType: intent.type, intentId: intent.id }
        });
    }

    // Get actor with state
    const actor = await prisma.actor.findUnique({
        where: { id: actorId },
        include: {
            agentState: true,
            wallet: true,
            jail: true,
        },
    });

    if (!actor) {
        await markIntentBlocked(intent.id, 'Actor not found', currentTick);
        if (isAgoraIntent(intent.type)) {
            void logAgoraDebug({
                scope: 'agora.intent.blocked',
                actorId,
                tick: currentTick,
                payload: { intentType: intent.type, reason: 'Actor not found' }
            });
        }
        return { processedCount, events };
    }

    // Validate actor can act
    if (actor.frozen || actor.dead || actor.jail) {
        await markIntentBlocked(intent.id, actor.frozen ? 'Actor frozen' : (actor.dead ? 'Actor dead' : 'Actor jailed'), currentTick);
        if (isAgoraIntent(intent.type)) {
            void logAgoraDebug({
                scope: 'agora.intent.blocked',
                actorId,
                tick: currentTick,
                payload: {
                    intentType: intent.type,
                    reason: actor.frozen ? 'Actor frozen' : (actor.dead ? 'Actor dead' : 'Actor jailed')
                }
            });
        }
        return { processedCount, events };
    }

    const intentParams = (intent.params as any) ?? {};
    const ownerOverride = Boolean(intentParams.ownerOverride);

    // Activity state blocking - prevent new intents if busy
    if (actor.agentState) {
        const { activityState, activityEndTick } = actor.agentState;
        const isBusy = Boolean(activityState && activityState !== 'IDLE');
        const hunger = Number(actor.agentState.hunger ?? 100);
        const energy = Number(actor.agentState.energy ?? 100);
        const health = Number(actor.agentState.health ?? 100);
        const urgentHunger = hunger <= 40;
        const urgentEnergy = energy <= 35;
        const urgentHealth = health <= 40;
        const emergencyBusyOverride = (
            (urgentHunger && ['INTENT_CONSUME_ITEM', 'INTENT_BUY_ITEM', 'INTENT_VISIT_BUSINESS'].includes(intent.type))
            || (urgentEnergy && intent.type === 'INTENT_REST')
            || (urgentHealth && intent.type === 'INTENT_VISIT_BUSINESS')
        );

        // Check if busy (Spec 10.1)
        if (isBusy && !isIntentAllowedWhileBusy(intent.type) && !emergencyBusyOverride) {
            if (ownerOverride && activityState === 'RESTING') {
                if (energy > 20) {
                    await prisma.agentState.update({
                        where: { actorId },
                        data: { activityState: 'IDLE', activityEndTick: null },
                    });
                    actor.agentState.activityState = 'IDLE';
                    actor.agentState.activityEndTick = null;
                } else {
                    await markIntentBlocked(intent.id, 'Too exhausted to interrupt rest', currentTick);
                    if (isAgoraIntent(intent.type)) {
                        void logAgoraDebug({
                            scope: 'agora.intent.blocked',
                            actorId,
                            tick: currentTick,
                            payload: { intentType: intent.type, reason: 'Too exhausted to interrupt rest' }
                        });
                    }
                    return { processedCount, events };
                }
            } else if (ownerOverride && activityState === 'WORKING') {
                await markIntentBlocked(intent.id, 'Cannot interrupt work', currentTick);
                if (isAgoraIntent(intent.type)) {
                    void logAgoraDebug({
                        scope: 'agora.intent.blocked',
                        actorId,
                        tick: currentTick,
                        payload: { intentType: intent.type, reason: 'Cannot interrupt work' }
                    });
                }
                return { processedCount, events };
            } else {
                await markIntentBlocked(intent.id, `Busy (${activityState}) until tick ${activityEndTick}`, currentTick);
                if (isAgoraIntent(intent.type)) {
                    void logAgoraDebug({
                        scope: 'agora.intent.blocked',
                        actorId,
                        tick: currentTick,
                        payload: { intentType: intent.type, reason: `Busy (${activityState}) until tick ${activityEndTick}` }
                    });
                }
                return { processedCount, events };
            }
        }

        if (isBusy && ownerOverride) {
            await prisma.agentState.update({
                where: { actorId },
                data: { activityState: 'IDLE', activityEndTick: null },
            });
            actor.agentState.activityState = 'IDLE';
            actor.agentState.activityEndTick = null;
        }
    }

    if (SBYTE_SPEND_INTENTS.has(intent.type)) {
        try {
            await walletService.syncWalletBalances(actorId);
            actor.wallet = await prisma.wallet.findUnique({ where: { actorId } });
            if (actor.agentState) {
                const refreshedState = await prisma.agentState.findUnique({ where: { actorId } });
                if (refreshedState) {
                    actor.agentState = refreshedState;
                }
            }
        } catch (error: any) {
            await markIntentBlocked(intent.id, `Wallet sync failed: ${String(error?.message || error)}`, currentTick);
            return { processedCount, events };
        }
    }

    // Execute handler
    try {
        const handler = getHandler(intent.type);
        if (!handler) {
            await markIntentBlocked(intent.id, `No handler for intent type: ${intent.type}`, currentTick);
            return { processedCount, events };
        }

        const intentRecord: IntentRecord = {
            id: intent.id,
            actorId: intent.actorId,
            type: intent.type,
            params: intent.params,
            priority: Number(intent.priority),
        };

        const actorRecord: ActorRecord = {
            id: actor.id,
            name: actor.name,
            frozen: actor.frozen,
            dead: actor.dead,
            reputation: Number(actor.reputation ?? 200),
            luck: actor.luck ?? 50
        };

        const agentStateRecord: AgentStateRecord | null = actor.agentState ? {
            actorId: actor.agentState.actorId,
            cityId: actor.agentState.cityId,
            housingTier: actor.agentState.housingTier,
            jobType: actor.agentState.jobType,
            wealthTier: actor.agentState.wealthTier,
            health: actor.agentState.health,
            energy: actor.agentState.energy,
            hunger: actor.agentState.hunger,
            social: actor.agentState.social,
            fun: actor.agentState.fun,
            purpose: actor.agentState.purpose,
            reputationScore: actor.agentState.reputationScore,
            activityState: actor.agentState.activityState,
            activityEndTick: actor.agentState.activityEndTick,
            publicExperience: actor.agentState.publicExperience,
            anger: actor.agentState.anger,
            lastJobChangeTick: actor.agentState.lastJobChangeTick,
            lastWorkedTick: actor.agentState.lastWorkedTick,
            lastGameTick: (actor.agentState as any).lastGameTick ?? 0,
            gamesToday: (actor.agentState as any).gamesToday ?? 0,
            gameWinStreak: (actor.agentState as any).gameWinStreak ?? 0,
            recentGamingPnl: Number((actor.agentState as any).recentGamingPnl ?? 0),
            lastBigLossTick: (actor.agentState as any).lastBigLossTick ?? 0,
            totalGamesPlayed: (actor.agentState as any).totalGamesPlayed ?? 0,
            totalGamesWon: (actor.agentState as any).totalGamesWon ?? 0
        } : null;

        const walletRecord: WalletRecord | null = actor.wallet ? {
            actorId: actor.wallet.actorId,
            balanceSbyte: actor.wallet.balanceSbyte,
        } : null;

        const result = await handler(
            intentRecord,
            actorRecord,
            agentStateRecord,
            walletRecord,
            currentTick,
            seed
        );

        const blockReason = result.intentStatus === IntentStatus.BLOCKED
            ? extractBlockReason(result.events)
            : null;

        const actorCityName = actor.agentState?.cityId
            ? (await prisma.city.findUnique({
                where: { id: actor.agentState.cityId },
                select: { name: true },
            }))?.name ?? null
            : null;
        const targetActorIds = Array.from(new Set(result.events.flatMap((event) => event.targetIds ?? [])));
        const targetActors = targetActorIds.length > 0
            ? await prisma.actor.findMany({
                where: { id: { in: targetActorIds } },
                select: { id: true, name: true },
            })
            : [];
        const targetNameById = new Map(targetActors.map((entry) => [entry.id, entry.name]));

        // Apply state updates in transaction
        await prisma.$transaction(async (tx) => {
            await applyStateUpdates(tx, result.stateUpdates);

            // Create events
            if ((intent.params as any)?.source === 'owner_suggestion' && result.events.length === 0) {
                const syntheticEvent = {
                    actorId: intent.actorId,
                    type: EventType.EVENT_OWNER_SUGGESTION,
                    targetIds: [],
                    outcome: result.intentStatus === IntentStatus.EXECUTED ? EventOutcome.SUCCESS : EventOutcome.BLOCKED,
                    sideEffects: {
                        intentType: intent.type,
                        reason: blockReason ?? null,
                    },
                };
                result.events.push(syntheticEvent as any);
            }

            for (const event of result.events) {
                const eventId = crypto.randomUUID();
                const targetNames = (event.targetIds ?? []).map((id) => targetNameById.get(id)).filter(Boolean) as string[];
                const keyEventContext = buildKeyEventContext({
                    actorName: actor.name,
                    cityName: actorCityName,
                    targetNames,
                    sideEffects: (event.sideEffects ?? {}) as Record<string, unknown>,
                    outcome: event.outcome,
                });
                const classification = classifyKeyEvent(event.type, keyEventContext);
                const priorityClassification = classifyKeyEventPriority(event.type, keyEventContext);
                await tx.event.create({
                    data: {
                        id: eventId,
                        actorId: event.actorId,
                        type: event.type,
                        targetIds: event.targetIds,
                        tick: currentTick,
                        outcome: event.outcome,
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        sideEffects: event.sideEffects as any,
                        isKeyEvent: classification.isKeyEvent,
                        keyEventTier: classification.tier,
                        keyEventHeadline: classification.headline,
                        agoraTriggerBoard: classification.agoraTriggerBoard,
                    },
                });

                if ((intent.params as any)?.source === 'owner_suggestion') {
                    const reason = (event.sideEffects as any)?.reason ?? null;
                    const label = formatEventLabel(String(event.type), targetNames, event.sideEffects as any);
                    const title = event.outcome === EventOutcome.SUCCESS ? 'Event recorded' : 'Event blocked';
                    const body = event.outcome === EventOutcome.SUCCESS
                        ? label
                        : `${label} ${reason ? `Reason: ${reason}.` : ''}`.trim();
                    await tx.notification.create({
                        data: {
                            actorId: intent.actorId,
                            type: event.outcome === EventOutcome.SUCCESS ? 'owner_event' : 'owner_event_blocked',
                            title,
                            body,
                            data: {
                                eventType: event.type,
                                outcome: event.outcome,
                                reason,
                                targetNames,
                            },
                            sourceIntentId: intent.id,
                        },
                    });
                }

                if (priorityClassification.isKeyEvent && priorityClassification.priority && event.outcome === EventOutcome.SUCCESS) {
                    const actorIds = Array.from(new Set([
                        event.actorId,
                        ...(event.targetIds ?? [])
                    ]));
                    const sideEffects = (event.sideEffects ?? {}) as Record<string, any>;
                    const businessIdFromSideEffects = sideEffects.businessId || sideEffects.business_id;
                    const eventType = String(event.type);
                    const businessIds = Array.from(new Set([
                        ...(businessIdFromSideEffects ? [businessIdFromSideEffects] : []),
                        ...((eventType.startsWith('EVENT_BUSINESS_') || eventType === 'EVENT_BUSINESS_CUSTOMER_VISIT') ? (event.targetIds ?? []) : [])
                    ])).filter(Boolean) as string[];
                    const actorsForSnapshot = actorIds.length > 0
                        ? await tx.actor.findMany({
                            where: { id: { in: actorIds } },
                            include: { agentState: true },
                        })
                        : [];
                    const businessesForSnapshot = businessIds.length > 0
                        ? await tx.business.findMany({
                            where: { id: { in: businessIds } },
                            select: {
                                id: true,
                                name: true,
                                businessType: true,
                                cityId: true,
                                ownerId: true,
                                status: true,
                                isOpen: true,
                                treasury: true,
                                reputation: true,
                                level: true,
                            }
                        })
                        : [];
                    const cityIds = Array.from(new Set([
                        ...(actorsForSnapshot.map((a) => a.agentState?.cityId).filter(Boolean) as string[]),
                        ...(businessesForSnapshot.map((b) => b.cityId).filter(Boolean) as string[]),
                        ...(sideEffects.cityId ? [sideEffects.cityId] : []),
                        ...(sideEffects.targetCityId ? [sideEffects.targetCityId] : []),
                    ]));
                    const citiesForSnapshot = cityIds.length > 0
                        ? await tx.city.findMany({
                            where: { id: { in: cityIds } },
                            select: {
                                id: true,
                                name: true,
                                reputationScore: true,
                                population: true,
                                securityLevel: true,
                            }
                        })
                        : [];
                    const cityNameByIdSnapshot = new Map(citiesForSnapshot.map((c) => [c.id, c.name]));
                    const actorSnapshot = actorsForSnapshot.map((entry) => ({
                        id: entry.id,
                        name: entry.name,
                        cityId: entry.agentState?.cityId ?? null,
                        cityName: entry.agentState?.cityId ? cityNameByIdSnapshot.get(entry.agentState.cityId) ?? null : null,
                        reputation: Number(entry.reputation ?? 0),
                        wealthTier: entry.agentState?.wealthTier ?? null,
                        jobType: entry.agentState?.jobType ?? null,
                        health: entry.agentState?.health ?? null,
                        energy: entry.agentState?.energy ?? null,
                        hunger: entry.agentState?.hunger ?? null,
                        social: entry.agentState?.social ?? null,
                        fun: entry.agentState?.fun ?? null,
                        purpose: entry.agentState?.purpose ?? null,
                        frozen: entry.frozen ?? false,
                    }));
                    const businessSnapshot = businessesForSnapshot.map((entry) => ({
                        id: entry.id,
                        name: entry.name,
                        businessType: entry.businessType,
                        cityId: entry.cityId ?? null,
                        cityName: entry.cityId ? cityNameByIdSnapshot.get(entry.cityId) ?? null : null,
                        ownerId: entry.ownerId ?? null,
                        status: entry.status,
                        isOpen: entry.isOpen,
                        treasury: Number(entry.treasury ?? 0),
                        reputation: Number(entry.reputation ?? 0),
                        level: Number(entry.level ?? 0),
                    }));
                    const citySnapshot = citiesForSnapshot.map((entry) => ({
                        id: entry.id,
                        name: entry.name,
                        reputationScore: Number(entry.reputationScore ?? 0),
                        population: Number(entry.population ?? 0),
                        securityLevel: entry.securityLevel ?? null,
                    }));

                    const keyEventId = crypto.randomUUID();
                    await tx.keyEvent.create({
                        data: {
                            id: keyEventId,
                            eventId,
                            eventType: event.type,
                            tick: currentTick,
                            priority: priorityClassification.priority,
                            actorId: event.actorId,
                            actorIds,
                            businessIds,
                            cityIds,
                            actorSnapshot,
                            businessSnapshot,
                            citySnapshot,
                            metadata: {
                                outcome: event.outcome,
                                actorName: actor.name,
                                targetNames,
                                sideEffects,
                            },
                        }
                    });

                    await tx.webhookQueue.create({
                        data: {
                            id: crypto.randomUUID(),
                            actorId: event.actorId ?? null,
                            eventId: null,
                            eventType: event.type,
                            payload: {
                                task: 'key_event_headline',
                                key_event_id: keyEventId,
                                event_type: event.type,
                                actor_name: actor.name,
                                target_names: targetNames,
                                business_names: businessSnapshot.map((entry) => entry.name).filter(Boolean),
                                city_name: actorCityName,
                                context: sideEffects,
                            },
                            status: 'pending',
                            attempts: 0,
                            maxAttempts: 3,
                        },
                    });
                }

                if (classification.isKeyEvent && classification.requiresWebhook) {
                    await tx.webhookQueue.create({
                        data: {
                            actorId: event.actorId,
                            eventId,
                            eventType: event.type,
                            payload: buildWebhookPayload({
                                eventType: event.type,
                                fallbackHeadline: classification.headline,
                                actorName: actor.name,
                                cityName: actorCityName,
                                targetNames,
                                sideEffects: (event.sideEffects ?? {}) as Record<string, unknown>,
                            }),
                            status: 'pending',
                            attempts: 0,
                            maxAttempts: 3,
                        },
                    });
                }
            }

            // Update intent status
            await tx.intent.update({
                where: { id: intent.id },
                data: {
                    status: result.intentStatus,
                    params: blockReason ? { ...(intent.params as any), blockReason } : intent.params
                },
            });

            const source = (intent.params as any)?.source;
            if (source === 'owner_suggestion'
                && (result.intentStatus === IntentStatus.EXECUTED || result.intentStatus === IntentStatus.BLOCKED)) {
                const label = formatIntentLabel(intent.type);
                const title = result.intentStatus === IntentStatus.EXECUTED
                    ? 'Request accepted'
                    : 'Request refused';
                const reason = result.intentStatus === IntentStatus.BLOCKED ? (blockReason ?? null) : null;
                const body = result.intentStatus === IntentStatus.EXECUTED
                    ? `Request accepted: ${label}.`
                    : `Request refused: ${label}.${reason ? ` Reason: ${reason}.` : ''}`;
                await tx.notification.create({
                    data: {
                        actorId: intent.actorId,
                        type: result.intentStatus === IntentStatus.EXECUTED
                            ? 'owner_request_accepted'
                            : 'owner_request_refused',
                        title,
                        body,
                        data: {
                            intentId: intent.id,
                            intentType: intent.type,
                            reason,
                        },
                        sourceIntentId: intent.id,
                    },
                });
            }
        });

        await recordIntentOutcome({
            actorId: actor.id,
            tick: currentTick,
            intentType: intent.type,
            outcome: result.intentStatus,
            contextActorId: intent.targetId ?? null,
            sbyteChange: 0,
            emotionalImpact: blockReason ?? null
        });
        MemoryManager.recordIntentResult(actor.id, intent.type, currentTick, result.intentStatus);

        events.push(...result.events);
        processedCount++;

        // Mark remaining intents for this actor as blocked (only one per tick)
        for (let i = 1; i < actionableIntents.length; i++) {
            await markIntentBlocked(actionableIntents[i].id, 'Only one intent per tick', currentTick);
        }
    } catch (error) {
        console.error(`Error processing intent ${intent.id}:`, error);
        await markIntentBlocked(intent.id, `Handler error: ${error}`, currentTick);
    }

    return { processedCount, events };


}

async function markIntentBlocked(intentId: string, reason: string, tick?: number) {
    const existing = await prisma.intent.findUnique({
        where: { id: intentId },
        select: { params: true, actorId: true, type: true }
    });
    await prisma.intent.update({
        where: { id: intentId },
        data: {
            status: 'blocked',
            params: { ...(existing?.params as any), blockReason: reason },
        },
    });
    if (existing?.actorId && existing?.type) {
        MemoryManager.recordIntentResult(existing.actorId, existing.type, tick ?? 0, 'blocked');
    }
}

function extractBlockReason(events: EventData[]): string | null {
    for (const event of events) {
        const sideEffects = event.sideEffects as any;
        if (sideEffects?.reason) return String(sideEffects.reason);
        if (sideEffects?.blockReason) return String(sideEffects.blockReason);
    }
    return null;
}

function isOwnerSuggestionIntent(intent: { params?: any }): boolean {
    const params = (intent.params as any) ?? {};
    return params.source === 'owner_suggestion';
}

function isAgoraIntent(intentType: string): boolean {
    return intentType === IntentType.INTENT_POST_AGORA
        || intentType === IntentType.INTENT_REPLY_AGORA
        || intentType === IntentType.INTENT_VOTE_AGORA;
}

/**
 * Get handler for intent type
 */
// Map of intent types to handlers
const HANDLER_MAP = new Map<string, IntentHandler>([
    // Core
    [IntentType.INTENT_IDLE, handleIdle],
    [IntentType.INTENT_WORK, handleWork],

    // Economy
    [IntentType.INTENT_MOVE_CITY, handleMoveCity],
    [IntentType.INTENT_PAY_RENT, EconomyHandlers.handlePayRent],
    [IntentType.INTENT_CHANGE_HOUSING, EconomyHandlers.handleChangeHousing],
    [IntentType.INTENT_TRADE, EconomyHandlers.handleTrade],
    [IntentType.INTENT_LIST, EconomyHandlers.handleListItem],
    [IntentType.INTENT_BUY, EconomyHandlers.handleBuyItem],
    [IntentType.INTENT_BUY_ITEM, EconomyHandlers.handleBuyFromStore],

    // Social
    [IntentType.INTENT_SOCIALIZE, SocialHandlers.handleSocialize],
    [IntentType.INTENT_FLIRT, SocialHandlers.handleFlirt],
    [IntentType.INTENT_ROMANTIC_INTERACTION, SocialHandlers.handleRomanticInteraction],
    [IntentType.INTENT_PROPOSE_DATING, SocialHandlers.handleProposeDating],
    [IntentType.INTENT_ACCEPT_DATING, SocialHandlers.handleAcceptDating],
    [IntentType.INTENT_END_DATING, SocialHandlers.handleEndDating],
    [IntentType.INTENT_PROPOSE_MARRIAGE, SocialHandlers.handleProposeMarriage],
    [IntentType.INTENT_ACCEPT_MARRIAGE, SocialHandlers.handleAcceptMarriage],
    [IntentType.INTENT_DIVORCE, SocialHandlers.handleDivorce],
    [IntentType.INTENT_HOUSEHOLD_TRANSFER, SocialHandlers.handleHouseholdTransfer],
    [IntentType.INTENT_PROPOSE_ALLIANCE, SocialHandlers.handleProposeAlliance],
    [IntentType.INTENT_ACCEPT_ALLIANCE, SocialHandlers.handleAcceptAlliance],
    [IntentType.INTENT_REJECT_ALLIANCE, SocialHandlers.handleRejectAlliance],
    [IntentType.INTENT_BETRAY_ALLIANCE, SocialHandlers.handleBetrayAlliance],
    [IntentType.INTENT_END_RIVALRY, SocialHandlers.handleEndRivalry],
    [IntentType.INTENT_FORGIVE_GRUDGE, SocialHandlers.handleForgiveGrudge],
    [IntentType.INTENT_ACCEPT_SPOUSE_MOVE, SocialHandlers.handleAcceptSpouseMove],
    [IntentType.INTENT_REJECT_SPOUSE_MOVE, SocialHandlers.handleRejectSpouseMove],
    [IntentType.INTENT_REQUEST_CONSTRUCTION, ConstructionHandlers.handleRequestConstruction],
    [IntentType.INTENT_SUBMIT_CONSTRUCTION_QUOTE, ConstructionHandlers.handleSubmitConstructionQuote],
    [IntentType.INTENT_ACCEPT_CONSTRUCTION_QUOTE, ConstructionHandlers.handleAcceptConstructionQuote],
    [IntentType.INTENT_BLACKLIST, SocialHandlers.handleBlacklist],

    // Governance
    [IntentType.INTENT_CITY_UPGRADE, handleGovernance],
    [IntentType.INTENT_CITY_TAX_CHANGE, handleGovernance],
    [IntentType.INTENT_CITY_SOCIAL_AID, handleGovernance],
    [IntentType.INTENT_CITY_SECURITY_FUNDING, handleGovernance],
    [IntentType.INTENT_VOTE, GovernanceHandlers.handleVote],
    [IntentType.INTENT_ALLOCATE_SPENDING, GovernanceHandlers.handleAllocateSpending],

    // Crime
    [IntentType.INTENT_STEAL, CrimeHandlers.handleSteal],
    [IntentType.INTENT_ARREST, CrimeHandlers.handleArrest],
    [IntentType.INTENT_IMPRISON, CrimeHandlers.handleImprison],
    [IntentType.INTENT_RELEASE, CrimeHandlers.handleRelease],
    [IntentType.INTENT_ASSAULT, CrimeHandlers.handleAssault],
    [IntentType.INTENT_FRAUD, CrimeHandlers.handleFraud],
    [IntentType.INTENT_FLEE, CrimeHandlers.handleFlee],
    [IntentType.INTENT_HIDE, CrimeHandlers.handleHide],

    // Agora
    [IntentType.INTENT_POST_AGORA, AgoraHandlers.handlePostAgora],
    [IntentType.INTENT_REPLY_AGORA, AgoraHandlers.handleReplyAgora],
    [IntentType.INTENT_VOTE_AGORA, AgoraHandlers.handleVoteAgora],
    [IntentType.INTENT_REPORT_AGORA, AgoraHandlers.handleReportAgora],

    // Public Employment
    [IntentType.INTENT_APPLY_PUBLIC_JOB, PublicEmploymentHandlers.handleApplyPublicJob],
    [IntentType.INTENT_RESIGN_PUBLIC_JOB, PublicEmploymentHandlers.handleResignPublicJob],
    [IntentType.INTENT_START_SHIFT, PublicEmploymentHandlers.handleStartShift],
    [IntentType.INTENT_END_SHIFT, PublicEmploymentHandlers.handleEndShift],
    [IntentType.INTENT_COLLECT_SALARY, PublicEmploymentHandlers.handleCollectSalary],

    // Property System
    [IntentType.INTENT_BUY_PROPERTY, PropertyHandlers.handleBuyProperty],
    [IntentType.INTENT_SELL_PROPERTY, PropertyHandlers.handleSellProperty],
    [IntentType.INTENT_LIST_PROPERTY, PropertyHandlers.handleListProperty],
    [IntentType.INTENT_ADJUST_RENT, PropertyHandlers.handleAdjustRent],
    [IntentType.INTENT_MAINTAIN_PROPERTY, PropertyHandlers.handleMaintainProperty],
    [IntentType.INTENT_EVICT, PropertyHandlers.handleEvict],
    [IntentType.INTENT_FOUND_BUSINESS, BusinessHandlers.handleFoundBusiness],
    [IntentType.INTENT_CONVERT_BUSINESS, BusinessHandlers.handleFoundBusiness],
    [IntentType.INTENT_UPGRADE_BUSINESS, BusinessHandlers.handleUpgradeBusiness],
    [IntentType.INTENT_SET_PRICES, BusinessHandlers.handleSetPrices],
    [IntentType.INTENT_IMPROVE_BUSINESS, BusinessHandlers.handleImproveBusiness],
    [IntentType.INTENT_WORK_OWN_BUSINESS, BusinessHandlers.handleWorkOwnBusiness],
    [IntentType.INTENT_HIRE_EMPLOYEE, BusinessHandlers.handleHireEmployee],
    [IntentType.INTENT_ADJUST_SALARY, BusinessHandlers.handleAdjustSalary],
    [IntentType.INTENT_FIRE_EMPLOYEE, BusinessHandlers.handleFireEmployee],
    [IntentType.INTENT_SELL_BUSINESS, BusinessHandlers.handleSellBusiness],
    [IntentType.INTENT_BUY_BUSINESS, BusinessHandlers.handleBuyBusiness],
    [IntentType.INTENT_DISSOLVE_BUSINESS, BusinessHandlers.handleDissolveBusiness],
    [IntentType.INTENT_WITHDRAW_BUSINESS_FUNDS, BusinessHandlers.handleWithdrawBusinessFunds],
    [IntentType.INTENT_INJECT_BUSINESS_FUNDS, BusinessHandlers.handleInjectBusinessFunds],
    [IntentType.INTENT_BUSINESS_WITHDRAW, BusinessHandlers.handleWithdrawBusinessFunds],
    [IntentType.INTENT_BUSINESS_INJECT, BusinessHandlers.handleInjectBusinessFunds],
    [IntentType.INTENT_CLOSE_BUSINESS, BusinessHandlers.handleCloseBusiness],
    [IntentType.INTENT_SET_LOAN_TERMS, BusinessHandlers.handleSetLoanTerms],
    [IntentType.INTENT_APPROVE_LOAN, BusinessHandlers.handleApproveLoan],
    [IntentType.INTENT_DENY_LOAN, BusinessHandlers.handleDenyLoan],
    [IntentType.INTENT_SET_HOUSE_EDGE, BusinessHandlers.handleSetHouseEdge],
    [IntentType.INTENT_MANAGE_RESTAURANT, BusinessHandlers.handleManageRestaurant],
    [IntentType.INTENT_MANAGE_CLINIC, BusinessHandlers.handleManageClinic],
    [IntentType.INTENT_HOST_EVENT, BusinessHandlers.handleHostEvent],
    [IntentType.INTENT_VISIT_BUSINESS, BusinessHandlers.handleVisitBusiness],
    [IntentType.INTENT_APPLY_PRIVATE_JOB, BusinessHandlers.handleApplyPrivateJob],
    [IntentType.INTENT_ACCEPT_JOB, BusinessHandlers.handleAcceptJob],
    [IntentType.INTENT_REJECT_JOB, BusinessHandlers.handleRejectJob],
    [IntentType.INTENT_QUIT_JOB, BusinessHandlers.handleQuitJob],
    [IntentType.INTENT_TRANSFER_MON_TO_BUSINESS, BusinessHandlers.handleTransferMonToBusiness],

    // Life/Career
    [IntentType.INTENT_SWITCH_JOB, LifeHandlers.handleSwitchJob],
    [IntentType.INTENT_FREEZE, LifeHandlers.handleFreeze],
    [IntentType.INTENT_REST, LifeHandlers.handleRest],
    [IntentType.INTENT_AVOID_GAMES, LifeHandlers.handleAvoidGames],
    [IntentType.INTENT_CONSUME_ITEM, LifeHandlers.handleConsumeItem],
    [IntentType.INTENT_FORAGE, LifeHandlers.handleForage],

    // Combat
    [IntentType.INTENT_ATTACK, CombatHandlers.handleAttack],
    [IntentType.INTENT_DEFEND, CombatHandlers.handleDefend],
    [IntentType.INTENT_RETREAT, CombatHandlers.handleRetreat],

    // Gaming
    [IntentType.INTENT_CHALLENGE_GAME, GamingHandlers.handleChallengeGame],
    [IntentType.INTENT_ACCEPT_GAME, GamingHandlers.handleAcceptGame],
    [IntentType.INTENT_REJECT_GAME, GamingHandlers.handleRejectGame],
    [IntentType.INTENT_PLAY_GAME, GamingHandlers.handlePlayGame],
    [IntentType.INTENT_BET, GamingHandlers.handleBet],

    // Crafting
    [IntentType.INTENT_CRAFT, CraftingHandlers.handleCraft],

    // Police
    [IntentType.INTENT_PATROL, PoliceHandlers.handlePatrol],
]);

/**
 * Get handler for intent type
 */
function getHandler(intentType: string): IntentHandler | null {
    return HANDLER_MAP.get(intentType) || null;
}

// ============ HANDLERS ============

/**
 * Handle INTENT_IDLE - do nothing
 */
async function handleIdle(
    _intent: IntentRecord,
    _actor: ActorRecord,
    _agentState: AgentStateRecord | null,
    _wallet: WalletRecord | null,
    _tick: number,
    _seed: bigint
): Promise<{ stateUpdates: StateUpdate[]; events: EventData[]; intentStatus: IntentStatus }> {
    return {
        stateUpdates: [],
        events: [],
        intentStatus: IntentStatus.EXECUTED,
    };
}

/**
 * Handle INTENT_WORK
 * - Decreases energy
 * - Increases wallet balance (with fees)
 * - Emits EVENT_WORK_COMPLETED
 */
async function handleWork(
    intent: IntentRecord,
    actor: ActorRecord,
    agentState: AgentStateRecord | null,
    wallet: WalletRecord | null,
    _tick: number,
    _seed: bigint
): Promise<{ stateUpdates: StateUpdate[]; events: EventData[]; intentStatus: IntentStatus }> {
    if (!agentState || !wallet) {
        return {
            stateUpdates: [],
            events: [{
                actorId: actor.id,
                type: EventType.EVENT_WORK_COMPLETED,
                targetIds: [],
                outcome: EventOutcome.FAIL,
                sideEffects: { reason: 'Missing agent state or wallet' },
            }],
            intentStatus: IntentStatus.BLOCKED,
        };
    }

    const params = (intent.params || {}) as { jobId?: string };
    if (!params.jobId && agentState.jobType === 'unemployed') {
        return {
            stateUpdates: [],
            events: [{
                actorId: actor.id,
                type: EventType.EVENT_WORK_COMPLETED,
                targetIds: [],
                outcome: EventOutcome.BLOCKED,
                sideEffects: { reason: 'No job to work' },
            }],
            intentStatus: IntentStatus.BLOCKED,
        };
    }

    const ownedItems = await prisma.inventoryItem.findMany({
        where: { actorId: actor.id, quantity: { gt: 0 } },
        include: { itemDef: true }
    });
    const ownedItemNames = ownedItems.map((item) => item.itemDef.name);

    // Private employment (segment-based)
    if (params.jobId) {
        const employment = await prisma.privateEmployment.findUnique({
            where: { id: params.jobId }
        });
        if (!employment || employment.agentId !== actor.id || employment.status !== 'ACTIVE') {
            return {
                stateUpdates: [],
                events: [{
                    actorId: actor.id,
                    type: EventType.EVENT_WORK_COMPLETED,
                    targetIds: [],
                    outcome: EventOutcome.BLOCKED,
                    sideEffects: { reason: 'Private employment not found or inactive' },
                }],
                intentStatus: IntentStatus.BLOCKED,
            };
        }

        const jobKey = `private:${employment.id}`;
        const segmentGate = canStartWorkSegment(agentState, jobKey, _tick);
        if (!segmentGate.allowed) {
            return {
                stateUpdates: [],
                events: [{
                    actorId: actor.id,
                    type: EventType.EVENT_WORK_COMPLETED,
                    targetIds: [],
                    outcome: EventOutcome.BLOCKED,
                    sideEffects: { reason: segmentGate.reason ?? 'Work segment limit reached' },
                }],
                intentStatus: IntentStatus.BLOCKED,
            };
        }

        const workHours = getPrivateWorkHours(agentState.jobType) * PRIVATE_WORK_HOURS_MULTIPLIER;
        const shiftDuration = getWorkSegmentDurationTicks(workHours);
        const shiftEndTick = _tick + shiftDuration;
        const workCost = getWorkStatusCost(
            getWorkStrainTierForJobType(agentState.jobType),
            ownedItemNames,
            true
        );
        const wouldDropUnsafe = (agentState.energy - workCost.energy) <= 0
            || (agentState.health - workCost.health) <= 0
            || (agentState.hunger - workCost.hunger) <= 0;
        if (wouldDropUnsafe) {
            return {
                stateUpdates: [],
                events: [{
                    actorId: actor.id,
                    type: EventType.EVENT_WORK_COMPLETED,
                    targetIds: [],
                    outcome: EventOutcome.BLOCKED,
                    sideEffects: { reason: 'Unsafe to work with current status' },
                }],
                intentStatus: IntentStatus.BLOCKED,
            };
        }

        const segmentResult = registerWorkSegmentCompletion(agentState, jobKey, _tick);

        return {
            stateUpdates: [{
                table: 'agentState',
                operation: 'update',
                where: { actorId: actor.id },
                data: {
                    activityState: 'WORKING',
                    activityEndTick: shiftEndTick,
                    energy: Math.max(0, agentState.energy - workCost.energy),
                    hunger: Math.max(0, agentState.hunger - workCost.hunger),
                    health: Math.max(0, agentState.health - workCost.health),
                    fun: Math.max(0, (agentState.fun ?? 0) - workCost.fun - 2),
                    social: Math.min(100, (agentState.social ?? 0) + 3),
                    purpose: Math.min(100, (agentState.purpose ?? 0) + 5),
                    ...segmentResult.updates
                },
            }],
            events: [{
                actorId: actor.id,
                type: EventType.EVENT_WORK_COMPLETED,
                targetIds: [],
                outcome: EventOutcome.SUCCESS,
                sideEffects: {
                    jobType: agentState.jobType,
                    businessId: employment.businessId,
                    salaryDaily: employment.salaryDaily.toString(),
                    privateEmploymentId: employment.id,
                    shiftDurationHours: workHours,
                    shiftEndTick,
                    segmentIndex: segmentResult.nextCompleted,
                    segmentComplete: segmentResult.completedDay
                },
            }],
            intentStatus: IntentStatus.EXECUTED,
        };
    }

    // Generic work (non-private, segment-based)
    const jobKey = `generic:${agentState.jobType}`;
    const segmentGate = canStartWorkSegment(agentState, jobKey, _tick);
    if (!segmentGate.allowed) {
        return {
            stateUpdates: [],
            events: [{
                actorId: actor.id,
                type: EventType.EVENT_WORK_COMPLETED,
                targetIds: [],
                outcome: EventOutcome.BLOCKED,
                sideEffects: { reason: segmentGate.reason ?? 'Work segment limit reached' },
            }],
            intentStatus: IntentStatus.BLOCKED,
        };
    }

    const workHours = getPrivateWorkHours(agentState.jobType);
    const shiftDuration = getWorkSegmentDurationTicks(workHours);
    const shiftEndTick = _tick + shiftDuration;
    const workCost = getWorkStatusCost(
        getWorkStrainTierForJobType(agentState.jobType),
        ownedItemNames,
        false
    );
    const wouldDropUnsafe = (agentState.energy - workCost.energy) <= 0
        || (agentState.health - workCost.health) <= 0
        || (agentState.hunger - workCost.hunger) <= 0;
    if (wouldDropUnsafe) {
        return {
            stateUpdates: [],
            events: [{
                actorId: actor.id,
                type: EventType.EVENT_WORK_COMPLETED,
                targetIds: [],
                outcome: EventOutcome.BLOCKED,
                sideEffects: { reason: 'Unsafe to work with current status' },
            }],
            intentStatus: IntentStatus.BLOCKED,
        };
    }

    const segmentResult = registerWorkSegmentCompletion(agentState, jobKey, _tick);

    let grossWage = new Decimal(0);
    let netWage = new Decimal(0);
    let platformFee = new Decimal(0);
    let cityFee = new Decimal(0);
    let salaryTxHash: string | null = null;
    let paymentFailedReason: string | null = null;

    if (segmentResult.completedDay) {
        const wageTable: Record<string, number> = {
            begging: 1,
            menial: 5,
            labor: 10,
            skilled: 25,
            creative: 50,
            executive: 100,
            investor: 200,
            mayor: 150,
        };
        grossWage = new Decimal(wageTable[agentState.jobType] ?? 5);

        try {
            const god = await prisma.actor.findFirst({ where: { isGod: true } });
            if (!god) {
                throw new Error('System offline (God missing)');
            }

            const useQueue = process.env.ENABLE_ONCHAIN_QUEUE === 'true';
            const wageWei = ethers.parseEther(grossWage.toString());
            const feeBps = getDynamicFeeBps(getCachedVaultHealth());
            const fees = calculateFees(wageWei, feeBps.cityBps, feeBps.platformBps);
            netWage = new Decimal(ethers.formatEther(fees.netAmount));
            platformFee = new Decimal(ethers.formatEther(fees.platformFee));
            cityFee = new Decimal(ethers.formatEther(fees.cityFee));

            const transactionId = crypto.randomUUID();

            if (useQueue) {
                const job = createOnchainJobUpdate({
                    jobType: 'AGENT_TRANSFER_SBYTE',
                    payload: {
                        fromActorId: god.id,
                        toActorId: actor.id,
                        amountWei: wageWei.toString(),
                        reason: 'salary',
                        cityId: agentState.cityId ?? null,
                    },
                    actorId: actor.id,
                    relatedIntentId: intent.id,
                    relatedTxId: transactionId,
                });

                salaryTxHash = null;

                return {
                    stateUpdates: [
                        {
                            table: 'agentState',
                            operation: 'update',
                            where: { actorId: actor.id },
                            data: {
                                activityState: 'WORKING',
                                activityEndTick: shiftEndTick,
                                energy: Math.max(0, agentState.energy - workCost.energy),
                                hunger: Math.max(0, agentState.hunger - workCost.hunger),
                                health: Math.max(0, agentState.health - workCost.health),
                                fun: Math.max(0, (agentState.fun ?? 0) - workCost.fun - 2),
                                social: Math.min(100, (agentState.social ?? 0) + 3),
                                purpose: Math.min(100, (agentState.purpose ?? 0) + 5),
                                ...segmentResult.updates
                            },
                        },
                        job.update,
                        {
                            table: 'transaction',
                            operation: 'create',
                            data: {
                                id: transactionId,
                                fromActorId: god.id,
                                toActorId: actor.id,
                                amount: grossWage.toNumber(),
                                feePlatform: platformFee.toNumber(),
                                feeCity: cityFee.toNumber(),
                                cityId: agentState.cityId ?? null,
                                tick: _tick,
                                reason: 'generic_work_salary',
                                onchainTxHash: salaryTxHash,
                                metadata: {
                                    jobType: agentState.jobType,
                                    netWage: netWage.toString(),
                                    segmentCount: WORK_SEGMENTS_PER_DAY,
                                    onchainJobId: job.jobId,
                                }
                            }
                        }
                    ],
                    events: [
                        {
                            actorId: actor.id,
                            type: EventType.EVENT_REPUTATION_UPDATED,
                            targetIds: [],
                            outcome: EventOutcome.SUCCESS,
                            sideEffects: { delta: 0.1, reason: 'work_completed' },
                        },
                        {
                            actorId: actor.id,
                            type: EventType.EVENT_WORK_COMPLETED,
                            targetIds: [],
                            outcome: EventOutcome.SUCCESS,
                            sideEffects: {
                                jobType: agentState.jobType,
                                grossWage: grossWage.toString(),
                                netWage: netWage.toString(),
                                platformFee: platformFee.toString(),
                                cityFee: cityFee.toString(),
                                energySpent: workCost.energy,
                                hoursWorked: workHours,
                                shiftEndTick,
                                segmentIndex: segmentResult.nextCompleted,
                                segmentComplete: segmentResult.completedDay,
                                queued: true
                            },
                        }
                    ],
                    intentStatus: IntentStatus.QUEUED,
                };
            }

            const wageTx = await agentTransferService.transfer(
                god.id,
                actor.id,
                wageWei,
                'salary',
                agentState.cityId ?? undefined
            );
            salaryTxHash = wageTx.txHash;
            netWage = new Decimal(ethers.formatEther(wageTx.netAmount));
            platformFee = new Decimal(ethers.formatEther(wageTx.platformFee));
            cityFee = new Decimal(ethers.formatEther(wageTx.cityFee));

            if (platformFee.greaterThan(0)) {
                await prisma.platformVault.update({
                    where: { id: 1 },
                    data: { balanceSbyte: { increment: platformFee.toNumber() } },
                });
            }

            await prisma.transaction.create({
                data: {
                    id: transactionId,
                    fromActorId: god.id,
                    toActorId: actor.id,
                    amount: grossWage.toNumber(),
                    feePlatform: platformFee.toNumber(),
                    feeCity: cityFee.toNumber(),
                    cityId: agentState.cityId ?? null,
                    tick: _tick,
                    reason: 'generic_work_salary',
                    onchainTxHash: salaryTxHash,
                    metadata: {
                        jobType: agentState.jobType,
                        netWage: netWage.toString(),
                        segmentCount: WORK_SEGMENTS_PER_DAY
                    }
                }
            });
        } catch (error: any) {
            paymentFailedReason = String(error?.message ?? error);
        }
    }

    return {
        stateUpdates: [
            {
                table: 'agentState',
                operation: 'update',
                where: { actorId: actor.id },
                data: {
                    activityState: 'WORKING',
                    activityEndTick: shiftEndTick,
                    energy: Math.max(0, agentState.energy - workCost.energy),
                    hunger: Math.max(0, agentState.hunger - workCost.hunger),
                    health: Math.max(0, agentState.health - workCost.health),
                    fun: Math.max(0, (agentState.fun ?? 0) - workCost.fun - 2),
                    social: Math.min(100, (agentState.social ?? 0) + 3),
                    purpose: Math.min(100, (agentState.purpose ?? 0) + 5),
                    ...segmentResult.updates
                },
            }
        ],
        events: [
            {
                actorId: actor.id,
                type: EventType.EVENT_REPUTATION_UPDATED,
                targetIds: [],
                outcome: EventOutcome.SUCCESS,
                sideEffects: { delta: 0.1, reason: 'work_completed' },
            },
            {
                actorId: actor.id,
                type: EventType.EVENT_WORK_COMPLETED,
                targetIds: [],
                outcome: paymentFailedReason ? EventOutcome.FAIL : EventOutcome.SUCCESS,
                sideEffects: {
                    jobType: agentState.jobType,
                    grossWage: grossWage.toString(),
                    netWage: netWage.toString(),
                    platformFee: platformFee.toString(),
                    cityFee: cityFee.toString(),
                    energySpent: workCost.energy,
                    hoursWorked: workHours,
                    shiftEndTick,
                    segmentIndex: segmentResult.nextCompleted,
                    segmentComplete: segmentResult.completedDay,
                    paymentFailedReason
                },
            }
        ],
        intentStatus: IntentStatus.EXECUTED,
    };
}

function getPrivateWorkHours(jobType?: string | null): number {
    switch ((jobType || '').toLowerCase()) {
        case 'executive':
        case 'investor':
            return 2;
        case 'skilled':
        case 'creative':
            return 4;
        case 'labor':
        case 'menial':
        case 'begging':
        default:
            return 5;
    }
}

/**
 * Handle INTENT_MOVE_CITY
 * - Changes agent's city
 * - Emits EVENT_CITY_MOVED
 */
async function handleMoveCity(
    intent: IntentRecord,
    actor: ActorRecord,
    agentState: AgentStateRecord | null,
    wallet: WalletRecord | null,
    tick: number,
    _seed: bigint
): Promise<{ stateUpdates: StateUpdate[]; events: EventData[]; intentStatus: IntentStatus }> {
    if (!agentState) {
        return {
            stateUpdates: [],
            events: [{
                actorId: actor.id,
                type: EventType.EVENT_CITY_MOVED,
                targetIds: [],
                outcome: EventOutcome.FAIL,
                sideEffects: { reason: 'Missing agent state' },
            }],
            intentStatus: IntentStatus.BLOCKED,
        };
    }

    const params = intent.params as { targetCityId?: string };
    if (!params?.targetCityId) {
        return {
            stateUpdates: [],
            events: [{
                actorId: actor.id,
                type: EventType.EVENT_CITY_MOVED,
                targetIds: [],
                outcome: EventOutcome.BLOCKED,
                sideEffects: { reason: 'No target city specified' },
            }],
            intentStatus: IntentStatus.BLOCKED,
        };
    }

    // Verify target city exists
    const targetCity = await prisma.city.findUnique({
        where: { id: params.targetCityId },
    });

    if (!targetCity) {
        return {
            stateUpdates: [],
            events: [{
                actorId: actor.id,
                type: EventType.EVENT_CITY_MOVED,
                targetIds: [],
                outcome: EventOutcome.BLOCKED,
                sideEffects: { reason: 'Target city not found' },
            }],
            intentStatus: IntentStatus.BLOCKED,
        };
    }

    const fromCityId = agentState.cityId;
    const MOVE_COOLDOWN_TICKS = 2160;

    if (agentState.lastMoveTick && tick - agentState.lastMoveTick < MOVE_COOLDOWN_TICKS) {
        return {
            stateUpdates: [],
            events: [{
                actorId: actor.id,
                type: EventType.EVENT_CITY_MOVED,
                targetIds: [],
                outcome: EventOutcome.BLOCKED,
                sideEffects: { reason: 'MOVE_COOLDOWN' },
            }],
            intentStatus: IntentStatus.BLOCKED,
        };
    }

    // Marriage consent gate
    const marriage = await prisma.consent.findFirst({
        where: {
            OR: [
                { partyAId: actor.id },
                { partyBId: actor.id }
            ],
            type: 'marriage',
            status: 'active'
        }
    });
    const spouseId = marriage
        ? (marriage.partyAId === actor.id ? marriage.partyBId : marriage.partyAId)
        : null;

    if (spouseId) {
        const existingConsent = await prisma.consent.findFirst({
            where: {
                type: 'spouse_move',
                status: 'active',
                partyAId: actor.id,
                partyBId: spouseId,
                terms: {
                    path: ['targetCityId'],
                    equals: params.targetCityId
                }
            }
        });

        if (!existingConsent) {
            await prisma.consent.create({
                data: {
                    type: 'spouse_move',
                    partyAId: actor.id,
                    partyBId: spouseId,
                    status: 'pending',
                    terms: { targetCityId: params.targetCityId, fromCityId },
                    cityId: fromCityId ?? null
                }
            });
            return {
                stateUpdates: [],
                events: [{
                    actorId: actor.id,
                    type: EventType.EVENT_SPOUSE_MOVE_CONSENT,
                    targetIds: [spouseId],
                    outcome: EventOutcome.BLOCKED,
                    sideEffects: { reason: 'AWAITING_PARTNER_CONSENT', targetCityId: params.targetCityId }
                }],
                intentStatus: IntentStatus.BLOCKED,
            };
        }
    }

    if (!wallet) {
        return {
            stateUpdates: [],
            events: [{
                actorId: actor.id,
                type: EventType.EVENT_CITY_MOVED,
                targetIds: [],
                outcome: EventOutcome.BLOCKED,
                sideEffects: { reason: 'Missing wallet' },
            }],
            intentStatus: IntentStatus.BLOCKED,
        };
    }

    const balance = Number(wallet.balanceSbyte);
    const moveCost = Math.max(5, balance * 0.01);
    if (balance < moveCost) {
        return {
            stateUpdates: [],
            events: [{
                actorId: actor.id,
                type: EventType.EVENT_CITY_MOVED,
                targetIds: [],
                outcome: EventOutcome.BLOCKED,
                sideEffects: { reason: 'Insufficient funds for move' },
            }],
            intentStatus: IntentStatus.BLOCKED,
        };
    }

    // Social penalty based on friends in current city
    let friendsInCity = 0;
    if (fromCityId) {
        const relationships = await prisma.relationship.findMany({
            where: {
                OR: [
                    { actorAId: actor.id },
                    { actorBId: actor.id }
                ],
                relationshipType: 'FRIENDSHIP'
            }
        });
        for (const rel of relationships) {
            const targetId = rel.actorAId === actor.id ? rel.actorBId : rel.actorAId;
            const targetState = await prisma.agentState.findUnique({ where: { actorId: targetId } });
            if (targetState?.cityId === fromCityId) {
                friendsInCity += 1;
            }
        }
    }
    const socialPenalty = Math.min(20, friendsInCity * 3);

    const stateUpdates: StateUpdate[] = [
        {
            table: 'agentState',
            operation: 'update',
            where: { actorId: actor.id },
            data: {
                cityId: params.targetCityId,
                lastMoveTick: tick,
                social: Math.max(0, agentState.social - socialPenalty)
            },
        },
        {
            table: 'wallet',
            operation: 'update',
            where: { actorId: actor.id },
            data: { balanceSbyte: { decrement: moveCost } }
        },
        {
            table: 'agentWallet',
            operation: 'update',
            where: { actorId: actor.id },
            data: { balanceSbyte: { decrement: moveCost } }
        },
        {
            table: 'cityVault',
            operation: 'update',
            where: { cityId: params.targetCityId },
            data: { balanceSbyte: { increment: moveCost } }
        },
        {
            table: 'transaction',
            operation: 'create',
            data: {
                fromActorId: actor.id,
                toActorId: null,
                amount: moveCost,
                feePlatform: 0,
                feeCity: moveCost,
                cityId: params.targetCityId,
                tick,
                reason: 'MOVE_CITY_COST',
                onchainTxHash: null,
                metadata: { fromCityId, toCityId: params.targetCityId, socialPenalty }
            }
        },
        // Increment Target City
        {
            table: 'city',
            operation: 'update',
            where: { id: params.targetCityId },
            data: { population: { increment: 1 } },
        }
    ];

    // Decrement From City
    if (fromCityId) {
        stateUpdates.push({
            table: 'city',
            operation: 'update',
            where: { id: fromCityId },
            data: { population: { decrement: 1 } },
        });
    }

    if (spouseId) {
        const consent = await prisma.consent.findFirst({
            where: {
                type: 'spouse_move',
                status: 'active',
                partyAId: actor.id,
                partyBId: spouseId,
                terms: {
                    path: ['targetCityId'],
                    equals: params.targetCityId
                }
            }
        });
        if (consent) {
            stateUpdates.push({
                table: 'consent',
                operation: 'update',
                where: { id: consent.id },
                data: { status: 'ended' }
            });
        }
    }

    return {
        stateUpdates,
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_CITY_MOVED,
            targetIds: [params.targetCityId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                fromCityId,
                toCityId: params.targetCityId,
                moveCost,
                socialPenalty,
                friendsLeft: friendsInCity
            },
        }],
        intentStatus: IntentStatus.EXECUTED,
    };
}

/**
 * Handle governance intents
 * Creates city_proposals row with status='pending'
 * Does NOT execute the proposal (God Service does that)
 */
async function handleGovernance(
    intent: IntentRecord,
    actor: ActorRecord,
    _agentState: AgentStateRecord | null,
    _wallet: WalletRecord | null,
    _tick: number,
    _seed: bigint
): Promise<{ stateUpdates: StateUpdate[]; events: EventData[]; intentStatus: IntentStatus }> {
    const params = intent.params as { cityId?: string; payload?: Record<string, unknown> };

    if (!params?.cityId) {
        return {
            stateUpdates: [],
            events: [{
                actorId: actor.id,
                type: EventType.EVENT_PROPOSAL_SUBMITTED,
                targetIds: [],
                outcome: EventOutcome.BLOCKED,
                sideEffects: { reason: 'No city specified' },
            }],
            intentStatus: IntentStatus.BLOCKED,
        };
    }

    // Verify actor is mayor of this city
    const city = await prisma.city.findUnique({
        where: { id: params.cityId },
    });

    if (!city) {
        return {
            stateUpdates: [],
            events: [{
                actorId: actor.id,
                type: EventType.EVENT_PROPOSAL_SUBMITTED,
                targetIds: [],
                outcome: EventOutcome.BLOCKED,
                sideEffects: { reason: 'City not found' },
            }],
            intentStatus: IntentStatus.BLOCKED,
        };
    }

    if (city.mayorId !== actor.id) {
        return {
            stateUpdates: [],
            events: [{
                actorId: actor.id,
                type: EventType.EVENT_PROPOSAL_SUBMITTED,
                targetIds: [],
                outcome: EventOutcome.BLOCKED,
                sideEffects: { reason: 'Actor is not mayor of this city' },
            }],
            intentStatus: IntentStatus.BLOCKED,
        };
    }

    // Map intent type to proposal type
    const proposalTypeMap: Record<string, string> = {
        [IntentType.INTENT_CITY_UPGRADE]: 'upgrade',
        [IntentType.INTENT_CITY_TAX_CHANGE]: 'tax_change',
        [IntentType.INTENT_CITY_SOCIAL_AID]: 'aid',
        [IntentType.INTENT_CITY_SECURITY_FUNDING]: 'security',
    };
    const proposalType = proposalTypeMap[intent.type] || 'upgrade';

    // Anti-rug checks (God intervention)
    const payload = (params.payload || {}) as Record<string, unknown>;
    const cityPolicy = await prisma.cityPolicy.findUnique({ where: { cityId: params.cityId } });
    const cityVault = await prisma.cityVault.findUnique({ where: { cityId: params.cityId } });
    const vaultBalance = new Decimal(cityVault?.balanceSbyte?.toString() || '0');
    const { blockReasons, warnReasons, estimatedCost, normalizedPayload } = validateGovernanceProposal({
        proposalType,
        payload,
        vaultBalance,
        cityPolicy,
        currentTick: _tick,
    });

    if (payload.withdrawAmount !== undefined || payload.withdrawVault === true) {
        blockReasons.push('Attempted city vault withdrawal');
    }

    if (blockReasons.length > 0) {
        const god = await prisma.actor.findFirst({ where: { isGod: true } });
        const stateUpdates: StateUpdate[] = [
            {
                table: 'actor',
                operation: 'update',
                where: { id: actor.id },
                data: { reputation: 50 },
            }
        ];
        if (god) {
            stateUpdates.push({
                table: 'adminLog',
                operation: 'create',
                data: {
                    godId: god.id,
                    action: 'GOD_INTERVENTION',
                    payload: {
                        actorId: actor.id,
                        cityId: params.cityId,
                        intentType: intent.type,
                        reasons: blockReasons,
                        warnings: warnReasons,
                    }
                }
            });
        }

        return {
            stateUpdates,
            events: [{
                actorId: actor.id,
                type: EventType.EVENT_PROPOSAL_SUBMITTED,
                targetIds: [],
                outcome: EventOutcome.BLOCKED,
                sideEffects: { reason: blockReasons.join('; ') },
            }],
            intentStatus: IntentStatus.BLOCKED,
        };
    }

    if (warnReasons.length > 0) {
        const god = await prisma.actor.findFirst({ where: { isGod: true } });
        if (god) {
            await prisma.adminLog.create({
                data: {
                    godId: god.id,
                    action: 'GOD_WARNING',
                    payload: {
                        actorId: actor.id,
                        cityId: params.cityId,
                        intentType: intent.type,
                        warnings: warnReasons,
                    }
                }
            });
        }
    }

    // Generate proposal ID
    const proposalId = crypto.randomUUID();

    return {
        stateUpdates: [
            {
                table: 'cityProposal',
                operation: 'create',
                data: {
                    id: proposalId,
                    cityId: params.cityId,
                    mayorId: actor.id,
                    type: proposalType,
                    payload: { ...normalizedPayload, estimatedCost: estimatedCost.toString() },
                    status: 'pending',
                },
            },
        ],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_PROPOSAL_SUBMITTED,
            targetIds: [params.cityId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                proposalId,
                proposalType,
                cityId: params.cityId,
            },
        }],
        intentStatus: IntentStatus.EXECUTED,
    };
}

/**
 * Helper to apply state updates dynamically
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function applyStateUpdates(tx: any, updates: StateUpdate[]) {
    for (const update of updates) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tableModel = (tx as any)[update.table];

        if (update.operation === 'update') {
            await tableModel.update({
                where: update.where,
                data: update.data,
            });
        } else if (update.operation === 'create') {
            await tableModel.create({
                data: update.data,
            });
        } else if (update.operation === 'delete') {
            await tableModel.delete({
                where: update.where,
            });
        }
    }
}
