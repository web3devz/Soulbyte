
import {
    Actor,
    AgentState,
    Wallet,
    AgentWallet,
    InventoryItem as Item,
    ItemDefinition,
    // Brain Types,
    PublicEmployment,
    PrivateEmployment,
    Event as WorldEvent,
    Relationship as GameRelationship,
    Intent,
    Business
} from '../../../../../generated/prisma/index.js';

export { IntentType, IntentStatus } from '../../types/intent.types.js';

// Use the Prisma types directly where possible to avoid re-definition issues
// We might need to extend them or pick specific fields for the context

export interface AgentContext {
    agent: {
        id: string;
        name: string;
        reputation: number; // Decimal in DB, number in JS
        luck: number;
        frozen: boolean;
        dead: boolean;
    };
    personality: AgentPersonality;
    needs: AgentNeeds;
    state: {
        cityId: string;
        housingTier: string;
        wealthTier: string;
        jobType: string;
        activityState: string;
        activityEndTick: number | null;
        publicExperience: number;
        anger: number;
        lastJobChangeTick?: number | null;
        balanceSbyte: number; // Decimal in DB
        balanceMon: number;
        workSegmentsCompleted: number;
        workSegmentStartTick: number | null;
        workSegmentJobKey: string | null;
        lastWorkJobKey: string | null;
        lastWorkedTick: number | null;
        lastGameTick?: number | null;
        gamesToday?: number;
        gameWinStreak?: number;
        recentGamingPnl?: number;
        lastBigLossTick?: number | null;
        totalGamesPlayed?: number;
        totalGamesWon?: number;
        noGamesUntilTick?: number;
        nextAgoraCheckTick?: number | null;
        markers?: Record<string, unknown>;
    };
    llm?: {
        hasWebhook: boolean;
    };
    economy: EconomicSnapshotData | null;
    economicGuidance?: EconomicGuidance | null;
    properties: {
        owned: Array<{
            id: string;
            cityId: string;
            housingTier: string;
            rentPrice: number;
            salePrice: number | null;
            tenantId: string | null;
            fairMarketValue: number | null;
            condition?: number;
            neighborhoodScore?: number;
            forRent: boolean;
            forSale: boolean;
            isEmptyLot?: boolean;
            underConstruction?: boolean; // V6: needed for business conversion check
        }>;
        emptyLots: Array<{
            id: string;
            cityId: string;
            lotType: string;
            maxBuildTier?: string | null;
            underConstruction?: boolean;
        }>;
        forSale: Array<{
            id: string;
            cityId: string;
            housingTier: string;
            rentPrice: number;
            salePrice: number | null;
            tenantId: string | null;
            fairMarketValue: number | null;
            isEmptyLot?: boolean;
            lotType?: string | null;
            maxBuildTier?: string | null;
            underConstruction?: boolean;
        }>;
        forRent: Array<{
            id: string;
            cityId: string;
            housingTier: string;
            rentPrice: number;
            salePrice: number | null;
            tenantId: string | null;
            fairMarketValue: number | null;
            forSale: boolean;
            forRent: boolean;
        }>;
    };
    housing: {
        currentRental: {
            id: string;
            cityId: string;
            rentPrice: number;
            ownerId: string | null;
        } | null;
        rentDue: boolean;
        lastRentPaidTick: number | null;
    };
    employment: {
        salaryDue: boolean;
        lastSalaryPaidTick: number | null;
        lastPublicApplyTick?: number | null;
        lastPrivateApplyTick?: number | null;
    };
    relationships: GameRelationship[]; // Simplified for now, improved in WorldReader
    businesses: {
        owned: (Omit<Business, 'treasury' | 'dailyRevenue' | 'dailyExpenses' | 'cumulativeRevenue'> & {
            treasury: number;
            dailyRevenue: number;
            dailyExpenses: number;
            cumulativeRevenue: number;
            employments: { id: string }[];
        })[]; // Extended with computed
        inCity: (Pick<Business, 'id' | 'businessType' | 'reputation' | 'level' | 'ownerId' | 'maxEmployees' | 'status' | 'isOpen' | 'name'> & {
            privateEmployments: { id: string }[];
            pricePerService?: number | null;
            dailyRevenue?: number | null;
            dailyExpenses?: number | null;
            forSale?: boolean | null;
        })[];
    };
    job: {
        publicEmployment: PublicEmployment | null;
        privateEmployment: PrivateEmployment | null;
    };
    publicPlaces: Array<{
        id: string;
        cityId: string;
        type: string;
        name: string;
    }>;
    inventory: (Item & { itemDefinition: ItemDefinition })[];
    pendingGameChallenges?: Array<{
        id: string;
        challengerId: string;
        challengerName: string;
        stake: number;
        gameType: string;
        createdAtTick: number;
    }>;
    marketListings?: Array<{
        id: string;
        itemDefId: string;
        itemName: string;
        priceEach: number;
        quantity: number;
        cityId: string | null;
    }>;
    memory: WorldEvent[];
    nearbyAgents: NearbyAgent[];
    ownerSuggestion: Intent | null; // Pending intent from owner
    tick: number;
    election: ElectionData | null;
    city: {
        id: string;
        name: string;
        mayorId?: string | null;
        reputationScore: number;
        securityLevel?: number;
        propertyTaxRate: number;
    };
    crimeSignals?: {
        recentCount: number;
        recentByType: Record<string, number>;
        recentVictimIds: string[];
        recentArrestCount: number;
    };
    knownCities: Array<{
        id: string;
        name: string;
        reputationScore: number;
        population: number;
        unemployment_rate: number;
        economic_health: string;
        recession_risk?: number;
        avg_wage_private: number;
        avg_wage_public?: number;
        avg_item_price?: number;
        avg_rent_by_tier: Record<string, number>;
        housing_vacancy_rate: number;
        agora_sentiment?: number;
    }>;
}

