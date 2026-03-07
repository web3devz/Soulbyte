/**
 * World State Routes
 * GET /api/v1/world/state - World snapshot for agents
 */
import { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { getLatestSnapshot } from '../services/economy-snapshot.service.js';

export async function worldRoutes(app: FastifyInstance) {
    /**
     * GET /api/v1/world/state
     * Returns world snapshot for agents with flattened fields for easy access
     */
    app.get('/api/v1/world/state', async (_request, reply) => {
        try {
            // Get current world state
            const worldState = await prisma.worldState.findFirst({
                where: { id: 1 },
            });

            // Get all agents with their state
            const agents = await prisma.actor.findMany({
                where: { kind: 'agent' },
                include: {
                    agentState: true,
                    wallet: true,
                    jail: true,
                    inventoryItems: {
                        include: { itemDef: true }
                    },
                    marketListings: {
                        where: { status: 'active' },
                        include: { itemDef: true }
                    },
                    consentsAsPartyA: {
                        where: { status: 'active' }
                    },
                    consentsAsPartyB: {
                        where: { status: 'active' }
                    }
                },
            });

            // Get cities summary
            const cities = await prisma.city.findMany({
                include: {
                    policies: true,
                    vault: true,
                },
            });

            const businesses = await prisma.business.findMany({
                where: { isOpen: true, status: 'ACTIVE' },
            });

            return reply.send({
                tick: worldState?.tick ?? 0,
                registryVersion: worldState?.registryVersion ?? '1.0.0',
                agents: agents.map((agent) => ({
                    // Core fields
                    id: agent.id,
                    name: agent.name,
                    frozen: agent.frozen,
                    frozenReason: agent.frozenReason,
                    isJailed: !!agent.jail,
                    jailReleaseTick: agent.jail?.releaseTick ?? null,
                    reputation: agent.reputation?.toString() ?? '0',
                    luck: agent.luck ?? 50,
                    economy: agent.agentState?.cityId ? getLatestSnapshot(agent.agentState.cityId) : null,

                    // Flattened for easy access by agent
                    cityId: agent.agentState?.cityId ?? null,
                    energy: agent.agentState?.energy ?? 0,
                    balance: agent.wallet?.balanceSbyte?.toString() ?? '0',

                    // Full state details
                    state: agent.agentState ? {
                        housingTier: agent.agentState.housingTier,
                        wealthTier: agent.agentState.wealthTier,
                        jobType: agent.agentState.jobType,
                        health: agent.agentState.health,
                        energy: agent.agentState.energy,
                        hunger: agent.agentState.hunger,
                        social: agent.agentState.social,
                        fun: agent.agentState.fun,
                        purpose: agent.agentState.purpose,
                        reputationScore: agent.agentState.reputationScore,
                    } : null,

                    wallet: agent.wallet ? {
                        balanceSbyte: agent.wallet.balanceSbyte.toString(),
                        lockedSbyte: agent.wallet.lockedSbyte.toString(),
                    } : null,

                    inventory: agent.inventoryItems.map(item => ({
                        itemId: item.itemDefId,
                        name: item.itemDef.name,
                        category: item.itemDef.category,
                        quantity: item.quantity,
                        quality: item.quality
                    })),

                    listings: agent.marketListings.map(listing => ({
                        id: listing.id,
                        item: listing.itemDef.name,
                        quantity: listing.quantity,
                        price: listing.priceEach.toString(),
                        cityId: listing.cityId
                    })),

                    consents: [
                        ...agent.consentsAsPartyA.map(c => ({ id: c.id, type: c.type, with: c.partyBId, status: c.status })),
                        ...agent.consentsAsPartyB.map(c => ({ id: c.id, type: c.type, with: c.partyAId, status: c.status }))
                    ]
                })),
                cities: cities.map((city) => ({
                    id: city.id,
                    name: city.name,
                    population: city.population,
                    populationCap: city.populationCap,
                    housingCapacity: city.housingCapacity,
                    jobCapacity: city.jobCapacity,
                    securityLevel: city.securityLevel,
                    healthServices: city.healthServices,
                    entertainment: city.entertainment,
                    transport: city.transport,
                    mayorId: city.mayorId,
                    reputationScore: city.reputationScore,
                    policy: city.policies ? {
                        rentTaxRate: city.policies.rentTaxRate.toString(),
                        tradeTaxRate: city.policies.tradeTaxRate.toString(),
                        professionTaxRate: city.policies.professionTaxRate.toString(),
                        cityFeeRate: city.policies.cityFeeRate.toString(),
                    } : null,
                    vaultBalance: city.vault?.balanceSbyte.toString() ?? '0',
                })),
                businesses: businesses.map((biz) => ({
                    id: biz.id,
                    name: biz.name,
                    businessType: biz.businessType,
                    ownerId: biz.ownerId,
                    cityId: biz.cityId,
                    reputation: biz.reputation,
                    level: biz.level,
                    maxEmployees: biz.maxEmployees,
                    treasury: biz.treasury.toString(),
                    qualityScore: biz.qualityScore,
                    isOpen: biz.isOpen,
                    customerVisitsToday: biz.customerVisitsToday,
                    dailyRevenue: biz.dailyRevenue.toString(),
                    dailyExpenses: biz.dailyExpenses.toString(),
                    status: biz.status,
                    ownerLastWorkedTick: biz.ownerLastWorkedTick ?? null,
                })),
            });
        } catch (error) {
            console.error('Error fetching world state:', error);
            return reply.code(500).send({ error: 'Internal server error' });
        }
    });

    /**
     * GET /api/v1/world/agent-status
     * Returns agent activity counts overall and per city
     */
    app.get('/api/v1/world/agent-status', async (_request, reply) => {
        try {
            const [states, cities] = await Promise.all([
                prisma.agentState.findMany({
                    select: {
                        cityId: true,
                        activityState: true,
                        actor: { select: { kind: true, dead: true, frozen: true } }
                    }
                }),
                prisma.city.findMany({ select: { id: true, name: true } })
            ]);

            const cityNameById = new Map(cities.map((city) => [city.id, city.name]));
            const totals = { idle: 0, working: 0, resting: 0, other: 0, total: 0 };
            const perCity = new Map<string, { cityId: string; cityName: string | null; idle: number; working: number; resting: number; other: number; total: number }>();

            for (const state of states) {
                if (state.actor.kind !== 'agent' || state.actor.dead || state.actor.frozen) continue;
                const activity = (state.activityState ?? 'IDLE').toUpperCase();
                const bucket = activity === 'IDLE'
                    ? 'idle'
                    : activity === 'WORKING'
                        ? 'working'
                        : activity === 'RESTING'
                            ? 'resting'
                            : 'other';

                totals[bucket] += 1;
                totals.total += 1;

                const cityId = state.cityId ?? 'unknown';
                const cityName = cityNameById.get(cityId) ?? null;
                if (!perCity.has(cityId)) {
                    perCity.set(cityId, { cityId, cityName, idle: 0, working: 0, resting: 0, other: 0, total: 0 });
                }
                const entry = perCity.get(cityId)!;
                entry[bucket] += 1;
                entry.total += 1;
            }

            return reply.send({
                totals,
                perCity: Array.from(perCity.values())
            });
        } catch (error) {
            console.error('Error fetching world agent status:', error);
            return reply.code(500).send({ error: 'Internal server error' });
        }
    });

    /**
     * GET /api/v1/world/tick
     * Returns current tick only
     */
    app.get('/api/v1/world/tick', async (_request, reply) => {
        try {
            const worldState = await prisma.worldState.findFirst({
                where: { id: 1 },
            });
            const genesisTimestamp = process.env.WORLD_GENESIS_TIMESTAMP ?? null;
            return reply.send({
                tick: worldState?.tick ?? 0,
                startedAt: genesisTimestamp
            });
        } catch (error) {
            console.error('Error fetching tick:', error);
            return reply.code(500).send({ error: 'Internal server error' });
        }
    });
}
