/**
 * Tick Runner - Background tick loop
 * Periodically processes world ticks
 */
import { prisma } from '../db.js';
import crypto from 'crypto';
import { processTick } from './world.engine.js';
import { checkFreeze, reviveFrozenAgents } from './freeze.engine.js';
import { EventType, EventOutcome } from '../types/event.types.js';
import { IntentStatus } from '../types/intent.types.js';
import { Decimal } from 'decimal.js';
import { ethers } from 'ethers';
import { processBusinessDaily } from './business.engine.js';
import { processLifeEvents } from './life-events.engine.js';
import { computeEconomicSnapshots, computeGodEconomicReport, pruneOldSnapshots, getLatestSnapshot } from '../services/economy-snapshot.service.js';
import { applyNeedsDecay } from './needs.engine.js';
import { applyEmotionalDecay } from './emotion.engine.js';
import { applyRelationshipDecay } from './social.engine.js';
import { generateTickNarrative } from './narrative.engine.js';
import { aggregateCityMetrics, regenerateLeaderboards } from './analytics.engine.js';
import { processConstructionProjects, generateConstructionQuotes, cleanupExpiredConstructionQuotes } from './construction.engine.js';
import { AgentBrain } from './agent-brain/brain.engine.js';
import { MemoryAccumulator } from './persona/memory-accumulator.js';
import { PersonaEngine } from './persona/persona.engine.js';
import { PersonaTrigger } from './persona/persona.trigger.js';
import { PersonaQueue } from './persona/persona.queue.js';
import { angelEngine } from './angel/angel.engine.js';
import { pnlEngine } from './pnl.engine.js';
import { propertyTaxEngine } from './property/property-tax.engine.js';
import { propertyMaintenanceEngine } from './property/property-maintenance.engine.js';
import { neighborhoodEngine } from './property/neighborhood.engine.js';
import { TICK_INTERVAL_MS, SIM_DAY_TICKS, SIM_TICKS_PER_HOUR } from '../config/time.js';
import { networthService } from '../services/networth.service.js';
import { getRestProfile } from './rest.utils.js';
import { GAMING_CONFIG } from '../config/gaming.js';
import { AgentTransferService } from '../services/agent-transfer.service.js';
import { debugLog } from '../utils/debug-log.js';
import { processNaturalDisasters } from './natural-disasters.engine.js'; // V6: Natural disasters
import { refreshAgoraSnapshot } from './agora/agora-snapshot.service.js';
import { classifyKeyEvent } from './key-events.engine.js';

let running = false;
let tickLoopTimeout: NodeJS.Timeout | null = null;
const brain = new AgentBrain();
const agentTransferService = new AgentTransferService();
const personaAccumulator = new MemoryAccumulator();
const personaTrigger = new PersonaTrigger();
const personaEngine = new PersonaEngine(personaAccumulator);
const personaQueue = new PersonaQueue(personaEngine, personaTrigger);
const STALE_PENDING_TICKS = 30;
const CONTINUOUS_INTENTS = new Set([
    'INTENT_REST',
    'INTENT_WORK',
    'INTENT_START_SHIFT',
    'INTENT_END_SHIFT',
    'INTENT_REQUEST_CONSTRUCTION',
    'INTENT_SUBMIT_CONSTRUCTION_QUOTE',
    'INTENT_ACCEPT_CONSTRUCTION_QUOTE',
]);

/**
 * Start the tick loop
 */
export async function startTickRunner(): Promise<void> {
    if (running) {
        console.log('Tick runner already running');
        return;
    }

    running = true;
    console.log(`✓ Tick runner started (interval: ${TICK_INTERVAL_MS}ms)`);

    tickLoop();
}

/**
 * Stop the tick loop
 */
export function stopTickRunner(): void {
    running = false;
    if (tickLoopTimeout) {
        clearTimeout(tickLoopTimeout);
        tickLoopTimeout = null;
    }
    console.log('Tick runner stopped');
}

/**
 * Main tick loop
 */
