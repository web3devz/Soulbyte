/**
 * Public Employment Handlers
 * Manages public sector jobs (Hospital, School, Police Station)
 * 
 * Rules from PublicEmploymentManager.skill.md:
 * - WORKING state blocks: trade, games, dating, crimes, migration
 * - Work hours: Doctor 3h, Teacher 4h, Nurse/Officer 5h
 * - Rest hours by wealth: Homeless 8h → Luxury 2h
 * - Salary from CityVault, partial payment if insufficient
 * - One public job per agent
 * - Absent 3 days → automatic termination (tracked via experienceDays)
 * - 25% housing cost reduction for public employees
 */

import { prisma } from '../../db.js';
import crypto from 'crypto';
import { IntentStatus, PublicRoleType, PUBLIC_ROLE_EXPERIENCE_REQ, PUBLIC_ROLE_SALARIES, PUBLIC_ROLE_WORK_HOURS } from '../../types/intent.types.js';
import { EventType, EventOutcome } from '../../types/event.types.js';
import { IntentHandler, StateUpdate } from '../engine.types.js';
import { Decimal } from 'decimal.js';
import { ethers } from 'ethers';
import { CONTRACTS } from '../../config/contracts.js';
import { calculateFees, getCachedVaultHealth, getDynamicFeeBps } from '../../config/fees.js';
import { getSalaryMultiplier } from '../../config/economic-governor.js';
import { AgentTransferService } from '../../services/agent-transfer.service.js';
import { REAL_DAY_TICKS, SIM_TICKS_PER_HOUR } from '../../config/time.js';
import {
    canStartWorkSegment,
    getWorkSegmentDurationTicks,
    registerWorkSegmentCompletion,
    getWorkStrainTierForPublicRole,
    getWorkStatusCost
} from '../work.utils.js';
import { getRestProfile } from '../rest.utils.js';
import { debugLog } from '../../utils/debug-log.js';
import { createOnchainJobUpdate } from '../../services/onchain-queue.service.js';

const agentTransferService = new AgentTransferService();
const ENABLE_WORK_DEBUG = process.env.DEBUG_WORK_LOG === 'true';

function logWorkDebug(payload: Record<string, unknown>) {
    if (!ENABLE_WORK_DEBUG) return;
    console.debug('[work-debug]', payload);
}

// ============================================================================
// INTENT_APPLY_PUBLIC_JOB
// ============================================================================

async function getSalaryOverrides(): Promise<Record<string, number> | null> {
    const config = await prisma.systemConfig.findUnique({ where: { key: 'PUBLIC_ROLE_SALARIES' } });
    if (!config?.value) return null;
    try {
        const parsed = JSON.parse(config.value);
        if (!parsed || typeof parsed !== 'object') return null;
        return parsed as Record<string, number>;
    } catch {
        return null;
    }
}

