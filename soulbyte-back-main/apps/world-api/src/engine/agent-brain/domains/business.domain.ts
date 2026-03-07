import { AgentContext, NeedUrgency, CandidateIntent, IntentType } from '../types.js';
import { PersonalityWeights } from '../personality-weights.js';
import { BusinessType } from '../../../../../../generated/prisma/index.js';
import { REAL_DAY_TICKS } from '../../../config/time.js';

const SIM_MONTH_TICKS = 30 * REAL_DAY_TICKS;
const CRITICAL_SBYTE_THRESHOLD = 10000;
const CRITICAL_MON_THRESHOLD = 1;
const DEFAULT_MON_TOPUP = 2;
const BUSINESS_STARTUP_COOLDOWN_TICKS = REAL_DAY_TICKS * 3; // V6: 3 sim-days between attempts

const BUSINESS_STARTUP_PLAN_TTL_TICKS = 3 * REAL_DAY_TICKS;

export class BusinessDomain {

    static getCandidates(ctx: AgentContext, urgencies: NeedUrgency[]): CandidateIntent[] {
        const candidates: CandidateIntent[] = [];

        const wealthTierRank = parseInt(ctx.state.wealthTier.replace('W', ''), 10) || 0;
        const vaultHealthDays = ctx.economy?.vault_health_days ?? null;
        const macroHiringFactor = vaultHealthDays !== null && vaultHealthDays < 60 ? 0.9 : 1.0;
        const startupPenalty = vaultHealthDays !== null && vaultHealthDays < 30 ? -8 : 0;
        const hasActivePublicJob = Boolean(ctx.job.publicEmployment && ctx.job.publicEmployment.endedAtTick === null);
        const hasActivePrivateJob = Boolean(ctx.job.privateEmployment);
        const hasActiveEmployment = hasActivePublicJob || hasActivePrivateJob;
        const markers = (ctx.state.markers ?? {}) as Record<string, any>;
        const startupPlan = markers.nextBusinessIntent as BusinessStartupPlan | undefined;
        const cooldownUntil = Number(markers.businessStartupCooldownUntilTick ?? 0);
        const inStartupCooldown = cooldownUntil > 0 && ctx.tick < cooldownUntil;

        const shouldResumeStartupPlan = !hasActiveEmployment
            && startupPlan
            && isStartupPlanFresh(startupPlan, ctx.tick)
            && isStartupPlanViable(startupPlan, ctx);

        if (shouldResumeStartupPlan) {
            const plannedPriority = Number(startupPlan.basePriority ?? 60);
            candidates.push({
                intentType: startupPlan.intentType,
                params: startupPlan.params,
                basePriority: Math.max(70, plannedPriority + 10),
                personalityBoost: PersonalityWeights.getBoost(ctx.personality.selfInterest, true),
                reason: 'Resuming business startup plan after leaving employment',
                domain: 'business',
            });
        }

        const pushBusinessOrResign = (candidate: CandidateIntent) => {
            if (!hasActiveEmployment) {
                // V6: Unemployed agents also need a cooldown to prevent founding a new business every tick.
                if (inStartupCooldown) return;
                candidates.push({
                    ...candidate,
                    params: {
                        ...candidate.params,
                        businessStartupCooldownUntilTick: ctx.tick + BUSINESS_STARTUP_COOLDOWN_TICKS,
                    }
                });
                return;
            }
            if (inStartupCooldown) return;
            const startupPlanPayload: BusinessStartupPlan = {
                intentType: candidate.intentType as IntentType,
                params: candidate.params ?? {},
                createdTick: ctx.tick,
                basePriority: candidate.basePriority,
            };
            if (hasActivePublicJob) {
                candidates.push({
                    intentType: IntentType.INTENT_RESIGN_PUBLIC_JOB,
                    params: {
                        reason: 'business_startup',
                        businessStartupPlan: startupPlanPayload,
                        businessStartupCooldownUntilTick: ctx.tick + BUSINESS_STARTUP_COOLDOWN_TICKS,
                    },
                    basePriority: Math.min(95, candidate.basePriority + 10),
                    personalityBoost: candidate.personalityBoost,
                    reason: `Resigning public job to start business: ${candidate.reason}`,
                    domain: 'business',
                });
            } else if (hasActivePrivateJob && ctx.job.privateEmployment) {
                candidates.push({
                    intentType: IntentType.INTENT_QUIT_JOB,
                    params: {
                        businessId: ctx.job.privateEmployment.businessId,
                        reason: 'business_startup',
                        businessStartupPlan: startupPlanPayload,
                        businessStartupCooldownUntilTick: ctx.tick + BUSINESS_STARTUP_COOLDOWN_TICKS,
                    },
                    basePriority: Math.min(95, candidate.basePriority + 10),
                    personalityBoost: candidate.personalityBoost,
                    reason: `Quitting private job to start business: ${candidate.reason}`,
                    domain: 'business',
                });
            }
        };

        // === V6: Multi-business suppression ===
        // Agents with many businesses have lower tendency to open new ones.
        // Only very ambitious + wealthy agents will seek a 3rd+ business autonomously.
        const ownedCount = ctx.businesses.owned.length;
        const multiBusinessSuppression =
            ownedCount >= 3 ? 0.0   // 3+ businesses: won't open more autonomously
                : ownedCount === 2 ? 0.3  // 2 businesses: 70% penalty
                    : ownedCount === 1 ? 0.7  // 1 business: 30% penalty to encourage growth stability
                        : 1.0;                    // 0 businesses: full motivation
        // Exception: very ambitious wealthy agents may still pursue an empire
        const isAmbitious = ctx.personality.selfInterest > 75 && ctx.state.balanceSbyte >= 50_000;
        const effectiveSuppression = isAmbitious ? Math.max(0.4, multiBusinessSuppression) : multiBusinessSuppression;
        // Skip entirely if suppression = 0 (and not ambitious)
        const canOpenNewBusiness = effectiveSuppression > 0 && !inStartupCooldown;

        // 1. FOUND BUSINESS (market gap + personality fit)
        if (canOpenNewBusiness && ctx.properties.emptyLots.length > 0) {
            const lot = ctx.properties.emptyLots.find((p) => p.cityId === ctx.state.cityId);
            if (lot) {
                const preferredType = chooseBusinessType(ctx, wealthTierRank);
                if (preferredType) {
                    const config = BUSINESS_CONFIG[preferredType];
                    const minCapital = BUSINESS_MIN_CAPITAL[preferredType] ?? 0;
                    const affordable = ctx.state.balanceSbyte >= (config.buildCost + minCapital);
                    const marketGap = ctx.economicGuidance?.marketGapByType?.[preferredType] ?? 0;
                    const typeCount = ctx.economy?.business_count_by_type?.[preferredType] ?? 0;
                    const isFirstType = typeCount === 0;
                    // Wealth override: agents with 5M+ SBYTE skip market gap requirements
                    const isVeryWealthy = ctx.state.balanceSbyte >= 5_000_000;
                    const motivated = isVeryWealthy || ctx.personality.selfInterest >= 30 || marketGap >= 0.15;
                    const crowdedMarket = !isVeryWealthy && marketGap <= -0.25;
                    const wealthPriorityBoost = isVeryWealthy ? 1.5 : 1.0;
                    if (affordable && motivated && (!crowdedMarket || isFirstType)) {
                        pushBusinessOrResign({
                            intentType: IntentType.INTENT_FOUND_BUSINESS,
                            params: {
                                businessType: preferredType,
                                cityId: ctx.state.cityId,
                                landId: lot.id,
                                proposedName: buildBusinessName(ctx.agent.name, preferredType),
                            },
                            // V6: effectiveSuppression multiplier applied to priority
                            basePriority: Math.round((35 + Math.round(marketGap * 20)) * wealthPriorityBoost * effectiveSuppression) + startupPenalty,
                            personalityBoost: PersonalityWeights.getBoost(ctx.personality.selfInterest, true),
                            reason: isVeryWealthy
                                ? `Wealthy entrepreneur founding a ${preferredType.toLowerCase()}`
                                : `Founding a ${preferredType.toLowerCase()} to capitalize on market gap`,
                            domain: 'business',
                        });
                    }
                }
            }
        }

        // 1b. CONVERT OWNED HOUSE INTO BUSINESS
        if (canOpenNewBusiness) {
            const ownedHouse = ctx.properties.owned.find((p) =>
                p.cityId === ctx.state.cityId
                && !p.isEmptyLot
                && !p.underConstruction
                && (!p.tenantId || p.tenantId === ctx.agent.id)
            );
            if (ownedHouse) {
                const preferredType = chooseBusinessType(ctx, wealthTierRank);
                if (preferredType) {
                    const config = BUSINESS_CONFIG[preferredType];
                    const minCapital = BUSINESS_MIN_CAPITAL[preferredType] ?? 0;
                    const affordable = ctx.state.balanceSbyte >= (config.buildCost + minCapital);
                    const marketGap = ctx.economicGuidance?.marketGapByType?.[preferredType] ?? 0;
                    const typeCount = ctx.economy?.business_count_by_type?.[preferredType] ?? 0;
                    const isFirstType = typeCount === 0;
                    const motivated = ctx.personality.selfInterest >= 30 || marketGap >= 0.15;
                    const crowdedMarket = marketGap <= -0.25;
                    if (affordable && motivated && (!crowdedMarket || isFirstType)) {
                        pushBusinessOrResign({
                            intentType: IntentType.INTENT_CONVERT_BUSINESS,
                            params: {
                                businessType: preferredType,
                                cityId: ctx.state.cityId,
                                landId: ownedHouse.id,
                                proposedName: buildBusinessName(ctx.agent.name, preferredType),
                            },
                            // V6: effectiveSuppression multiplier applied
                            basePriority: Math.round((33 + Math.round(marketGap * 20)) * effectiveSuppression) + startupPenalty,
                            personalityBoost: PersonalityWeights.getBoost(ctx.personality.selfInterest, true),
                            reason: `Converting property into ${preferredType.toLowerCase()}`,
                            domain: 'business',
                        });
                    }
                }
            }
        }

        // 1c. BUY HOUSE FOR CONVERSION
        if (canOpenNewBusiness && ctx.properties.emptyLots.length === 0) {
            const houseForSale = ctx.properties.forSale.find((p) =>
                !p.isEmptyLot
                && !p.underConstruction
                && p.salePrice
                && p.salePrice <= ctx.state.balanceSbyte * 0.5
                && p.cityId === ctx.state.cityId
                && (!p.tenantId || p.tenantId === ctx.agent.id)
            );
            if (houseForSale) {
                const preferredType = chooseBusinessType(ctx, wealthTierRank);
                if (preferredType) {
                    pushBusinessOrResign({
                        intentType: IntentType.INTENT_CONVERT_BUSINESS,
                        params: {
                            businessType: preferredType,
                            cityId: ctx.state.cityId,
                            landId: houseForSale.id,
                            proposedName: buildBusinessName(ctx.agent.name, preferredType),
                        },
                        basePriority: 28 + startupPenalty,
                        personalityBoost: PersonalityWeights.getBoost(ctx.personality.selfInterest, true),
                        reason: 'Acquiring property to convert into business',
                        domain: 'business',
                    });
                }
            }
        }

        if (canOpenNewBusiness && ctx.properties.emptyLots.length === 0) {
            const lot = ctx.properties.forSale.find((p) =>
                p.isEmptyLot
                && p.salePrice
                && p.salePrice <= ctx.state.balanceSbyte * 0.5
                && p.cityId === ctx.state.cityId
            );
            if (lot) {
                pushBusinessOrResign({
                    intentType: IntentType.INTENT_BUY_PROPERTY,
                    params: { propertyId: lot.id, maxPrice: lot.salePrice },
                    basePriority: 30,
                    personalityBoost: PersonalityWeights.getBoost(ctx.personality.selfInterest, true),
                    reason: 'Acquiring land for future business',
                    domain: 'business',
                });
            }
        }

        // 1d. WEALTH GROWTH: Buy an existing business (V6 — wealth ambition)
        // Agents with W4+ wealth consider acquiring profitable businesses they don't own
        if (canOpenNewBusiness && wealthTierRank >= 4 && ctx.state.balanceSbyte >= 20_000) {
            const acquirableBusinesses = ctx.businesses.inCity.filter((b) =>
                b.ownerId !== ctx.agent.id
                && b.status === 'ACTIVE'
                && (b.dailyRevenue ?? 0) > (b.dailyExpenses ?? 0)
                && (b.forSale || (b.dailyRevenue ?? 0) > 500)
            );
            if (acquirableBusinesses.length > 0) {
                const target = acquirableBusinesses.sort((a, b) =>
                    (b.dailyRevenue ?? 0) - (a.dailyRevenue ?? 0)
                )[0];
                if (target.forSale) {
                    candidates.push({
                        intentType: IntentType.INTENT_BUY_BUSINESS,
                        params: { businessId: target.id },
                        // V6: suppression always applies — empire building still capped
                        basePriority: Math.round(40 * effectiveSuppression),
                        personalityBoost: PersonalityWeights.getBoost(ctx.personality.selfInterest, true),
                        reason: `Wealth ambition: acquiring ${target.name} (revenue: ${Math.round(target.dailyRevenue ?? 0)}/day)`,
                        domain: 'business',
                    });
                }
            }
        }

        // 2. MANAGE BUSINESS
        for (const business of ctx.businesses.owned) {
            const dailyBurn = business.dailyExpenses || 0;
            const runwayDays = dailyBurn > 0 ? business.treasury / dailyBurn : 9999;
            const reserveTarget = Math.max(dailyBurn * 7, BUSINESS_MIN_CAPITAL[business.businessType] ?? 0);
            const recommendedPrice = ctx.economicGuidance?.recommendedPricesByType?.[business.businessType] ?? 25;
            const recommendedSalary = (ctx.economicGuidance?.recommendedSalary ?? 80) * macroHiringFactor;

            if (business.treasury < reserveTarget && ctx.state.balanceSbyte > 200) {
                const needed = reserveTarget - business.treasury;
                const amount = Math.min(needed, Math.max(200, ctx.state.balanceSbyte * 0.2));
                candidates.push({
                    intentType: IntentType.INTENT_BUSINESS_INJECT,
                    params: { businessId: business.id, amount: Math.round(amount) },
                    basePriority: 70 + (runwayDays < 3 ? 10 : 0),
                    personalityBoost: PersonalityWeights.getBoost(ctx.personality.workEthic, true),
                    reason: `Business runway low (${runwayDays.toFixed(1)} days), injecting funds`,
                    domain: 'business',
                });
            }
            if (runwayDays < 2 && ctx.state.balanceSbyte < 200) {
                candidates.push({
                    intentType: IntentType.INTENT_CLOSE_BUSINESS,
                    params: { businessId: business.id, reason: 'low_runway' },
                    basePriority: 85,
                    personalityBoost: PersonalityWeights.getBoost(ctx.personality.selfInterest, true),
                    reason: `Business runway critical (${runwayDays.toFixed(1)} days), considering closure`,
                    domain: 'business',
                });
            }
            if (runwayDays > 20 && business.dailyRevenue > business.dailyExpenses && business.treasury > reserveTarget * 2) {
                const withdrawAmount = Math.min(200, business.treasury - reserveTarget * 1.5);
                candidates.push({
                    intentType: IntentType.INTENT_BUSINESS_WITHDRAW,
                    params: { businessId: business.id, amount: Math.max(50, Math.round(withdrawAmount)) },
                    basePriority: 45,
                    personalityBoost: PersonalityWeights.getBoost(ctx.personality.selfInterest, true),
                    reason: `Business profitable with long runway, withdrawing profits`,
                    domain: 'business',
                });
            }

            // Work at own business if not automated/understaffed
            const maxEmployees = (business as any).maxEmployees || 3;
            const requiredEmployees = Math.min(maxEmployees, Math.max(1, Math.ceil(business.level / 2)));
            const currentEmployees = business.employments ? business.employments.length : 0;
            const ownerWorkedRecently = business.ownerLastWorkedTick !== null
                && ctx.tick - Number(business.ownerLastWorkedTick) < REAL_DAY_TICKS;
            if (currentEmployees < requiredEmployees && !ownerWorkedRecently) {
                candidates.push({
                    intentType: IntentType.INTENT_WORK_OWN_BUSINESS,
                    params: { businessId: business.id },
                    basePriority: 65,
                    personalityBoost: PersonalityWeights.getBoost(ctx.personality.workEthic, true),
                    reason: `Staffing gap at ${business.name}; owner stepping in`,
                    domain: 'business',
                });
            }

            // === CRITICAL: SBYTE < 10K threshold (Priority 90, overrides busy) ===
            if (business.treasury < CRITICAL_SBYTE_THRESHOLD) {
                const shortfall = CRITICAL_SBYTE_THRESHOLD - business.treasury;
                if (ctx.state.balanceSbyte >= shortfall * 0.5) {
                    const injectAmount = Math.min(shortfall, ctx.state.balanceSbyte * 0.4);
                    candidates.push({
                        intentType: IntentType.INTENT_BUSINESS_INJECT,
                        params: { businessId: business.id, amount: Math.round(injectAmount) },
                        basePriority: 90,
                        personalityBoost: 0,
                        reason: `CRITICAL: Business treasury below ${CRITICAL_SBYTE_THRESHOLD} SBYTE (${Math.round(business.treasury)})`,
                        domain: 'business',
                    });
                } else {
                    // Owner can't afford to inject -> consider closing
                    candidates.push({
                        intentType: IntentType.INTENT_CLOSE_BUSINESS,
                        params: { businessId: business.id, reason: 'critical_low_sbyte' },
                        basePriority: 88,
                        personalityBoost: 0,
                        reason: `CRITICAL: Cannot fund business (treasury: ${Math.round(business.treasury)}, owner: ${Math.round(ctx.state.balanceSbyte)})`,
                        domain: 'business',
                    });
                }
            }

            // === CRITICAL: MON < 1 threshold (Priority 88, overrides busy) ===
            const businessMon = (business as any).walletBalanceMon ?? 999;
            if (businessMon < CRITICAL_MON_THRESHOLD && ctx.state.balanceSbyte >= 1000) {
                candidates.push({
                    intentType: IntentType.INTENT_TRANSFER_MON_TO_BUSINESS,
                    params: { businessId: business.id, amount: DEFAULT_MON_TOPUP },
                    basePriority: 88,
                    personalityBoost: 0,
                    reason: `Business wallet MON critically low (${businessMon.toFixed(2)} MON), topping up ${DEFAULT_MON_TOPUP} MON`,
                    domain: 'business',
                });
            }

            // === Monthly profit withdrawal (max 50% of positive delta) ===
            const config = (business as any).config ?? {};
            const lastProfitTakeTick = config.finance?.lastProfitTakeTick ?? 0;
            const lastMonthTreasury = config.finance?.lastMonthTreasury ?? business.treasury;
            const monthElapsed = ctx.tick - lastProfitTakeTick >= SIM_MONTH_TICKS;
            const profitDelta = business.treasury - lastMonthTreasury;
            if (monthElapsed && profitDelta > 0 && business.treasury > reserveTarget * 1.5) {
                const maxProfit = profitDelta * 0.5; // Max 50% of monthly profit
                const safeWithdraw = Math.min(maxProfit, business.treasury - reserveTarget * 1.2);
                if (safeWithdraw > 50) {
                    candidates.push({
                        intentType: IntentType.INTENT_BUSINESS_WITHDRAW,
                        params: {
                            businessId: business.id,
                            amount: Math.round(safeWithdraw),
                            reason: 'monthly_profit_take',
                        },
                        basePriority: 50,
                        personalityBoost: PersonalityWeights.getBoost(ctx.personality.selfInterest, true),
                        reason: `Monthly profit take: ${Math.round(safeWithdraw)} SBYTE (50% of ${Math.round(profitDelta)} profit)`,
                        domain: 'business',
                    });
                }
            }

            // 3. SET PRICES (Dynamic)
            if (business.dailyRevenue < business.dailyExpenses * 1.05) {
                const isCasino = business.businessType === BusinessType.CASINO;
                const adjustedPrice = Math.round(recommendedPrice * 1.1);
                candidates.push({
                    intentType: IntentType.INTENT_SET_PRICES,
                    params: isCasino
                        ? { businessId: business.id, minBet: 100, maxBet: 300 }
                        : { businessId: business.id, pricePerService: Math.max(5, adjustedPrice) },
                    basePriority: 60,
                    personalityBoost: 0,
                    reason: `Raising prices to improve margins for ${business.name}`,
                    domain: 'business',
                });
            } else if (business.dailyRevenue > business.dailyExpenses * 1.25 && (ctx.economicGuidance?.marketGapByType?.[business.businessType] ?? 0) < -0.2) {
                const isCasino = business.businessType === BusinessType.CASINO;
                const adjustedPrice = Math.round(recommendedPrice * 0.95);
                candidates.push({
                    intentType: IntentType.INTENT_SET_PRICES,
                    params: isCasino
                        ? { businessId: business.id, minBet: 100, maxBet: 300 }
                        : { businessId: business.id, pricePerService: Math.max(3, adjustedPrice) },
                    basePriority: 45,
                    personalityBoost: 0,
                    reason: `Lowering prices to stay competitive for ${business.name}`,
                    domain: 'business',
                });
            }

            // 4. HIRE EMPLOYEE
            if (currentEmployees < maxEmployees && business.treasury > recommendedSalary * 2) {
                const candidate = ctx.nearbyAgents.find(agent => !agent.isEnemy);
                if (candidate) {
                    candidates.push({
                        intentType: IntentType.INTENT_HIRE_EMPLOYEE,
                        params: { businessId: business.id, targetAgentId: candidate.id, offeredSalary: Math.max(50, Math.round(recommendedSalary)) },
                        basePriority: 38 + (vaultHealthDays !== null && vaultHealthDays < 60 ? -4 : 0),
                        personalityBoost: PersonalityWeights.getBoost(ctx.personality.selfInterest, true),
                        reason: `Hiring ${candidate.name} for ${business.name}`,
                        domain: 'business',
                    });
                }
            }
        }

        return candidates;
    }
}

