import { prisma } from '../../db.js';
import { EventSummary, PersonaModifiers, PersonaState, TriggerType } from './persona.types.js';
import { MemoryAccumulator, buildAccumulatedContext, categorizeEvent } from './memory-accumulator.js';
import { RuleBasedReflection, LLMReflection, chooseReflectionMode } from './reflection.engine.js';
import { enforceGoalLimit, generateGoals, updateGoals } from './goal.engine.js';
import { ModifierCalculator } from './modifier-calculator.js';
import { personaService } from './persona.service.js';

export class PersonaEngine {
    constructor(private accumulator: MemoryAccumulator) {}

    async reflect(agentId: string, trigger: TriggerType, tick: number): Promise<void> {
        const persona = await personaService.loadPersona(agentId);
        if (!persona) return;

        const events = this.accumulator.drain(agentId);
        const snapshot = await this.loadSnapshot(agentId);
        if (!snapshot) return;

        const baseContext = buildAccumulatedContext({
            agentId,
            events,
            tick,
            lastReflectionTick: persona.lastReflectionTick,
            currentWealth: snapshot.balanceSbyte,
            previousWealth: persona.lastWealthBalance,
            olderWealth: persona.previousWealthBalance,
            currentWealthTier: snapshot.wealthTier,
            currentHousing: snapshot.housingTier,
            currentJob: snapshot.jobType,
            currentRelationships: snapshot.relationshipCount,
            currentBusinesses: snapshot.businessCount,
            personality: snapshot.personality,
            recentGoalProgress: [],
        });

        const existingGoals = await personaService.getGoals(agentId);
        const activeGoals = existingGoals.filter(goal => goal.status === 'active');
        const { goals: progressedGoals, progress } = updateGoals(activeGoals, baseContext, tick);
        const context = { ...baseContext, recentGoalProgress: progress };

        const newGoals = generateGoals(persona, context, tick);
        const mergedGoals = enforceGoalLimit(mergeGoals([...existingGoals.filter(g => g.status !== 'active'), ...progressedGoals], newGoals));

        const reflectionMode = chooseReflectionMode(trigger);
        const reflection = reflectionMode === 'llm'
            ? await new LLMReflection().reflect(context, persona)
            : new RuleBasedReflection().reflect(context, persona);

        const updatedPersona = applyPersonaUpdate(persona, reflection, tick, snapshot.balanceSbyte);

        const modifiers = ModifierCalculator.compute(updatedPersona, mergedGoals, tick);
        const mergedModifiers: PersonaModifiers = reflection.intentBoosts
            ? { ...modifiers, intentBoosts: reflection.intentBoosts }
            : modifiers;

        const memories = formMemories(events, context.personality);

        await personaService.savePersona(updatedPersona);
        await personaService.replaceGoals(agentId, mergedGoals);
        await personaService.saveModifiers(agentId, mergedModifiers);
        await personaService.saveMemories(agentId, memories);
        await personaService.decayMemories(agentId);
    }

    private async loadSnapshot(agentId: string): Promise<{
        balanceSbyte: number;
        wealthTier: string;
        housingTier: string;
        jobType: string | null;
        relationshipCount: number;
        businessCount: number;
        personality: any;
    } | null> {
        const actor = await prisma.actor.findUnique({
            where: { id: agentId },
            include: {
                agentState: true,
                wallet: true,
                relationshipsA: true,
                relationshipsB: true,
                businessesOwned: true,
            },
        });
        if (!actor || !actor.agentState) return null;
        const relationshipCount = actor.relationshipsA.length + actor.relationshipsB.length;
        return {
            balanceSbyte: actor.wallet ? Number(actor.wallet.balanceSbyte) : 0,
            wealthTier: actor.agentState.wealthTier,
            housingTier: actor.agentState.housingTier,
            jobType: actor.agentState.jobType,
            relationshipCount,
            businessCount: actor.businessesOwned.length,
            personality: normalizePersonality(actor.agentState.personality),
        };
    }
}