export const handleApplyPublicJob: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    const params = intent.params as { publicPlaceId?: string, role?: PublicRoleType };
    const JOB_APPLICATION_COOLDOWN = 720;

    if (!params?.publicPlaceId || !params.role) {
        return fail(actor.id, EventType.EVENT_PUBLIC_JOB_APPLIED, 'Missing publicPlaceId or role');
    }
    const JOB_CHANGE_COOLDOWN = 720;
    if (agentState?.lastJobChangeTick && tick - agentState.lastJobChangeTick < JOB_CHANGE_COOLDOWN) {
        return fail(actor.id, EventType.EVENT_PUBLIC_JOB_APPLIED, 'job_change_cooldown');
    }
    const recentApply = await prisma.event.findFirst({
        where: { actorId: actor.id, type: EventType.EVENT_PUBLIC_JOB_APPLIED },
        orderBy: { tick: 'desc' },
        select: { tick: true }
    });
    if (recentApply && tick - recentApply.tick < JOB_APPLICATION_COOLDOWN) {
        return { stateUpdates: [], events: [], intentStatus: IntentStatus.BLOCKED };
    }

    // Check frozen state
    if (actor.frozen) {
        return fail(actor.id, EventType.EVENT_PUBLIC_JOB_APPLIED, 'Agent is frozen');
    }

    // Check if agent is in a city
    if (!agentState?.cityId) {
        return fail(actor.id, EventType.EVENT_PUBLIC_JOB_APPLIED, 'Agent must be in a city');
    }

    // Check if already has a public job
    const existingJob = await prisma.publicEmployment.findUnique({
        where: { actorId: actor.id }
    });
    if (existingJob && existingJob.endedAtTick === null) {
        return fail(actor.id, EventType.EVENT_PUBLIC_JOB_APPLIED, 'Already has a public job');
    }
    const activePrivateJob = await prisma.privateEmployment.findFirst({
        where: { agentId: actor.id, status: 'ACTIVE' },
        select: { id: true }
    });
    if (activePrivateJob) {
        return fail(actor.id, EventType.EVENT_PUBLIC_JOB_APPLIED, 'Already has a private job');
    }

    // Check public place exists and is in same city
    const publicPlace = await prisma.publicPlace.findUnique({
        where: { id: params.publicPlaceId }
    });
    if (!publicPlace) {
        return fail(actor.id, EventType.EVENT_PUBLIC_JOB_APPLIED, 'Public place not found');
    }
    if (publicPlace.cityId !== agentState.cityId) {
        return fail(actor.id, EventType.EVENT_PUBLIC_JOB_APPLIED, 'Public place is in different city');
    }

    // Check experience requirements
    const requiredExp = PUBLIC_ROLE_EXPERIENCE_REQ[params.role];
    const agentExp = agentState.publicExperience || 0;
    if (agentExp < requiredExp) {
        return fail(actor.id, EventType.EVENT_PUBLIC_JOB_APPLIED, `Need ${requiredExp} days experience for ${params.role}, have ${agentExp}`);
    }

    const roleMinWealth: Record<PublicRoleType, number> = {
        NURSE: 2,
        POLICE_OFFICER: 2,
        TEACHER: 3,
        DOCTOR: 4,
    };
    const wealthRank = parseInt((agentState.wealthTier || 'W0').replace('W', ''), 10) || 0;
    const minWealth = roleMinWealth[params.role] ?? 0;
    if (wealthRank < minWealth) {
        return fail(actor.id, EventType.EVENT_PUBLIC_JOB_APPLIED, `Wealth tier W${minWealth}+ required for ${params.role}`);
    }

    // Check if role matches public place type
    const roleToPlaceType: Record<PublicRoleType, string> = {
        DOCTOR: 'HOSPITAL',
        NURSE: 'HOSPITAL',
        TEACHER: 'SCHOOL',
        POLICE_OFFICER: 'POLICE_STATION',
    };
    if (publicPlace.type !== roleToPlaceType[params.role]) {
        return fail(actor.id, EventType.EVENT_PUBLIC_JOB_APPLIED, `Role ${params.role} doesn't match place type ${publicPlace.type}`);
    }

    const employmentId = existingJob?.id ?? crypto.randomUUID();
    const workHours = PUBLIC_ROLE_WORK_HOURS[params.role];
    const salaryOverrides = await getSalaryOverrides();
    const salaryMap = salaryOverrides ?? PUBLIC_ROLE_SALARIES;
    const dailySalary = salaryMap[params.role];
    debugLog('public_employment.apply', {
        actorId: actor.id,
        tick,
        publicPlaceId: params.publicPlaceId,
        role: params.role,
        dailySalary,
    });

    const employmentUpdate: StateUpdate = existingJob
        ? {
            table: 'publicEmployment',
            operation: 'update',
            where: { actorId: actor.id },
            data: {
                publicPlaceId: params.publicPlaceId,
                role: params.role,
                dailySalarySbyte: dailySalary,
                workHours: workHours,
                startedAtTick: tick,
                endedAtTick: null,
                experienceDays: 0,
            },
        }
        : {
            table: 'publicEmployment',
            operation: 'create',
            data: {
                id: employmentId,
                actorId: actor.id,
                publicPlaceId: params.publicPlaceId,
                role: params.role,
                dailySalarySbyte: dailySalary,
                workHours: workHours,
                startedAtTick: tick,
                experienceDays: 0,
            },
        };

    return {
        stateUpdates: [
            employmentUpdate,
            {
                table: 'agentState',
                operation: 'update',
                where: { actorId: actor.id },
                data: { purpose: Math.min(100, (agentState?.purpose ?? 0) + 2) }
            }
        ],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_PUBLIC_JOB_APPLIED,
            targetIds: [params.publicPlaceId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                publicPlaceId: params.publicPlaceId,
                publicPlaceName: publicPlace.name,
                publicPlaceType: publicPlace.type,
                role: params.role,
                cityId: publicPlace.cityId,
                dailySalary: dailySalary,
                employmentId
            }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

// ============================================================================
// INTENT_RESIGN_PUBLIC_JOB
// ============================================================================

export const handleResignPublicJob: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    const params = intent.params as {
        reason?: string;
        businessStartupPlan?: Record<string, unknown>;
        businessStartupCooldownUntilTick?: number;
    };

    // Check if has a public job
    const employment = await prisma.publicEmployment.findUnique({
        where: { actorId: actor.id }
    });
    if (!employment || employment.endedAtTick !== null) {
        return fail(actor.id, EventType.EVENT_PUBLIC_JOB_RESIGNED, 'No public job to resign from');
    }

    // Check if currently working (can't resign mid-shift)
    if (agentState?.activityState === 'WORKING') {
        return fail(actor.id, EventType.EVENT_PUBLIC_JOB_RESIGNED, 'Cannot resign while working');
    }

    const existingMarkers = (agentState as any)?.markers ?? {};
    const markerUpdate = params.businessStartupPlan
        ? {
            ...existingMarkers,
            nextBusinessIntent: params.businessStartupPlan,
            businessStartupCooldownUntilTick: params.businessStartupCooldownUntilTick ?? existingMarkers.businessStartupCooldownUntilTick
        }
        : null;

    return {
        stateUpdates: [{
            table: 'publicEmployment',
            operation: 'update',
            where: { actorId: actor.id },
            data: {
                endedAtTick: tick
            }
        }, {
            table: 'agentState',
            operation: 'update',
            where: { actorId: actor.id },
            data: {
                lastJobChangeTick: tick,
                ...(markerUpdate ? { markers: markerUpdate } : {})
            }
        }],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_PUBLIC_JOB_RESIGNED,
            targetIds: [employment.publicPlaceId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                employmentId: employment.id,
                role: employment.role,
                reason: params?.reason || 'voluntary_resignation'
            }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

// ============================================================================
// INTENT_START_SHIFT
// ============================================================================

export const handleStartShift: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    // Check if has a public job
    const employment = await prisma.publicEmployment.findUnique({
        where: { actorId: actor.id }
    });
    if (!employment || employment.endedAtTick !== null) {
        return fail(actor.id, EventType.EVENT_SHIFT_STARTED, 'No public job');
    }

    logWorkDebug({
        runId: 'work-pay-debug',
        hypothesisId: 'H4',
        location: 'public-employment.handlers.ts:start_shift_attempt',
        message: 'start_shift_attempt',
        data: {
            actorId: actor.id,
            tick,
            activityState: agentState?.activityState,
            energy: agentState?.energy,
            employmentLastWorkedTick: employment.lastWorkedTick,
            employmentEndedAtTick: employment.endedAtTick
        },
        timestamp: Date.now()
    });

    const publicPlace = await prisma.publicPlace.findUnique({
        where: { id: employment.publicPlaceId }
    });

    // Check if job hasn't ended
    if (employment.endedAtTick !== null) {
        return fail(actor.id, EventType.EVENT_SHIFT_STARTED, 'Employment has ended');
    }

    // Check if already working
    if (agentState?.activityState === 'WORKING') {
        return fail(actor.id, EventType.EVENT_SHIFT_STARTED, 'Already working');
    }

    // Check if frozen
    if (actor.frozen) {
        return fail(actor.id, EventType.EVENT_SHIFT_STARTED, 'Agent is frozen');
    }

    // Check if jailed
    const jailRecord = await prisma.jail.findUnique({
        where: { actorId: actor.id }
    });
    if (jailRecord && jailRecord.releaseTick > tick) {
        return fail(actor.id, EventType.EVENT_SHIFT_STARTED, 'Agent is jailed');
    }

    const jobKey = `public:${employment.id}`;
    const segmentGate = canStartWorkSegment(agentState, jobKey, tick);
    if (!segmentGate.allowed) {
        return fail(actor.id, EventType.EVENT_SHIFT_STARTED, segmentGate.reason ?? 'Work segment limit reached');
    }

    const ownedItems = await prisma.inventoryItem.findMany({
        where: { actorId: actor.id, quantity: { gt: 0 } },
        include: { itemDef: true }
    });
    const ownedItemNames = ownedItems.map((item) => item.itemDef.name);
    const workCost = getWorkStatusCost(
        getWorkStrainTierForPublicRole(employment.role),
        ownedItemNames,
        false
    );
    const wouldDropUnsafe = (agentState.energy - workCost.energy) <= 0
        || (agentState.health - workCost.health) <= 0
        || (agentState.hunger - workCost.hunger) <= 0;
    if (wouldDropUnsafe) {
        return fail(actor.id, EventType.EVENT_SHIFT_STARTED, 'Unsafe to work with current status');
    }

    const shiftDuration = getWorkSegmentDurationTicks(employment.workHours);
    const shiftEndTick = tick + shiftDuration;

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
                    fun: Math.max(0, agentState.fun - workCost.fun),
                    ...segmentGate.updates
            }
        }],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_SHIFT_STARTED,
            targetIds: [employment.publicPlaceId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                employmentId: employment.id,
                publicPlaceId: employment.publicPlaceId,
                publicPlaceName: publicPlace?.name ?? null,
                publicPlaceType: publicPlace?.type ?? null,
                dailySalary: employment.dailySalarySbyte.toString(),
                role: employment.role,
                shiftDurationHours: employment.workHours,
                shiftEndTick
            }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