type BusinessStartupPlan = {
    intentType: IntentType;
    params: Record<string, unknown>;
    createdTick: number;
    basePriority?: number;
};

function isStartupPlanFresh(plan: BusinessStartupPlan, tick: number): boolean {
    if (!plan || !Number.isFinite(plan.createdTick)) return false;
    return (plan.createdTick + BUSINESS_STARTUP_PLAN_TTL_TICKS) >= tick;
}

function isStartupPlanViable(plan: BusinessStartupPlan, ctx: AgentContext): boolean {
    if (!plan || !plan.intentType) return false;
    const params = plan.params ?? {};
    if (plan.intentType === IntentType.INTENT_FOUND_BUSINESS) {
        const businessType = params.businessType as BusinessType | undefined;
        const landId = params.landId as string | undefined;
        if (!businessType || !landId) return false;
        const lot = ctx.properties.emptyLots.find((p) => p.id === landId);
        if (!lot) return false;
        const config = BUSINESS_CONFIG[businessType];
        if (!config) return false;
        const minCapital = BUSINESS_MIN_CAPITAL[businessType] ?? 0;
        return ctx.state.balanceSbyte >= (config.buildCost + minCapital);
    }
    if (plan.intentType === IntentType.INTENT_CONVERT_BUSINESS) {
        const businessType = params.businessType as BusinessType | undefined;
        const landId = params.landId as string | undefined;
        if (!businessType || !landId) return false;
        const ownedHouse = ctx.properties.owned.find((p) => p.id === landId && !p.isEmptyLot && !p.underConstruction);
        if (!ownedHouse) return false;
        const config = BUSINESS_CONFIG[businessType];
        if (!config) return false;
        const minCapital = BUSINESS_MIN_CAPITAL[businessType] ?? 0;
        const required = (config.buildCost * 0.5) + minCapital;
        return ctx.state.balanceSbyte >= required;
    }
    return false;
}

