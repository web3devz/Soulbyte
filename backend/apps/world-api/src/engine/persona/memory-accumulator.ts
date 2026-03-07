import { EventData, EventOutcome, EventType } from '../../types/event.types.js';
import { AccumulatedContext, EventSummary, MemoryCategory } from './persona.types.js';
import { AgentPersonality } from '../agent-brain/types.js';

type BufferEntry = {
    events: EventSummary[];
    lastTick: number;
};

const MAX_BUFFER = 100;

export class MemoryAccumulator {
    private buffers = new Map<string, BufferEntry>();

    ingest(agentId: string, event: EventData, tick: number): void {
        const summary = summarizeEvent(event, agentId, tick);
        const buffer = this.buffers.get(agentId) ?? { events: [], lastTick: tick };
        buffer.events.push(summary);
        buffer.lastTick = tick;
        if (buffer.events.length > MAX_BUFFER) {
            buffer.events = buffer.events.slice(buffer.events.length - MAX_BUFFER);
        }
        this.buffers.set(agentId, buffer);
    }

    ingestForEvent(event: EventData, tick: number): void {
        this.ingest(event.actorId, event, tick);
        for (const targetId of event.targetIds || []) {
            if (targetId === event.actorId) continue;
            this.ingest(targetId, event, tick);
        }
    }

    drain(agentId: string): EventSummary[] {
        const buffer = this.buffers.get(agentId);
        if (!buffer) return [];
        this.buffers.delete(agentId);
        return buffer.events;
    }
}

export function buildAccumulatedContext(params: {
    agentId: string;
    events: EventSummary[];
    tick: number;
    lastReflectionTick: number;
    currentWealth: number;
    previousWealth?: number;
    olderWealth?: number;
    currentWealthTier: string;
    currentHousing: string;
    currentJob: string | null;
    currentRelationships: number;
    currentBusinesses: number;
    personality: AgentPersonality;
    recentGoalProgress: { goalId: string; progressDelta: number }[];
}): AccumulatedContext {
    const categorized = {
        economicEvents: [] as EventSummary[],
        socialEvents: [] as EventSummary[],
        crimeEvents: [] as EventSummary[],
        achievementEvents: [] as EventSummary[],
        lossEvents: [] as EventSummary[],
        survivalEvents: [] as EventSummary[],
    };

    for (const ev of params.events) {
        const category = categorizeEvent(ev.eventType, ev.source.type);
        switch (category) {
            case MemoryCategory.ECONOMIC:
                categorized.economicEvents.push(ev);
                break;
            case MemoryCategory.SOCIAL:
                categorized.socialEvents.push(ev);
                break;
            case MemoryCategory.CRIME:
                categorized.crimeEvents.push(ev);
                break;
            case MemoryCategory.ACHIEVEMENT:
                categorized.achievementEvents.push(ev);
                break;
            case MemoryCategory.LOSS:
                categorized.lossEvents.push(ev);
                break;
            case MemoryCategory.SURVIVAL:
                categorized.survivalEvents.push(ev);
                break;
            default:
                break;
        }
    }

    const totalSbyteImpact = params.events.reduce((sum, ev) => sum + ev.sbyteImpact, 0);
    const previousBalance = params.previousWealth ?? (params.currentWealth - totalSbyteImpact);
    const olderBalance = params.olderWealth ?? previousBalance;
    const wealthTrend = computeWealthTrend(params.currentWealth, previousBalance, olderBalance);

    const needsTrend = params.events.some(ev => ev.eventType === EventType.EVENT_RESTED) ? 'improving' : 'stable';
    const socialTrend = categorized.socialEvents.length > 0 ? 'expanding' : 'stable';

    return {
        agentId: params.agentId,
        sinceLastReflection: Math.max(0, params.tick - params.lastReflectionTick),
        ...categorized,
        wealthTrend,
        needsTrend,
        socialTrend,
        currentWealth: params.currentWealth,
        currentWealthTier: params.currentWealthTier,
        currentHousing: params.currentHousing,
        currentJob: params.currentJob,
        currentRelationships: params.currentRelationships,
        currentBusinesses: params.currentBusinesses,
        recentGoalProgress: params.recentGoalProgress,
        personality: params.personality,
    };
}

