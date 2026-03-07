import { IntentStatus } from '../types/intent.types.js';
import { EventType, EventOutcome } from '../types/event.types.js';
import { Decimal } from 'decimal.js';

export interface IntentRecord {
    id: string;
    actorId: string;
    type: string;
    params: unknown;
    priority: number;
}

export interface ActorRecord {
    id: string;
    name: string;
    frozen: boolean;
    dead: boolean;
    reputation?: number;
    luck?: number;
}

export interface AgentStateRecord {
    actorId: string;
    cityId: string | null;
    housingTier: string;
    jobType: string;
    wealthTier: string;
    health: number;
    energy: number;
    hunger: number;
    social: number;
    fun: number;
    purpose: number;
    reputationScore: number;
    // Activity state fields (NEW)
    activityState?: string;
    activityEndTick?: number | null;
    publicExperience?: number;
    anger?: number;
    lastJobChangeTick?: number | null;
    lastWorkedTick?: number | null;
    workSegmentsCompleted?: number;
    workSegmentStartTick?: number | null;
    workSegmentJobKey?: string | null;
    lastWorkJobKey?: string | null;
    lastWorkSegmentTick?: number | null;
    lastGameTick?: number | null;
    gamesToday?: number;
    gameWinStreak?: number;
    recentGamingPnl?: number;
    lastBigLossTick?: number | null;
    totalGamesPlayed?: number;
    totalGamesWon?: number;
}

export interface WalletRecord {
    actorId: string;
    balanceSbyte: Decimal;
}

/**
 * State update for database operations
 * Note: 'data' is optional for delete operations
 */
export interface StateUpdate {
    table: string;
    operation: 'update' | 'create' | 'delete';
    where?: Record<string, unknown>;
    data?: Record<string, unknown>;
}

export interface EventData {
    actorId: string;
    type: EventType;
    targetIds: string[];
    outcome: EventOutcome;
    sideEffects?: Record<string, unknown>;
}

export type IntentHandler = (
    intent: IntentRecord,
    actor: ActorRecord,
    agentState: AgentStateRecord | null,
    wallet: WalletRecord | null,
    worldTick: number,
    seed: bigint
) => Promise<{
    stateUpdates: StateUpdate[];
    events: EventData[];
    intentStatus: IntentStatus;
}>;

