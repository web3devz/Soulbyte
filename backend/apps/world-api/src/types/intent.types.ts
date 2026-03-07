/**
 * Intent Types - MVP + Public Employment + Property System
 * Full backend intent catalog
 */

export enum IntentType {
    // Core
    INTENT_IDLE = 'INTENT_IDLE',
    INTENT_WORK = 'INTENT_WORK',
    INTENT_SWITCH_JOB = 'INTENT_SWITCH_JOB',
    INTENT_CRAFT = 'INTENT_CRAFT',

    // Life/Status
    INTENT_FREEZE = 'INTENT_FREEZE',
    INTENT_REST = 'INTENT_REST',
    INTENT_AVOID_GAMES = 'INTENT_AVOID_GAMES',

    // Economy
    INTENT_MOVE_CITY = 'INTENT_MOVE_CITY',
    INTENT_PAY_RENT = 'INTENT_PAY_RENT',
    INTENT_CHANGE_HOUSING = 'INTENT_CHANGE_HOUSING',
    INTENT_TRADE = 'INTENT_TRADE',
    INTENT_LIST = 'INTENT_LIST',
    INTENT_BUY = 'INTENT_BUY',
    INTENT_BUY_ITEM = 'INTENT_BUY_ITEM',

    // Property System (NEW)
    INTENT_BUY_PROPERTY = 'INTENT_BUY_PROPERTY',
    INTENT_SELL_PROPERTY = 'INTENT_SELL_PROPERTY',
    INTENT_LIST_PROPERTY = 'INTENT_LIST_PROPERTY',
    INTENT_ADJUST_RENT = 'INTENT_ADJUST_RENT',
    INTENT_MAINTAIN_PROPERTY = 'INTENT_MAINTAIN_PROPERTY',
    INTENT_EVICT = 'INTENT_EVICT',

    // Public Employment (NEW)
    INTENT_APPLY_PUBLIC_JOB = 'INTENT_APPLY_PUBLIC_JOB',
    INTENT_RESIGN_PUBLIC_JOB = 'INTENT_RESIGN_PUBLIC_JOB',
    INTENT_START_SHIFT = 'INTENT_START_SHIFT',
    INTENT_END_SHIFT = 'INTENT_END_SHIFT',
    INTENT_COLLECT_SALARY = 'INTENT_COLLECT_SALARY',

    // Combat
    INTENT_ATTACK = 'INTENT_ATTACK',
    INTENT_DEFEND = 'INTENT_DEFEND',
    INTENT_RETREAT = 'INTENT_RETREAT',

    // Gaming
    INTENT_PLAY_GAME = 'INTENT_PLAY_GAME',
    INTENT_BET = 'INTENT_BET',
    INTENT_CHALLENGE_GAME = 'INTENT_CHALLENGE_GAME',
    INTENT_ACCEPT_GAME = 'INTENT_ACCEPT_GAME',
    INTENT_REJECT_GAME = 'INTENT_REJECT_GAME',

    // Social
    INTENT_SOCIALIZE = 'INTENT_SOCIALIZE',
    INTENT_FLIRT = 'INTENT_FLIRT',
    INTENT_ROMANTIC_INTERACTION = 'INTENT_ROMANTIC_INTERACTION',
    INTENT_PROPOSE_ALLIANCE = 'INTENT_PROPOSE_ALLIANCE',
    INTENT_ACCEPT_ALLIANCE = 'INTENT_ACCEPT_ALLIANCE',
    INTENT_REJECT_ALLIANCE = 'INTENT_REJECT_ALLIANCE',
    INTENT_PROPOSE_DATING = 'INTENT_PROPOSE_DATING',
    INTENT_ACCEPT_DATING = 'INTENT_ACCEPT_DATING',
    INTENT_END_DATING = 'INTENT_END_DATING',
    INTENT_PROPOSE_MARRIAGE = 'INTENT_PROPOSE_MARRIAGE',
    INTENT_ACCEPT_MARRIAGE = 'INTENT_ACCEPT_MARRIAGE',
    INTENT_DIVORCE = 'INTENT_DIVORCE',
    INTENT_HOUSEHOLD_TRANSFER = 'INTENT_HOUSEHOLD_TRANSFER',
    INTENT_BLACKLIST = 'INTENT_BLACKLIST',

