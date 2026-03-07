import { prisma } from '../db.js';
import { PUBLIC_ROLE_SALARIES } from '../types/intent.types.js';
import { CONTRACTS } from '../config/contracts.js';
import { GENESIS_SALE_PRICE_BY_TIER } from '../config/economy.js';
import { VaultHealthService } from './vault-health.service.js';
import { getDynamicFeeBps, updateCachedVaultHealth } from '../config/fees.js';
import { getSalaryMultiplier } from '../config/economic-governor.js';

export interface EconomicSnapshot {
    city_id: string;
    computed_at_tick: number;
    avg_rent_by_tier: Record<string, number>;
    housing_vacancy_rate_by_tier: Record<string, number>;
    avg_wage_public: number;
    avg_wage_private: number;
    avg_meal_price: number;
    avg_item_price: number;
    housing_vacancy_rate: number;
    unemployment_rate: number;
    business_count_by_type: Record<string, number>;
    population: number;
    agents_below_w2: number;
    total_sbyte_in_circulation: number;
    avg_agent_balance: number;
    median_agent_balance: number;
    gini_coefficient: number;
    total_earned: number;
    total_spent: number;
    total_burned: number;
    total_minted: number;
    net_money_flow: number;
    avg_business_revenue: number;
    avg_business_reputation: number;
    businesses_bankrupt_last_period: number;
    inflation_pressure: number;
    economic_health: string;
    price_trend: string;
    avg_property_condition: number;
    avg_fmv_by_tier: Record<string, number>;
    total_property_tax_collected: number;
    condemned_properties: number;
    population_change_last_period: number;
    immigration_count: number;
    emigration_count: number;
    crime_hotspot_count: number;
    crimes_last_period: number;
    recession_risk: number;
    vault_health_days?: number;
    vault_daily_burn_rate?: number;
    vault_onchain_balance?: number;
    fee_bps_platform?: number;
    fee_bps_city?: number;
    fee_bps_total?: number;
    salary_multiplier?: number;
}

export interface GodEconomicReport {
    cities: Array<{
        city_id: string;
        economic_health: string;
        population_trend: 'growing' | 'stable' | 'declining';
        treasury_runway_days: number;
        inflation_pressure: number;
        crime_rate: number;
        business_failure_rate: number;
    }>;
    total_sbyte_supply: number;
    total_sbyte_burned_last_period: number;
    total_sbyte_minted_last_period: number;
    net_supply_change: number;
    global_inflation_rate: number;
    alerts: Array<{
        severity: 'info' | 'warning' | 'critical';
        city_id: string | null;
        message: string;
        recommended_action: string;
    }>;
}

const snapshotCache = new Map<string, EconomicSnapshot>();
let globalReportCache: GodEconomicReport | null = null;
const vaultHealthService = new VaultHealthService();

const WINDOW_TICKS = 50;

function avg(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
}

function gini(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const n = sorted.length;
    const total = sorted.reduce((sum, v) => sum + v, 0);
    if (total === 0) return 0;
    let cumulative = 0;
    for (let i = 0; i < n; i++) {
        cumulative += (i + 1) * sorted[i];
    }
    return (2 * cumulative) / (n * total) - (n + 1) / n;
}

function clamp(num: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, num));
}

function deriveEconomicHealth(unemployment: number, inflation: number): string {
    if (unemployment > 0.35 || inflation < -0.2) return 'recession';
    if (unemployment > 0.5 || inflation < -0.4) return 'crisis';
    if (unemployment < 0.1 && inflation > 0.1) return 'booming';
    if (unemployment < 0.2) return 'stable';
    return 'stagnant';
}

