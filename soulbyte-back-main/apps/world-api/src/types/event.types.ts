/**
 * Event Types - MVP Subset
 * Events emitted by the World Engine
 */

export enum EventType {
    // Work
    EVENT_WORK_COMPLETED = 'EVENT_WORK_COMPLETED',
    EVENT_JOB_SWITCHED = 'EVENT_JOB_SWITCHED',
    EVENT_ITEM_CRAFTED = 'EVENT_ITEM_CRAFTED',

    // Combat
    EVENT_COMBAT_RESULT = 'EVENT_COMBAT_RESULT',

    // Gaming
    EVENT_GAME_RESULT = 'EVENT_GAME_RESULT',
    EVENT_GAME_CHALLENGE = 'EVENT_GAME_CHALLENGE',
    EVENT_GAME_ACCEPTED = 'EVENT_GAME_ACCEPTED',
    EVENT_GAME_REJECTED = 'EVENT_GAME_REJECTED',

    // Movement
    EVENT_CITY_MOVED = 'EVENT_CITY_MOVED',

    // Life/Status
    EVENT_FROZEN = 'EVENT_FROZEN',
    EVENT_UNFROZEN = 'EVENT_UNFROZEN',
    EVENT_RESTED = 'EVENT_RESTED',

    // Social
    EVENT_SOCIALIZED = 'EVENT_SOCIALIZED',
    EVENT_FLIRTED = 'EVENT_FLIRTED',
    EVENT_ROMANTIC_INTERACTION = 'EVENT_ROMANTIC_INTERACTION',
    EVENT_RELATIONSHIP_CHANGED = 'EVENT_RELATIONSHIP_CHANGED',
    EVENT_ALLIANCE_PROPOSED = 'EVENT_ALLIANCE_PROPOSED',
    EVENT_ALLIANCE_RESOLVED = 'EVENT_ALLIANCE_RESOLVED', // accept/reject
    EVENT_DATING_PROPOSED = 'EVENT_DATING_PROPOSED',
    EVENT_DATING_RESOLVED = 'EVENT_DATING_RESOLVED',
    EVENT_DATING_ENDED = 'EVENT_DATING_ENDED',
    EVENT_MARRIAGE_PROPOSED = 'EVENT_MARRIAGE_PROPOSED',
    EVENT_MARRIAGE_RESOLVED = 'EVENT_MARRIAGE_RESOLVED',
    EVENT_DIVORCE = 'EVENT_DIVORCE',
    EVENT_HOUSEHOLD_TRANSFER = 'EVENT_HOUSEHOLD_TRANSFER',
    EVENT_BLACKLIST_UPDATED = 'EVENT_BLACKLIST_UPDATED',
    EVENT_SPOUSE_MOVE_CONSENT = 'EVENT_SPOUSE_MOVE_CONSENT',
    EVENT_REPUTATION_UPDATED = 'EVENT_REPUTATION_UPDATED',

    // Economy
    EVENT_RENT_PAID = 'EVENT_RENT_PAID',
    EVENT_HOUSING_CHANGED = 'EVENT_HOUSING_CHANGED',
    EVENT_TRADE_COMPLETED = 'EVENT_TRADE_COMPLETED',
    EVENT_LISTING_CREATED = 'EVENT_LISTING_CREATED',
    EVENT_LISTING_CANCELLED = 'EVENT_LISTING_CANCELLED',
    EVENT_ITEM_BOUGHT = 'EVENT_ITEM_BOUGHT',
    EVENT_DISTRIBUTION_RECEIVED = 'EVENT_DISTRIBUTION_RECEIVED',