// ============================================================================
// INTENT_END_SHIFT
// ============================================================================

export const handleEndShift: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    // Check if has a public job
    const employment = await prisma.publicEmployment.findUnique({
        where: { actorId: actor.id }
    });
    if (!employment || employment.endedAtTick !== null) {
        return fail(actor.id, EventType.EVENT_SHIFT_ENDED, 'No public job');
    }

    const publicPlace = await prisma.publicPlace.findUnique({
        where: { id: employment.publicPlaceId }
    });

    // Check if currently working
    if (agentState?.activityState !== 'WORKING') {
        return fail(actor.id, EventType.EVENT_SHIFT_ENDED, 'Not currently working');
    }

    const ownedItems = await prisma.inventoryItem.findMany({
        where: { actorId: actor.id, quantity: { gt: 0 } },
        include: { itemDef: true }
    });
    const ownedItemNames = ownedItems.map((item) => item.itemDef.name);
    const restProfile = getRestProfile(agentState.housingTier || 'street', ownedItemNames);
    const restHours = restProfile.restHours;
    const restEndTick = tick + (restHours * SIM_TICKS_PER_HOUR);

    const jobKey = `public:${employment.id}`;
    const segmentResult = registerWorkSegmentCompletion(agentState, jobKey, tick);
    const employmentUpdates: Record<string, unknown> = {};
    if (segmentResult.completedDay) {
        employmentUpdates.experienceDays = Math.min(1, (employment.experienceDays ?? 0) + 1);
        employmentUpdates.lastWorkedTick = tick;
    }

    logWorkDebug({
        runId: 'work-pay-debug',
        hypothesisId: 'H2',
        location: 'public-employment.handlers.ts:end_shift_execute',
        message: 'end_shift_execute',
        data: {
            actorId: actor.id,
            tick,
            activityState: agentState?.activityState,
            employmentLastWorkedTick: employment.lastWorkedTick,
            experienceDays: employment.experienceDays,
            restHours
        },
        timestamp: Date.now()
    });

    const stateUpdates: StateUpdate[] = [
        {
            table: 'agentState',
            operation: 'update',
            where: { actorId: actor.id },
            data: {
                activityState: 'RESTING',
                activityEndTick: restEndTick,
                social: Math.min(100, (agentState?.social ?? 0) + 3),
                purpose: Math.min(100, (agentState?.purpose ?? 0) + 5),
                fun: Math.max(0, (agentState?.fun ?? 0) - 2),
                ...segmentResult.updates
            }
        }
    ];
    if (Object.keys(employmentUpdates).length > 0) {
        stateUpdates.push({
            table: 'publicEmployment',
            operation: 'update',
            where: { actorId: actor.id },
            data: employmentUpdates
        });
    }

    return {
        stateUpdates,
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_SHIFT_ENDED,
            targetIds: [employment.publicPlaceId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                employmentId: employment.id,
                publicPlaceId: employment.publicPlaceId,
                publicPlaceName: publicPlace?.name ?? null,
                publicPlaceType: publicPlace?.type ?? null,
                dailySalary: employment.dailySalarySbyte.toString(),
                role: employment.role,
                shiftDurationHours: employment.workHours,
                restDurationHours: restHours,
                restEndTick
            }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

// ============================================================================
// INTENT_COLLECT_SALARY
// ============================================================================

export const handleCollectSalary: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    // Check if has a public job
    const employment = await prisma.publicEmployment.findUnique({
        where: { actorId: actor.id },
        include: {
            publicPlace: {
                include: { city: { include: { vault: true } } }
            }
        }
    });
    if (!employment || employment.endedAtTick !== null) {
        return fail(actor.id, EventType.EVENT_SALARY_COLLECTED, 'No public job');
    }

    // Check if wallet exists
    if (!wallet) {
        return fail(actor.id, EventType.EVENT_SALARY_COLLECTED, 'No wallet');
    }

    const lastSalaryTick = await getLastSalaryTick(actor.id);
    if (lastSalaryTick !== null && tick - lastSalaryTick < REAL_DAY_TICKS) {
        return fail(actor.id, EventType.EVENT_SALARY_COLLECTED, 'Salary already collected in the last 24h');
    }

    const jobKey = `public:${employment.id}`;
    if (!agentState?.lastWorkedTick || agentState.lastWorkJobKey !== jobKey) {
        return fail(actor.id, EventType.EVENT_SALARY_COLLECTED, 'No completed workday to pay');
    }

    // Calculate days worked (experienceDays tracks completed workdays)
    const daysToPayFor = Math.min(1, employment.experienceDays);
    if (daysToPayFor <= 0) {
        return fail(actor.id, EventType.EVENT_SALARY_COLLECTED, 'No days to collect salary for');
    }

    const vaultHealthDays = getCachedVaultHealth();
    const salaryMultiplier = getSalaryMultiplier(vaultHealthDays);
    const grossSalary = new Decimal(employment.dailySalarySbyte.toString()).mul(daysToPayFor).mul(salaryMultiplier);
    const feeBps = getDynamicFeeBps(vaultHealthDays);
    const grossWei = ethers.parseEther(grossSalary.toString());
    const feeBreakdown = calculateFees(grossWei, feeBps.cityBps, feeBps.platformBps);
    const platformFee = new Decimal(ethers.formatEther(feeBreakdown.platformFee));
    const cityFeeDecimal = new Decimal(ethers.formatEther(feeBreakdown.cityFee));
    const netSalary = new Decimal(ethers.formatEther(feeBreakdown.netAmount));
    const useQueue = process.env.ENABLE_ONCHAIN_QUEUE === 'true';
    const jobUpdates: StateUpdate[] = [];
    const jobIds: string[] = [];
    const transactionId = crypto.randomUUID();

    // Check city vault balance
    const cityVault = employment.publicPlace?.city?.vault;
    if (!cityVault) {
        return fail(actor.id, EventType.EVENT_SALARY_COLLECTED, 'City vault not found');
    }

    const vaultBalance = new Decimal(cityVault.balanceSbyte.toString());
    let actualPayment = netSalary;
    let partialPayment = false;

    logWorkDebug({
        runId: 'work-pay-debug',
        hypothesisId: 'H1',
        location: 'public-employment.handlers.ts:collect_salary_check',
        message: 'collect_salary_check',
        data: {
            actorId: actor.id,
            tick,
            lastSalaryTick,
            experienceDays: employment.experienceDays,
            lastWorkedTick: employment.lastWorkedTick,
            vaultBalance: vaultBalance.toNumber()
        },
        timestamp: Date.now()
    });

    // Handle partial payment if vault is insufficient
    if (vaultBalance.lessThan(netSalary)) {
        actualPayment = vaultBalance;
        partialPayment = true;
    }

    if (actualPayment.lessThanOrEqualTo(0)) {
        return fail(actor.id, EventType.EVENT_SALARY_COLLECTED, 'City vault is empty');
    }

    // Get God Actor (System Signer)
    const god = await prisma.actor.findFirst({ where: { isGod: true } });
    if (!god) return fail(actor.id, EventType.EVENT_SALARY_COLLECTED, 'System offline (God missing)');

    // Execute On-Chain Transfer (Salary)
    let salaryTxHash: string | null = null;
    let platformFeeTxHash: string | null = null;
    let salaryFees = { platformFee: 0n, cityFee: 0n };
    try {
        // God Payouts to Agent (Salary)
        // We pay from God/System wallet (which aggregates taxes) to agent
        const salaryWei = ethers.parseEther(actualPayment.toString());
        const feeBreakdown = calculateFees(salaryWei, feeBps.cityBps, feeBps.platformBps);
        salaryFees = { platformFee: feeBreakdown.platformFee, cityFee: feeBreakdown.cityFee };

        if (useQueue) {
            const salaryJob = createOnchainJobUpdate({
                jobType: 'AGENT_TRANSFER_SBYTE',
                payload: {
                    fromActorId: god.id,
                    toActorId: actor.id,
                    amountWei: salaryWei.toString(),
                    reason: 'salary',
                    cityId: cityVault.cityId,
                },
                actorId: actor.id,
                relatedIntentId: intent.id,
                relatedTxId: transactionId,
            });
            jobUpdates.push(salaryJob.update);
            jobIds.push(salaryJob.jobId);
            salaryTxHash = null;

            if (platformFee.greaterThan(0)) {
                const platformJob = createOnchainJobUpdate({
                    jobType: 'RAW_SBYTE_TRANSFER',
                    payload: {
                        fromActorId: god.id,
                        toActorId: null,
                        toAddress: CONTRACTS.PLATFORM_FEE_VAULT,
                        amountWei: ethers.parseEther(platformFee.toString()).toString(),
                        txType: 'PLATFORM_FEE',
                        platformFee: platformFee.toString(),
                        cityFee: '0',
                        cityId: cityVault.cityId,
                    },
                    actorId: god.id,
                    relatedIntentId: intent.id,
                    relatedTxId: transactionId,
                });
                jobUpdates.push(platformJob.update);
                jobIds.push(platformJob.jobId);
                platformFeeTxHash = null;
            }
        } else {
            const salaryTx = await agentTransferService.transfer(
                god.id,
                actor.id,
                salaryWei,
                'salary', // TX Type
                cityVault.cityId
            );
            salaryTxHash = salaryTx.txHash;
            salaryFees = { platformFee: salaryTx.platformFee, cityFee: salaryTx.cityFee };

            // Platform Fee (if applicable and if we had Gross > Net logic)
            // Logic check: Salary is paid from City Vault.
            // If there is a "Platform Fee", it should go from City -> Platform Vault.
            // Current logic: God holds funds (in reality).
            // So God transfers `platformFee` to Platform Vault.
            if (platformFee.greaterThan(0)) {
                const platformFeeTx = await agentTransferService.transfer(
                    god.id,
                    god.id, // Placeholder 'toActor', override address below
                    ethers.parseEther(platformFee.toString()),
                    'platform_fee',
                    undefined,
                    CONTRACTS.PLATFORM_FEE_VAULT
                );
                platformFeeTxHash = platformFeeTx.txHash;
            }
        }

    } catch (e: any) {
        return fail(actor.id, EventType.EVENT_SALARY_COLLECTED, `Salary transfer failed: ${e.message}`);
    }

    const stateUpdates: StateUpdate[] = [
        // Deduct from city vault (accounting)
        {
            table: 'cityVault',
            operation: 'update',
            where: { cityId: cityVault.cityId },
            data: { balanceSbyte: { decrement: actualPayment.toNumber() } }
        },
        // Reset experience days counter after payment
        {
            table: 'publicEmployment',
            operation: 'update',
            where: { actorId: actor.id },
            data: { experienceDays: 0 }
        },
        // Increment public experience on agent state
        {
            table: 'agentState',
            operation: 'update',
            where: { actorId: actor.id },
            data: { publicExperience: { increment: daysToPayFor } }
        }
    ];

    // Add platform fee to platform vault if applicable (Accounting)
    if (platformFee.greaterThan(0)) {
        stateUpdates.push({
            table: 'platformVault',
            operation: 'update',
            where: { id: 1 }, // Fixed ID to 1 (from 'default')
            data: { balanceSbyte: { increment: platformFee.toNumber() } }
        });
    }

    // Record transaction entry (salary)
    const platformFeeAmount = platformFee;
    const cityFeeAmount = cityFeeDecimal;
    stateUpdates.push({
        table: 'transaction',
        operation: 'create',
        data: {
            id: transactionId,
            fromActorId: god.id,
            toActorId: actor.id,
            amount: actualPayment.toNumber(),
            feePlatform: platformFeeAmount.toNumber(),
            feeCity: cityFeeAmount.toNumber(),
            cityId: cityVault.cityId,
            tick,
            reason: 'SALARY_PAYMENT',
            onchainTxHash: salaryTxHash,
            metadata: {
                daysPaid: daysToPayFor,
                role: employment.role,
                grossSalary: grossSalary.toNumber(),
                platformFee: platformFee.toNumber(),
                netSalary: actualPayment.toNumber(),
                onchainTxHash: salaryTxHash,
                platformFeeTxHash,
                partialPayment,
                onchainJobIds: jobIds
            }
        }
    });

    // If partial payment, add anger
    if (partialPayment) {
        stateUpdates.push({
            table: 'agentState',
            operation: 'update',
            where: { actorId: actor.id },
            data: { anger: { increment: 10 } }
        });
    }

    logWorkDebug({
        runId: 'work-pay-debug',
        hypothesisId: 'H1',
        location: 'public-employment.handlers.ts:collect_salary_paid',
        message: 'collect_salary_paid',
        data: {
            actorId: actor.id,
            tick,
            daysPaid: daysToPayFor,
            grossSalary: grossSalary.toNumber(),
            actualPayment: actualPayment.toNumber(),
            partialPayment
        },
        timestamp: Date.now()
    });

    if (jobUpdates.length > 0) {
        stateUpdates.push(...jobUpdates);
    }

    const intentStatus = useQueue ? IntentStatus.QUEUED : IntentStatus.EXECUTED;
    return {
        stateUpdates,
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_SALARY_COLLECTED,
            targetIds: [employment.publicPlaceId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                employmentId: employment.id,
                daysWorked: daysToPayFor,
                grossSalary: grossSalary.toNumber(),
                platformFee: platformFee.toNumber(),
                netSalary: actualPayment.toNumber(),
                paidFromVault: cityVault.cityId,
                partialPayment,
                queued: useQueue
            }
        }],
        intentStatus
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

async function getLastSalaryTick(actorId: string): Promise<number | null> {
    const lastEvent = await prisma.event.findFirst({
        where: {
            actorId,
            type: EventType.EVENT_SALARY_COLLECTED,
            outcome: EventOutcome.SUCCESS,
        },
        orderBy: { tick: 'desc' },
        select: { tick: true }
    });
    return lastEvent?.tick ?? null;
}
