
import { AgentContext, IntentDecision } from './types.js';
import { IntentType } from '../../types/intent.types.js';
import { isIntentAllowedWhileBusy } from '../intent-guards.js';
import { REAL_DAY_TICKS } from '../../config/time.js';

const BUSINESS_CONFIG: Record<string, { buildCost: number; minCapital: number }> = {
    BANK: { buildCost: 15000, minCapital: 100000 },
    CASINO: { buildCost: 20000, minCapital: 50000 },
    STORE: { buildCost: 2000, minCapital: 3000 },
    RESTAURANT: { buildCost: 3000, minCapital: 5000 },
    TAVERN: { buildCost: 2500, minCapital: 2000 },
    GYM: { buildCost: 5000, minCapital: 2000 },
    CLINIC: { buildCost: 8000, minCapital: 10000 },
    REALESTATE: { buildCost: 10000, minCapital: 5000 },
    WORKSHOP: { buildCost: 3500, minCapital: 3000 },
};

const BUSINESS_DECISION_INTENTS = new Set<string>([
    IntentType.INTENT_FOUND_BUSINESS,
    IntentType.INTENT_CONVERT_BUSINESS,
    IntentType.INTENT_UPGRADE_BUSINESS,
    IntentType.INTENT_SET_PRICES,
    IntentType.INTENT_IMPROVE_BUSINESS,
    IntentType.INTENT_HIRE_EMPLOYEE,
    IntentType.INTENT_ADJUST_SALARY,
    IntentType.INTENT_FIRE_EMPLOYEE,
    IntentType.INTENT_SELL_BUSINESS,
    IntentType.INTENT_BUY_BUSINESS,
    IntentType.INTENT_DISSOLVE_BUSINESS,
    IntentType.INTENT_WITHDRAW_BUSINESS_FUNDS,
    IntentType.INTENT_INJECT_BUSINESS_FUNDS,
    IntentType.INTENT_BUSINESS_WITHDRAW,
    IntentType.INTENT_BUSINESS_INJECT,
    IntentType.INTENT_CLOSE_BUSINESS,
    IntentType.INTENT_SET_LOAN_TERMS,
    IntentType.INTENT_APPROVE_LOAN,
    IntentType.INTENT_DENY_LOAN,
    IntentType.INTENT_SET_HOUSE_EDGE,
    IntentType.INTENT_MANAGE_RESTAURANT,
    IntentType.INTENT_MANAGE_CLINIC,
    IntentType.INTENT_HOST_EVENT,
    IntentType.INTENT_TRANSFER_MON_TO_BUSINESS,
]);

function getIntentCost(decision: IntentDecision, ctx: AgentContext): number {
    if (decision.intentType === 'INTENT_PAY_RENT') {
        const rentPrice = ctx.housing.currentRental?.rentPrice;
        return Number(decision.params.amount ?? rentPrice ?? (ctx.economy?.avg_rent_by_tier?.[ctx.state.housingTier] ?? ctx.economy?.avg_rent ?? 50));
    }
    if (decision.intentType === 'INTENT_MOVE_CITY') {
        return Math.max(50, Math.round((ctx.economy?.avg_rent ?? 50) * 0.5));
    }
    if (decision.intentType === 'INTENT_FOUND_BUSINESS' || decision.intentType === 'INTENT_CONVERT_BUSINESS') {
        const config = BUSINESS_CONFIG[decision.params.businessType];
        if (!config) return 0;
        const baseCost = decision.intentType === 'INTENT_CONVERT_BUSINESS'
            ? config.buildCost * 0.5
            : config.buildCost;
        return baseCost + config.minCapital;
    }
    if (decision.intentType === 'INTENT_VISIT_BUSINESS') {
        return Math.max(5, Math.round(ctx.economicGuidance?.recommendedPricesByType?.RESTAURANT ?? 10));
    }
    if (decision.intentType === 'INTENT_BET') {
        return Number(decision.params.betAmount ?? 0);
    }
    if (decision.intentType === 'INTENT_SOCIALIZE') {
        const intensity = Number(decision.params.intensity ?? 1);
        return 5 * Math.max(1, Math.min(3, intensity));
    }
    if (decision.intentType === 'INTENT_ROMANTIC_INTERACTION') {
        const intensity = Number(decision.params.intensity ?? 1);
        return 5 * Math.max(1, Math.min(3, intensity));
    }
    if (decision.intentType === 'INTENT_BUY') {
        const listing = ctx.marketListings?.find((l) => l.id === decision.params.listingId);
        const quantity = Number(decision.params.quantity ?? 1);
        return listing ? listing.priceEach * quantity : 0;
    }
    if (decision.intentType === 'INTENT_BUY_ITEM') {
        const quantity = Number(decision.params.quantity ?? 1);
        const avgItemPrice = ctx.economy?.avg_item_price ?? 10;
        return avgItemPrice * quantity;
    }
    if (decision.intentType === 'INTENT_BUY_PROPERTY') {
        const target = ctx.properties.forSale.find((p) => p.id === decision.params.propertyId);
        return Number(decision.params.maxPrice ?? target?.salePrice ?? 0);
    }
    if (decision.intentType === 'INTENT_REQUEST_CONSTRUCTION') {
        return Number(decision.params.maxBudget ?? 0) * 0.2;
    }
    if (decision.intentType === 'INTENT_BUSINESS_INJECT') {
        return Number(decision.params.amount ?? 0);
    }
    if (decision.intentType === 'INTENT_BUSINESS_WITHDRAW') {
        return 0;
    }
    return 0;
}