function computeCityMultiplier(snapshot: EconomicSnapshot): number {
    let mult = 1.0;
    if (snapshot.population > 100) mult += 0.2;
    if (snapshot.population > 500) mult += 0.3;

    if (snapshot.economic_health === 'booming') mult += 0.3;
    if (snapshot.economic_health === 'recession') mult -= 0.3;
    if (snapshot.economic_health === 'crisis') mult -= 0.5;

    const bizTotal = Object.values(snapshot.business_count_by_type).reduce((a, b) => a + b, 0);
    const bizDensity = snapshot.population === 0 ? 0 : bizTotal / snapshot.population;
    if (bizDensity > 0.1) mult += 0.1;

    if (snapshot.gini_coefficient > 0.6) mult += 0.1;

    return Math.max(0.3, Math.min(2.5, mult));
}

function computeFairMarketValue(
    property: { housingTier: string; condition?: number | null; neighborhoodScore?: number | null },
    snapshot: EconomicSnapshot
): number {
    const basePrice = GENESIS_SALE_PRICE_BY_TIER[property.housingTier] ?? 0;
    const cityMultiplier = computeCityMultiplier(snapshot);
    const tierVacancy = snapshot.housing_vacancy_rate_by_tier[property.housingTier] ?? snapshot.housing_vacancy_rate;
    const demandMultiplier =
        tierVacancy < 0.05 ? 1.3 :
        tierVacancy < 0.15 ? 1.0 :
        tierVacancy < 0.30 ? 0.8 :
        0.6;
    const condition = property.condition ?? 100;
    const conditionMultiplier = condition >= 80 ? 1.0
        : condition >= 60 ? 0.9
            : condition >= 40 ? 0.75
                : condition >= 20 ? 0.5
                    : 0.25;
    const neighborhoodMultiplier = 1.0 + (property.neighborhoodScore ?? 0);
    return basePrice * cityMultiplier * demandMultiplier * conditionMultiplier * neighborhoodMultiplier;
}

