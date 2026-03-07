import crypto from 'crypto';
import { AccumulatedContext, AgentGoal, GoalType, PersonaState } from './persona.types.js';

const MAX_ACTIVE_GOALS = 3;

export function generateGoals(persona: PersonaState, ctx: AccumulatedContext, tick: number): AgentGoal[] {
    const goals: AgentGoal[] = [];
    const p = ctx.personality;
    const ambitionTags = (persona.ambitions ?? []).map(a => a.toLowerCase());

    if (wealthTierRank(ctx.currentWealthTier) <= wealthTierRank('W1')) {
        goals.push(makeGoal(persona.actorId, GoalType.ESCAPE_POVERTY, 'W3', 90, tick));
    }

    const ambition = (p.aggression + p.riskTolerance) / 2;
    if (ambition > 60 && wealthTierRank(ctx.currentWealthTier) <= wealthTierRank('W5')) {
        goals.push(makeGoal(
            persona.actorId,
            GoalType.REACH_WEALTH_TIER,
            ambition > 80 ? 'W7' : 'W5',
            Math.floor(ambition * 0.6),
            tick
        ));
    }

    if (ctx.wealthTrend === 'rising' && ctx.currentHousing === 'street') {
        goals.push(makeGoal(persona.actorId, GoalType.ACQUIRE_HOUSING, 'shelter', 70, tick));
    }

    if (p.creativity > 65 && wealthTierRank(ctx.currentWealthTier) >= wealthTierRank('W3') && ctx.currentBusinesses === 0) {
        goals.push(makeGoal(
            persona.actorId,
            GoalType.FOUND_BUSINESS,
            'any',
            Math.floor(p.creativity * 0.5),
            tick
        ));
    }

    if (persona.grudges.length > 0) {
        const strongest = [...persona.grudges].sort((a, b) => b.intensity - a.intensity)[0];
        if (strongest.intensity > 60 && p.aggression > 50) {
            goals.push(makeGoal(
                persona.actorId,
                GoalType.REVENGE,
                strongest.targetActorId,
                Math.floor(strongest.intensity * 0.5),
                tick
            ));
        }
    }

    if (p.socialNeed > 60 && ctx.currentRelationships > 0 && persona.loneliness > 50) {
        goals.push(makeGoal(
            persona.actorId,
            GoalType.GET_MARRIED,
            'any',
            Math.floor(persona.loneliness * 0.4),
            tick
        ));
    }

    if (ambitionTags.includes('grow wealth')) {
        const ambitionScore = Math.floor((p.selfInterest + p.riskTolerance) * 0.25); // 0..50
        goals.push(makeGoal(
            persona.actorId,
            GoalType.ACCUMULATE_WEALTH,
            'any',
            35 + ambitionScore,
            tick
        ));
    }

    return goals;
}

export function updateGoals(goals: AgentGoal[], ctx: AccumulatedContext, tick: number): { goals: AgentGoal[]; progress: { goalId: string; progressDelta: number }[] } {
    const updated: AgentGoal[] = [];
    const progressEntries: { goalId: string; progressDelta: number }[] = [];

    for (const goal of goals) {
        if (goal.status !== 'active') {
            updated.push(goal);
            continue;
        }

        const progress = computeProgress(goal, ctx);
        const progressDelta = progress - goal.progress;
        progressEntries.push({ goalId: goal.id, progressDelta });

        let next: AgentGoal = { ...goal, progress };
        if (progressDelta <= 0) {
            next.frustration = Math.min(100, next.frustration + 10);
            next.attempts = next.attempts + 1;
        }

        if (next.progress >= 100) {
            next.status = 'achieved';
            updated.push(next);
            continue;
        }

        if (next.deadline && tick > next.deadline) {
            next.status = 'failed';
            updated.push(next);
            continue;
        }

        if (next.frustration > 80 && ctx.personality.patience < 40) {
            next.status = 'abandoned';
            updated.push(next);
            continue;
        }

        if (next.frustration > 60 && ctx.personality.patience > 60) {
            next.priority = Math.min(95, next.priority + 10);
        } else {
            next.priority = Math.max(5, next.priority - 1);
        }

        updated.push(next);
    }

    return { goals: updated, progress: progressEntries };
}

