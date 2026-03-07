import { prisma } from '../db.js';
import { buildAccumulatedContext } from './persona/memory-accumulator.js';
import { enforceGoalLimit, generateGoals, updateGoals } from './persona/goal.engine.js';
import { personaService } from './persona/persona.service.js';

export async function assignGoalsAtBirth(currentTick: number): Promise<number> {
    const agents = await prisma.actor.findMany({
        where: { kind: 'agent' },
        include: { agentState: true, wallet: true, relationshipsA: true, relationshipsB: true, businessesOwned: true }
    });
    let created = 0;
    for (const agent of agents) {
        if (!agent.agentState || !agent.wallet) continue;
        const persona = await personaService.loadPersona(agent.id);
        if (!persona) continue;
        const existing = await personaService.getActiveGoals(agent.id);
        if (existing.length > 0) continue;

        const context = buildAccumulatedContext({
            agentId: agent.id,
            events: [],
            tick: currentTick,
            lastReflectionTick: persona.lastReflectionTick,
            currentWealth: Number(agent.wallet.balanceSbyte),
            previousWealth: persona.lastWealthBalance,
            olderWealth: persona.previousWealthBalance,
            currentWealthTier: agent.agentState.wealthTier,
            currentHousing: agent.agentState.housingTier,
            currentJob: agent.agentState.jobType,
            currentRelationships: agent.relationshipsA.length + agent.relationshipsB.length,
            currentBusinesses: agent.businessesOwned.length,
            personality: (agent.agentState.personality as any) || {},
            recentGoalProgress: [],
        });

        const goals = enforceGoalLimit(generateGoals(persona, context, currentTick));
        if (goals.length > 0) {
            await personaService.replaceGoals(agent.id, goals);
            created += 1;
        }
    }
    return created;
}

export async function updateGoalProgress(currentTick: number): Promise<number> {
    const agents = await prisma.actor.findMany({
        where: { kind: 'agent' },
        include: { agentState: true, wallet: true, relationshipsA: true, relationshipsB: true, businessesOwned: true }
    });
    let updated = 0;
    for (const agent of agents) {
        if (!agent.agentState || !agent.wallet) continue;
        const persona = await personaService.loadPersona(agent.id);
        if (!persona) continue;
        const existingGoals = await personaService.getActiveGoals(agent.id);
        if (existingGoals.length === 0) continue;

        const context = buildAccumulatedContext({
            agentId: agent.id,
            events: [],
            tick: currentTick,
            lastReflectionTick: persona.lastReflectionTick,
            currentWealth: Number(agent.wallet.balanceSbyte),
            previousWealth: persona.lastWealthBalance,
            olderWealth: persona.previousWealthBalance,
            currentWealthTier: agent.agentState.wealthTier,
            currentHousing: agent.agentState.housingTier,
            currentJob: agent.agentState.jobType,
            currentRelationships: agent.relationshipsA.length + agent.relationshipsB.length,
            currentBusinesses: agent.businessesOwned.length,
            personality: (agent.agentState.personality as any) || {},
            recentGoalProgress: [],
        });

        const { goals } = updateGoals(existingGoals, context, currentTick);
        await personaService.replaceGoals(agent.id, goals);
        updated += 1;
    }
    return updated;
}