async function tickLoop(): Promise<void> {
    if (!running) return;

    try {
        // Get current world state
        let worldState = await prisma.worldState.findFirst({
            where: { id: 1 },
        });

        // Create if doesn't exist
        if (!worldState) {
            worldState = await prisma.worldState.create({
                data: { id: 1, tick: 0 },
            });
        }

        const currentTick = worldState.tick;
        const seed = BigInt(Date.now()); // Use timestamp as seed for MVP

        console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`Processing tick ${currentTick}`);

        // 0. Auto-resolve activity timers (before brain)
        await queueAutoShiftEnds(currentTick);
        await clearExpiredActivities(currentTick);
        await applyRestingRecovery(currentTick);
        await clearStaleActivities();
        await clearStalePendingIntents(currentTick);
        await refreshAgoraSnapshot(currentTick);

        // 1. BRAIN: Generate Decisions for all Agents
        // -------------------------------------------------------------
        const activeAgents = await prisma.actor.findMany({
            where: { kind: 'agent', frozen: false, dead: false },
            select: { id: true }
        });

        if (activeAgents.length > 0) {
            console.log(`  🧠 Brain thinking for ${activeAgents.length} agents...`);
            const decisionsCount = await processBrainsInChunks(activeAgents, currentTick, seed.toString());
            console.log(`  🧠 Generated ${decisionsCount} new intents`);
        }
        // -------------------------------------------------------------

        // 1. Process intents
        const { processedIntents, events } = await processTick(currentTick, seed);
        console.log(`  Processed ${processedIntents} intents`);
        console.log(`  Generated ${events.length} events`);

        // 1.1 Persona memory + triggers
        for (const event of events) {
            personaAccumulator.ingestForEvent(event, currentTick);
            const trigger = personaTrigger.shouldReflect(event.actorId, event, currentTick);
            if (trigger) personaQueue.enqueue(event.actorId, trigger, currentTick);
            for (const targetId of event.targetIds || []) {
                const targetTrigger = personaTrigger.shouldReflect(targetId, event, currentTick);
                if (targetTrigger) personaQueue.enqueue(targetId, targetTrigger, currentTick);
            }
        }

        // 1.2 Narrative events from tick
        if (events.length > 0) {
            await generateTickNarrative(currentTick, events);
        }

        // 2. Check freeze conditions for all agents
        const freezeCount = await checkFreeze(currentTick);
        if (freezeCount > 0) {
            console.log(`  Froze ${freezeCount} agents`);
        }
        const revivedCount = await reviveFrozenAgents(currentTick);
        if (revivedCount > 0) {
            console.log(`  Revived ${revivedCount} agents (balance restored)`);
        }

        // 2.5 Daily reputation drift (sim-time day)
        if (currentTick > 0 && currentTick % SIM_DAY_TICKS === 0) {
            const driftCount = await applyDailyReputationDrift(currentTick);
            console.log(`  Applied reputation drift to ${driftCount} agents`);
        }

        // 2.52 Emotional decay & relationship decay (every 10 ticks)
        if (currentTick > 0 && currentTick % 10 === 0) {
            await applyEmotionalDecay(currentTick);
            await applyRelationshipDecay(currentTick);
        }

        // 2.55 Needs decay (every 60 ticks)
        if (currentTick > 0 && currentTick % 60 === 0) {
            const decayed = await applyNeedsDecay(currentTick);
            console.log(`  Needs decay applied to ${decayed} agents`);
        }

        // 2.6 Daily business and life event cycles (sim-time day)
        if (currentTick > 0 && currentTick % SIM_DAY_TICKS === 0) {
            const businessCount = await processBusinessDaily(currentTick, seed);
            const lifeEvents = await processLifeEvents(currentTick, seed);
            console.log(`  Business daily cycle: ${businessCount} businesses`);
            console.log(`  Life events triggered: ${lifeEvents}`);

            await prisma.agentState.updateMany({
                where: { gamesToday: { gt: 0 } },
                data: { gamesToday: 0 }
            });
            await prisma.$executeRaw`
                UPDATE "agent_state"
                SET "recent_gaming_pnl" = "recent_gaming_pnl" * 0.8
                WHERE ABS("recent_gaming_pnl") > 1
            `;

            // V6: Natural disasters (random chance per city per sim-day)
            const disastersTriggered = await processNaturalDisasters(currentTick, Number(seed));
            if (disastersTriggered > 0) {
                console.log(`  🌪️  Natural disasters triggered: ${disastersTriggered}`);
            }

            await emitCityPulseEvents(currentTick);
        }

        // 2.65 Construction progress (every tick)
        const quotesGenerated = await generateConstructionQuotes(currentTick);
        const quotesExpired = await cleanupExpiredConstructionQuotes(currentTick);
        const constructionCount = await processConstructionProjects(currentTick);
        if (constructionCount > 0) {
            console.log(`  Construction projects processed: ${constructionCount}`);
        }
        if (quotesGenerated > 0 || quotesExpired > 0) {
            console.log(`  Construction quotes: +${quotesGenerated}, expired ${quotesExpired}`);
        }

        // 2.7 Economic snapshots (every 50 ticks)
        if (currentTick > 0 && currentTick % 50 === 0) {
            const snapshotCount = await computeEconomicSnapshots(currentTick);
            console.log(`  Economic snapshots computed: ${snapshotCount}`);
            const activeCities = await prisma.city.findMany({ select: { id: true } });
            for (const city of activeCities) {
                neighborhoodEngine.computeNeighborhoodScores(city.id, currentTick).catch(console.error);
            }
        }

        // 2.8 God economic report (every 100 ticks)
        if (currentTick > 0 && currentTick % 100 === 0) {
            await computeGodEconomicReport(currentTick);
            await pruneOldSnapshots();
            console.log('  God economic report updated');
        }

        // 2.9 Analytics (every 50 ticks)
        if (currentTick > 0 && currentTick % 50 === 0) {
            await aggregateCityMetrics(currentTick);
        }

        // 2.10 Leaderboards (every 10 ticks)
        if (currentTick > 0 && currentTick % 10 === 0) {
            await regenerateLeaderboards(currentTick);
        }

        // 2.11 PNL snapshots + leaderboard (every 720 ticks)
        if (currentTick > 0 && currentTick % 720 === 0) {
            await pnlEngine.takeSnapshots(currentTick);
            await networthService.takeSnapshots(new Date());
        }

        // 2.11.1 Property tax + maintenance (every 8640 ticks)
        if (currentTick > 0 && currentTick % 8640 === 0) {
            const activeCities = await prisma.city.findMany({ select: { id: true } });
            for (const city of activeCities) {
                propertyTaxEngine.collectTaxes(currentTick, city.id).catch(console.error);
                propertyMaintenanceEngine.degradeAll(currentTick).catch(console.error);
            }
        }

        // 2.12 Periodic persona triggers (cheap check)
        for (const agent of activeAgents) {
            const periodic = personaTrigger.shouldReflect(agent.id, null, currentTick);
            if (periodic) personaQueue.enqueue(agent.id, periodic, currentTick);
        }

        // 2.13 Angel moderation cycles
        if (currentTick > 0 && currentTick % 50 === 0) {
            angelEngine.reviewFlaggedPosts(currentTick).catch(console.error);
        }
        if (currentTick > 0 && currentTick % 7200 === 0) {
            angelEngine.generateWorldReport(currentTick).catch(console.error);
        }

        if (currentTick > 0 && currentTick % 5 === 0) {
            await expireGameChallenges(currentTick);
        }

        // 3. Increment tick
        await prisma.worldState.update({
            where: { id: 1 },
            data: {
                tick: currentTick + 1,
                updatedAt: new Date(),
            },
        });

        console.log(`Tick ${currentTick} complete → now at tick ${currentTick + 1}`);

    } catch (error) {
        console.error('Error in tick loop:', error);
        try {
            const fallbackState = await prisma.worldState.findFirst({ where: { id: 1 } });
            if (fallbackState) {
                await prisma.worldState.update({
                    where: { id: 1 },
                    data: {
                        tick: fallbackState.tick + 1,
                        updatedAt: new Date(),
                    },
                });
                console.warn(`Tick advanced despite error → now at tick ${fallbackState.tick + 1}`);
            }
        } catch (advanceError) {
            console.error('Failed to advance tick after error:', advanceError);
        }
    }

    // Schedule next tick
    if (running) {
        tickLoopTimeout = setTimeout(tickLoop, TICK_INTERVAL_MS);
    }
}