    // Property System (NEW)
    EVENT_PROPERTY_BOUGHT = 'EVENT_PROPERTY_BOUGHT',
    EVENT_PROPERTY_SOLD = 'EVENT_PROPERTY_SOLD',
    EVENT_PROPERTY_LISTED = 'EVENT_PROPERTY_LISTED',
    EVENT_RENT_ADJUSTED = 'EVENT_RENT_ADJUSTED',
    EVENT_EVICTION = 'EVENT_EVICTION',
    EVENT_PROPERTY_TAX_PAID = 'EVENT_PROPERTY_TAX_PAID',
    EVENT_PROPERTY_TAX_MISSED = 'EVENT_PROPERTY_TAX_MISSED',
    EVENT_PROPERTY_SEIZED = 'EVENT_PROPERTY_SEIZED',
    EVENT_PROPERTY_MAINTAINED = 'EVENT_PROPERTY_MAINTAINED',
    EVENT_PROPERTY_CONDEMNED = 'EVENT_PROPERTY_CONDEMNED',
    EVENT_TENANT_LEFT = 'EVENT_TENANT_LEFT',
    EVENT_TENANT_RATED_LANDLORD = 'EVENT_TENANT_RATED_LANDLORD',
    EVENT_LANDLORD_RATED_TENANT = 'EVENT_LANDLORD_RATED_TENANT',

    // Public Employment (NEW)
    EVENT_PUBLIC_JOB_APPLIED = 'EVENT_PUBLIC_JOB_APPLIED',
    EVENT_PRIVATE_JOB_APPLIED = 'EVENT_PRIVATE_JOB_APPLIED',
    EVENT_PRIVATE_JOB_ACCEPTED = 'EVENT_PRIVATE_JOB_ACCEPTED',
    EVENT_PUBLIC_JOB_RESIGNED = 'EVENT_PUBLIC_JOB_RESIGNED',
    EVENT_SHIFT_STARTED = 'EVENT_SHIFT_STARTED',
    EVENT_SHIFT_ENDED = 'EVENT_SHIFT_ENDED',
    EVENT_SALARY_COLLECTED = 'EVENT_SALARY_COLLECTED',
    EVENT_PUBLIC_JOB_TERMINATED = 'EVENT_PUBLIC_JOB_TERMINATED',

    // Agora
    EVENT_AGORA_POSTED = 'EVENT_AGORA_POSTED',
    EVENT_AGORA_POST_REJECTED = 'EVENT_AGORA_POST_REJECTED',
    EVENT_AGORA_VOTED = 'EVENT_AGORA_VOTED',
    EVENT_AGORA_REPORTED = 'EVENT_AGORA_REPORTED',
    EVENT_AGORA_POST_DELETED = 'EVENT_AGORA_POST_DELETED',
    EVENT_ANGEL_REPORT_GENERATED = 'EVENT_ANGEL_REPORT_GENERATED',
    EVENT_CITY_PULSE = 'EVENT_CITY_PULSE',
    EVENT_CITY_RECESSION_DETECTED = 'EVENT_CITY_RECESSION_DETECTED',
    EVENT_GOD_RECESSION_INTERVENTION = 'EVENT_GOD_RECESSION_INTERVENTION',

    // Crime/Police
    EVENT_CRIME_COMMITTED = 'EVENT_CRIME_COMMITTED', // steal, assault, fraud
    EVENT_ARREST = 'EVENT_ARREST',
    EVENT_IMPRISONED = 'EVENT_IMPRISONED',
    EVENT_RELEASED = 'EVENT_RELEASED',
    EVENT_PATROL_LOGGED = 'EVENT_PATROL_LOGGED',

    // Proposals
    EVENT_PROPOSAL_SUBMITTED = 'EVENT_PROPOSAL_SUBMITTED',
    EVENT_PROPOSAL_APPROVED = 'EVENT_PROPOSAL_APPROVED',
    EVENT_PROPOSAL_REJECTED = 'EVENT_PROPOSAL_REJECTED',

    // City/Governance
    EVENT_VOTE_CAST = 'EVENT_VOTE_CAST',
    EVENT_SPENDING_ALLOCATED = 'EVENT_SPENDING_ALLOCATED',
    EVENT_CITY_UPGRADED = 'EVENT_CITY_UPGRADED',
    EVENT_CITY_TAX_CHANGED = 'EVENT_CITY_TAX_CHANGED',
    EVENT_CITY_AID_APPLIED = 'EVENT_CITY_AID_APPLIED',
    EVENT_CITY_SECURITY_FUNDED = 'EVENT_CITY_SECURITY_FUNDED',

