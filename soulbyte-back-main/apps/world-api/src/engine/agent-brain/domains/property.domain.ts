import { AgentContext, CandidateIntent, UrgencyLevel } from '../types.js';
import { PersonalityWeights } from '../personality-weights.js';
import { IntentType } from '../types.js';
import { debugLog } from '../../../utils/debug-log.js';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const getVacancyRate = (ctx: AgentContext, tier: string) => {
    return ctx.economy?.vacancy_rate_by_tier?.[tier]
        ?? ctx.economy?.vacancy_rate
        ?? 0;
};

const getMarketRent = (ctx: AgentContext, tier: string, fallbackRent: number) => {
    return ctx.economicGuidance?.recommendedRentByTier?.[tier]
        ?? ctx.economy?.avg_rent_by_tier?.[tier]
        ?? fallbackRent;
};

const estimateSalePrice = (ctx: AgentContext, property: AgentContext['properties']['owned'][number]) => {
    if (property.fairMarketValue && property.fairMarketValue > 0) {
        return property.fairMarketValue;
    }
    const marketRent = getMarketRent(ctx, property.housingTier, property.rentPrice);
    const vacancy = getVacancyRate(ctx, property.housingTier);
    const capRate = clamp(0.07 + vacancy * 0.08, 0.06, 0.16);
    const annualNet = marketRent * 365;
    if (annualNet <= 0) {
        return property.salePrice ?? Math.max(1, marketRent * 365 * 8);
    }
    return Math.max(1, Math.round(annualNet / capRate));
};

const isOwnerOccupied = (ctx: AgentContext, property: AgentContext['properties']['owned'][number]) => {
    return property.tenantId === ctx.agent.id;
};

