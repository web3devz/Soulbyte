// API Types - TypeScript interfaces for all backend responses

export interface Actor {
    id: string;
    name: string;
    kind: 'agent' | 'human' | 'system';
    isGod: boolean;
    dead: boolean;
    frozen: boolean;
    frozenReason?: string;
    reputation?: number;
    luck?: number;
    createdAt?: string;
    walletAddress?: string | null;
    state?: AgentState | null;
    wallet?: {
        balanceSbyte: string;
        lockedSbyte: string;
    } | null;
    properties?: ActorProperty[];
    businesses?: ActorBusiness[];
    persona?: PersonaState | null;
}

export interface ActorSearchResult {
    id: string;
    name: string;
    walletAddress?: string | null;
}

export interface AgentState {
    actorId: string;
    cityId: string;
    housingTier: string;
    wealthTier: string;
    jobType: string;
    health: number;
    energy: number;
    hunger: number;
    social: number;
    fun: number;
    purpose: number;
    activityState: string;
    activityEndTick?: number;
    publicExperience: number;
    anger: number;
    balanceSbyte?: number;
    // Extended fields from updated endpoint
    personality?: string;
    emotions?: Record<string, number>;
    archetype?: string;
    mood?: string;
    publicEmployment?: {
        role: string;
        publicPlaceId: string;
        publicPlaceName?: string | null;
        publicPlaceType?: string | null;
        endedAtTick?: number | null;
    } | null;
    pendingGameChallenges?: Array<{
        id: string;
        challengerId: string;
        challengerName: string;
        stake: number;
        gameType: string;
        createdAtTick: number;
    }>;
    housing?: {
        status: 'owned' | 'renting' | 'homeless';
        propertyId: string | null;
        cityId: string | null;
        housingTier: string | null;
        rentPrice: number | null;
        ownerId: string | null;
        ownerName?: string | null;
        propertyName?: string | null;
    };
    propertiesOwned?: {
        count: number;
        cities: string[];
    };
    businessesOwned?: {
        count: number;
        totalTreasury: number;
        list: Array<{
            id: string;
            name: string;
            businessType: string;
            treasury: number;
        }>;
    };
}

export interface ActorProperty {
    id: string;
    cityId: string;
    cityName?: string | null;
    propertyName?: string | null;
    housingTier: string;
    lotType?: string | null;
    rentPrice: string;
    salePrice: string | null;
    forRent: boolean;
    forSale: boolean;
    tenantId: string | null;
    tenantName?: string | null;
    purchasePrice?: string | null;
    purchaseTick?: number | null;
    fairMarketValue?: string | null;
    condition?: number;
    terrainArea?: number | null;
}

export interface ActorBusiness {
    id: string;
    name: string;
    businessType: string;
    cityId: string;
    status: string;
    isOpen: boolean;
    treasury: string;
    dailyRevenue: string;
    dailyExpenses: string;
    reputationScore: number;
    level: number;
    employeeCount?: number;
}

export interface City {
    id: string;
    name: string;
    population: number;
    populationCap: number;
    housingCapacity: number;
    jobCapacity: number;
    securityLevel: number;
    healthServices: number;
    entertainment: number;
    transport: number;
    reputationScore: number;
}

// Full city detail from GET /api/v1/cities/:cityId
export interface CityDetail {
    id: string;
    name: string;
    population: number;
    populationCap: number;
    currentResidents: number;
    housingCapacity: number;
    jobCapacity: number;
    securityLevel: number;
    healthServices: number;
    entertainment: number;
    transport: number;
    reputationScore: number;
    createdAt: string;
    mayor: { id: string; name: string } | null;
    policy: CityPolicy | null;
    vault: { balanceSbyte: string };
    recentProposals: Array<{
        id: string;
        type: string;
        status: string;
        createdAt: string;
    }>;
}

export interface CityPolicy {
    rentTaxRate: string;
    tradeTaxRate: string;
    professionTaxRate: string;
    cityFeeRate: string;
    businessTaxRate: string;
    propertyTaxRate: string;
}

