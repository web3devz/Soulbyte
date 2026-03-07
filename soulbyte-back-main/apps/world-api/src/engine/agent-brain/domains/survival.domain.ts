
import { AgentContext, NeedUrgency, CandidateIntent, UrgencyLevel } from '../types.js';
import { PersonalityWeights } from '../personality-weights.js';
import { ItemCategory, BusinessType } from '../../../../../../generated/prisma/index.js';
import { debugLog } from '../../../utils/debug-log.js';

export class SurvivalDomain {

    static getCandidates(ctx: AgentContext, urgencies: NeedUrgency[]): CandidateIntent[] {
        const candidates: CandidateIntent[] = [];
        const hungerRecoveryByItem: Record<string, number> = {
            CONS_RATION: 35,
            CONS_MEAL: 50,
            CONS_ENERGY_DRINK: 0,
            CONS_MEDKIT: 0,
        };

        // --- HUNGER ---
        const hungerUrgency = urgencies.find(u => u.need === 'hunger');
        if (hungerUrgency && hungerUrgency.urgency >= UrgencyLevel.LOW) {

            // Option A: Consume item from inventory (free, if available)
            // Check for consumable items
            const foodItems = ctx.inventory.filter(i =>
                (i.quantity ?? 0) > 0 && (
                    i.itemDefinition.category === ItemCategory.consumable
                    || i.itemDefinition.name.toLowerCase().includes('food')
                    || i.itemDefinition.name.toLowerCase().includes('ration')
                )
            );
            const food = foodItems[0];

            if (food) {
                const hungerGain = hungerRecoveryByItem[food.itemDefinition.name] ?? 10;
                const hungerDeficit = Math.max(0, 100 - hungerUrgency.value);
                let quantity = Math.max(1, Math.ceil(hungerDeficit / Math.max(1, hungerGain)));
                quantity = Math.min(quantity, Math.max(1, food.quantity ?? 1), 5);
                debugLog('survival.consume_candidate', {
                    agentId: ctx.agent.id,
                    tick: ctx.tick,
                    hunger: hungerUrgency.value,
                    item: food.itemDefinition.name,
                    quantity,
                });
                candidates.push({
                    intentType: 'INTENT_CONSUME_ITEM',
                    params: { itemDefId: food.itemDefId, quantity },
                    basePriority: 75 + ((100 - hungerUrgency.value) * 0.5), // Higher than buying/foraging
                    personalityBoost: 0,
                    reason: `Hungry (${hungerUrgency.value}%), eating ${food.itemDefinition.name}`,
                    domain: 'survival',
                });
            }

            // Option B: Visit restaurant (costs SBYTE, better recovery)
            const restaurants = ctx.businesses.inCity.filter(
                b => b.businessType === BusinessType.RESTAURANT
            );
            const store = ctx.businesses.inCity.find(
                b => b.businessType === BusinessType.STORE
            );

            // Check if can afford meal
            const mealPrice = ctx.economy?.avg_meal_price ?? 50;

            const restaurantEffects = { hunger: 50, fun: 10, social: 5 };
            const restaurantPersonalityBoost = (
                PersonalityWeights.getBoost(ctx.personality.socialNeed, true)
                + PersonalityWeights.getBoost(ctx.personality.selfInterest, true)
                + PersonalityWeights.getBoost(ctx.personality.energyManagement, false)
            );
            const restaurantChoices = restaurants
                .filter(r => ctx.state.balanceSbyte > (r.pricePerService ?? mealPrice))
                .map(r => {
                    const price = r.pricePerService ?? mealPrice;
                    const rep = Number(r.reputation ?? 0);
                    const funNeed = Math.max(0, 100 - ctx.needs.fun);
                    const socialNeed = Math.max(0, 100 - ctx.needs.social);
                    const benefit = restaurantEffects.hunger + (funNeed * 0.05) + (socialNeed * 0.05);
                    const costPenalty = (price / Math.max(1, ctx.state.balanceSbyte)) * 100;
                    const repBonus = rep * 0.02;
                    return { restaurant: r, score: benefit + repBonus - costPenalty };
                });
            restaurantChoices.sort((a, b) => b.score - a.score);
            const bestRestaurant = restaurantChoices[0]?.restaurant ?? null;

            if (bestRestaurant && ctx.state.balanceSbyte > (bestRestaurant.pricePerService ?? mealPrice)) {
                debugLog('survival.restaurant_candidate', {
                    agentId: ctx.agent.id,
                    tick: ctx.tick,
                    hunger: hungerUrgency.value,
                    businessId: bestRestaurant.id,
                });
                candidates.push({
                    intentType: 'INTENT_VISIT_BUSINESS',
                    params: { businessId: bestRestaurant.id },
                    basePriority: 52 + ((100 - hungerUrgency.value) * 0.35),
                    personalityBoost: restaurantPersonalityBoost,
                    reason: `Hungry, visiting restaurant`,
                    domain: 'survival',
                });
            }

            const totalFoodQty = foodItems.reduce((sum, item) => sum + (item.quantity ?? 0), 0);
            const allowStoreBuy = hungerUrgency.urgency >= UrgencyLevel.MODERATE || totalFoodQty === 0;
            if (store && ctx.state.balanceSbyte > 15 && allowStoreBuy) {
                const itemType = hungerUrgency.value <= 40 ? 'CONS_MEAL' : 'CONS_RATION';
                const hungerGain = itemType === 'CONS_MEAL' ? 50 : 35;
                const priceEach = itemType === 'CONS_MEAL' ? 30 : 15;
                const hungerDeficit = Math.max(0, 100 - hungerUrgency.value);
                let quantity = Math.max(1, Math.ceil(hungerDeficit / hungerGain));
                quantity = Math.min(quantity, 5);
                while (quantity > 0 && (priceEach * quantity) > ctx.state.balanceSbyte) {
                    quantity -= 1;
                }
                if (quantity > 0) {
                    debugLog('survival.store_buy_candidate', {
                        agentId: ctx.agent.id,
                        tick: ctx.tick,
                        hunger: hungerUrgency.value,
                        itemType,
                        quantity,
                        balance: ctx.state.balanceSbyte,
                        inventoryFoodQty: totalFoodQty,
                    });
                    candidates.push({
                        intentType: 'INTENT_BUY_ITEM',
                        params: { businessId: store.id, itemType, quantity },
                        basePriority: 56 + ((100 - hungerUrgency.value) * 0.4),
                        personalityBoost: PersonalityWeights.getBoost(ctx.personality.selfInterest, true),
                        reason: `Buying food from store (hunger ${hungerUrgency.value})`,
                        domain: 'survival',
                    });
                }
            }

            const canAffordMeal = ctx.state.balanceSbyte >= mealPrice;
            const shouldForage = (totalFoodQty === 0)
                && (!bestRestaurant || !canAffordMeal)
                && (!store || ctx.state.balanceSbyte < 15);
            if (shouldForage && hungerUrgency.urgency >= UrgencyLevel.MODERATE) {
                candidates.push({
                    intentType: 'INTENT_FORAGE',
                    params: {},
                    basePriority: 40 + ((100 - hungerUrgency.value) * 0.25),
                    personalityBoost: PersonalityWeights.getBoost(ctx.personality.energyManagement, false),
                    reason: `Low funds, foraging for food`,
                    domain: 'survival',
                });
            }
        }

        // --- ENERGY ---
        const energyUrgency = urgencies.find(u => u.need === 'energy');
        if (energyUrgency && energyUrgency.urgency >= UrgencyLevel.MODERATE) {
            candidates.push({
                intentType: 'INTENT_REST',
                params: {},
                basePriority: 60 + ((100 - energyUrgency.value) * 0.4),
                personalityBoost: PersonalityWeights.getBoost(ctx.personality.energyManagement, true),
                reason: `Exhausted (${energyUrgency.value}%), resting`,
                domain: 'survival',
            });
        }

        // --- HEALTH ---
        const healthUrgency = urgencies.find(u => u.need === 'health');
        if (healthUrgency && healthUrgency.urgency >= UrgencyLevel.MODERATE) {
            // Visit clinic
            const clinic = ctx.businesses.inCity.find(b => b.businessType === BusinessType.CLINIC);
            if (clinic && ctx.state.balanceSbyte > 100) {
                candidates.push({
                    intentType: 'INTENT_VISIT_BUSINESS',
                    params: { businessId: clinic.id },
                    basePriority: 85 + ((100 - healthUrgency.value) * 0.4),
                    personalityBoost: 0,
                    reason: `Health critical (${healthUrgency.value}%), visiting clinic`,
                    domain: 'survival',
                });
            }
            // Rest as health recovery fallback
            candidates.push({
                intentType: 'INTENT_REST',
                params: {},
                basePriority: 75 + ((100 - healthUrgency.value) * 0.2),
                personalityBoost: 0,
                reason: `Health low (${healthUrgency.value}%), resting to recover`,
                domain: 'survival',
            });
        }

        return candidates;
    }
}
