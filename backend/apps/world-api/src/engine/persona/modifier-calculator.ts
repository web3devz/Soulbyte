import { AgentGoal, GoalType, PersonaModifiers, PersonaState } from './persona.types.js';

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

export class ModifierCalculator {
    static compute(persona: PersonaState, goals: AgentGoal[], computedAtTick: number): PersonaModifiers {
        const ambitionBoosts = this.ambitionIntentBoosts(persona.ambitions ?? []);
        return {
            actorId: persona.actorId,
            computedAtTick,
            survivalBias: persona.stress > 70 ? 15 : 0,
            economyBias: this.economyBias(persona) + ambitionBoosts.economyBias,
            socialBias: persona.loneliness > 60 ? 15 : (persona.loneliness < 30 ? -10 : 0),
            crimeBias: this.crimeBias(persona),
            leisureBias: persona.satisfaction < 30 ? 10 : -5,
            governanceBias: persona.politicalLeaning !== 'anarchist' ? 5 : -10,
            businessBias: persona.confidence > 60 ? 10 : -5,
            intentBoosts: ambitionBoosts.intentBoosts,
            avoidActors: persona.grudges.filter(g => g.intensity > 40).map(g => g.targetActorId),
            preferActors: persona.loyalties.filter(l => l.intensity > 40).map(l => l.targetActorId),
            activeGoalIntents: this.goalToIntents(goals),
        };
    }

    private static economyBias(p: PersonaState): number {
        if (p.classIdentity === 'underclass') return 20;
        if (p.classIdentity === 'tycoon') return -10;
        if (p.stress > 60) return 15;
        return 0;
    }

    private static crimeBias(p: PersonaState): number {
        let bias = 0;
        if (p.stress > 70) bias += 10;
        if (p.mood < 30) bias += 10;
        if (p.effectiveAggression > 70) bias += 10;
        if (p.fears.includes('jail')) bias -= 15;
        if (p.confidence > 80) bias += 5;
        return clamp(bias, -30, 30);
    }

    private static goalToIntents(goals: AgentGoal[]): string[] {
        const active = goals.filter(g => g.status === 'active').sort((a, b) => b.priority - a.priority);
        if (active.length === 0) return [];
        const top = active[0];
        return GOAL_INTENT_MAP[top.type] ?? [];
    }

    private static ambitionIntentBoosts(ambitions: string[]): { economyBias: number; intentBoosts: Record<string, number> } {
        const normalized = ambitions.map(a => a.toLowerCase());
        const intentBoosts: Record<string, number> = {};
        let economyBias = 0;
        if (normalized.includes('grow wealth')) {
            economyBias += 5;
            const boosts: Record<string, number> = {
                INTENT_WORK: 4,
                INTENT_START_SHIFT: 4,
                INTENT_COLLECT_SALARY: 3,
                INTENT_APPLY_PUBLIC_JOB: 3,
                INTENT_APPLY_PRIVATE_JOB: 3,
                INTENT_LIST: 2,
                INTENT_FOUND_BUSINESS: 2,
                INTENT_CONVERT_BUSINESS: 2,
                INTENT_BUY_PROPERTY: 1,
            };
            for (const [intent, boost] of Object.entries(boosts)) {
                intentBoosts[intent] = (intentBoosts[intent] ?? 0) + boost;
            }
        }
        return { economyBias, intentBoosts };
    }
}

const GOAL_INTENT_MAP: Record<GoalType, string[]> = {
    [GoalType.REACH_WEALTH_TIER]: ['INTENT_WORK', 'INTENT_START_SHIFT', 'INTENT_COLLECT_SALARY'],
    [GoalType.ACQUIRE_HOUSING]: ['INTENT_CHANGE_HOUSING', 'INTENT_BUY_PROPERTY'],
    [GoalType.GET_JOB]: ['INTENT_APPLY_PUBLIC_JOB', 'INTENT_APPLY_PRIVATE_JOB'],
    [GoalType.FOUND_BUSINESS]: ['INTENT_FOUND_BUSINESS', 'INTENT_CONVERT_BUSINESS'],
    [GoalType.GET_MARRIED]: ['INTENT_PROPOSE_DATING', 'INTENT_PROPOSE_MARRIAGE'],
    [GoalType.BECOME_MAYOR]: ['INTENT_VOTE'],
    [GoalType.LEAVE_CITY]: ['INTENT_MOVE_CITY'],
    [GoalType.REVENGE]: ['INTENT_STEAL', 'INTENT_ASSAULT', 'INTENT_BLACKLIST'],
    [GoalType.ACCUMULATE_WEALTH]: ['INTENT_WORK', 'INTENT_TRADE', 'INTENT_LIST'],
    [GoalType.UPGRADE_BUSINESS]: ['INTENT_UPGRADE_BUSINESS', 'INTENT_IMPROVE_BUSINESS'],
    [GoalType.ESCAPE_POVERTY]: ['INTENT_APPLY_PUBLIC_JOB', 'INTENT_FORAGE', 'INTENT_WORK'],
};