    // Agora
    INTENT_POST_AGORA = 'INTENT_POST_AGORA',
    INTENT_REPLY_AGORA = 'INTENT_REPLY_AGORA',
    INTENT_VOTE_AGORA = 'INTENT_VOTE_AGORA',
    INTENT_REPORT_AGORA = 'INTENT_REPORT_AGORA',

    // Crime
    INTENT_STEAL = 'INTENT_STEAL',
    INTENT_ASSAULT = 'INTENT_ASSAULT',
    INTENT_FRAUD = 'INTENT_FRAUD',
    INTENT_FLEE = 'INTENT_FLEE',
    INTENT_HIDE = 'INTENT_HIDE',

    // Police
    INTENT_PATROL = 'INTENT_PATROL',
    INTENT_ARREST = 'INTENT_ARREST',
    INTENT_IMPRISON = 'INTENT_IMPRISON',
    INTENT_RELEASE = 'INTENT_RELEASE',

    // Governance
    INTENT_VOTE = 'INTENT_VOTE',
    INTENT_ALLOCATE_SPENDING = 'INTENT_ALLOCATE_SPENDING',
    INTENT_CITY_UPGRADE = 'INTENT_CITY_UPGRADE',
    INTENT_CITY_TAX_CHANGE = 'INTENT_CITY_TAX_CHANGE',
    INTENT_CITY_SOCIAL_AID = 'INTENT_CITY_SOCIAL_AID',
    INTENT_CITY_SECURITY_FUNDING = 'INTENT_CITY_SECURITY_FUNDING',

    // Business
    INTENT_FOUND_BUSINESS = 'INTENT_FOUND_BUSINESS',
    INTENT_CONVERT_BUSINESS = 'INTENT_CONVERT_BUSINESS',
    INTENT_UPGRADE_BUSINESS = 'INTENT_UPGRADE_BUSINESS',
    INTENT_SET_PRICES = 'INTENT_SET_PRICES',
    INTENT_IMPROVE_BUSINESS = 'INTENT_IMPROVE_BUSINESS',
    INTENT_WORK_OWN_BUSINESS = 'INTENT_WORK_OWN_BUSINESS',
    INTENT_HIRE_EMPLOYEE = 'INTENT_HIRE_EMPLOYEE',
    INTENT_ADJUST_SALARY = 'INTENT_ADJUST_SALARY',
    INTENT_FIRE_EMPLOYEE = 'INTENT_FIRE_EMPLOYEE',
    INTENT_SELL_BUSINESS = 'INTENT_SELL_BUSINESS',
    INTENT_BUY_BUSINESS = 'INTENT_BUY_BUSINESS',
    INTENT_DISSOLVE_BUSINESS = 'INTENT_DISSOLVE_BUSINESS',
    INTENT_WITHDRAW_BUSINESS_FUNDS = 'INTENT_WITHDRAW_BUSINESS_FUNDS',
    INTENT_INJECT_BUSINESS_FUNDS = 'INTENT_INJECT_BUSINESS_FUNDS',
    INTENT_BUSINESS_WITHDRAW = 'INTENT_BUSINESS_WITHDRAW',
    INTENT_BUSINESS_INJECT = 'INTENT_BUSINESS_INJECT',
    INTENT_CLOSE_BUSINESS = 'INTENT_CLOSE_BUSINESS',
    INTENT_SET_LOAN_TERMS = 'INTENT_SET_LOAN_TERMS',
    INTENT_APPROVE_LOAN = 'INTENT_APPROVE_LOAN',
    INTENT_DENY_LOAN = 'INTENT_DENY_LOAN',
    INTENT_SET_HOUSE_EDGE = 'INTENT_SET_HOUSE_EDGE',
    INTENT_MANAGE_RESTAURANT = 'INTENT_MANAGE_RESTAURANT',
    INTENT_MANAGE_CLINIC = 'INTENT_MANAGE_CLINIC',
    INTENT_HOST_EVENT = 'INTENT_HOST_EVENT',
    INTENT_VISIT_BUSINESS = 'INTENT_VISIT_BUSINESS',
    INTENT_APPLY_PRIVATE_JOB = 'INTENT_APPLY_PRIVATE_JOB',
    INTENT_ACCEPT_JOB = 'INTENT_ACCEPT_JOB',
    INTENT_REJECT_JOB = 'INTENT_REJECT_JOB',
    INTENT_QUIT_JOB = 'INTENT_QUIT_JOB',
    INTENT_CONSUME_ITEM = 'INTENT_CONSUME_ITEM',
    INTENT_FORAGE = 'INTENT_FORAGE',
    INTENT_BETRAY_ALLIANCE = 'INTENT_BETRAY_ALLIANCE',
    INTENT_END_RIVALRY = 'INTENT_END_RIVALRY',
    INTENT_FORGIVE_GRUDGE = 'INTENT_FORGIVE_GRUDGE',
    INTENT_ACCEPT_SPOUSE_MOVE = 'INTENT_ACCEPT_SPOUSE_MOVE',
    INTENT_REJECT_SPOUSE_MOVE = 'INTENT_REJECT_SPOUSE_MOVE',
    INTENT_REQUEST_CONSTRUCTION = 'INTENT_REQUEST_CONSTRUCTION',
    INTENT_SUBMIT_CONSTRUCTION_QUOTE = 'INTENT_SUBMIT_CONSTRUCTION_QUOTE',
    INTENT_ACCEPT_CONSTRUCTION_QUOTE = 'INTENT_ACCEPT_CONSTRUCTION_QUOTE',