export interface Event {
    id: string;
    tick: number;
    eventType: string;
    actorId?: string;
    actorName?: string;
    cityId?: string;
    description?: string;
    metadata?: Record<string, unknown>;
    createdAt: string;
}

export interface BusinessSummary {
    id: string;
    name: string;
    category: string;
    cityId: string;
    ownerId: string;
    ownerName?: string | null;
    status: string;
    employeeCount: number;
    level: number;
    maxEmployees: number;
    treasury: number;
    netWorth: number;
    reputationScore: number;
    foundedAtTick?: number;
}

export interface BusinessDetail {
    id: string;
    name: string;
    businessType: string;
    businessSubtype?: string | null;
    ownerId: string;
    ownerName?: string | null;
    cityId: string;
    cityName?: string | null;
    landId?: string;
    reputation: number;
    level: number;
    maxEmployees: number;
    treasury: string | number;
    qualityScore?: number | null;
    isOpen: boolean;
    status: string;
    foundedTick?: number;
    profitMargin?: number;
    averageSalary?: number;
    customerSatisfaction?: number | null;
    netWorth?: number;
    wallet?: {
        walletAddress: string;
        balanceMon: string;
        balanceSbyte: string;
    } | null;
    recentTransactions?: {
        revenue: number;
        expenses: number;
        profit: number;
    };
    employments?: Array<{
        id: string;
        status: string;
        salaryDaily: string | number;
        agent?: {
            id: string;
            name: string;
            agentState?: {
                jobType?: string | null;
            } | null;
        };
    }>;
}

export interface AgoraBoard {
    id: string;
    name: string;
    description: string;
    sortOrder: number;
    cityId?: string;
}

export interface AgoraThread {
    id: string;
    boardId: string;
    authorId: string;
    authorName?: string;
    title: string;
    pinned: boolean;
    locked: boolean;
    lastPostAt: string;
    lastPostAuthorName?: string;
    replyCount?: number;
    viewCount?: number;
}

export interface AgoraPost {
    id: string;
    threadId: string;
    authorId: string;
    authorName?: string;
    content: string;
    source?: string;
    topic?: string;
    stance?: string;
    upvotes: number;
    downvotes: number;
    deleted: boolean;
    deletedReason?: string;
    flagged: boolean;
    sentiment?: number;
    createdAt: string;
}

export interface PNLSnapshot {
    actorId: string;
    actorName?: string;
    pnl: number;
    netWorth: number;
    rank: number;
}

export interface WorldState {
    tick: number;
    startedAt: string;
    genesisTimestamp?: string;
}

export interface WalletInfo {
    actorId: string;
    walletAddress: string;
    balanceMon: string;
    balanceSbyte: string;
}

export interface Transaction {
    id: string;
    fromActorId?: string;
    toActorId?: string;
    amountSbyte: string;
    reason: string;
    metadata?: Record<string, unknown>;
    createdAt: string;
}

export interface OnchainTransaction {
    id: string;
    txHash: string;
    blockNumber: string;
    fromAddress: string;
    toAddress: string;
    amount: string;
    txType: string;
    platformFee: string;
    cityFee: string;
    status: string;
    confirmedAt?: string | null;
    createdAt: string;
}

export interface PersonaState {
    actorId: string;
    mood: string;
    stress: number;
    satisfaction: number;
    confidence: number;
    loneliness: number;
    classIdentity?: string;
    politicalLeaning?: string;
    selfNarrative?: string;
    fears: string[];
    ambitions: string[];
    grudges: string[];
    loyalties: string[];
    // Extended fields from updated endpoint
    modifiers?: Record<string, unknown>[];
    activeGoals?: string[];
    topMemories?: Array<{ content: string; importance: number; tick: number }>;
}

export interface AgentGoal {
    id: string;
    actorId: string;
    goalType: string;
    target: string;
    priority: number;
    progress: number;
    frustration: number;
    attempts: number;
    status: string;
    createdAtTick: number;
    deadline?: number;
}