async function clearStalePendingIntents(currentTick: number): Promise<void> {
    const cutoffTick = currentTick - STALE_PENDING_TICKS;
    if (cutoffTick <= 0) return;

    const stale = await prisma.intent.findMany({
        where: {
            status: 'pending',
            tick: { lte: cutoffTick },
        },
        select: { id: true, params: true, type: true },
        take: 500,
    });
    if (stale.length === 0) return;

    for (const intent of stale) {
        if (CONTINUOUS_INTENTS.has(intent.type)) {
            continue;
        }
        const params = (intent.params as any) ?? {};
        await prisma.intent.update({
            where: { id: intent.id },
            data: {
                status: 'blocked',
                params: {
                    ...params,
                    blockReason: 'stale_pending_intent',
                    stale: { atTick: currentTick, threshold: STALE_PENDING_TICKS },
                },
            },
        });
    }
    console.warn(`Cleared ${stale.length} stale pending intents (>${STALE_PENDING_TICKS} ticks)`);
}

export async function applyDailyReputationDrift(currentTick: number): Promise<number> {
    const agents = await prisma.actor.findMany({
        where: { kind: 'agent' },
        include: { agentState: true }
    });

    let updated = 0;
    for (const agent of agents) {
        const state = agent.agentState;
        if (!state) continue;

        let delta = new Decimal(0);

        // Housing drift
        switch (state.housingTier) {
            case 'street':
                delta = delta.minus(2);
                break;
            case 'shelter':
            case 'slum_room':
                delta = delta.minus(0.5);
                break;
            case 'condo':
            case 'house':
                delta = delta.plus(0.1);
                break;
            case 'villa':
            case 'estate':
            case 'palace':
            case 'citadel':
                delta = delta.plus(0.5);
                break;
            default:
                break;
        }

        // Employment drift
        if (state.jobType === 'unemployed') {
            delta = delta.minus(1);
        }

        // Public job drift
        const publicJob = await prisma.publicEmployment.findUnique({ where: { actorId: agent.id } });
        if (publicJob && publicJob.endedAtTick === null) {
            delta = delta.plus(0.5);
        }

        // Marriage drift
        const marriage = await prisma.consent.findFirst({
            where: {
                OR: [{ partyAId: agent.id }, { partyBId: agent.id }],
                type: 'marriage',
                status: 'active'
            }
        });
        if (marriage) {
            delta = delta.plus(0.2);
        }

        // Wealth drift
        const wealth = state.wealthTier || 'W0';
        const wealthNum = parseInt(wealth.replace('W', ''), 10);
        if (!Number.isNaN(wealthNum) && wealthNum >= 6) {
            delta = delta.plus(0.5);
        }

        if (delta.equals(0)) continue;

        const currentRep = new Decimal(agent.reputation?.toString() || '200');
        let nextRep = currentRep.plus(delta);
        if (nextRep.lessThan(0)) nextRep = new Decimal(0);
        if (nextRep.greaterThan(1000)) nextRep = new Decimal(1000);

        await prisma.actor.update({
            where: { id: agent.id },
            data: { reputation: nextRep.toNumber() }
        });

        await prisma.event.create({
            data: {
                actorId: agent.id,
                type: EventType.EVENT_REPUTATION_UPDATED,
                targetIds: [],
                tick: currentTick,
                outcome: EventOutcome.SUCCESS,
                sideEffects: {
                    delta: delta.toNumber(),
                    reason: 'daily_drift'
                }
            }
        });

        updated += 1;
    }

    return updated;
}

