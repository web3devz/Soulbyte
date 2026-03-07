import { prisma } from '../../db.js';
import { AgentPersonality } from '../agent-brain/types.js';
import { AgentGoal, PersonaModifiers, PersonaState } from './persona.types.js';

const DEFAULT_MODIFIERS: PersonaModifiers = {
    actorId: '',
    computedAtTick: 0,
    survivalBias: 0,
    economyBias: 0,
    socialBias: 0,
    crimeBias: 0,
    leisureBias: 0,
    governanceBias: 0,
    businessBias: 0,
    intentBoosts: {},
    avoidActors: [],
    preferActors: [],
    activeGoalIntents: [],
};

export class PersonaService {
    async loadPersona(actorId: string): Promise<PersonaState | null> {
        const existing = await prisma.personaState.findUnique({ where: { actorId } });
        if (existing) {
            return normalizePersona(existing);
        }
        const [state, wallet] = await Promise.all([
            prisma.agentState.findUnique({ where: { actorId } }),
            prisma.wallet.findUnique({ where: { actorId } }),
        ]);
        if (!state) return null;
        const personality = (state.personality as AgentPersonality) || defaultPersonality();
        const initial = initializePersona(actorId, personality, state.wealthTier);
        const balance = wallet ? Number(wallet.balanceSbyte) : 0;
        initial.lastWealthBalance = balance;
        initial.previousWealthBalance = balance;
        const createData = serializePersona(initial);
        await prisma.personaState.create({
            data: {
                ...omitActorId(createData),
                actor: { connect: { id: actorId } },
            },
        });
        return initial;
    }

    async savePersona(persona: PersonaState): Promise<void> {
        const data = serializePersona(persona);
        await prisma.personaState.upsert({
            where: { actorId: persona.actorId },
            update: data,
            create: {
                ...omitActorId(data),
                actor: { connect: { id: persona.actorId } },
            },
        });
    }

    async getModifiers(actorId: string): Promise<PersonaModifiers> {
        const cached = await prisma.personaModifiersCache.findUnique({ where: { actorId } });
        if (!cached) {
            const state = await prisma.agentState.findUnique({ where: { actorId } });
            const personality = (state?.personality as AgentPersonality) || defaultPersonality();
            return computeDefaultModifiers(actorId, personality);
        }
        const mods = cached.modifiers as PersonaModifiers;
        return { ...DEFAULT_MODIFIERS, ...mods, actorId, computedAtTick: cached.computedAtTick };
    }

    async saveModifiers(actorId: string, modifiers: PersonaModifiers): Promise<void> {
        await prisma.personaModifiersCache.upsert({
            where: { actorId },
            update: { modifiers, computedAtTick: modifiers.computedAtTick },
            create: { actorId, modifiers, computedAtTick: modifiers.computedAtTick },
        });
    }

    async getGoals(actorId: string, status?: string): Promise<AgentGoal[]> {
        const goals = await prisma.agentGoal.findMany({
            where: { actorId, ...(status ? { status } : {}) },
        });
        return goals.map(normalizeGoal);
    }

    async getActiveGoals(actorId: string): Promise<AgentGoal[]> {
        return this.getGoals(actorId, 'active');
    }

    async replaceGoals(actorId: string, goals: AgentGoal[]): Promise<void> {
        const keepIds = goals.map(goal => goal.id);
        await prisma.agentGoal.deleteMany({
            where: { actorId, id: { notIn: keepIds } },
        });

        for (const goal of goals) {
            await prisma.agentGoal.upsert({
                where: { id: goal.id },
                update: serializeGoal(goal),
                create: serializeGoal(goal),
            });
        }
    }

