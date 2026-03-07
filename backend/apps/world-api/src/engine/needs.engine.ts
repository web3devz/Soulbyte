import { prisma } from '../db.js';

const BASE_DECAY_PER_HOUR = {
    hunger: 3.5,
    energy: 2.2,
    social: 2,
    fun: 2,
    purpose: 1,
    health: 1
};

const HOUSING_MODIFIER: Record<string, number> = {
    street: 2,
    shelter: 1,
    slum_room: 1,
    apartment: 0,
    condo: -1,
    house: -1,
    villa: -2,
    estate: -2,
    palace: -3,
    citadel: -4
};

const HOUSING_RECOVERY: Record<string, Partial<typeof BASE_DECAY_PER_HOUR>> = {
    condo: { energy: 1, fun: 0.5 },
    house: { energy: 1.5, fun: 0.5, social: 0.5 },
    villa: { energy: 2, fun: 1, social: 1, health: 0.5 },
    estate: { energy: 2, fun: 1.5, social: 1, health: 0.5 },
    palace: { energy: 2.5, fun: 2, social: 1.5, health: 1 },
    citadel: { energy: 3, fun: 2, social: 2, health: 1 }
};

function clamp(value: number): number {
    return Math.max(0, Math.min(100, value));
}

export async function applyNeedsDecay(currentTick: number): Promise<number> {
    const agents = await prisma.actor.findMany({
        where: { kind: 'agent', frozen: false },
        include: { agentState: true }
    });

    let updated = 0;
    for (const agent of agents) {
        const state = agent.agentState;
        if (!state) continue;

        if (state.activityState === 'RESTING') {
            // Resting recovery is handled elsewhere; skip decay entirely.
            continue;
        }

        const housingMod = HOUSING_MODIFIER[state.housingTier] ?? 0;
        let hungerDecay = BASE_DECAY_PER_HOUR.hunger + housingMod;
        let energyDecay = BASE_DECAY_PER_HOUR.energy + housingMod;
        let socialDecay = BASE_DECAY_PER_HOUR.social;
        let funDecay = BASE_DECAY_PER_HOUR.fun;
        let purposeDecay = BASE_DECAY_PER_HOUR.purpose;

        if (state.activityState === 'WORKING') {
            hungerDecay *= 1.2;
            energyDecay *= 1.2;
        }

        let healthDecay = BASE_DECAY_PER_HOUR.health;
        if (state.hunger <= 10 || state.energy <= 10) healthDecay += 3;

        const next = {
            hunger: clamp(state.hunger - hungerDecay),
            energy: clamp(state.energy - energyDecay),
            social: clamp(state.social - socialDecay),
            fun: clamp(state.fun - funDecay),
            purpose: clamp(state.purpose - purposeDecay),
            health: clamp(state.health - healthDecay)
        };

        const housingRecovery = HOUSING_RECOVERY[state.housingTier] ?? {};
        if (housingRecovery.energy) next.energy = clamp(next.energy + housingRecovery.energy);
        if (housingRecovery.fun) next.fun = clamp(next.fun + housingRecovery.fun);
        if (housingRecovery.social) next.social = clamp(next.social + housingRecovery.social);
        if (housingRecovery.health) next.health = clamp(next.health + housingRecovery.health);

        if (state.activityState === 'IDLE') {
            const lowSocial = (state.social ?? 0) <= 50;
            const lowFun = (state.fun ?? 0) <= 50;
            const lowPurpose = (state.purpose ?? 0) <= 50;
            const idleSocial = lowSocial ? 5 : 1;
            const idleFun = lowFun ? 5 : 1;
            const idlePurpose = lowPurpose ? 4 : 0.5;
            next.social = clamp(next.social + idleSocial);
            next.fun = clamp(next.fun + idleFun);
            next.purpose = clamp(next.purpose + idlePurpose);
        }

        // Passive recovery when reasonably stable
        if (next.hunger >= 50 && next.energy >= 50) {
            next.health = clamp(next.health + 2);
        }
        if (state.activityState !== 'WORKING' && next.hunger >= 30) {
            next.health = clamp(next.health + 1);
        }

        await prisma.agentState.update({
            where: { actorId: agent.id },
            data: next
        });
        updated += 1;
    }

    return updated;
}