async function queueAutoShiftEnds(currentTick: number): Promise<void> {
    const endingWorkers = await prisma.agentState.findMany({
        where: {
            activityState: 'WORKING',
            activityEndTick: { lte: currentTick },
            actor: {
                frozen: false,
                dead: false,
            }
        },
        select: { actorId: true, activityEndTick: true }
    });

    if (endingWorkers.length === 0) return;

    for (const worker of endingWorkers) {
        const employment = await prisma.publicEmployment.findUnique({
            where: { actorId: worker.actorId }
        });
        if (!employment || employment.endedAtTick !== null) continue;

        const existingIntent = await prisma.intent.findFirst({
            where: {
                actorId: worker.actorId,
                type: 'INTENT_END_SHIFT',
                status: 'pending',
            }
        });
        if (existingIntent) continue;

        await prisma.intent.create({
            data: {
                actorId: worker.actorId,
                type: 'INTENT_END_SHIFT',
                params: { source: 'system_auto' },
                priority: 1,
                status: 'pending',
                tick: currentTick,
            }
        });
    }
}

async function clearExpiredActivities(currentTick: number): Promise<void> {
    const expired = await prisma.agentState.findMany({
        where: {
            activityState: { in: ['RESTING', 'WORKING'] },
            activityEndTick: { lte: currentTick },
            actor: {
                frozen: false,
                dead: false,
            }
        },
        select: { actorId: true, activityState: true, housingTier: true, energy: true, health: true, purpose: true }
    });

    if (expired.length === 0) return;

    const actorIds = expired.map((state) => state.actorId);
    const inventoryItems = await prisma.inventoryItem.findMany({
        where: { actorId: { in: actorIds }, quantity: { gt: 0 } },
        include: { itemDef: true }
    });
    const itemNamesByActor = new Map<string, string[]>();
    for (const item of inventoryItems) {
        const list = itemNamesByActor.get(item.actorId) ?? [];
        list.push(item.itemDef.name);
        itemNamesByActor.set(item.actorId, list);
    }

    for (const state of expired) {
        if (state.activityState === 'WORKING') {
            const employment = await prisma.publicEmployment.findUnique({
                where: { actorId: state.actorId }
            });
            if (employment && employment.endedAtTick === null) {
                // Grace period: let INTENT_END_SHIFT handle it normally
                // But if overdue by 120+ ticks, force to IDLE as safety valve
                const activityEnd = await prisma.agentState.findUnique({
                    where: { actorId: state.actorId },
                    select: { activityEndTick: true }
                });
                const endTick = activityEnd?.activityEndTick ?? currentTick;
                if (currentTick - endTick < 120) {
                    continue;
                }
                console.warn(`Force-idling ${state.actorId}: shift overdue by ${currentTick - endTick} ticks`);
                // Fall through to normal WORKING→IDLE/REST transition below
            }
            const ownedItems = itemNamesByActor.get(state.actorId) ?? [];
            if ((state.energy ?? 0) < 40) {
                const restProfile = getRestProfile(state.housingTier || 'street', ownedItems);
                const exhaustionFactor = Math.max(0.5, 1 - (state.energy ?? 0) / 40);
                const adjustedHours = Math.ceil(restProfile.restHours * exhaustionFactor);
                const restEndTick = currentTick + (adjustedHours * SIM_TICKS_PER_HOUR);
                await prisma.agentState.update({
                    where: { actorId: state.actorId },
                    data: {
                        activityState: 'RESTING',
                        activityEndTick: restEndTick,
                        energy: Math.min(100, (state.energy ?? 0) + 5),
                        health: Math.min(100, (state.health ?? 0) + 5),
                    }
                });
                continue;
            }
            await prisma.agentState.update({
                where: { actorId: state.actorId },
                data: {
                    activityState: 'IDLE',
                    activityEndTick: null,
                }
            });
            continue;
        }

        if (state.activityState === 'RESTING') {
            const ownedItems = itemNamesByActor.get(state.actorId) ?? [];
            const restProfile = getRestProfile(state.housingTier || 'street', ownedItems);
            const restHours = restProfile.restHours;
            const baseEnergyGain = restHours * 12;
            const baseHealthGain = Math.max(2, Math.floor(restHours * 1.1));
            const energyGain = Math.round(baseEnergyGain * restProfile.energyMult);
            const healthGain = Math.round(baseHealthGain * restProfile.healthMult);
            await prisma.agentState.update({
                where: { actorId: state.actorId },
                data: {
                    activityState: 'IDLE',
                    activityEndTick: null,
                    energy: Math.min(100, (state.energy ?? 0) + energyGain),
                    health: Math.min(100, (state.health ?? 0) + healthGain),
                    purpose: Math.min(100, (state.purpose ?? 0) + 3),
                }
            });
            continue;
        }

        await prisma.agentState.update({
            where: { actorId: state.actorId },
            data: {
                activityState: 'IDLE',
                activityEndTick: null,
            }
        });
    }
}