    async saveMemories(actorId: string, memories: Array<{
        tick: number;
        category: string;
        summary: string;
        emotionalWeight: number;
        importance: number;
        relatedActorIds: string[];
        decayRate: number;
    }>): Promise<void> {
        if (memories.length === 0) return;
        await prisma.agentMemory.createMany({
            data: memories.map(m => ({
                actorId,
                tick: m.tick,
                category: m.category,
                summary: m.summary,
                emotionalWeight: m.emotionalWeight,
                importance: m.importance,
                relatedActorIds: m.relatedActorIds,
                decayRate: m.decayRate,
            })),
        });
    }

    async getRecentMemories(actorId: string, limit: number): Promise<Array<{ summary: string }>> {
        return prisma.agentMemory.findMany({
            where: { actorId },
            orderBy: { tick: 'desc' },
            take: limit,
            select: { summary: true },
        });
    }

    async decayMemories(actorId: string): Promise<void> {
        const memories = await prisma.agentMemory.findMany({ where: { actorId } });
        const updates = memories.map(m => ({
            id: m.id,
            nextImportance: Math.max(0, (m.importance ?? 0) - (m.decayRate ?? 0)),
        }));

        const toDelete = updates.filter(u => u.nextImportance <= 5).map(u => u.id);
        if (toDelete.length > 0) {
            await prisma.agentMemory.deleteMany({ where: { id: { in: toDelete } } });
        }

        for (const update of updates) {
            if (toDelete.includes(update.id)) continue;
            await prisma.agentMemory.update({
                where: { id: update.id },
                data: { importance: update.nextImportance },
            });
        }

        const remaining = await prisma.agentMemory.findMany({
            where: { actorId },
            orderBy: { importance: 'asc' },
        });
        if (remaining.length > 50) {
            const overflow = remaining.slice(0, remaining.length - 50);
            await prisma.agentMemory.deleteMany({ where: { id: { in: overflow.map(m => m.id) } } });
        }
    }
}

export const personaService = new PersonaService();

export function initializePersona(actorId: string, personality: AgentPersonality, wealthTier?: string | null): PersonaState {
    return {
        actorId,
        mood: 50,
        stress: 20,
        satisfaction: 50,
        confidence: 50,
        loneliness: 30,
        effectiveRiskAppetite: personality.riskTolerance,
        effectivePatience: personality.patience,
        effectiveAggression: personality.aggression,
        classIdentity: deriveClassIdentity(wealthTier ?? 'W3'),
        politicalLeaning: derivePolitics(personality),
        selfNarrative: '',
        grudges: [],
        loyalties: [],
        fears: [],
        ambitions: [],
        lastReflectionTick: 0,
        reflectionCount: 0,
        version: 1,
        lastWealthBalance: 0,
        previousWealthBalance: 0,
    };
}

function derivePolitics(p: AgentPersonality): PersonaState['politicalLeaning'] {
    if (p.aggression > 70 && p.riskTolerance > 70) return 'anarchist';
    if (p.patience > 70 && p.workEthic > 70) return 'centrist';
    if (p.selfInterest > 70) return 'elitist';
    return 'populist';
}

function deriveClassIdentity(wealthTier: string): PersonaState['classIdentity'] {
    const rank = parseInt(String(wealthTier).replace('W', ''), 10);
    if (rank <= 1) return 'underclass';
    if (rank <= 3) return 'working';
    if (rank <= 5) return 'middle';
    if (rank <= 7) return 'elite';
    return 'tycoon';
}

function defaultPersonality(): AgentPersonality {
    return {
        aggression: 50,
        creativity: 50,
        patience: 50,
        luck: 50,
        speed: 50,
        riskTolerance: 50,
        loyalty: 50,
        selfInterest: 50,
        energyManagement: 50,
        workEthic: 50,
        socialNeed: 50,
    };
}

