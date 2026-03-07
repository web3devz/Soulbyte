import { AgentContext, CandidateIntent } from '../types.js';
import { PersonalityWeights } from '../personality-weights.js';
import { IntentType } from '../types.js';
import { CONSTRUCTION_BASE_COSTS } from '../../../config/gameplay.js';

const HOMELESS_TIER = 'street';
const HOUSING_COMFORT_SCORE: Record<string, number> = {
    street: 0,
    shelter: 1,
    slum_room: 2,
    apartment: 3,
    condo: 4,
    house: 5,
    villa: 6,
    estate: 7,
    palace: 8,
    citadel: 9
};

const toBuildingType = (tier?: string | null) => {
    if (!tier) return null;
    return tier.toUpperCase();
};

const chooseAffordableRental = (ctx: AgentContext) => {
    const affordable = ctx.properties.forRent
        .filter((p) => p.rentPrice > 0 && p.rentPrice <= ctx.state.balanceSbyte)
        .map((p) => {
            const comfort = HOUSING_COMFORT_SCORE[p.housingTier] ?? 1;
            const valueScore = p.rentPrice / Math.max(1, comfort);
            return { property: p, valueScore };
        })
        .sort((a, b) => a.valueScore - b.valueScore);
    return affordable[0]?.property ?? null;
};

const chooseOwnedVacantHome = (ctx: AgentContext) => {
    const ownedVacant = ctx.properties.owned
        .filter((p) => p.cityId === ctx.state.cityId)
        .filter((p) => !p.tenantId)
        .map((p) => ({
            property: p,
            comfort: HOUSING_COMFORT_SCORE[p.housingTier] ?? 1
        }))
        .sort((a, b) => b.comfort - a.comfort);
    return ownedVacant[0]?.property ?? null;
};

const chooseAffordablePurchase = (ctx: AgentContext, includeEmptyLots: boolean) => {
    const candidates = ctx.properties.forSale
        .filter((p) => p.salePrice && p.salePrice > 0)
        .filter((p) => includeEmptyLots || !p.isEmptyLot)
        .filter((p) => (p.salePrice ?? 0) <= ctx.state.balanceSbyte)
        .filter((p) => {
            if (!p.fairMarketValue || p.fairMarketValue <= 0) return true;
            if (p.fairMarketValue < 1000) return true;
            return (p.salePrice ?? 0) <= p.fairMarketValue * 2.0;
        })
        .map((p) => {
            const fmv = p.fairMarketValue && p.fairMarketValue > 0 ? p.fairMarketValue : p.salePrice ?? 1;
            const priceScore = fmv > 0 ? (p.salePrice ?? 0) / fmv : 1;
            return { property: p, priceScore };
        })
        .sort((a, b) => a.priceScore - b.priceScore);
    return candidates[0]?.property ?? null;
};

const chooseAffordableEmptyLot = (ctx: AgentContext) => {
    const candidates = ctx.properties.forSale
        .filter((p) => p.isEmptyLot)
        .filter((p) => p.salePrice && p.salePrice > 0)
        .filter((p) => (p.salePrice ?? 0) <= ctx.state.balanceSbyte)
        .sort((a, b) => (a.salePrice ?? 0) - (b.salePrice ?? 0));
    return candidates[0] ?? null;
};

const selectMoveCityTarget = (ctx: AgentContext) => {
    const currentCityId = ctx.state.cityId;
    return ctx.knownCities
        .filter((city) => city.id !== currentCityId)
        .filter((city) => (city.agora_sentiment ?? 0) > -0.3)
        .sort((a, b) => (b.housing_vacancy_rate ?? 0) - (a.housing_vacancy_rate ?? 0))[0] ?? null;
};