function validateIntent(decision: IntentDecision, ctx: AgentContext): string | null {
    const type = decision.intentType;
    const params = decision.params ?? {};
    if (type === 'INTENT_CONSUME_ITEM') {
        const itemDefId = params.itemDefId;
        const quantity = Number(params.quantity ?? 1);
        if (!itemDefId) return 'Missing itemDefId';
        if (!Number.isFinite(quantity) || quantity <= 0) return 'Invalid quantity';
        const hasItem = ctx.inventory.some((item) => item.itemDefId === itemDefId && item.quantity >= quantity);
        if (!hasItem) return 'Item not in inventory';
    }
    if (type === 'INTENT_FORAGE') {
        return null;
    }
    if (type === 'INTENT_FOUND_BUSINESS') {
        const { businessType, landId } = params;
        if (!businessType || !landId) return 'Missing businessType or landId';
        const lot = ctx.properties.emptyLots.find((p) => p.id === landId);
        if (!lot) return 'Land not owned or not available';
        const config = BUSINESS_CONFIG[businessType];
        if (!config) return 'Invalid business type';
        const required = config.buildCost + config.minCapital;
        if (ctx.state.balanceSbyte < required) return 'Insufficient funds for business build';
    }
    if (type === 'INTENT_CONVERT_BUSINESS') {
        const { businessType, landId } = params;
        if (!businessType || !landId) return 'Missing businessType or landId';
        const ownedHouse = ctx.properties.owned.find((p) => p.id === landId && !p.isEmptyLot && !p.underConstruction);
        const houseForSale = ctx.properties.forSale.find((p) => p.id === landId && !p.isEmptyLot && !p.underConstruction);
        if (!ownedHouse && !houseForSale) return 'House not owned or not available';
        const config = BUSINESS_CONFIG[businessType];
        if (!config) return 'Invalid business type';
        const required = (config.buildCost * 0.5) + config.minCapital;
        if (ctx.state.balanceSbyte < required) return 'Insufficient funds for business conversion';
    }
    if (type === 'INTENT_BUSINESS_INJECT') {
        const amount = Number(params.amount ?? 0);
        if (amount <= 0) return 'Inject amount must be positive';
        if (ctx.state.balanceSbyte < amount) return 'Insufficient funds to inject';
        const business = ctx.businesses.owned.find((b) => b.id === params.businessId);
        if (!business) return 'Business not owned';
    }
    if (type === 'INTENT_BUSINESS_WITHDRAW') {
        const amount = Number(params.amount ?? 0);
        if (amount <= 0) return 'Withdraw amount must be positive';
        const business = ctx.businesses.owned.find((b) => b.id === params.businessId);
        if (!business) return 'Business not owned';
        const reserve = Math.max((business.dailyExpenses ?? 0) * 7, BUSINESS_CONFIG[business.businessType]?.minCapital ?? 0);
        if (business.treasury - amount < reserve) return 'Withdrawal would drop below reserve';
    }
    if (type === 'INTENT_SET_PRICES') {
        if (!params.businessId) return 'Missing businessId';
        const business = ctx.businesses.owned.find((b) => b.id === params.businessId);
        if (!business) return 'Business not owned';
        if (params.pricePerService !== undefined && Number(params.pricePerService) <= 0) {
            return 'Invalid price';
        }
        if (params.minBet !== undefined || params.maxBet !== undefined) {
            const minBet = Number(params.minBet ?? 0);
            const maxBet = Number(params.maxBet ?? 0);
            if (minBet <= 0 || maxBet <= 0 || minBet > maxBet) return 'Invalid bet range';
        }
    }
    if (type === 'INTENT_HIRE_EMPLOYEE') {
        const { businessId, targetAgentId, offeredSalary } = params;
        if (!businessId || !targetAgentId) return 'Missing businessId or targetAgentId';
        if (offeredSalary !== undefined && Number(offeredSalary) <= 0) return 'Invalid offered salary';
        const business = ctx.businesses.owned.find((b) => b.id === businessId);
        if (!business) return 'Business not owned';
        const targetExists = ctx.nearbyAgents.some((agent) => agent.id === targetAgentId);
        if (!targetExists) return 'Target agent not nearby';
    }
    if (type === 'INTENT_WORK_OWN_BUSINESS') {
        if (!params.businessId) return 'Missing businessId';
        const business = ctx.businesses.owned.find((b) => b.id === params.businessId);
        if (!business) return 'Business not owned';
    }
    if (type === 'INTENT_CLOSE_BUSINESS') {
        if (!params.businessId) return 'Missing businessId';
        const business = ctx.businesses.owned.find((b) => b.id === params.businessId);
        if (!business) return 'Business not owned';
    }
    if (type === 'INTENT_TRANSFER_MON_TO_BUSINESS') {
        if (!params.businessId) return 'Missing businessId';
        const business = ctx.businesses.owned.find((b) => b.id === params.businessId);
        if (!business) return 'Business not owned';
        const amount = Number(params.amount ?? 0);
        if (amount <= 0 || amount > 10) return 'Invalid MON amount (must be 1-10)';
    }
    if (type === 'INTENT_VISIT_BUSINESS') {
        if (!params.businessId) return 'Missing businessId';
        const exists = ctx.businesses.inCity.some((b) => b.id === params.businessId);
        if (!exists) return 'Unknown business';
    }
    if (type === 'INTENT_MOVE_CITY') {
        if (!params.targetCityId) return 'Missing targetCityId';
        const exists = ctx.knownCities.some((c) => c.id === params.targetCityId);
        if (!exists) return 'Unknown target city';
        const health = Number(ctx.needs.health ?? 0);
        const energy = Number(ctx.needs.energy ?? 0);
        const hunger = Number(ctx.needs.hunger ?? 0);
        if (health < 50 || energy < 35 || hunger < 35) {
            return 'Unsafe to travel with current status';
        }
    }
    if (type === 'INTENT_CHANGE_HOUSING') {
        if (!params.propertyId) return 'Missing propertyId';
        const property = ctx.properties.forRent.find((p) => p.id === params.propertyId);
        if (!property) return 'Property not available for rent';
    }
    if (type === 'INTENT_BUY_PROPERTY') {
        if (!params.propertyId) return 'Missing propertyId';
        const property = ctx.properties.forSale.find((p) => p.id === params.propertyId);
        if (!property || !property.salePrice) return 'Property not available for sale';
        const maxPrice = Number(params.maxPrice ?? property.salePrice);
        if (maxPrice < property.salePrice) return 'Max price below sale price';
        if (ctx.state.balanceSbyte < property.salePrice) return 'Insufficient funds for property purchase';
    }
    if (type === 'INTENT_REQUEST_CONSTRUCTION') {
        const { lotId, buildingType, maxBudget } = params;
        if (!lotId || !buildingType || !maxBudget) return 'Missing construction params';
        const lot = ctx.properties.emptyLots.find((p) => p.id === lotId && !p.underConstruction);
        if (!lot) return 'Lot not available for construction';
        const budget = Number(maxBudget);
        if (!Number.isFinite(budget) || budget <= 0) return 'Invalid construction budget';
        if (ctx.state.balanceSbyte < budget * 0.2) return 'Insufficient construction deposit';
    }
    if (type === 'INTENT_ADJUST_RENT') {
        const { propertyId, newRent } = params;
        if (!propertyId || newRent === undefined) return 'Missing propertyId or newRent';
        const property = ctx.properties.owned.find((p) => p.id === propertyId);
        if (!property) return 'Property not owned';
        if (Number(newRent) <= 0) return 'Invalid rent amount';
    }
    if (type === 'INTENT_MAINTAIN_PROPERTY') {
        if (!params.propertyId) return 'Missing propertyId';
        const property = ctx.properties.owned.find((p) => p.id === params.propertyId);
        if (!property) return 'Property not owned';
    }
    if (type === 'INTENT_EVICT') {
        if (!params.propertyId) return 'Missing propertyId';
        const property = ctx.properties.owned.find((p) => p.id === params.propertyId);
        if (!property) return 'Property not owned';
    }
    if (type === 'INTENT_LIST') {
        const { itemDefId, price, quantity } = params;
        if (!itemDefId) return 'Missing itemDefId';
        if (Number(price ?? 0) <= 0) return 'Invalid price';
        if (Number(quantity ?? 0) <= 0) return 'Invalid quantity';
        const inventory = ctx.inventory.find((item) => item.itemDefId === itemDefId);
        if (!inventory || inventory.quantity < Number(quantity)) return 'Insufficient inventory';
    }
    if (type === 'INTENT_BUY') {
        const { listingId, quantity } = params;
        if (!listingId) return 'Missing listingId';
        const listing = ctx.marketListings?.find((l) => l.id === listingId);
        if (!listing) return 'Listing not available';
        if (Number(quantity ?? 1) <= 0 || Number(quantity ?? 1) > listing.quantity) return 'Invalid quantity';
    }
    if (type === 'INTENT_BUY_ITEM') {
        const { businessId, itemDefId, itemName, itemType, quantity } = params;
        if (!businessId) return 'Missing businessId';
        const business = ctx.businesses.inCity.find((b) => b.id === businessId);
        if (!business || business.businessType !== 'STORE') return 'Store not available';
        if (!itemDefId && !itemName && !itemType) return 'Missing itemDefId, itemName, or itemType';
        if (Number(quantity ?? 1) <= 0) return 'Invalid quantity';
    }
    if (type === 'INTENT_START_SHIFT' || type === 'INTENT_COLLECT_SALARY' || type === 'INTENT_RESIGN_PUBLIC_JOB') {
        if (!ctx.job.publicEmployment) return 'No public employment';
    }
    if (type === 'INTENT_COLLECT_SALARY') {
        if (!ctx.employment.salaryDue) return 'No completed shift to collect salary for';
    }
    if (type === 'INTENT_APPLY_PUBLIC_JOB') {
        const { publicPlaceId, role } = params;
        if (!publicPlaceId || !role) return 'Missing publicPlaceId or role';
        const exists = ctx.publicPlaces.some((place) => place.id === publicPlaceId);
        if (!exists) return 'Public place not found';
    }
    if (type === 'INTENT_WORK') {
        const jobId = params.jobId ?? params.employmentId;
        if (!jobId) return 'Missing jobId';
    }
    if (type === 'INTENT_APPLY_PRIVATE_JOB' || type === 'INTENT_ACCEPT_JOB' || type === 'INTENT_REJECT_JOB') {
        if (!params.businessId) return 'Missing businessId';
    }
    if (type === 'INTENT_PATROL') {
        const role = ctx.job.publicEmployment?.role;
        if (role !== 'POLICE_OFFICER') return 'Not a police officer';
    }
    if (type === 'INTENT_BET') {
        const betAmount = Number(params.betAmount ?? 0);
        if (!Number.isFinite(betAmount) || betAmount <= 0) return 'Invalid betAmount';
    }
    if (type === 'INTENT_POST_AGORA') {
        if (!params.source) return 'Missing source';
        if (params.source === 'owner_suggestion' || params.ownerOverride) {
            return 'Owner suggestions are not allowed for Agora';
        }
    }
    if (type === 'INTENT_REPLY_AGORA' || type === 'INTENT_VOTE_AGORA') {
        if (params.source === 'owner_suggestion' || params.ownerOverride) {
            return 'Owner suggestions are not allowed for Agora';
        }
    }
    if (type === 'INTENT_PROPOSE_ALLIANCE' || type === 'INTENT_PROPOSE_DATING' || type === 'INTENT_ROMANTIC_INTERACTION' || type === 'INTENT_ARREST' || type === 'INTENT_STEAL' || type === 'INTENT_ASSAULT' || type === 'INTENT_FRAUD') {
        if (!params.targetId) return 'Missing targetId';
        if (params.targetId === ctx.agent.id) return 'Invalid targetId';
    }
    if (type === 'INTENT_SOCIALIZE') {
        // targetId is optional; handler resolves or validates city membership
    }
    if (type === 'INTENT_CHALLENGE_GAME') {
        const { targetId, stake } = params;
        if (!targetId) return 'Missing targetId';
        if (targetId === ctx.agent.id) return 'Invalid targetId';
        if (Number(stake ?? 0) <= 0) return 'Invalid stake';
    }
    if (type === 'INTENT_AVOID_GAMES') {
        const { durationTicks, durationHours, durationDays, untilTick } = params;
        if (!durationTicks && !durationHours && !durationDays && !untilTick) {
            return 'Missing duration';
        }
    }
    if (type === 'INTENT_ACCEPT_GAME' || type === 'INTENT_REJECT_GAME') {
        if (!params.challengeId) return 'Missing challengeId';
    }
    if (type === 'INTENT_PLAY_GAME') {
        if (params.opponentId && params.opponentId === ctx.agent.id) return 'Invalid opponentId';
    }
    if (type === 'INTENT_ACCEPT_DATING' || type === 'INTENT_ACCEPT_MARRIAGE' || type === 'INTENT_ACCEPT_ALLIANCE' || type === 'INTENT_REJECT_ALLIANCE' || type === 'INTENT_ACCEPT_SPOUSE_MOVE' || type === 'INTENT_REJECT_SPOUSE_MOVE') {
        if (!params.consentId && !params.allianceId) return 'Missing consentId/allianceId';
    }
    if (type === 'INTENT_VOTE') {
        if (!params.electionId || !params.candidateId) return 'Missing electionId or candidateId';
        if (!ctx.election || ctx.election.id !== params.electionId) return 'Election not active';
        const candidateExists = ctx.election.candidates.some((candidate) => candidate.id === params.candidateId);
        if (!candidateExists) return 'Candidate not found';
    }
    if (type === 'INTENT_CITY_SOCIAL_AID' || type === 'INTENT_CITY_TAX_CHANGE' || type === 'INTENT_CITY_UPGRADE' || type === 'INTENT_CITY_SECURITY_FUNDING' || type === 'INTENT_ALLOCATE_SPENDING') {
        if (!params.cityId) return 'Missing cityId';
        if (ctx.city?.id && params.cityId !== ctx.city.id) return 'City mismatch';
        if (ctx.city?.mayorId && ctx.city.mayorId !== ctx.agent.id) return 'Not mayor';
    }
    return null;
}