    // Business Owner Financial Management
    INTENT_TRANSFER_MON_TO_BUSINESS = 'INTENT_TRANSFER_MON_TO_BUSINESS',
}

/**
 * Intent status enum matching Prisma schema
 */
export enum IntentStatus {
    PENDING = 'pending',
    QUEUED = 'queued',
    APPROVED = 'approved',
    BLOCKED = 'blocked',
    REWRITTEN = 'rewritten',
    EXECUTED = 'executed',
}

/**
 * Governance intent types for proposal handling
 */
export const GOVERNANCE_INTENTS = [
    IntentType.INTENT_CITY_UPGRADE,
    IntentType.INTENT_CITY_TAX_CHANGE,
    IntentType.INTENT_CITY_SOCIAL_AID,
    IntentType.INTENT_CITY_SECURITY_FUNDING,
] as const;

/**
 * Public employment intent types
 */
export const PUBLIC_EMPLOYMENT_INTENTS = [
    IntentType.INTENT_APPLY_PUBLIC_JOB,
    IntentType.INTENT_RESIGN_PUBLIC_JOB,
    IntentType.INTENT_START_SHIFT,
    IntentType.INTENT_END_SHIFT,
    IntentType.INTENT_COLLECT_SALARY,
] as const;

/**
 * Property system intent types
 */
export const PROPERTY_INTENTS = [
    IntentType.INTENT_BUY_PROPERTY,
    IntentType.INTENT_SELL_PROPERTY,
    IntentType.INTENT_LIST_PROPERTY,
    IntentType.INTENT_ADJUST_RENT,
    IntentType.INTENT_MAINTAIN_PROPERTY,
    IntentType.INTENT_EVICT,
] as const;

/**
 * Intents allowed while agent is busy (working/resting)
 */
export const BUSY_ALLOWED_INTENTS = [
    IntentType.INTENT_IDLE,
    IntentType.INTENT_END_SHIFT,
    IntentType.INTENT_DEFEND,
    IntentType.INTENT_RETREAT,
    IntentType.INTENT_PAY_RENT,
    IntentType.INTENT_COLLECT_SALARY,
    IntentType.INTENT_ACCEPT_JOB,
    IntentType.INTENT_REJECT_JOB,
    IntentType.INTENT_ACCEPT_DATING,
    IntentType.INTENT_ACCEPT_MARRIAGE,
    IntentType.INTENT_ACCEPT_ALLIANCE,
    IntentType.INTENT_REJECT_ALLIANCE,
    IntentType.INTENT_ACCEPT_GAME,
    IntentType.INTENT_REJECT_GAME,
    IntentType.INTENT_AVOID_GAMES,
    IntentType.INTENT_ACCEPT_SPOUSE_MOVE,
    IntentType.INTENT_REJECT_SPOUSE_MOVE,
    IntentType.INTENT_ACCEPT_CONSTRUCTION_QUOTE,
    IntentType.INTENT_POST_AGORA,
    IntentType.INTENT_REPLY_AGORA,
    IntentType.INTENT_VOTE_AGORA,
    IntentType.INTENT_REPORT_AGORA,
    // Business-critical owner actions (override busy state)
    IntentType.INTENT_BUSINESS_INJECT,
    IntentType.INTENT_INJECT_BUSINESS_FUNDS,
    IntentType.INTENT_CLOSE_BUSINESS,
    IntentType.INTENT_TRANSFER_MON_TO_BUSINESS,
    // Allow all business decisions while busy
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
] as const;

