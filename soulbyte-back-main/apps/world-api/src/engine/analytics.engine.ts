import { prisma } from '../db.js';

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export async function aggregateCityMetrics(tick: number): Promise<number> {
    const cities = await prisma.city.findMany({ include: { vault: true } });
    let created = 0;
    for (const city of cities) {
        const agents = await prisma.actor.findMany({
            where: { kind: 'agent' },
            include: { agentState: true, wallet: true }
        });
        const cityAgents = agents.filter(a => a.agentState?.cityId === city.id);
        const balances = cityAgents.map(a => Number(a.wallet?.balanceSbyte ?? 0));
        const metrics = {
            total_wealth: balances.reduce((s, v) => s + v, 0),
            median_wealth: median(balances),
            unemployment_rate: 0,
            active_businesses: await prisma.business.count({ where: { cityId: city.id, status: 'ACTIVE' } }),
            vault_balance: Number(city.vault?.balanceSbyte ?? 0)
        };
        await prisma.cityAnalyticsSnapshot.upsert({
            where: { cityId_tick: { cityId: city.id, tick } },
            create: { cityId: city.id, tick, metrics },
            update: { metrics }
        });
        created += 1;
    }
    return created;
}

export async function regenerateLeaderboards(tick: number): Promise<number> {
    const agents = await prisma.actor.findMany({
        where: { kind: 'agent' },
        include: { wallet: true, agentState: true }
    });
    const sorted = [...agents].sort(
        (a, b) => Number(b.wallet?.balanceSbyte ?? 0) - Number(a.wallet?.balanceSbyte ?? 0)
    );
    const rankings = sorted.slice(0, 50).map((a, i) => ({
        rank: i + 1,
        actor_id: a.id,
        name: a.name,
        wealth_tier: a.agentState?.wealthTier ?? 'W0',
        balance_sbyte: Number(a.wallet?.balanceSbyte ?? 0)
    }));
    await prisma.leaderboard.create({
        data: {
            cityId: null,
            leaderboardType: 'wealth',
            tick,
            rankings
        }
    });
    return 1;
}