const BUSINESS_CONFIG: Record<string, { minWealth: string; buildCost: number }> = {
    BANK: { minWealth: 'W5', buildCost: 15000 },
    CASINO: { minWealth: 'W5', buildCost: 20000 },
    STORE: { minWealth: 'W3', buildCost: 2000 },
    RESTAURANT: { minWealth: 'W3', buildCost: 3000 },
    TAVERN: { minWealth: 'W3', buildCost: 2500 },
    GYM: { minWealth: 'W4', buildCost: 5000 },
    CLINIC: { minWealth: 'W4', buildCost: 8000 },
    REALESTATE: { minWealth: 'W5', buildCost: 10000 },
    WORKSHOP: { minWealth: 'W3', buildCost: 3500 },
};

const BUSINESS_MIN_CAPITAL: Record<string, number> = {
    RESTAURANT: 5000,
    CASINO: 50000,
    CLINIC: 10000,
    BANK: 100000,
    STORE: 3000,
    TAVERN: 2000,
    GYM: 2000,
    REALESTATE: 5000,
    WORKSHOP: 3000,
};

const BUSINESS_PERSONALITY_FIT: Record<string, Array<keyof AgentContext['personality']>> = {
    BANK: ['selfInterest', 'patience'],
    CASINO: ['riskTolerance', 'selfInterest'],
    STORE: ['workEthic', 'patience'],
    RESTAURANT: ['socialNeed', 'creativity'],
    TAVERN: ['socialNeed', 'riskTolerance'],
    GYM: ['workEthic', 'energyManagement'],
    CLINIC: ['patience', 'workEthic'],
    REALESTATE: ['selfInterest', 'patience'],
    WORKSHOP: ['workEthic', 'creativity'],
};