export async function computeEconomicSnapshots(currentTick: number): Promise<number> {
    const cities = await prisma.city.findMany({
        include: { vault: true }
    });

    const vaultHealth = await vaultHealthService.computeVaultHealth();
    const vaultHealthDays = vaultHealth.healthDays;
    const salaryMultiplier = getSalaryMultiplier(vaultHealthDays);
    const feeBps = getDynamicFeeBps(vaultHealthDays);
    updateCachedVaultHealth(vaultHealthDays);

    const now = new Date();
    const windowMs = WINDOW_TICKS * 5000;
    const windowStart = new Date(now.getTime() - windowMs);

    for (const city of cities) {
        const properties = await prisma.property.findMany({
            where: { cityId: city.id },
            select: {
                id: true,
                cityId: true,
                housingTier: true,
                rentPrice: true,
                forRent: true,
                isEmptyLot: true,
                tenantId: true,
                fairMarketValue: true,
                condition: true,
                neighborhoodScore: true
            }
        });
        const rentable = properties.filter(p => p.forRent && !p.isEmptyLot);
        const vacancyRate = rentable.length === 0
            ? 0
            : rentable.filter(p => !p.tenantId).length / rentable.length;

        const avgRentByTier: Record<string, number> = {};
        const vacancyByTier: Record<string, number> = {};
        for (const prop of rentable) {
            const tier = prop.housingTier;
            if (!avgRentByTier[tier]) avgRentByTier[tier] = 0;
        }
        const tierBuckets: Record<string, number[]> = {};
        for (const prop of rentable) {
            if (!tierBuckets[prop.housingTier]) tierBuckets[prop.housingTier] = [];
            tierBuckets[prop.housingTier].push(Number(prop.rentPrice));
        }
        Object.entries(tierBuckets).forEach(([tier, values]) => {
            avgRentByTier[tier] = avg(values);
        });
        for (const [tier, list] of Object.entries(tierBuckets)) {
            const total = list.length;
            const vacant = rentable.filter(p => p.housingTier === tier && !p.tenantId).length;
            vacancyByTier[tier] = total === 0 ? 0 : vacant / total;
        }

        const cityBusinesses = await prisma.business.findMany({
            where: { cityId: city.id },
            include: { employments: { where: { status: 'ACTIVE' } } }
        });

        const businessCountByType: Record<string, number> = {};
        for (const biz of cityBusinesses) {
            businessCountByType[biz.businessType] = (businessCountByType[biz.businessType] || 0) + 1;
        }

        const privateWages = cityBusinesses.flatMap(b => b.employments.map(e => Number(e.salaryDaily)));
        const avgWagePrivate = avg(privateWages);

        const restaurantPrices = cityBusinesses
            .filter(b => b.businessType === 'RESTAURANT')
            .map(b => Number((b.config as any)?.pricePerService ?? 50));
        const avgMealPrice = avg(restaurantPrices);

        const marketListings = await prisma.marketListing.findMany({
            where: { cityId: city.id, status: 'active' }
        });
        const avgItemPrice = avg(marketListings.map(m => Number(m.priceEach)));

        const agents = await prisma.actor.findMany({
            where: { kind: 'agent', frozen: false },
            include: {
                agentState: true,
                privateEmployments: { where: { status: 'ACTIVE' } },
                businessesOwned: true,
                wallet: true
            }
        });
        const publicEmployments = await prisma.publicEmployment.findMany({
            where: { endedAtTick: null, publicPlace: { cityId: city.id } }
        });
        const publicEmploymentIds = new Set(publicEmployments.map(e => e.actorId));
        const cityAgents = agents.filter(a => a.agentState?.cityId === city.id);
        const population = cityAgents.length;
        const agentsBelowW2 = cityAgents.filter(a => ['W0', 'W1'].includes(a.agentState?.wealthTier ?? 'W0')).length;

        const employed = cityAgents.filter(a => {
            const hasPublic = publicEmploymentIds.has(a.id);
            const hasPrivate = (a.privateEmployments || []).length > 0;
            const hasBusiness = (a.businessesOwned || []).length > 0;
            return hasPublic || hasPrivate || hasBusiness;
        }).length;
        const unemploymentRate = population === 0 ? 0 : (population - employed) / population;

        const balances = cityAgents.map(a => Number(a.wallet?.balanceSbyte ?? 0));
        const avgBalance = avg(balances);
        const medianBalance = median(balances);
        const giniCoefficient = gini(balances);

        const walletSum = await prisma.wallet.aggregate({
            where: { actorId: { in: cityAgents.map(a => a.id) } },
            _sum: { balanceSbyte: true }
        });
        const businessTreasurySum = await prisma.business.aggregate({
            where: { cityId: city.id },
            _sum: { treasury: true }
        });

        const platformVault = await prisma.platformVault.findFirst({ where: { id: 1 } });
        const totalSupply =
            Number(walletSum._sum.balanceSbyte ?? 0) +
            Number(businessTreasurySum._sum.treasury ?? 0) +
            Number(city.vault?.balanceSbyte ?? 0) +
            Number(platformVault?.balanceSbyte ?? 0);

        const onchainWindow = await prisma.onchainTransaction.findMany({
            where: { createdAt: { gte: windowStart } }
        });
        const totalMinted = onchainWindow
            .filter(tx => tx.txType === 'LIFE_EVENT_FORTUNE' || tx.txType === 'HUMAN_DEPOSIT')
            .reduce((sum, tx) => sum + Number(tx.amount), 0);
        const totalBurned = onchainWindow
            .filter(tx => tx.toAddress === CONTRACTS.BURN_ADDRESS || tx.txType === 'LIFE_EVENT_MISFORTUNE')
            .reduce((sum, tx) => sum + Number(tx.amount), 0);
        const totalSpent = onchainWindow
            .filter(tx => ['RENT_PAYMENT', 'MARKET_PURCHASE', 'BUSINESS_BUILD'].includes(tx.txType))
            .reduce((sum, tx) => sum + Number(tx.amount), 0);
        const totalEarned = onchainWindow
            .filter(tx => ['SALARY_PAYMENT', 'BUSINESS_PAYMENT', 'MARKET_PURCHASE'].includes(tx.txType))
            .reduce((sum, tx) => sum + Number(tx.amount), 0);

        const netMoneyFlow = totalEarned - totalSpent - totalBurned + totalMinted;
        const inflationPressure = totalSupply === 0 ? 0 : clamp(netMoneyFlow / totalSupply, -1, 1);

        const avgBusinessRevenue = avg(cityBusinesses.map(b => Number(b.dailyRevenue)));
        const avgBusinessReputation = avg(cityBusinesses.map(b => Number(b.reputation)));
        const bankruptCount = await prisma.business.count({
            where: { cityId: city.id, status: 'BANKRUPT', dissolvedTick: { gte: currentTick - WINDOW_TICKS } }
        });

        const snapshot: EconomicSnapshot = {
            city_id: city.id,
            computed_at_tick: currentTick,
            avg_rent_by_tier: avgRentByTier,
            housing_vacancy_rate_by_tier: vacancyByTier,
            avg_wage_public: avg(Object.values(PUBLIC_ROLE_SALARIES)),
            avg_wage_private: avgWagePrivate,
            avg_meal_price: avgMealPrice,
            avg_item_price: avgItemPrice,
            housing_vacancy_rate: vacancyRate,
            unemployment_rate: unemploymentRate,
            business_count_by_type: businessCountByType,
            population,
            agents_below_w2: agentsBelowW2,
            total_sbyte_in_circulation: totalSupply,
            avg_agent_balance: avgBalance,
            median_agent_balance: medianBalance,
            gini_coefficient: giniCoefficient,
            total_earned: totalEarned,
            total_spent: totalSpent,
            total_burned: totalBurned,
            total_minted: totalMinted,
            net_money_flow: netMoneyFlow,
            avg_business_revenue: avgBusinessRevenue,
            avg_business_reputation: avgBusinessReputation,
            businesses_bankrupt_last_period: bankruptCount,
            inflation_pressure: inflationPressure,
            economic_health: deriveEconomicHealth(unemploymentRate, inflationPressure),
            price_trend: inflationPressure > 0.05 ? 'rising' : inflationPressure < -0.05 ? 'falling' : 'stable',
            avg_property_condition: 0,
            avg_fmv_by_tier: {},
            total_property_tax_collected: 0,
            condemned_properties: 0,
            population_change_last_period: 0,
            immigration_count: 0,
            emigration_count: 0,
            crime_hotspot_count: 0,
            crimes_last_period: 0,
            recession_risk: 0,
            vault_health_days: vaultHealthDays,
            vault_daily_burn_rate: vaultHealth.totalDailyBurnRate,
            vault_onchain_balance: vaultHealth.onchainBalanceFormatted,
            fee_bps_platform: feeBps.platformBps,
            fee_bps_city: feeBps.cityBps,
            fee_bps_total: feeBps.platformBps + feeBps.cityBps,
            salary_multiplier: salaryMultiplier
        };

        snapshotCache.set(city.id, snapshot);

        const infraScore = (Number(city.securityLevel)
            + Number(city.healthServices)
            + Number(city.entertainment)
            + Number(city.transport)) / 4;
        const repTarget = clamp(50 + avgBusinessReputation * 0.2 + infraScore * 10, 0, 500);
        const repDelta = clamp(repTarget - Number(city.reputationScore), -2, 2);
        const repStep = Math.round(repDelta);
        if (repStep !== 0) {
            await prisma.city.update({
                where: { id: city.id },
                data: { reputationScore: { increment: repStep } }
            });
        }

        const fmvByTier: Record<string, number[]> = {};
        let conditionSum = 0;
        let conditionCount = 0;
        let condemnedCount = 0;

        for (const prop of properties) {
            const fmv = computeFairMarketValue(prop as any, snapshot);
            await prisma.property.update({
                where: { id: prop.id },
                data: {
                    fairMarketValue: fmv,
                    lastValuationTick: currentTick
                }
            });

            const tier = prop.housingTier;
            if (!fmvByTier[tier]) fmvByTier[tier] = [];
            fmvByTier[tier].push(fmv);

            conditionSum += Number(prop.condition ?? 100);
            conditionCount += 1;
            if ((prop.condition ?? 100) <= 0) condemnedCount += 1;
        }

        const taxWindow = await prisma.transaction.findMany({
            where: {
                cityId: city.id,
                reason: 'PROPERTY_TAX',
                tick: { gte: currentTick - WINDOW_TICKS }
            },
            select: { amount: true }
        });
        const totalPropertyTax = taxWindow.reduce((sum, t) => sum + Number(t.amount), 0);

        const crimeWindow = await prisma.crime.count({
            where: { cityId: city.id, tick: { gte: currentTick - WINDOW_TICKS } }
        });

        const moveEvents = await prisma.event.findMany({
            where: {
                type: 'EVENT_CITY_MOVED',
                tick: { gte: currentTick - WINDOW_TICKS }
            },
            select: { sideEffects: true }
        });
        let immigration = 0;
        let emigration = 0;
        for (const ev of moveEvents) {
            const fromCityId = (ev.sideEffects as any)?.fromCityId;
            const toCityId = (ev.sideEffects as any)?.toCityId;
            if (toCityId === city.id) immigration += 1;
            if (fromCityId === city.id) emigration += 1;
        }

        const previousSnapshot = await prisma.economicSnapshot.findFirst({
            where: { cityId: city.id, computedAtTick: { lt: currentTick } },
            orderBy: { computedAtTick: 'desc' }
        });
        const populationChange = previousSnapshot
            ? (snapshot.population - ((previousSnapshot.data as any)?.population ?? 0))
            : 0;

        const recessionRisk = assessRecessionRisk({
            unemployment_rate: unemploymentRate,
            economic_health: snapshot.economic_health,
            housing_vacancy_rate: vacancyRate,
            businesses_bankrupt_last_period: bankruptCount,
            inflation_pressure: inflationPressure,
            agents_below_w2: agentsBelowW2,
            population
        });

        snapshot.avg_property_condition = conditionCount > 0 ? conditionSum / conditionCount : 0;
        snapshot.avg_fmv_by_tier = Object.fromEntries(
            Object.entries(fmvByTier).map(([tier, values]) => [tier, avg(values)])
        );
        snapshot.total_property_tax_collected = totalPropertyTax;
        snapshot.condemned_properties = condemnedCount;
        snapshot.population_change_last_period = populationChange;
        snapshot.immigration_count = immigration;
        snapshot.emigration_count = emigration;
        snapshot.crime_hotspot_count = crimeWindow >= 3 ? Math.floor(crimeWindow / 3) : 0;
        snapshot.crimes_last_period = crimeWindow;
        snapshot.recession_risk = recessionRisk;

        await prisma.economicSnapshot.create({
            data: {
                cityId: city.id,
                computedAtTick: currentTick,
                data: snapshot as any
            }
        });
    }

    return cities.length;
}

