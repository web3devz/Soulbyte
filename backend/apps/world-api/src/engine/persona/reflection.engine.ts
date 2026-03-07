import { llmService } from '../../services/llm.service.js';
import {
    AccumulatedContext,
    GrudgeEntry,
    LoyaltyEntry,
    PersonaState,
    PersonaUpdate,
    TriggerType,
} from './persona.types.js';

function clamp(value: number, min = 0, max = 100): number {
    return Math.max(min, Math.min(max, value));
}

export class RuleBasedReflection {
    reflect(ctx: AccumulatedContext, currentPersona: PersonaState): PersonaUpdate {
        const update: PersonaUpdate = {};
        const allEvents = [
            ...ctx.economicEvents,
            ...ctx.socialEvents,
            ...ctx.crimeEvents,
            ...ctx.achievementEvents,
            ...ctx.lossEvents,
            ...ctx.survivalEvents,
        ];

        if (allEvents.length > 0) {
            const avgEmotion = allEvents.reduce((sum, e) => sum + emotionalWeight(e), 0) / allEvents.length;
            update.mood = clamp(currentPersona.mood + avgEmotion * 0.3);
        }

        const lossCount = ctx.lossEvents.length;
        const stressDelta = (lossCount * 8) - (ctx.achievementEvents.length * 5) + (ctx.wealthTrend === 'freefall' ? 20 : 0);
        update.stress = clamp(currentPersona.stress + stressDelta);

        const satisfactionDelta = (ctx.achievementEvents.length * 6) - (lossCount * 4);
        update.satisfaction = clamp(currentPersona.satisfaction + satisfactionDelta);

        const confidenceDelta = (ctx.achievementEvents.length * 5) - (ctx.crimeEvents.length * 2);
        update.confidence = clamp(currentPersona.confidence + confidenceDelta);

        const lonelinessDelta = ctx.socialEvents.length > 0 ? -8 : 6;
        update.loneliness = clamp(currentPersona.loneliness + lonelinessDelta);

        const ambitionShift = ctx.wealthTrend === 'rising' ? 5 : ctx.wealthTrend === 'declining' ? -5 : 0;
        update.ambitions = dedupeList([
            ...currentPersona.ambitions,
            ...(ambitionShift > 0 ? ['grow wealth'] : []),
        ]).slice(0, 3);

        update.classIdentity = deriveClassIdentity(ctx.currentWealthTier);

        const fearShift = ctx.lossEvents.length > 0 ? ['loss', 'poverty'] : [];
        update.fears = dedupeList([...currentPersona.fears, ...fearShift]).slice(0, 3);

        // Risk/patience/aggression drift from experiences
        update.effectiveRiskAppetite = clamp(currentPersona.effectiveRiskAppetite + (ctx.wealthTrend === 'freefall' ? 5 : 0));
        update.effectivePatience = clamp(currentPersona.effectivePatience + (ctx.lossEvents.length > 2 ? -5 : 0));
        update.effectiveAggression = clamp(currentPersona.effectiveAggression + (ctx.crimeEvents.length > 0 ? 3 : 0));

        // Grudges
        const newGrudge = findNewGrudge(ctx, currentPersona);
        if (newGrudge) {
            update.newGrudge = newGrudge;
        }

        // Loyalty
        const newLoyalty = findNewLoyalty(ctx, currentPersona);
        if (newLoyalty) {
            update.newLoyalty = newLoyalty;
        }

        return update;
    }
}

export class LLMReflection {
    async reflect(ctx: AccumulatedContext, currentPersona: PersonaState): Promise<PersonaUpdate> {
        const prompt = buildReflectionPrompt(ctx, currentPersona);
        const response = await llmService.generatePersonaReflection(prompt);
        if (!response) {
            return new RuleBasedReflection().reflect(ctx, currentPersona);
        }
        return response;
    }
}

export function chooseReflectionMode(trigger: TriggerType): 'rule' | 'llm' {
    const LLM_TRIGGERS: TriggerType[] = [
        TriggerType.JAILED,
        TriggerType.WEALTH_TIER_CHANGE,
        TriggerType.MARRIED,
        TriggerType.DIVORCED,
        TriggerType.BUSINESS_FOUNDED,
        TriggerType.BUSINESS_BANKRUPT,
        TriggerType.BETRAYED,
        TriggerType.ELECTED_MAYOR,
    ];
    return LLM_TRIGGERS.includes(trigger) ? 'llm' : 'rule';
}

