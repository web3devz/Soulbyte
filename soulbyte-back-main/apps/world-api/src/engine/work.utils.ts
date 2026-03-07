import { REAL_DAY_TICKS, REAL_TICKS_PER_MINUTE } from '../config/time.js';
import { MIN_WORK_SEGMENT_MINUTES, WORK_SEGMENTS_PER_DAY } from '../config/work.js';
import { AgentStateRecord } from './engine.types.js';

export type WorkSegmentState = Pick<AgentStateRecord,
    | 'workSegmentsCompleted'
    | 'workSegmentStartTick'
    | 'workSegmentJobKey'
    | 'lastWorkedTick'
    | 'lastWorkJobKey'
>;

export function getWorkSegmentDurationTicks(totalWorkHours: number): number {
    const totalMinutes = Math.max(1, Math.round(totalWorkHours * 60));
    const segmentMinutes = Math.max(MIN_WORK_SEGMENT_MINUTES, Math.round(totalMinutes / WORK_SEGMENTS_PER_DAY));
    return Math.max(1, Math.round(segmentMinutes * REAL_TICKS_PER_MINUTE));
}

export function normalizeWorkSegmentState(state: WorkSegmentState | null, jobKey: string, tick: number) {
    const updates: Record<string, unknown> = {};
    const workSegmentJobKey = state?.workSegmentJobKey ?? null;
    const workSegmentStartTick = state?.workSegmentStartTick ?? null;
    const workSegmentsCompleted = state?.workSegmentsCompleted ?? 0;

    const isSameJob = workSegmentJobKey === jobKey;
    const isNewDay = !workSegmentStartTick || (tick - workSegmentStartTick >= REAL_DAY_TICKS);

    if (!isSameJob || isNewDay) {
        updates.workSegmentJobKey = jobKey;
        updates.workSegmentStartTick = tick;
        updates.workSegmentsCompleted = 0;
        return {
            updates,
            workSegmentJobKey: jobKey,
            workSegmentStartTick: tick,
            workSegmentsCompleted: 0
        };
    }

    return {
        updates,
        workSegmentJobKey,
        workSegmentStartTick,
        workSegmentsCompleted
    };
}

export function canStartWorkSegment(state: WorkSegmentState | null, jobKey: string, tick: number) {
    const lastWorkedTick = state?.lastWorkedTick ?? null;
    const lastWorkJobKey = state?.lastWorkJobKey ?? null;
    if (lastWorkedTick !== null && lastWorkJobKey === jobKey && (tick - lastWorkedTick < REAL_DAY_TICKS)) {
        return { allowed: false, reason: 'Already completed a full workday in the last 24h' };
    }

    const normalized = normalizeWorkSegmentState(state, jobKey, tick);
    if (normalized.workSegmentsCompleted >= WORK_SEGMENTS_PER_DAY) {
        return { allowed: false, reason: 'Workday segments already completed', updates: normalized.updates };
    }

    return { allowed: true, updates: normalized.updates };
}

export function registerWorkSegmentCompletion(
    state: WorkSegmentState | null,
    jobKey: string,
    tick: number
) {
    const normalized = normalizeWorkSegmentState(state, jobKey, tick);
    const nextCompleted = normalized.workSegmentsCompleted + 1;
    const updates: Record<string, unknown> = {
        ...normalized.updates,
        workSegmentJobKey: jobKey,
        workSegmentStartTick: normalized.workSegmentStartTick,
        workSegmentsCompleted: nextCompleted,
        lastWorkSegmentTick: tick
    };

    let completedDay = false;
    if (nextCompleted >= WORK_SEGMENTS_PER_DAY) {
        completedDay = true;
        updates.workSegmentsCompleted = 0;
        updates.lastWorkedTick = tick;
        updates.lastWorkJobKey = jobKey;
    }

    return { updates, completedDay, nextCompleted };
}

const WORK_STATUS_COSTS: Record<'low' | 'mid' | 'high', { energy: number; hunger: number; health: number; fun: number }> = {
    low: { energy: 10, hunger: 8, health: 1, fun: 2 },
    mid: { energy: 8, hunger: 6, health: 1, fun: 1 },
    high: { energy: 6, hunger: 4, health: 0, fun: 1 }
};

export function getWorkStrainTierForJobType(jobType: string): 'low' | 'mid' | 'high' {
    if (['begging', 'menial', 'labor'].includes(jobType)) return 'low';
    if (['skilled', 'creative'].includes(jobType)) return 'mid';
    return 'high';
}

export function getWorkStrainTierForPublicRole(role: string): 'low' | 'mid' | 'high' {
    if (['NURSE', 'POLICE_OFFICER'].includes(role)) return 'low';
    if (['TEACHER'].includes(role)) return 'mid';
    return 'high';
}

export function getEnergyDrainMultiplierFromItems(ownedItemNames: string[]) {
    let multiplier = 1;
    if (ownedItemNames.includes('ITEM_WORK_BOOTS')) multiplier *= 0.95;
    if (ownedItemNames.includes('ITEM_INDUSTRIAL_EXOSUIT')) multiplier *= 0.6;
    return multiplier;
}

export function getWorkStatusCost(
    tier: 'low' | 'mid' | 'high',
    ownedItemNames: string[],
    privateSectorBoost = false
) {
    const base = WORK_STATUS_COSTS[tier];
    const energyMultiplier = getEnergyDrainMultiplierFromItems(ownedItemNames);
    const privateMultiplier = privateSectorBoost ? 0.9 : 1;
    return {
        energy: Math.max(1, Math.round(base.energy * energyMultiplier * privateMultiplier)),
        hunger: Math.max(1, Math.round(base.hunger * privateMultiplier)),
        health: Math.max(0, Math.round(base.health * privateMultiplier)),
        fun: Math.max(0, Math.round(base.fun * privateMultiplier))
    };
}