function applyPersonaUpdate(
    persona: PersonaState,
    update: Partial<PersonaState> & { newGrudge?: any; newLoyalty?: any; intentBoosts?: Record<string, number> },
    tick: number,
    currentBalance: number
): PersonaState {
    const { newGrudge, newLoyalty, intentBoosts: _intentBoosts, ...rest } = update;
    const next: PersonaState = {
        ...persona,
        ...rest,
        lastReflectionTick: tick,
        reflectionCount: persona.reflectionCount + 1,
        grudges: decaySocialList(persona.grudges).slice(),
        loyalties: decaySocialList(persona.loyalties).slice(),
        fears: update.fears ?? persona.fears,
        ambitions: update.ambitions ?? persona.ambitions,
    };

    if (newGrudge) {
        next.grudges = trimList([...next.grudges, newGrudge], 5);
    }
    if (newLoyalty) {
        next.loyalties = trimList([...next.loyalties, newLoyalty], 5);
    }

    next.fears = trimList(next.fears, 3);
    next.ambitions = trimList(next.ambitions, 3);
    next.previousWealthBalance = persona.lastWealthBalance ?? currentBalance;
    next.lastWealthBalance = currentBalance;

    return next;
}

function trimList<T>(list: T[], max: number): T[] {
    return list.slice(0, max);
}

function decaySocialList<T extends { intensity: number }>(entries: T[]): T[] {
    return entries.map(entry => ({ ...entry, intensity: Math.max(0, entry.intensity - 2) }));
}

function mergeGoals(existing: any[], incoming: any[]): any[] {
    const byKey = new Map<string, any>();
    for (const goal of existing) {
        byKey.set(`${goal.type}:${goal.target}`, goal);
    }
    for (const goal of incoming) {
        const key = `${goal.type}:${goal.target}`;
        if (byKey.has(key)) continue;
        byKey.set(key, goal);
    }
    return Array.from(byKey.values());
}

function formMemories(events: EventSummary[], personality: any): Array<{
    tick: number;
    category: string;
    summary: string;
    emotionalWeight: number;
    importance: number;
    relatedActorIds: string[];
    decayRate: number;
}> {
    return events.map(ev => ({
        tick: ev.tick,
        category: categorizeEvent(ev.eventType, ev.source.type),
        summary: summarizeEvent(ev),
        emotionalWeight: computeEmotionalWeight(ev, personality),
        importance: computeImportance(ev),
        relatedActorIds: ev.involvedActors,
        decayRate: computeDecayRate(ev),
    }));
}

function summarizeEvent(event: EventSummary): string {
    return `${event.eventType} at tick ${event.tick}`;
}

function computeEmotionalWeight(event: EventSummary, personality: any): number {
    const base = EVENT_EMOTION_MAP[event.eventType] ?? 0;
    if (event.eventType.includes('CRIME') && event.outcome === 'success') {
        return base + (personality.aggression > 60 ? 20 : -10);
    }
    if (event.eventType.includes('SALARY')) {
        return base + (personality.workEthic > 60 ? 15 : 5);
    }
    return base;
}

function computeImportance(event: EventSummary): number {
    const base = Math.min(100, Math.max(10, Math.abs(event.sbyteImpact) / 10));
    return event.eventType.includes('MARRIAGE') ? Math.max(base, 80) : base;
}

function computeDecayRate(event: EventSummary): number {
    if ((EVENT_EMOTION_MAP[event.eventType] ?? 0) < -60) return 0.2;
    return 2;
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

function normalizePersonality(raw: any) {
    return {
        aggression: Number(raw?.aggression ?? 50),
        creativity: Number(raw?.creativity ?? 50),
        patience: Number(raw?.patience ?? 50),
        luck: Number(raw?.luck ?? 50),
        speed: Number(raw?.speed ?? 50),
        riskTolerance: Number(raw?.riskTolerance ?? 50),
        loyalty: Number(raw?.loyalty ?? 50),
        selfInterest: Number(raw?.selfInterest ?? 50),
        energyManagement: Number(raw?.energyManagement ?? 50),
        workEthic: Number(raw?.workEthic ?? 50),
        socialNeed: Number(raw?.socialNeed ?? 50),
    };
}