export class PropertyDomain {
    static getCandidates(ctx: AgentContext): CandidateIntent[] {
        const candidates: CandidateIntent[] = [];

        if (!ctx.economy) return candidates;

        const wealthTier = ctx.state.wealthTier;
        const canInvest = ['W4', 'W5', 'W6', 'W7', 'W8', 'W9'].includes(wealthTier);

        const cityRep = ctx.economy.city_reputation ?? 200;
        const cityModifier = cityRep > 350 ? 1.2 : cityRep > 250 ? 1.1 : cityRep > 150 ? 1.0 : cityRep > 100 ? 0.85 : 0.7;

        const maintenanceCostByTier: Record<string, number> = {
            shelter: 2,
            slum_room: 5,
            apartment: 15,
            condo: 50,
            house: 150,
            villa: 500,
            estate: 2000,
            palace: 5000,
            citadel: 15000
        };

        // Investment buys: seek discounted properties with strong yield and low vacancy risk
        if (canInvest) {
            for (const prop of ctx.properties.forSale) {
                if (prop.isEmptyLot) continue;
                if (!prop.salePrice || prop.salePrice <= 0) continue;
                if (ctx.state.balanceSbyte < prop.salePrice) continue;

                const vacancy = getVacancyRate(ctx, prop.housingTier);
                if (vacancy > 0.35) continue;

                const marketRent = getMarketRent(ctx, prop.housingTier, prop.rentPrice);
                const marketValue = prop.fairMarketValue && prop.fairMarketValue > 0
                    ? prop.fairMarketValue
                    : Math.max(1, Math.round(marketRent * 365 * 10));
                const discount = marketValue > 0 ? prop.salePrice / marketValue : 1;
                const annualTaxCost = marketValue * (ctx.city.propertyTaxRate ?? 0.02);
                const annualMaintenanceCost = (maintenanceCostByTier[prop.housingTier] ?? 0) * 365;
                const netYieldAfterExpenses = prop.salePrice > 0
                    ? ((marketRent * 365) - annualTaxCost - annualMaintenanceCost) / prop.salePrice
                    : 0;
                const minYield = 0.07 + Math.max(0, vacancy - 0.1) * 0.2;

                if (discount < 0.95 && netYieldAfterExpenses > minYield * cityModifier) {
                    debugLog('property.investment_buy_candidate', {
                        agentId: ctx.agent.id,
                        tick: ctx.tick,
                        propertyId: prop.id,
                        discount,
                        netYieldAfterExpenses,
                        vacancy,
                    });
                    candidates.push({
                        intentType: IntentType.INTENT_BUY_PROPERTY,
                        params: { propertyId: prop.id, maxPrice: prop.salePrice },
                        basePriority: Math.round(35 * cityModifier),
                        personalityBoost: PersonalityWeights.getBoost(ctx.personality.selfInterest, true),
                        reason: 'Discounted property with strong yield',
                        domain: 'economy'
                    });
                    break;
                }
            }
        }

        // Manage owned properties: rent/sale intelligence, avoid loss pricing
        const ownedCount = ctx.properties.owned.length;
        for (const prop of ctx.properties.owned) {
            if (isOwnerOccupied(ctx, prop)) continue;

            const vacancy = getVacancyRate(ctx, prop.housingTier);
            const marketRent = getMarketRent(ctx, prop.housingTier, prop.rentPrice);
            const marketSale = estimateSalePrice(ctx, prop);
            const rentMultiplier = vacancy < 0.1 ? 1.08 : vacancy < 0.2 ? 1.02 : vacancy < 0.3 ? 0.98 : 0.9;
            const saleMultiplier = vacancy < 0.12 ? 1.08 : vacancy < 0.22 ? 1.02 : vacancy < 0.3 ? 0.98 : 0.92;
            const targetRent = Math.max(1, Math.round(marketRent * rentMultiplier));
            const targetSale = Math.max(1, Math.round(marketSale * saleMultiplier));

            const isVacant = !prop.tenantId;
            // Empty lots cannot be rented, only sold
            const isEmptyLot = prop.isEmptyLot === true;
            const shouldConsiderSale = isEmptyLot || (ownedCount > 1
                && (vacancy > 0.3 || (ctx.economy?.unemployment ?? 0) > 0.3));

            if (isVacant && (!prop.forRent && !prop.forSale)) {
                // For empty lots, only list for sale (renting blocked by handler)
                const listForRent = !shouldConsiderSale && !isEmptyLot;
                const listForSale = shouldConsiderSale || isEmptyLot;
                debugLog('property.list_candidate', {
                    agentId: ctx.agent.id,
                    tick: ctx.tick,
                    propertyId: prop.id,
                    forRent: listForRent,
                    forSale: listForSale,
                    isEmptyLot,
                    targetRent,
                    targetSale,
                });
                candidates.push({
                    intentType: IntentType.INTENT_LIST_PROPERTY,
                    params: {
                        propertyId: prop.id,
                        forRent: listForRent,
                        forSale: listForSale,
                        rentPrice: listForRent ? targetRent : undefined,
                        salePrice: listForSale ? targetSale : undefined,
                    },
                    basePriority: 32,
                    personalityBoost: PersonalityWeights.getBoost(ctx.personality.selfInterest, true),
                    reason: listForSale
                        ? (isEmptyLot ? 'Listing empty lot for sale' : 'Listing vacant property for sale due to weak rental market')
                        : 'Listing vacant property for rent at market rate',
                    domain: 'economy',
                });
                break;
            }

            if (isVacant && prop.forRent) {
                if (prop.rentPrice > targetRent * 1.2 || prop.rentPrice < targetRent * 0.75) {
                    debugLog('property.adjust_rent_candidate', {
                        agentId: ctx.agent.id,
                        tick: ctx.tick,
                        propertyId: prop.id,
                        currentRent: prop.rentPrice,
                        targetRent,
                    });
                    candidates.push({
                        intentType: IntentType.INTENT_ADJUST_RENT,
                        params: { propertyId: prop.id, newRent: targetRent },
                        basePriority: 30,
                        personalityBoost: PersonalityWeights.getBoost(ctx.personality.selfInterest, true),
                        reason: 'Repricing vacant rental to match market demand',
                        domain: 'economy'
                    });
                    break;
                }
            }

            if (isVacant && shouldConsiderSale) {
                if (!prop.forSale || !prop.salePrice || Math.abs(prop.salePrice - targetSale) / targetSale > 0.2) {
                    debugLog('property.sale_price_candidate', {
                        agentId: ctx.agent.id,
                        tick: ctx.tick,
                        propertyId: prop.id,
                        targetSale,
                    });
                    candidates.push({
                        intentType: IntentType.INTENT_LIST_PROPERTY,
                        params: {
                            propertyId: prop.id,
                            forSale: true,
                            forRent: false,
                            rentPrice: targetRent,
                            salePrice: targetSale,
                        },
                        basePriority: 28,
                        personalityBoost: PersonalityWeights.getBoost(ctx.personality.selfInterest, true),
                        reason: 'Listing property for sale at market price',
                        domain: 'economy'
                    });
                    break;
                }
            }

            if (!isVacant && prop.forRent) {
                const maxSafeIncrease = Math.round(prop.rentPrice * 1.15);
                const desiredIncrease = Math.min(targetRent, maxSafeIncrease);
                if (prop.rentPrice < targetRent * 0.7 && desiredIncrease > prop.rentPrice) {
                    debugLog('property.rent_raise_candidate', {
                        agentId: ctx.agent.id,
                        tick: ctx.tick,
                        propertyId: prop.id,
                        currentRent: prop.rentPrice,
                        newRent: desiredIncrease,
                    });
                    candidates.push({
                        intentType: IntentType.INTENT_ADJUST_RENT,
                        params: { propertyId: prop.id, newRent: desiredIncrease },
                        basePriority: 22,
                        personalityBoost: PersonalityWeights.getBoost(ctx.personality.selfInterest, true),
                        reason: 'Gently raising rent toward market without evicting tenant',
                        domain: 'economy'
                    });
                    break;
                }
            }
        }

        // Maintain owned properties with low condition
        for (const prop of ctx.properties.owned) {
            const condition = prop.condition ?? 100;
            if (condition >= 60) continue;
            const cost = maintenanceCostByTier[prop.housingTier] ?? 0;
            if (cost <= 0 || ctx.state.balanceSbyte < cost * 3) continue;
            candidates.push({
                intentType: IntentType.INTENT_MAINTAIN_PROPERTY,
                params: { propertyId: prop.id },
                basePriority: condition < 30 ? 45 : 25,
                personalityBoost: PersonalityWeights.getBoost(ctx.personality.selfInterest, true),
                reason: condition < 30 ? 'Prevent tenant loss from degradation' : 'Maintain property value',
                domain: 'economy'
            });
            break;
        }

        return candidates;
    }
}