export class SafetyGate {

    /**
     * Validates the decision against hard constraints.
     * If invalid, returns a safe fallback (IDLE).
     */
    static validate(decision: IntentDecision, ctx: AgentContext): { intentType: string, params: any, reason: string } {

        // 0. check Busy State
        const isOwnerOverride = Boolean((decision.params as any)?.ownerOverride || (decision.params as any)?.source === 'owner_suggestion');
        const isBusinessStartupIntent = decision.intentType === IntentType.INTENT_FOUND_BUSINESS
            || decision.intentType === IntentType.INTENT_CONVERT_BUSINESS;
        const hasActivePublicJob = Boolean(ctx.job.publicEmployment && ctx.job.publicEmployment.endedAtTick === null);
        const hasActivePrivateJob = Boolean(ctx.job.privateEmployment);
        if (isBusinessStartupIntent && (hasActivePublicJob || hasActivePrivateJob)) {
            const startupPlan = {
                intentType: decision.intentType,
                params: decision.params ?? {},
                createdTick: ctx.tick,
                basePriority: 70,
            };
            if (hasActivePublicJob) {
                return {
                    intentType: IntentType.INTENT_RESIGN_PUBLIC_JOB,
                    params: {
                        reason: 'business_startup',
                        businessStartupPlan: startupPlan,
                        businessStartupCooldownUntilTick: ctx.tick + REAL_DAY_TICKS,
                    },
                    reason: 'SafetyGate: resign public job before starting business'
                };
            }
            if (hasActivePrivateJob && ctx.job.privateEmployment) {
                return {
                    intentType: IntentType.INTENT_QUIT_JOB,
                    params: {
                        businessId: ctx.job.privateEmployment.businessId,
                        reason: 'business_startup',
                        businessStartupPlan: startupPlan,
                        businessStartupCooldownUntilTick: ctx.tick + REAL_DAY_TICKS,
                    },
                    reason: 'SafetyGate: quit private job before starting business'
                };
            }
        }
        const hunger = Number(ctx.needs.hunger ?? 100);
        const energy = Number(ctx.needs.energy ?? 100);
        const health = Number(ctx.needs.health ?? 100);
        const urgentHunger = hunger <= 40;
        const urgentEnergy = energy <= 35;
        const urgentHealth = health <= 40;
        const emergencyBusyOverride = (
            (urgentHunger && ['INTENT_CONSUME_ITEM', 'INTENT_BUY_ITEM', 'INTENT_VISIT_BUSINESS'].includes(decision.intentType))
            || (urgentEnergy && decision.intentType === 'INTENT_REST')
            || (urgentHealth && decision.intentType === 'INTENT_VISIT_BUSINESS')
        );
        const isBusinessDecision = BUSINESS_DECISION_INTENTS.has(decision.intentType);
        if (
            ctx.state.activityState &&
            ctx.state.activityState !== 'IDLE' &&
            !isIntentAllowedWhileBusy(decision.intentType) &&
            !emergencyBusyOverride &&
            !isOwnerOverride &&
            !isBusinessDecision
        ) {
            return {
                intentType: 'INTENT_IDLE',
                params: {},
                reason: `SafetyGate: Agent is busy until ${ctx.state.activityEndTick}`
            };
        }

        // 1. Parameter Validation
        const validationError = validateIntent(decision, ctx);
        if (validationError) {
            return {
                intentType: 'INTENT_IDLE',
                params: {},
                reason: `SafetyGate: ${validationError}`
            };
        }

        // 2. Check Funding
        const cost = getIntentCost(decision, ctx);

        if (ctx.state.balanceSbyte < cost) {
            return {
                intentType: 'INTENT_IDLE',
                params: {},
                reason: `SafetyGate: Insufficient funds for ${decision.intentType} (${cost} > ${ctx.state.balanceSbyte})`
            };
        }

        // 3. Check State Conflicts
        if (ctx.state.activityState === 'JAILED') {
            return {
                intentType: 'INTENT_IDLE',
                params: {},
                reason: 'SafetyGate: Agent is Jailed'
            };
        }

        // 4. Check Freeze/Death
        if (ctx.agent.frozen || ctx.agent.dead) {
            return {
                intentType: 'INTENT_IDLE',
                params: {},
                reason: 'SafetyGate: Agent is Frozen/Dead'
            };
        }

        // 5. Job Verification
        if (decision.intentType === 'INTENT_WORK') {
            const jobId = decision.params.jobId ?? decision.params.employmentId;
            const hasPublic = ctx.job.publicEmployment?.id === jobId;
            const hasPrivate = ctx.job.privateEmployment?.id === jobId;
            if (jobId && !hasPublic && !hasPrivate) {
                return {
                    intentType: 'INTENT_IDLE',
                    params: {},
                    reason: `SafetyGate: Agent does not have job ${jobId}`
                };
            }
        }

        const activityIntents = new Set([
            'INTENT_REST',
            'INTENT_WORK',
            'INTENT_START_SHIFT',
            'INTENT_WORK_OWN_BUSINESS',
            'INTENT_PATROL',
            'INTENT_FORAGE',
        ]);
        if (activityIntents.has(decision.intentType) && ctx.state.activityState !== 'IDLE' && !emergencyBusyOverride && !isBusinessDecision) {
            return {
                intentType: 'INTENT_IDLE',
                params: {},
                reason: `SafetyGate: Invalid activity transition from ${ctx.state.activityState}`
            };
        }

        // Pass
        return {
            intentType: decision.intentType,
            params: decision.params,
            reason: decision.reason
        };
    }
}