function buildBusinessName(_agentName: string, type: BusinessType): string {
    const suffixMap: Record<string, string> = {
        BANK: 'Bank',
        CASINO: 'Casino',
        STORE: 'Store',
        RESTAURANT: 'Kitchen',
        TAVERN: 'Tavern',
        GYM: 'Gym',
        CLINIC: 'Clinic',
        REALESTATE: 'Realty',
        WORKSHOP: 'Workshop',
    };
    const adjectives = [
        'Bright',
        'Silver',
        'Golden',
        'Quiet',
        'Lucky',
        'Swift',
        'Grand',
        'Crimson',
        'Blue',
        'Emerald',
        'Iron',
        'Humble',
        'Noble',
        'Starlight',
        'Cedar',
        'Maple',
        'River',
        'Harbor',
        'Summit',
        'Amber',
    ];
    const nouns = [
        'Haven',
        'Corner',
        'Market',
        'House',
        'Guild',
        'Works',
        'Hall',
        'Gardens',
        'Lane',
        'Anchor',
        'Cove',
        'Foundry',
        'Circle',
        'Union',
        'Depot',
        'Crown',
        'Bridge',
        'Beacon',
        'Square',
        'Vista',
    ];
    const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    return `${adjective} ${noun} ${suffixMap[type] ?? 'Business'}`;
}