    // System
    EVENT_BURN = 'EVENT_BURN',
    EVENT_TRANSFER = 'EVENT_TRANSFER',
    EVENT_AGENT_BORN = 'EVENT_AGENT_BORN',
    EVENT_SKILL_BUDGET_EXCEEDED = 'EVENT_SKILL_BUDGET_EXCEEDED',

    // Business
    EVENT_BUSINESS_FOUNDED = 'EVENT_BUSINESS_FOUNDED',
    EVENT_BUSINESS_CONVERTED = 'EVENT_BUSINESS_CONVERTED',
    EVENT_BUSINESS_OPENED = 'EVENT_BUSINESS_OPENED',
    EVENT_BUSINESS_UPGRADED = 'EVENT_BUSINESS_UPGRADED',
    EVENT_BUSINESS_SOLD = 'EVENT_BUSINESS_SOLD',
    EVENT_BUSINESS_DISSOLVED = 'EVENT_BUSINESS_DISSOLVED',
    EVENT_BUSINESS_BANKRUPT = 'EVENT_BUSINESS_BANKRUPT',
    EVENT_BUSINESS_PAYROLL_PAID = 'EVENT_BUSINESS_PAYROLL_PAID',
    EVENT_BUSINESS_PAYROLL_MISSED = 'EVENT_BUSINESS_PAYROLL_MISSED',
    EVENT_BUSINESS_CRITICAL_FUNDS = 'EVENT_BUSINESS_CRITICAL_FUNDS',
    EVENT_BUSINESS_LOW_GAS = 'EVENT_BUSINESS_LOW_GAS',
    EVENT_BUSINESS_CLOSED = 'EVENT_BUSINESS_CLOSED',
    EVENT_BUSINESS_TAX_PAID = 'EVENT_BUSINESS_TAX_PAID',
    EVENT_BUSINESS_TAX_MISSED = 'EVENT_BUSINESS_TAX_MISSED',
    EVENT_BUSINESS_MAINTENANCE_PAID = 'EVENT_BUSINESS_MAINTENANCE_PAID',
    EVENT_BUSINESS_QUALITY_DROP = 'EVENT_BUSINESS_QUALITY_DROP',
    EVENT_BUSINESS_INJECT = 'EVENT_BUSINESS_INJECT',
    EVENT_BUSINESS_WITHDRAW = 'EVENT_BUSINESS_WITHDRAW',
    EVENT_EMPLOYEE_HIRED = 'EVENT_EMPLOYEE_HIRED',
    EVENT_EMPLOYEE_FIRED = 'EVENT_EMPLOYEE_FIRED',
    EVENT_EMPLOYEE_QUIT = 'EVENT_EMPLOYEE_QUIT',
    EVENT_EMPLOYEE_QUIT_UNPAID = 'EVENT_EMPLOYEE_QUIT_UNPAID',
    EVENT_EMPLOYEE_SALARY_ADJUSTED = 'EVENT_EMPLOYEE_SALARY_ADJUSTED',
    EVENT_BUSINESS_REVENUE_EARNED = 'EVENT_BUSINESS_REVENUE_EARNED',
    EVENT_BUSINESS_CUSTOMER_VISIT = 'EVENT_BUSINESS_CUSTOMER_VISIT',
    EVENT_BUSINESS_OWNER_WORKED = 'EVENT_BUSINESS_OWNER_WORKED',
    EVENT_ITEM_CONSUMED = 'EVENT_ITEM_CONSUMED',
    EVENT_FORAGED = 'EVENT_FORAGED',
    EVENT_ALLIANCE_BETRAYED = 'EVENT_ALLIANCE_BETRAYED',
    EVENT_CONSTRUCTION_REQUEST_CREATED = 'EVENT_CONSTRUCTION_REQUEST_CREATED',
    EVENT_CONSTRUCTION_QUOTE_SUBMITTED = 'EVENT_CONSTRUCTION_QUOTE_SUBMITTED',
    EVENT_CONSTRUCTION_STARTED = 'EVENT_CONSTRUCTION_STARTED',
    EVENT_CONSTRUCTION_COMPLETED = 'EVENT_CONSTRUCTION_COMPLETED',
    EVENT_CONSTRUCTION_PAYMENT_DEFAULT = 'EVENT_CONSTRUCTION_PAYMENT_DEFAULT',
    EVENT_CONSTRUCTION_PROJECT_PAUSED = 'EVENT_CONSTRUCTION_PROJECT_PAUSED',
    EVENT_LOAN_ISSUED = 'EVENT_LOAN_ISSUED',
    EVENT_LOAN_REPAID = 'EVENT_LOAN_REPAID',
    EVENT_LOAN_DEFAULTED = 'EVENT_LOAN_DEFAULTED',
    EVENT_BUSINESS_REPUTATION_CHANGED = 'EVENT_BUSINESS_REPUTATION_CHANGED',
    EVENT_BUSINESS_FORCED_CLOSED = 'EVENT_BUSINESS_FORCED_CLOSED',