async function clearStaleActivities(): Promise<void> {
    const stale = await prisma.agentState.findMany({
        where: {
            activityState: { in: ['RESTING', 'WORKING'] },
            activityEndTick: null,
        },
        select: { actorId: true }
    });

    if (stale.length === 0) return;

    for (const state of stale) {
        await prisma.agentState.update({
            where: { actorId: state.actorId },
            data: {
                activityState: 'IDLE',
                activityEndTick: null,
            }
        });
    }
}

async function expireGameChallenges(currentTick: number): Promise<void> {
    const pending = await prisma.consent.findMany({
        where: { type: 'game_challenge', status: 'pending' },
        select: { id: true, terms: true, partyAId: true, cityId: true }
    });

    if (pending.length === 0) return;
    const god = await prisma.actor.findFirst({ where: { isGod: true } });
    if (!god) return;

    for (const challenge of pending) {
        const createdAtTick = Number((challenge.terms as any)?.createdAtTick ?? 0);
        const stake = Number((challenge.terms as any)?.stake ?? 0);
        const escrowed = Boolean((challenge.terms as any)?.escrowed);
        if (currentTick - createdAtTick > GAMING_CONFIG.CHALLENGE_EXPIRY_TICKS) {
            if (escrowed && stake > 0) {
                try {
                    const useQueue = process.env.ENABLE_ONCHAIN_QUEUE === 'true';
                    if (useQueue) {
                        const jobId = crypto.randomUUID();
                        const stakeWei = ethers.parseEther(stake.toString());
                        await prisma.$transaction([
                            prisma.consent.update({
                                where: { id: challenge.id },
                                data: { status: 'expired' }
                            }),
                            prisma.platformVault.update({
                                where: { id: 1 },
                                data: { balanceSbyte: { decrement: stake } }
                            }),
                            prisma.onchainJob.create({
                                data: {
                                    id: jobId,
                                    jobType: 'AGENT_TRANSFER_SBYTE',
                                    status: 'queued',
                                    payload: {
                                        fromActorId: god.id,
                                        toActorId: challenge.partyAId,
                                        amountWei: stakeWei.toString(),
                                        reason: 'gaming_pvp_refund',
                                        cityId: challenge.cityId ?? null,
                                    },
                                    actorId: god.id,
                                    retryCount: 0,
                                    nextAttemptAt: new Date(),
                                }
                            }),
                            prisma.transaction.create({
                                data: {
                                    id: crypto.randomUUID(),
                                    fromActorId: god.id,
                                    toActorId: challenge.partyAId,
                                    amount: stake,
                                    feePlatform: 0,
                                    feeCity: 0,
                                    cityId: challenge.cityId ?? null,
                                    tick: currentTick,
                                    reason: 'gaming_pvp_refund',
                                    onchainTxHash: null,
                                    metadata: { stake, role: 'challenger_refund', expired: true, onchainJobId: jobId }
                                }
                            })
                        ]);
                    } else {
                        const refundTx = await agentTransferService.transfer(
                            god.id,
                            challenge.partyAId,
                            ethers.parseEther(stake.toString()),
                            'gaming_pvp_refund',
                            challenge.cityId || undefined
                        );
                        await prisma.$transaction([
                            prisma.consent.update({
                                where: { id: challenge.id },
                                data: { status: 'expired' }
                            }),
                            prisma.platformVault.update({
                                where: { id: 1 },
                                data: { balanceSbyte: { decrement: stake } }
                            }),
                            prisma.transaction.create({
                                data: {
                                    fromActorId: god.id,
                                    toActorId: challenge.partyAId,
                                    amount: stake,
                                    feePlatform: Number(ethers.formatEther(refundTx.platformFee)),
                                    feeCity: Number(ethers.formatEther(refundTx.cityFee)),
                                    cityId: challenge.cityId ?? null,
                                    tick: currentTick,
                                    reason: 'gaming_pvp_refund',
                                    onchainTxHash: refundTx.txHash,
                                    metadata: { stake, role: 'challenger_refund', expired: true }
                                }
                            })
                        ]);
                    }
                } catch (error) {
                    console.error('Failed to refund expired game challenge', error);
                }
            } else {
                await prisma.consent.update({
                    where: { id: challenge.id },
                    data: { status: 'expired' }
                });
            }
        }
    }
}