/**
 * Business owner work intent params
 */
export interface WorkOwnBusinessIntentParams {
    businessId: string;
}

/**
 * Intent submission payload from agents
 */
export interface IntentPayload {
    actorId: string;
    type: IntentType;
    targetId?: string;
    params?: Record<string, unknown>;
    priority?: number;
    expectedCost?: number;
    expectedReward?: number;
}

/**
 * Intent params for INTENT_WORK
 */
export interface WorkIntentParams {
    jobType?: string;
}

/**
 * Intent params for INTENT_MOVE_CITY
 */
export interface MoveCityIntentParams {
    targetCityId: string;
}

/**
 * Intent params for governance proposals
 */
export interface GovernanceIntentParams {
    cityId: string;
    proposalType: 'upgrade' | 'tax_change' | 'aid' | 'security' | 'housing';
    payload: {
        upgradeType?: string;
        requestedLevel?: number;
        estimatedCost?: number;
        newTaxRate?: number;
        aidAmount?: number;
        securityFunding?: number;
        justification?: string;
    };
}

// ============================================================================
// PUBLIC EMPLOYMENT INTENT PARAMS (NEW)
// ============================================================================

/**
 * Public role types matching Prisma schema
 */
export type PublicRoleType = 'DOCTOR' | 'NURSE' | 'TEACHER' | 'POLICE_OFFICER';

/**
 * Experience requirements per role (in days)
 */
export const PUBLIC_ROLE_EXPERIENCE_REQ: Record<PublicRoleType, number> = {
    DOCTOR: 30,
    TEACHER: 10,
    NURSE: 0,
    POLICE_OFFICER: 0,
};

/**
 * Daily salaries per role (in SBYTE)
 */
export const PUBLIC_ROLE_SALARIES: Record<PublicRoleType, number> = {
    DOCTOR: 1000,
    TEACHER: 600,
    NURSE: 250,
    POLICE_OFFICER: 250,
};

/**
 * Work hours per day per role
 */
export const PUBLIC_ROLE_WORK_HOURS: Record<PublicRoleType, number> = {
    DOCTOR: 3,
    TEACHER: 4,
    NURSE: 5,
    POLICE_OFFICER: 5,
};

/**
 * Intent params for INTENT_APPLY_PUBLIC_JOB
 */
export interface ApplyPublicJobParams {
    publicPlaceId: string;
    role: PublicRoleType;
}

/**
 * Intent params for INTENT_RESIGN_PUBLIC_JOB
 */
export interface ResignPublicJobParams {
    reason?: string;
}

/**
 * Intent params for INTENT_START_SHIFT
 */
export interface StartShiftParams {
    // No params needed, uses current employment
}

/**
 * Intent params for INTENT_END_SHIFT
 */
export interface EndShiftParams {
    // No params needed
}

/**
 * Intent params for INTENT_COLLECT_SALARY
 */
export interface CollectSalaryParams {
    daysWorked?: number; // Optional, system calculates from employment record
}

// ============================================================================
// PROPERTY SYSTEM INTENT PARAMS (NEW)
// ============================================================================

/**
 * Platform fee for property transactions (env-configured)
 */

/**
 * Intent params for INTENT_BUY_PROPERTY
 */
export interface BuyPropertyParams {
    propertyId: string;
    maxPrice?: number; // Max price willing to pay
}

/**
 * Intent params for INTENT_SELL_PROPERTY
 */
export interface SellPropertyParams {
    propertyId: string;
    salePrice: number;
}

/**
 * Intent params for INTENT_LIST_PROPERTY
 */
export interface ListPropertyParams {
    propertyId: string;
    rentPrice: number;
    forRent: boolean;
    forSale: boolean;
    salePrice?: number;
}

/**
 * Intent params for INTENT_ADJUST_RENT
 */
export interface AdjustRentParams {
    propertyId: string;
    newRent: number;
}

export interface MaintainPropertyParams {
    propertyId: string;
}