function assessRecessionRisk(input: {
    unemployment_rate: number;
    economic_health: string;
    housing_vacancy_rate: number;
    businesses_bankrupt_last_period: number;
    inflation_pressure: number;
    agents_below_w2: number;
    population: number;
}): number {
    let risk = 0;
    if (input.unemployment_rate > 0.25) risk += 25;
    if (input.unemployment_rate > 0.4) risk += 15;
    if (input.economic_health === 'recession') risk += 20;
    if (input.economic_health === 'crisis') risk += 30;
    if (input.housing_vacancy_rate > 0.3) risk += 10;
    if (input.businesses_bankrupt_last_period > 2) risk += 10;
    if (input.inflation_pressure < -0.5) risk += 10;
    if (input.population > 0 && (input.agents_below_w2 / input.population) > 0.4) risk += 15;
    return Math.min(100, risk);
}

export async function computeGodEconomicReport(currentTick: number): Promise<GodEconomicReport> {
    const cities = await prisma.city.findMany({
        include: { vault: true }
    });

    const reports: GodEconomicReport['cities'] = [];
    const alerts: GodEconomicReport['alerts'] = [];

    let totalSupply = 0;
    let totalBurned = 0;
    let totalMinted = 0;
    let inflationSum = 0;

    for (const city of cities) {
        const latest = snapshotCache.get(city.id);
        let previous: EconomicSnapshot | null = null;
        if (latest) {
            const prevSnapshot = await prisma.economicSnapshot.findFirst({
                where: { cityId: city.id, computedAtTick: { lt: latest.computed_at_tick } },
                orderBy: { computedAtTick: 'desc' }
            });
            previous = prevSnapshot?.data as any || null;
        }

        const populationTrend = !latest || !previous
            ? 'stable'
            : latest.population > previous.population
                ? 'growing'
                : latest.population < previous.population
                    ? 'declining'
                    : 'stable';

        const publicEmployees = await prisma.publicEmployment.count({
            where: { endedAtTick: null, publicPlace: { cityId: city.id } }
        });
        const avgPublicWage = avg(Object.values(PUBLIC_ROLE_SALARIES));
        const treasuryRunway = publicEmployees === 0
            ? 9999
            : Number(city.vault?.balanceSbyte ?? 0) / (publicEmployees * avgPublicWage);

        const failureRate = latest ? latest.businesses_bankrupt_last_period : 0;
        const inflation = latest ? latest.inflation_pressure : 0;

        reports.push({
            city_id: city.id,
            economic_health: latest?.economic_health ?? 'stable',
            population_trend: populationTrend,
            treasury_runway_days: treasuryRunway,
            inflation_pressure: inflation,
            crime_rate: 0,
            business_failure_rate: failureRate
        });

        if (latest?.gini_coefficient && latest.gini_coefficient > 0.9) {
            alerts.push({
                severity: 'warning',
                city_id: city.id,
                message: 'Extreme inequality detected',
                recommended_action: 'Consider social aid or tax relief'
            });
        }

        if (latest) {
            totalSupply += latest.total_sbyte_in_circulation;
            totalBurned += latest.total_burned;
            totalMinted += latest.total_minted;
            inflationSum += latest.inflation_pressure;
        }
    }

    const globalReport: GodEconomicReport = {
        cities: reports,
        total_sbyte_supply: totalSupply,
        total_sbyte_burned_last_period: totalBurned,
        total_sbyte_minted_last_period: totalMinted,
        net_supply_change: totalMinted - totalBurned,
        global_inflation_rate: reports.length === 0 ? 0 : inflationSum / reports.length,
        alerts
    };

    globalReportCache = globalReport;
    return globalReport;
}

export async function pruneOldSnapshots(): Promise<void> {
    const cities = await prisma.city.findMany({ select: { id: true } });
    for (const city of cities) {
        const oldSnapshots = await prisma.economicSnapshot.findMany({
            where: { cityId: city.id },
            orderBy: { computedAtTick: 'desc' },
            skip: 100,
            select: { id: true }
        });
        if (oldSnapshots.length > 0) {
            await prisma.economicSnapshot.deleteMany({
                where: { id: { in: oldSnapshots.map(s => s.id) } }
            });
        }
    }
}

export function getLatestSnapshot(cityId: string): EconomicSnapshot | null {
    return snapshotCache.get(cityId) ?? null;
}

export function getGlobalReport(): GodEconomicReport | null {
    return globalReportCache;
}