function meetsWealthRequirement(currentRank: number, requiredTier: string): boolean {
    const requiredRank = parseInt(requiredTier.replace('W', ''), 10) || 0;
    return currentRank >= requiredRank;
}

function chooseBusinessType(ctx: AgentContext, wealthTierRank: number): BusinessType | null {
    if (!ctx.economy) return null;
    const candidateTypes = Object.keys(BUSINESS_CONFIG) as BusinessType[];
    let best: { type: BusinessType; score: number } | null = null;

    for (const type of candidateTypes) {
        const config = BUSINESS_CONFIG[type];
        if (!meetsWealthRequirement(wealthTierRank, config.minWealth)) continue;
        const minCapital = BUSINESS_MIN_CAPITAL[type] ?? 0;
        if (ctx.state.balanceSbyte < (config.buildCost + minCapital)) continue;

        const gap = ctx.economicGuidance?.marketGapByType?.[type] ?? 0;
        const personalityTraits = BUSINESS_PERSONALITY_FIT[type] ?? [];
        const personalityScore = personalityTraits.reduce((sum, trait) => sum + ((ctx.personality[trait] ?? 50) - 50), 0) / 5;
        const marketScore = gap * 40;
        const riskAdjustment = type === BusinessType.CASINO || type === BusinessType.BANK
            ? (ctx.personality.riskTolerance - 50) / 5
            : 0;
        const score = 20 + marketScore + personalityScore + riskAdjustment;

        if (!best || score > best.score) {
            best = { type, score };
        }
    }

    return best?.type ?? null;
}