export function categorizeEvent(eventType: string, sourceType?: EventType): MemoryCategory {
    const type = sourceType ?? (eventType as EventType);
    switch (type) {
        case EventType.EVENT_RENT_PAID:
        case EventType.EVENT_HOUSING_CHANGED:
        case EventType.EVENT_TRADE_COMPLETED:
        case EventType.EVENT_LISTING_CREATED:
        case EventType.EVENT_LISTING_CANCELLED:
        case EventType.EVENT_ITEM_BOUGHT:
        case EventType.EVENT_PROPERTY_BOUGHT:
        case EventType.EVENT_PROPERTY_SOLD:
        case EventType.EVENT_PROPERTY_LISTED:
        case EventType.EVENT_SALARY_COLLECTED:
        case EventType.EVENT_BUSINESS_REVENUE_EARNED:
        case EventType.EVENT_BUSINESS_PAYROLL_PAID:
        case EventType.EVENT_LOAN_ISSUED:
        case EventType.EVENT_LOAN_REPAID:
        case EventType.EVENT_LOAN_DEFAULTED:
            return MemoryCategory.ECONOMIC;
        case EventType.EVENT_RELATIONSHIP_CHANGED:
        case EventType.EVENT_SOCIALIZED:
        case EventType.EVENT_ALLIANCE_PROPOSED:
        case EventType.EVENT_ALLIANCE_RESOLVED:
        case EventType.EVENT_DATING_PROPOSED:
        case EventType.EVENT_DATING_RESOLVED:
        case EventType.EVENT_DATING_ENDED:
        case EventType.EVENT_MARRIAGE_PROPOSED:
        case EventType.EVENT_MARRIAGE_RESOLVED:
        case EventType.EVENT_HOUSEHOLD_TRANSFER:
        case EventType.EVENT_ALLIANCE_BETRAYED:
        case EventType.EVENT_BLACKLIST_UPDATED:
            return MemoryCategory.SOCIAL;
        case EventType.EVENT_CRIME_COMMITTED:
        case EventType.EVENT_ARREST:
        case EventType.EVENT_IMPRISONED:
        case EventType.EVENT_RELEASED:
            return MemoryCategory.CRIME;
        case EventType.EVENT_BUSINESS_FOUNDED:
        case EventType.EVENT_BUSINESS_CONVERTED:
        case EventType.EVENT_BUSINESS_UPGRADED:
        case EventType.EVENT_BUSINESS_SOLD:
        case EventType.EVENT_CITY_UPGRADED:
        case EventType.EVENT_VOTE_CAST:
        case EventType.EVENT_PROPOSAL_APPROVED:
            return MemoryCategory.ACHIEVEMENT;
        case EventType.EVENT_BUSINESS_BANKRUPT:
        case EventType.EVENT_BUSINESS_FORCED_CLOSED:
        case EventType.EVENT_BUSINESS_PAYROLL_MISSED:
        case EventType.EVENT_EMPLOYEE_FIRED:
        case EventType.EVENT_EMPLOYEE_QUIT:
        case EventType.EVENT_PUBLIC_JOB_TERMINATED:
        case EventType.EVENT_EVICTION:
        case EventType.EVENT_DIVORCE:
        case EventType.EVENT_LIFE_EVENT_MISFORTUNE:
            return MemoryCategory.LOSS;
        case EventType.EVENT_FROZEN:
        case EventType.EVENT_UNFROZEN:
        case EventType.EVENT_RESTED:
        case EventType.EVENT_LIFE_EVENT_FORTUNE:
            return MemoryCategory.SURVIVAL;
        default:
            return MemoryCategory.ECONOMIC;
    }
}

export function computeWealthTrend(currentBalance: number, previousBalance: number, oldBalance: number): AccumulatedContext['wealthTrend'] {
    const recentDelta = currentBalance - previousBalance;
    const olderDelta = previousBalance - oldBalance;
    if (recentDelta > 0 && olderDelta > 0) return 'rising';
    if (previousBalance > 0 && recentDelta < -previousBalance * 0.3) return 'freefall';
    if (recentDelta < 0) return 'declining';
    return 'stable';
}

function summarizeEvent(event: EventData, perspectiveActorId: string, tick: number): EventSummary {
    const involvedActors = [event.actorId, ...(event.targetIds || [])];
    const { eventType, sbyteImpact } = normalizeEvent(event, perspectiveActorId);
    return {
        eventType,
        tick: event.tick ?? tick,
        outcome: event.outcome,
        involvedActors,
        sbyteImpact,
        source: {
            type: event.type,
            outcome: event.outcome,
        },
    };
}

function normalizeEvent(event: EventData, perspectiveActorId: string): { eventType: string; sbyteImpact: number } {
    const sbyteImpact = extractSbyteImpact(event, perspectiveActorId);
    if (event.type === EventType.EVENT_CRIME_COMMITTED) {
        if (event.actorId === perspectiveActorId) {
            return {
                eventType: event.outcome === EventOutcome.SUCCESS ? 'EVENT_CRIME_SUCCESS' : 'EVENT_CRIME_FAILED',
                sbyteImpact,
            };
        }
        return {
            eventType: 'EVENT_CRIME_VICTIMIZED',
            sbyteImpact,
        };
    }
    return { eventType: event.type, sbyteImpact };
}

function extractSbyteImpact(event: EventData, perspectiveActorId: string): number {
    const sideEffects = (event.sideEffects || {}) as Record<string, any>;
    if (typeof sideEffects.netWage === 'string') return Number(sideEffects.netWage);
    if (typeof sideEffects.netWage === 'number') return sideEffects.netWage;
    if (typeof sideEffects.netSalary === 'number') return sideEffects.netSalary;
    if (typeof sideEffects.grossSalary === 'number') return sideEffects.grossSalary;
    if (typeof sideEffects.amount === 'string') return Number(sideEffects.amount);
    if (typeof sideEffects.amount === 'number') return sideEffects.amount;
    if (typeof sideEffects.sbyteDelta === 'number') return sideEffects.sbyteDelta;
    if (typeof sideEffects.price === 'number') return perspectiveActorId === event.actorId ? -sideEffects.price : sideEffects.price;
    if (typeof sideEffects.netProceeds === 'number') return sideEffects.netProceeds;
    if (typeof sideEffects.grossWage === 'string') return Number(sideEffects.grossWage);
    if (typeof sideEffects.grossWage === 'number') return sideEffects.grossWage;
    return 0;
}