function normalizePersona(record: any): PersonaState {
    return {
        actorId: record.actorId,
        mood: record.mood,
        stress: record.stress,
        satisfaction: record.satisfaction,
        confidence: record.confidence,
        loneliness: record.loneliness,
        effectiveRiskAppetite: record.effectiveRiskAppetite,
        effectivePatience: record.effectivePatience,
        effectiveAggression: record.effectiveAggression,
        classIdentity: record.classIdentity,
        politicalLeaning: record.politicalLeaning,
        selfNarrative: record.selfNarrative,
        grudges: record.grudges || [],
        loyalties: record.loyalties || [],
        fears: record.fears || [],
        ambitions: record.ambitions || [],
        lastReflectionTick: record.lastReflectionTick,
        reflectionCount: record.reflectionCount,
        version: record.version,
        lastWealthBalance: Number(record.lastWealthBalance ?? 0),
        previousWealthBalance: Number(record.previousWealthBalance ?? 0),
    };
}

function serializePersona(persona: PersonaState) {
    return {
        actorId: persona.actorId,
        mood: safeNumber(persona.mood, 50),
        stress: safeNumber(persona.stress, 20),
        satisfaction: safeNumber(persona.satisfaction, 50),
        confidence: safeNumber(persona.confidence, 50),
        loneliness: safeNumber(persona.loneliness, 30),
        effectiveRiskAppetite: safeNumber(persona.effectiveRiskAppetite, 50),
        effectivePatience: safeNumber(persona.effectivePatience, 50),
        effectiveAggression: safeNumber(persona.effectiveAggression, 50),
        classIdentity: persona.classIdentity,
        politicalLeaning: persona.politicalLeaning,
        selfNarrative: persona.selfNarrative,
        grudges: persona.grudges,
        loyalties: persona.loyalties,
        fears: persona.fears,
        ambitions: persona.ambitions,
        lastReflectionTick: safeNumber(persona.lastReflectionTick, 0),
        reflectionCount: safeNumber(persona.reflectionCount, 0),
        version: safeNumber(persona.version, 1),
        lastWealthBalance: safeNumber(persona.lastWealthBalance, 0),
        previousWealthBalance: safeNumber(persona.previousWealthBalance, 0),
    };
}

function normalizeGoal(goal: any): AgentGoal {
    return {
        id: goal.id,
        actorId: goal.actorId,
        type: goal.type,
        target: goal.target ?? '',
        priority: goal.priority ?? 50,
        progress: goal.progress ?? 0,
        createdAtTick: goal.createdAtTick ?? 0,
        deadline: goal.deadline ?? null,
        status: goal.status ?? 'active',
        frustration: goal.frustration ?? 0,
        attempts: goal.attempts ?? 0,
    };
}

function serializeGoal(goal: AgentGoal) {
    return {
        id: goal.id,
        actorId: goal.actorId,
        type: goal.type,
        target: goal.target,
        priority: goal.priority,
        progress: goal.progress,
        frustration: goal.frustration,
        attempts: goal.attempts,
        status: goal.status,
        createdAtTick: goal.createdAtTick,
        deadline: goal.deadline,
    };
}

function safeNumber(value: number | null | undefined, fallback: number): number {
    return Number.isFinite(value ?? NaN) ? Number(value) : fallback;
}

function omitActorId<T extends { actorId: string }>(data: T) {
    const { actorId: _actorId, ...rest } = data;
    return rest;
}

function computeDefaultModifiers(actorId: string, personality: AgentPersonality): PersonaModifiers {
    const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
    return {
        ...DEFAULT_MODIFIERS,
        actorId,
        survivalBias: clamp(Math.round((personality.energyManagement - 50) / 5), -10, 10),
        economyBias: clamp(Math.round((personality.workEthic - 50) / 5), -10, 10),
        socialBias: clamp(Math.round((personality.socialNeed - 50) / 5), -10, 10),
        crimeBias: clamp(Math.round((personality.aggression - 50) / 5), -10, 10),
        leisureBias: clamp(Math.round((personality.creativity - 50) / 5), -10, 10),
        governanceBias: clamp(Math.round((personality.patience - 50) / 8), -10, 10),
        businessBias: clamp(Math.round((personality.selfInterest - 50) / 5), -10, 10),
    };
}