async function emitCityPulseEvents(currentTick: number): Promise<void> {
    const god = await prisma.actor.findFirst({
        where: { isGod: true },
        select: { id: true, name: true }
    });
    const cities = await prisma.city.findMany({
        select: { id: true, name: true, mayorId: true }
    });
    for (const city of cities) {
        const actorId = city.mayorId ?? god?.id ?? null;
        if (!actorId) continue;
        const snapshot = getLatestSnapshot(city.id);
        const sideEffects = {
            city: city.name,
            cityName: city.name,
            economicHealth: snapshot?.economic_health ?? 'stable',
            unemployment: snapshot?.unemployment_rate ?? null,
            vacancyRate: snapshot?.housing_vacancy_rate ?? null,
        };
        const classification = classifyKeyEvent('EVENT_CITY_PULSE', sideEffects);
        await prisma.event.create({
            data: {
                id: crypto.randomUUID(),
                actorId,
                type: EventType.EVENT_CITY_PULSE,
                targetIds: [],
                tick: currentTick,
                outcome: EventOutcome.SUCCESS,
                sideEffects,
                isKeyEvent: classification.isKeyEvent,
                keyEventTier: classification.tier,
                keyEventHeadline: classification.headline,
                agoraTriggerBoard: classification.agoraTriggerBoard,
            }
        });
    }
}

