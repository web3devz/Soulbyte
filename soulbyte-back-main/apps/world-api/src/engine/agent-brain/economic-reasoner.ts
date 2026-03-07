import { EconomicSnapshotData } from './types.js';

export interface EconomicGuidance {
    recommendedPricesByType: Record<string, number>;
    recommendedSalary: number;
    recommendedRentByTier: Record<string, number>;
    marketGapByType: Record<string, number>;
    marketPressure: {
        inflationMultiplier: number;
        unemploymentFactor: number;
    };
}

const DEMAND_FACTORS: Record<string, number> = {
    BANK: 0.15,
    CASINO: 0.10,
    STORE: 0.20,
    RESTAURANT: 0.25,
    TAVERN: 0.20,
    GYM: 0.08,
    CLINIC: 0.06,
    REALESTATE: 0.03,
    WORKSHOP: 0.07,
};

const DEFAULT_BASE_PRICES: Record<string, number> = {
    BANK: 60,
    CASINO: 80,
    STORE: 30,
    RESTAURANT: 45,
    TAVERN: 35,
    GYM: 40,
    CLINIC: 55,
    REALESTATE: 70,
    WORKSHOP: 35,
};

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function computeMarketGap(snapshot: EconomicSnapshotData): Record<string, number> {
    const population = snapshot.population ?? 0;
    const gaps: Record<string, number> = {};
    for (const [type, demand] of Object.entries(DEMAND_FACTORS)) {
        const expected = Math.max(1, Math.round((population * demand) / 100));
        const current = snapshot.business_count_by_type?.[type] ?? 0;
        const gap = (expected - current) / expected;
        gaps[type] = clamp(gap, -1, 1);
    }
    return gaps;
}

function basePriceForType(snapshot: EconomicSnapshotData, type: string): number {
    if (['RESTAURANT', 'TAVERN'].includes(type)) {
        return snapshot.avg_meal_price > 0 ? snapshot.avg_meal_price : DEFAULT_BASE_PRICES[type] ?? 40;
    }
    if (['STORE', 'WORKSHOP'].includes(type)) {
        return snapshot.avg_item_price > 0 ? snapshot.avg_item_price : DEFAULT_BASE_PRICES[type] ?? 35;
    }
    if (['GYM', 'CLINIC'].includes(type)) {
        const wage = snapshot.avg_wage_private > 0 ? snapshot.avg_wage_private : snapshot.avg_wage_public;
        return wage > 0 ? wage * 0.3 : DEFAULT_BASE_PRICES[type] ?? 45;
    }
    if (['BANK', 'CASINO', 'REALESTATE'].includes(type)) {
        const base = snapshot.median_agent_balance > 0 ? snapshot.median_agent_balance * 0.03 : snapshot.avg_agent_balance * 0.02;
        return base > 0 ? base : DEFAULT_BASE_PRICES[type] ?? 60;
    }
    return DEFAULT_BASE_PRICES[type] ?? 40;
}

export function computeEconomicGuidance(snapshot: EconomicSnapshotData): EconomicGuidance {
    const inflation = snapshot.inflation_pressure ?? 0;
    const inflationMultiplier = clamp(1 + inflation * 0.6, 0.7, 1.5);
    const unemployment = snapshot.unemployment ?? 0;
    const unemploymentFactor = clamp(1 - unemployment * 0.35, 0.6, 1.05);

    const marketGapByType = computeMarketGap(snapshot);

    const recommendedPricesByType: Record<string, number> = {};
    for (const type of Object.keys(DEMAND_FACTORS)) {
        const base = basePriceForType(snapshot, type);
        const gap = marketGapByType[type] ?? 0;
        const competitionMultiplier = clamp(1 + gap * 0.15, 0.75, 1.2);
        recommendedPricesByType[type] = Math.max(1, Math.round(base * inflationMultiplier * competitionMultiplier));
    }

    const wageBase = snapshot.avg_wage_private > 0 ? snapshot.avg_wage_private : snapshot.avg_wage_public;
    const recommendedSalary = Math.max(1, Math.round(wageBase * unemploymentFactor * inflationMultiplier));

    const recommendedRentByTier: Record<string, number> = {};
    if (snapshot.avg_rent_by_tier) {
        for (const [tier, rent] of Object.entries(snapshot.avg_rent_by_tier)) {
            const adjusted = Math.max(1, Math.round(rent * inflationMultiplier * unemploymentFactor));
            recommendedRentByTier[tier] = adjusted;
        }
    }

    return {
        recommendedPricesByType,
        recommendedSalary,
        recommendedRentByTier,
        marketGapByType,
        marketPressure: {
            inflationMultiplier,
            unemploymentFactor,
        },
    };
}