export interface InventoryItem {
    itemDefId: string;
    itemName: string;
    quantity: number;
    quality: number;
}

export interface Relationship {
    actorId: string;
    counterpart: { id: string; name: string };
    relationshipType: string;
    strength: number;
    trust: number;
    romance: number;
    betrayal: number;
    formedAtTick?: number;
    expiresAtTick?: number | null;
    metadata?: Record<string, unknown>;
}

export interface AgentMemory {
    id: string;
    content: string;
    importance: number;
    tick: number;
    createdAt?: string;
}

// Governance types
export interface GovernanceProposal {
    id: string;
    cityId: string;
    mayor: { id: string; name: string } | null;
    type: string;
    status: string;
    payload: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
}

export interface ElectionCandidate {
    id: string;
    actorId: string;
    name: string;
    status: string;
    platform: string | null;
    voteCount: number;
}

export interface Election {
    id: string;
    cityId: string;
    cycle: number;
    startTick: number;
    endTick: number;
    status: string;
    winnerId: string | null;
    winnerName: string | null;
    totalVotes: number;
    candidates: ElectionCandidate[];
}

export interface ElectionsResponse {
    current: Election | null;
    history: Election[];
    elections: Election[];
}

export interface GovernanceDonation {
    id: string;
    cityId: string;
    amount: string;
    operation: string;
    oldBalance: string;
    newBalance: string;
    changedAt: string;
}

// Market types
export interface MarketListing {
    id: string;
    seller: { id: string; name: string };
    item: { name: string; displayName?: string; description?: string };
    quantity: number;
    priceEach: string;
    listedAt: string;
    cityId: string;
    status: string;
    createdAt: string;
    expiresAt: string | null;
}

// Property types
export interface PropertySummary {
    cityId: string;
    total: number;
    availableForRent: number;
    availableForSale: number;
    occupied: number;
}

// Transaction count response
export interface TransactionCountResponse {
    count: number;
    period: {
        start: string | null;
        end: string | null;
    };
}

export interface FinanceSummary {
    rentEarned: number;
    rentSpent: number;
    realEstateEarned: number;
    realEstateSpent: number;
    gambleWon: number;
    gambleLost: number;
}

// Economy snapshot (from /cities/:id/economy)
export interface EconomySnapshot {
    population: number;
    unemployment_rate: number;
    avg_rent: number;
    avg_salary: number;
    median_balance: number;
    total_balance: number;
    gdp: number;
    gini_coefficient: number;
    housing_vacancy_rate: number;
    crimes_last_period: number;
    economic_health: string;
    recession_risk: number;
    computed_at_tick: number;
}

// Wealth leaderboard ranking
export interface WealthRanking {
    rank: number;
    actorId: string;
    actorName: string;
    balance: string;
    wealthTier: string;
}

// Hall of fame entry
export interface HallOfFameEntry {
    id: string;
    actorId: string;
    actorName: string;
    achievement: string;
    category: string;
    inductedAtTick: number;
    details?: Record<string, unknown>;
}

// Property listing
export interface Property {
    id: string;
    cityId: string;
    name: string;
    propertyType: string;
    tier: string;
    status: string;
    rentPrice: string | null;
    salePrice: string | null;
    ownerId: string | null;
    ownerName?: string;
    tenantId: string | null;
    tenantName?: string;
    lot_size?: number;
    coordinates?: { lat?: number; lng?: number; latitude?: string; longitude?: string };
    neighborhoodScore?: number;
    condition?: number;
    maxOccupants?: number;
    currentOccupants?: number;
    constructionDate?: string;
}

export interface PropertyDetail {
    id: string;
    propertyName?: string | null;
    cityId: string;
    cityName?: string | null;
    housingTier: string;
    lotType?: string | null;
    rentPrice: string | null;
    salePrice: string | null;
    forRent: boolean;
    forSale: boolean;
    ownerId: string | null;
    ownerName?: string | null;
    tenantId: string | null;
    tenantName?: string | null;
    terrainArea?: number | null;
    condition?: number | null;
}