    // Life Events
    EVENT_LIFE_EVENT_FORTUNE = 'EVENT_LIFE_EVENT_FORTUNE',
    EVENT_LIFE_EVENT_MISFORTUNE = 'EVENT_LIFE_EVENT_MISFORTUNE',

    // Owner suggestion tracking
    EVENT_OWNER_SUGGESTION = 'EVENT_OWNER_SUGGESTION',
}

/**
 * Event outcome enum matching Prisma schema
 */
export enum EventOutcome {
    SUCCESS = 'success',
    FAIL = 'fail',
    BLOCKED = 'blocked',
}

/**
 * Base event structure
 */
export interface EventData {
    actorId: string;
    type: EventType;
    targetIds: string[];
    tick: number;
    outcome: EventOutcome;
    sideEffects?: Record<string, unknown>;
}

/**
 * Work completed event side effects
 */
export interface WorkCompletedSideEffects {
    sbyteEarned: number;
    energySpent: number;
    platformFee: number;
    cityFee: number;
}

/**
 * City moved event side effects
 */
export interface CityMovedSideEffects {
    fromCityId: string;
    toCityId: string;
    moveCost: number;
}

/**
 * Proposal submitted event side effects
 */
export interface ProposalSubmittedSideEffects {
    proposalId: string;
    proposalType: string;
    cityId: string;
}

/**
 * Frozen event side effects
 */
export interface FrozenSideEffects {
    reason: 'economic_freeze' | 'health_collapse' | 'admin_action';
}

// ============================================================================
// PUBLIC EMPLOYMENT SIDE EFFECTS (NEW)
// ============================================================================

/**
 * Public job applied event side effects
 */
export interface PublicJobAppliedSideEffects {
    publicPlaceId: string;
    role: string;
    cityId: string;
}

/**
 * Shift started/ended event side effects
 */
export interface ShiftSideEffects {
    employmentId: string;
    role: string;
    shiftDurationHours: number;
}

/**
 * Salary collected event side effects
 */
export interface SalaryCollectedSideEffects {
    employmentId: string;
    daysWorked: number;
    grossSalary: number;
    platformFee: number;
    netSalary: number;
    paidFromVault: string; // cityId
    partialPayment: boolean;
}

/**
 * Public job terminated event side effects
 */
export interface PublicJobTerminatedSideEffects {
    employmentId: string;
    role: string;
    reason: 'resigned' | 'absent_3_days' | 'city_dissolved' | 'admin_action';
}

// ============================================================================
// PROPERTY SYSTEM SIDE EFFECTS (NEW)
// ============================================================================

/**
 * Property bought event side effects
 */
export interface PropertyBoughtSideEffects {
    propertyId: string;
    buyerId: string;
    sellerId: string | null; // null if bought from city
    price: number;
    platformFee: number;
    cityFee: number;
    housingTier: string;
}

/**
 * Property sold event side effects
 */
export interface PropertySoldSideEffects {
    propertyId: string;
    sellerId: string;
    buyerId: string;
    price: number;
    netProceeds: number;
}

/**
 * Property listed event side effects
 */
export interface PropertyListedSideEffects {
    propertyId: string;
    forRent: boolean;
    forSale: boolean;
    rentPrice: number;
    salePrice: number | null;
}

/**
 * Eviction event side effects
 */
export interface EvictionSideEffects {
    propertyId: string;
    tenantId: string;
    ownerId: string;
    missedRentDays: number;
    reason: 'missed_rent' | 'owner_request' | 'city_action';
}