function buildReflectionPrompt(ctx: AccumulatedContext, currentPersona: PersonaState): string {
    return [
        `Agent: ${ctx.agentId}`,
        `Mood: ${currentPersona.mood} Stress: ${currentPersona.stress} Satisfaction: ${currentPersona.satisfaction}`,
        `Wealth: ${ctx.currentWealthTier} (${ctx.currentWealth}) Trend: ${ctx.wealthTrend}`,
        `Housing: ${ctx.currentHousing} Job: ${ctx.currentJob ?? 'none'}`,
        `Social: ${ctx.currentRelationships} relationships, trend ${ctx.socialTrend}`,
        `Events: ${ctx.economicEvents.length} economic, ${ctx.socialEvents.length} social, ${ctx.crimeEvents.length} crime, ${ctx.lossEvents.length} loss`,
        `Personality: aggression ${ctx.personality.aggression}, patience ${ctx.personality.patience}, risk ${ctx.personality.riskTolerance}`,
    ].join('\n');
}

function emotionalWeight(event: { eventType: string }): number {
    return EVENT_EMOTION_MAP[event.eventType] ?? 0;
}

function findNewGrudge(ctx: AccumulatedContext, persona: PersonaState): GrudgeEntry | null {
    const crimes = ctx.crimeEvents.filter(e => e.eventType === 'EVENT_CRIME_VICTIMIZED');
    const offender = crimes.find(c => c.involvedActors.length > 1);
    if (!offender) return null;
    const targetActorId = offender.involvedActors.find(id => id !== ctx.agentId);
    if (!targetActorId) return null;
    if (persona.grudges.some(g => g.targetActorId === targetActorId)) return null;
    return {
        targetActorId,
        reason: `victimized: ${offender.eventType}`,
        intensity: 70,
        formedAtTick: offender.tick,
    };
}

function findNewLoyalty(ctx: AccumulatedContext, persona: PersonaState): LoyaltyEntry | null {
    const positives = ctx.socialEvents.filter(e => (EVENT_EMOTION_MAP[e.eventType] ?? 0) > 60);
    const candidate = positives.find(p => p.involvedActors.length > 1);
    if (!candidate) return null;
    const targetActorId = candidate.involvedActors.find(id => id !== ctx.agentId);
    if (!targetActorId) return null;
    if (persona.loyalties.some(l => l.targetActorId === targetActorId)) return null;
    return {
        targetActorId,
        reason: `bonded: ${candidate.eventType}`,
        intensity: 70,
        formedAtTick: candidate.tick,
    };
}

function dedupeList(values: string[]): string[] {
    return Array.from(new Set(values.filter(Boolean)));
}

function deriveClassIdentity(wealthTier: string): PersonaState['classIdentity'] {
    const rank = parseInt(String(wealthTier).replace('W', ''), 10);
    if (rank <= 1) return 'underclass';
    if (rank <= 3) return 'working';
    if (rank <= 5) return 'middle';
    if (rank <= 7) return 'elite';
    return 'tycoon';
}

const EVENT_EMOTION_MAP: Record<string, number> = {
    EVENT_SALARY_COLLECTED: +30,
    EVENT_RENT_PAID: -5,
    EVENT_EVICTION: -70,
    EVENT_IMPRISONED: -60,
    EVENT_CRIME_SUCCESS: +20,
    EVENT_CRIME_FAILED: -40,
    EVENT_CRIME_VICTIMIZED: -50,
    EVENT_MARRIAGE_RESOLVED: +80,
    EVENT_DIVORCE: -60,
    EVENT_BUSINESS_FOUNDED: +70,
    EVENT_BUSINESS_CONVERTED: +70,
    EVENT_BUSINESS_BANKRUPT: -80,
    EVENT_LIFE_EVENT_FORTUNE: +50,
    EVENT_LIFE_EVENT_MISFORTUNE: -50,
    EVENT_DATING_RESOLVED: +40,
    EVENT_DATING_ENDED: -30,
    EVENT_ALLIANCE_RESOLVED: +35,
    EVENT_ALLIANCE_BETRAYED: -70,
    EVENT_BUSINESS_UPGRADED: +40,
};