export class HousingDomain {
    static getCandidates(ctx: AgentContext): CandidateIntent[] {
        const candidates: CandidateIntent[] = [];
        if (!ctx.economy) return candidates;

        const homeless = ctx.state.housingTier === HOMELESS_TIER;
        const currentComfort = HOUSING_COMFORT_SCORE[ctx.state.housingTier] ?? 1;
        const vacancyRate = ctx.economy.vacancy_rate ?? 0;
        const scarcityBoost = vacancyRate < 0.1 ? 12 : vacancyRate < 0.2 ? 6 : 0;

        const ownedVacantHome = chooseOwnedVacantHome(ctx);
        if (ownedVacantHome && ctx.housing.currentRental?.id !== ownedVacantHome.id) {
            const ownedComfort = HOUSING_COMFORT_SCORE[ownedVacantHome.housingTier] ?? 1;
            const isUpgrade = ownedComfort > currentComfort;
            if (homeless || isUpgrade) {
                const ownedBase = homeless ? 95 : 30;
                candidates.push({
                    intentType: IntentType.INTENT_CHANGE_HOUSING,
                    params: { propertyId: ownedVacantHome.id },
                    basePriority: ownedBase + scarcityBoost,
                    personalityBoost: PersonalityWeights.getBoost(ctx.personality.energyManagement, true),
                    reason: homeless
                        ? `Moving into owned home to exit homelessness`
                        : `Moving into owned home (upgrade)`,
                    domain: 'housing',
                });
            }
        }

        const rental = chooseAffordableRental(ctx);
        if (rental && homeless) {
            const avgRent = ctx.economicGuidance?.recommendedRentByTier?.[rental.housingTier]
                ?? ctx.economy.avg_rent_by_tier?.[rental.housingTier]
                ?? rental.rentPrice;
            const dealBoost = avgRent > 0 ? Math.min(10, Math.round(((avgRent - rental.rentPrice) / avgRent) * 10)) : 0;
            candidates.push({
                intentType: IntentType.INTENT_CHANGE_HOUSING,
                params: { propertyId: rental.id },
                basePriority: 85 + scarcityBoost + dealBoost,
                personalityBoost: PersonalityWeights.getBoost(ctx.personality.energyManagement, true),
                reason: `Securing housing before work`,
                domain: 'housing',
            });
        }

        const purchase = chooseAffordablePurchase(ctx, false);
        if (purchase && homeless) {
            const avgRent = ctx.economicGuidance?.recommendedRentByTier?.[purchase.housingTier]
                ?? ctx.economy.avg_rent_by_tier?.[purchase.housingTier]
                ?? purchase.rentPrice;
            const paybackYears = avgRent > 0 && purchase.salePrice
                ? purchase.salePrice / (avgRent * 365)
                : null;
            const valueBoost = paybackYears !== null && paybackYears <= 8 ? 8 : paybackYears !== null && paybackYears <= 12 ? 4 : 0;
            const buyBoost = PersonalityWeights.getBoost(ctx.personality.riskTolerance, true);
            candidates.push({
                intentType: IntentType.INTENT_BUY_PROPERTY,
                params: { propertyId: purchase.id, maxPrice: purchase.salePrice },
                basePriority: 70 + scarcityBoost + valueBoost,
                personalityBoost: buyBoost,
                reason: `Buying a home to avoid homelessness`,
                domain: 'housing',
            });
        }

        const emptyLotForSale = chooseAffordableEmptyLot(ctx);
        if (emptyLotForSale && homeless) {
            candidates.push({
                intentType: IntentType.INTENT_BUY_PROPERTY,
                params: { propertyId: emptyLotForSale.id, maxPrice: emptyLotForSale.salePrice },
                basePriority: 60 + scarcityBoost,
                personalityBoost: PersonalityWeights.getBoost(ctx.personality.riskTolerance, true),
                reason: `Buying an empty lot to build a home`,
                domain: 'housing',
            });
        }

        const buildableLot = ctx.properties.emptyLots.find((lot) => !lot.underConstruction);
        if (buildableLot && homeless) {
            const buildingTier = buildableLot.maxBuildTier ?? 'slum_room';
            const buildingType = toBuildingType(buildingTier);
            const buildCost = buildingType ? CONSTRUCTION_BASE_COSTS[buildingType] ?? 0 : 0;
            if (buildingType && buildCost > 0 && ctx.state.balanceSbyte >= buildCost * 0.2) {
                candidates.push({
                    intentType: IntentType.INTENT_REQUEST_CONSTRUCTION,
                    params: {
                        lotId: buildableLot.id,
                        buildingType,
                        maxBudget: buildCost,
                        preferredConstructorId: null
                    },
                    basePriority: 75 + scarcityBoost,
                    personalityBoost: PersonalityWeights.getBoost(ctx.personality.patience, true),
                    reason: `Building housing on owned lot`,
                    domain: 'housing',
                });
            }
        }

        const hasHousingOptions = candidates.length > 0;
        if (homeless && !hasHousingOptions) {
            const targetCity = selectMoveCityTarget(ctx);
            if (targetCity) {
                candidates.push({
                    intentType: IntentType.INTENT_MOVE_CITY,
                    params: { targetCityId: targetCity.id },
                    basePriority: 80 + scarcityBoost,
                    personalityBoost: PersonalityWeights.getBoost(ctx.personality.riskTolerance, true),
                    reason: `No housing available locally, moving to ${targetCity.name}`,
                    domain: 'housing',
                });
            }
        }

        return candidates;
    }
}