export function enforceGoalLimit(goals: AgentGoal[]): AgentGoal[] {
    const active = goals.filter(g => g.status === 'active').sort((a, b) => b.priority - a.priority);
    if (active.length <= MAX_ACTIVE_GOALS) return goals;
    const keepIds = new Set(active.slice(0, MAX_ACTIVE_GOALS).map(g => g.id));
    return goals.map(g => {
        if (g.status === 'active' && !keepIds.has(g.id)) {
            return { ...g, status: 'abandoned' };
        }
        return g;
    });
}

function computeProgress(goal: AgentGoal, ctx: AccumulatedContext): number {
    switch (goal.type) {
        case GoalType.REACH_WEALTH_TIER: {
            const targetMin = wealthTierMin(goal.target);
            return targetMin > 0 ? Math.min(100, Math.floor((ctx.currentWealth / targetMin) * 100)) : 0;
        }
        case GoalType.ACQUIRE_HOUSING:
            return ctx.currentHousing === goal.target ? 100 : ctx.currentHousing !== 'street' ? 50 : 0;
        case GoalType.GET_JOB:
            return ctx.currentJob && ctx.currentJob !== 'unemployed' ? 100 : 0;
        case GoalType.FOUND_BUSINESS:
            return ctx.currentBusinesses > 0 ? 100 : ctx.currentWealth > 1000 ? 30 : 0;
        case GoalType.GET_MARRIED:
            if (hasEventType(ctx, 'EVENT_MARRIAGE_RESOLVED')) return 100;
            if (hasEventType(ctx, 'EVENT_DATING_RESOLVED')) return 60;
            return ctx.currentRelationships > 0 ? 30 : 0;
        case GoalType.BECOME_MAYOR:
            return ctx.currentJob === 'mayor' ? 100 : 0;
        case GoalType.REVENGE:
            return ctx.crimeEvents.some(e => e.involvedActors.includes(goal.target)) ? 50 : 0;
        case GoalType.ACCUMULATE_WEALTH:
            return Math.min(100, Math.floor(ctx.currentWealth / 1000));
        case GoalType.UPGRADE_BUSINESS:
            return ctx.currentBusinesses > 0 ? 60 : 0;
        case GoalType.ESCAPE_POVERTY:
            return Math.min(100, Math.floor((ctx.currentWealth / 101) * 100));
        case GoalType.LEAVE_CITY:
            return hasEventType(ctx, 'EVENT_CITY_MOVED') ? 100 : 0;
        default:
            return goal.progress;
    }
}

function wealthTierMin(tier: string): number {
    const map: Record<string, number> = {
        W0: 0,
        W1: 1,
        W2: 11,
        W3: 101,
        W4: 1001,
        W5: 10001,
        W6: 100001,
        W7: 500001,
        W8: 1000001,
        W9: 5000001,
    };
    return map[tier] ?? 0;
}

function wealthTierRank(tier: string): number {
    const numeric = parseInt(String(tier).replace('W', ''), 10);
    return Number.isNaN(numeric) ? 0 : numeric;
}

function hasEventType(ctx: AccumulatedContext, eventType: string): boolean {
    const events = [
        ...ctx.economicEvents,
        ...ctx.socialEvents,
        ...ctx.crimeEvents,
        ...ctx.achievementEvents,
        ...ctx.lossEvents,
        ...ctx.survivalEvents,
    ];
    return events.some(event => event.eventType === eventType);
}

function makeGoal(actorId: string, type: GoalType, target: string, priority: number, tick: number): AgentGoal {
    return {
        id: crypto.randomUUID(),
        actorId,
        type,
        target,
        priority,
        progress: 0,
        createdAtTick: tick,
        deadline: null,
        status: 'active',
        frustration: 0,
        attempts: 0,
    };
}