async function applyRestingRecovery(currentTick: number): Promise<void> {
    const resting = await prisma.agentState.findMany({
        where: {
            activityState: 'RESTING',
            activityEndTick: { gt: currentTick },
            actor: { frozen: false, dead: false }
        },
        select: { actorId: true, housingTier: true, energy: true, health: true }
    });

    if (resting.length === 0) return;

    const actorIds = resting.map((state) => state.actorId);
    const inventoryItems = await prisma.inventoryItem.findMany({
        where: { actorId: { in: actorIds }, quantity: { gt: 0 } },
        include: { itemDef: true }
    });
    const itemNamesByActor = new Map<string, string[]>();
    for (const item of inventoryItems) {
        const list = itemNamesByActor.get(item.actorId) ?? [];
        list.push(item.itemDef.name);
        itemNamesByActor.set(item.actorId, list);
    }

    for (const state of resting) {
        const ownedItems = itemNamesByActor.get(state.actorId) ?? [];
        const restProfile = getRestProfile(state.housingTier || 'street', ownedItems);
        const energyDivisor = restProfile.energyMult > 0 ? restProfile.energyMult : 1;
        const healthDivisor = restProfile.healthMult > 0 ? restProfile.healthMult : 1;
        const energyInterval = Math.max(1, Math.round(8 / energyDivisor));
        const healthInterval = Math.max(1, Math.round(24 / healthDivisor));
        const energyGain = currentTick % energyInterval === 0 ? 1 : 0;
        const healthGain = currentTick % healthInterval === 0 ? 1 : 0;
        if (energyGain > 0 || healthGain > 0) {
            await prisma.agentState.update({
                where: { actorId: state.actorId },
                data: {
                    energy: Math.min(100, (state.energy ?? 0) + energyGain),
                    health: Math.min(100, (state.health ?? 0) + healthGain),
                }
            });
        }
    }
}