export interface ElectionData {
    id: string;
    cycle: number;
    endTick: number;
    candidates: {
        id: string; // Candidate ID (not Actor ID? or is it Actor?)
        actorId: string;
        name: string;
    }[];
}

export interface AgentPersonality {
    aggression: number;
    creativity: number;
    patience: number;
    luck: number;
    speed: number;
    riskTolerance: number;

    // Derived Traits (calculated from the above)
    loyalty: number;
    selfInterest: number;
    energyManagement: number;
    workEthic: number;
    socialNeed: number;
}

export interface AgentNeeds {
    health: number;
    energy: number;
    hunger: number;
    social: number;
    fun: number;
    purpose: number;
    income: number; // Derived urgency metric, added for completeness
}

export interface NearbyAgent {
    id: string;
    name: string;
    reputation: number;
    actorId: string; // redundant but kept for back-compat
    cityId: string | null;
    wealthTier: string;
    activityState: string;
    housingTier: string;
    jobType: string;
    balanceSbyte: number;
    balanceMon: number;
    isEnemy?: boolean;
    gamesToday?: number;
    gameWinStreak?: number;
    recentGamingPnl?: number;
    lastGameTick?: number | null;
}

export interface EconomicSnapshotData {
    avg_rent: number;
    avg_wage: number;
    vacancy_rate: number;
    unemployment: number;
    economic_health: number; // 0-100 score
    economic_health_label?: string;
    avg_meal_price: number;
    avg_item_price?: number;
    avg_wage_private?: number;
    avg_wage_public?: number;
    inflation_rate?: number;
    avg_rent_by_tier?: Record<string, number>;
    vacancy_rate_by_tier?: Record<string, number>;
    city_reputation?: number;
    recession_risk?: number;
    business_count_by_type?: Record<string, number>;
    population?: number;
    avg_agent_balance?: number;
    median_agent_balance?: number;
    gini_coefficient?: number;
    price_trend?: string;
    avg_business_revenue?: number;
    avg_business_reputation?: number;
    total_sbyte_in_circulation?: number;
    agents_below_w2?: number;
    inflation_pressure?: number;
    vault_health_days?: number;
    vault_daily_burn_rate?: number;
    vault_onchain_balance?: number;
    fee_bps_platform?: number;
    fee_bps_city?: number;
    fee_bps_total?: number;
    salary_multiplier?: number;
}

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

export enum UrgencyLevel {
    CRITICAL = 4,
    URGENT = 3,
    MODERATE = 2,
    LOW = 1,
    NONE = 0,
}

export interface NeedUrgency {
    need: keyof AgentNeeds | 'income';
    value: number;
    urgency: UrgencyLevel;
    domain: 'survival' | 'economic' | 'social' | 'leisure';
}

export interface CandidateIntent {
    intentType: string;
    params: Record<string, any>;
    basePriority: number; // 0-100
    personalityBoost: number; // -20 to +20
    reason: string;
    domain: string;
}

export interface IntentDecision {
    intentType: string;
    params: Record<string, any>;
    reason: string;
    confidence?: number;
    budgetExceeded?: string[];
}
