import { EventOutcome, EventType } from '../../types/event.types.js';
import { AgentPersonality } from '../agent-brain/types.js';

export type ClassIdentity = 'underclass' | 'working' | 'middle' | 'elite' | 'tycoon';
export type PoliticalLeaning = 'populist' | 'centrist' | 'elitist' | 'anarchist';

export interface PersonaState {
    actorId: string;

    // Emotional State (0-100)
    mood: number;
    stress: number;
    satisfaction: number;
    confidence: number;
    loneliness: number;

    // Risk & Temperament
    effectiveRiskAppetite: number;
    effectivePatience: number;
    effectiveAggression: number;

    // Identity
    classIdentity: ClassIdentity;
    politicalLeaning: PoliticalLeaning;
    selfNarrative: string;

    // Social Map
    grudges: GrudgeEntry[];
    loyalties: LoyaltyEntry[];
    fears: string[];
    ambitions: string[];

    // Meta
    lastReflectionTick: number;
    reflectionCount: number;
    version: number;
    lastWealthBalance: number;
    previousWealthBalance: number;
}

export interface GrudgeEntry {
    targetActorId: string;
    reason: string;
    intensity: number;
    formedAtTick: number;
}

export interface LoyaltyEntry {
    targetActorId: string;
    reason: string;
    intensity: number;
    formedAtTick: number;
}

export interface MemoryEntry {
    id: string;
    actorId: string;
    tick: number;
    category: MemoryCategory;
    summary: string;
    emotionalWeight: number;
    importance: number;
    relatedActorIds: string[];
    decayRate: number;
}

export enum MemoryCategory {
    ECONOMIC = 'economic',
    SOCIAL = 'social',
    CRIME = 'crime',
    ACHIEVEMENT = 'achievement',
    LOSS = 'loss',
    SURVIVAL = 'survival',
}

export interface AgentGoal {
    id: string;
    actorId: string;
    type: GoalType;
    target: string;
    priority: number;
    progress: number;
    createdAtTick: number;
    deadline: number | null;
    status: 'active' | 'achieved' | 'abandoned' | 'failed';
    frustration: number;
    attempts: number;
}

export enum GoalType {
    REACH_WEALTH_TIER = 'reach_wealth_tier',
    ACQUIRE_HOUSING = 'acquire_housing',
    GET_JOB = 'get_job',
    FOUND_BUSINESS = 'found_business',
    GET_MARRIED = 'get_married',
    BECOME_MAYOR = 'become_mayor',
    LEAVE_CITY = 'leave_city',
    REVENGE = 'revenge',
    ACCUMULATE_WEALTH = 'accumulate',
    UPGRADE_BUSINESS = 'upgrade_business',
    ESCAPE_POVERTY = 'escape_poverty',
}

export interface PersonaModifiers {
    actorId: string;
    computedAtTick: number;
    survivalBias: number;
    economyBias: number;
    socialBias: number;
    crimeBias: number;
    leisureBias: number;
    governanceBias: number;
    businessBias: number;
    intentBoosts: Record<string, number>;
    avoidActors: string[];
    preferActors: string[];
    activeGoalIntents: string[];
}

export interface AccumulatedContext {
    agentId: string;
    sinceLastReflection: number;

    economicEvents: EventSummary[];
    socialEvents: EventSummary[];
    crimeEvents: EventSummary[];
    achievementEvents: EventSummary[];
    lossEvents: EventSummary[];
    survivalEvents: EventSummary[];

    wealthTrend: 'rising' | 'stable' | 'declining' | 'freefall';
    needsTrend: 'improving' | 'stable' | 'declining';
    socialTrend: 'expanding' | 'stable' | 'shrinking' | 'isolated';

    currentWealth: number;
    currentWealthTier: string;
    currentHousing: string;
    currentJob: string | null;
    currentRelationships: number;
    currentBusinesses: number;
    recentGoalProgress: GoalProgressEntry[];
    personality: AgentPersonality;
}

export interface EventSummary {
    eventType: string;
    tick: number;
    outcome: 'success' | 'fail' | 'blocked';
    involvedActors: string[];
    sbyteImpact: number;
    source: {
        type: EventType;
        outcome: EventOutcome;
    };
}

export interface GoalProgressEntry {
    goalId: string;
    progressDelta: number;
}

export enum TriggerType {
    JAILED = 'JAILED',
    RELEASED = 'RELEASED',
    WEALTH_TIER_CHANGE = 'WEALTH_TIER_CHANGE',
    MARRIED = 'MARRIED',
    DIVORCED = 'DIVORCED',
    BUSINESS_FOUNDED = 'BUSINESS_FOUNDED',
    BUSINESS_BANKRUPT = 'BUSINESS_BANKRUPT',
    BETRAYED = 'BETRAYED',
    ELECTED_MAYOR = 'ELECTED_MAYOR',
    EVICTED = 'EVICTED',
    HIRED = 'HIRED',
    FIRED = 'FIRED',
    NEAR_FREEZE = 'NEAR_FREEZE',
    GOAL_STAGNATION = 'GOAL_STAGNATION',
    STRESS_SPIKE = 'STRESS_SPIKE',
    TIMER = 'TIMER',
    OWNER_INTERACTION = 'OWNER_INTERACTION',
}

export interface PersonaUpdate {
    mood?: number;
    stress?: number;
    satisfaction?: number;
    confidence?: number;
    loneliness?: number;
    effectiveRiskAppetite?: number;
    effectivePatience?: number;
    effectiveAggression?: number;
    selfNarrative?: string;
    fears?: string[];
    ambitions?: string[];
    classIdentity?: ClassIdentity;
    politicalLeaning?: PoliticalLeaning;
    newGrudge?: GrudgeEntry;
    newLoyalty?: LoyaltyEntry;
    intentBoosts?: Record<string, number>;
}