async function processBrainsInChunks(
    activeAgents: Array<{ id: string }>,
    currentTick: number,
    seed: string
): Promise<number> {
    let decisionsCount = 0;
    const chunkSize = 10;
    const SURVIVAL_OVERRIDE_INTENTS = new Set([
        'INTENT_REST',
        'INTENT_CONSUME_ITEM',
        'INTENT_BUY_ITEM',
        'INTENT_VISIT_BUSINESS',
    ]);

    for (let i = 0; i < activeAgents.length; i += chunkSize) {
        const chunk = activeAgents.slice(i, i + chunkSize);
        const results = await Promise.all(chunk.map(async (agent) => {
            try {
                const decision = await withTimeout(
                    brain.decideAction(agent.id, currentTick, seed),
                    4000,
                    `brain.decideAction(${agent.id})`
                );
                debugLog('tick.brain_decision', {
                    agentId: agent.id,
                    tick: currentTick,
                    intentType: decision.intentType,
                    params: decision.params,
                    priority: decision.priority,
                    reason: decision.reason,
                    budgetExceeded: decision.budgetExceeded ?? [],
                });
                if (decision.intentType !== 'INTENT_IDLE') {
                    const existingPending = await prisma.intent.findFirst({
                        where: { actorId: agent.id, status: 'pending' },
                        select: { id: true, params: true }
                    });
                    if (existingPending) {
                        const source = (existingPending.params as any)?.source;
                        const allowOverride = source === 'owner_suggestion'
                            || SURVIVAL_OVERRIDE_INTENTS.has(decision.intentType);
                        if (!allowOverride) {
                            debugLog('tick.pending_intent_skipped', {
                                agentId: agent.id,
                                tick: currentTick,
                                intentType: decision.intentType,
                                reason: 'pending_intent_exists',
                            });
                            return { actorId: agent.id, created: 0, budgetExceeded: decision.budgetExceeded ?? [] };
                        }
                    }
                    const createdIntent = await prisma.intent.create({
                        data: {
                            actorId: agent.id,
                            type: decision.intentType,
                            params: { ...(decision.params ?? {}), source: 'agent_brain' },
                            priority: decision.priority,
                            status: 'pending',
                            tick: currentTick
                        }
                    });
                    if ((decision.params as any)?.ownerOverride) {
                        const pendingOwnerSuggestion = await prisma.intent.findFirst({
                            where: {
                                actorId: agent.id,
                                status: 'pending',
                                params: { path: ['source'], equals: 'owner_suggestion' }
                            },
                            orderBy: { createdAt: 'desc' }
                        });
                        if (pendingOwnerSuggestion) {
                            const params = (pendingOwnerSuggestion.params as any) ?? {};
                            await prisma.intent.update({
                                where: { id: pendingOwnerSuggestion.id },
                                data: {
                                    status: IntentStatus.REWRITTEN,
                                    params: {
                                        ...params,
                                        rewrittenToIntentId: createdIntent.id,
                                        rewrittenAtTick: currentTick
                                    }
                                }
                            });
                        }
                    }
                    return { actorId: agent.id, created: 1, budgetExceeded: decision.budgetExceeded ?? [] };
                }
                return { actorId: agent.id, created: 0, budgetExceeded: decision.budgetExceeded ?? [] };
            } catch (err) {
                console.error(`  ❌ Error processing brain for agent ${agent.id}:`, err);
                return { actorId: agent.id, created: 0, budgetExceeded: [] };
            }
        }));

        for (const result of results) {
            decisionsCount += result.created;
            if (result.budgetExceeded.length > 0) {
                await prisma.event.create({
                    data: {
                        actorId: result.actorId,
                        type: EventType.EVENT_SKILL_BUDGET_EXCEEDED,
                        targetIds: [],
                        tick: currentTick,
                        outcome: EventOutcome.SUCCESS,
                        sideEffects: { skills: result.budgetExceeded }
                    }
                });
            }
        }
    }

    return decisionsCount;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error(`Timeout after ${ms}ms: ${label}`));
        }, ms);
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Run a single tick manually (for testing)
 */
export async function runSingleTick(): Promise<{
    tick: number;
    processedIntents: number;
    eventsGenerated: number;
}> {
    const worldState = await prisma.worldState.findFirst({
        where: { id: 1 },
    });

    const currentTick = worldState?.tick ?? 0;
    const seed = BigInt(Date.now());

    const { processedIntents, events } = await processTick(currentTick, seed);
    await checkFreeze(currentTick);

    await prisma.worldState.update({
        where: { id: 1 },
        data: {
            tick: currentTick + 1,
            updatedAt: new Date(),
        },
    });

    return {
        tick: currentTick,
        processedIntents,
        eventsGenerated: events.length,
    };
}
