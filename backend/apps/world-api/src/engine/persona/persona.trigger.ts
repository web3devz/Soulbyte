import { EventData, EventOutcome, EventType } from '../../types/event.types.js';
import { TriggerType } from './persona.types.js';

export class PersonaTrigger {
    private lastReflection: Map<string, number> = new Map();
    private lossBuffer: Map<string, { count: number; firstTick: number }> = new Map();

    shouldReflect(agentId: string, event: EventData | null, tick: number): TriggerType | null {
        if (event) {
            const trigger = eventToTrigger(event);
            if (trigger) return trigger;
        }

        const last = this.lastReflection.get(agentId) ?? 0;
        if (tick - last > 720) return TriggerType.TIMER;

        if (event && isLossEvent(event.type)) {
            const window = this.lossBuffer.get(agentId) ?? { count: 0, firstTick: tick };
            if (tick - window.firstTick > 100) {
                window.count = 0;
                window.firstTick = tick;
            }
            window.count += 1;
            this.lossBuffer.set(agentId, window);
            if (window.count >= 3) {
                this.lossBuffer.set(agentId, { count: 0, firstTick: tick });
                return TriggerType.STRESS_SPIKE;
            }
        }

        return null;
    }

    markReflected(agentId: string, tick: number): void {
        this.lastReflection.set(agentId, tick);
    }
}

function eventToTrigger(event: EventData): TriggerType | null {
    switch (event.type) {
        case EventType.EVENT_IMPRISONED:
            return TriggerType.JAILED;
        case EventType.EVENT_RELEASED:
            return TriggerType.RELEASED;
        case EventType.EVENT_MARRIAGE_RESOLVED:
            return event.outcome === EventOutcome.SUCCESS ? TriggerType.MARRIED : null;
        case EventType.EVENT_DIVORCE:
            return TriggerType.DIVORCED;
        case EventType.EVENT_BUSINESS_FOUNDED:
        case EventType.EVENT_BUSINESS_CONVERTED:
            return TriggerType.BUSINESS_FOUNDED;
        case EventType.EVENT_BUSINESS_BANKRUPT:
            return TriggerType.BUSINESS_BANKRUPT;
        case EventType.EVENT_ALLIANCE_BETRAYED:
            return TriggerType.BETRAYED;
        case EventType.EVENT_EVICTION:
            return TriggerType.EVICTED;
        case EventType.EVENT_EMPLOYEE_HIRED:
        case EventType.EVENT_PUBLIC_JOB_APPLIED:
            return TriggerType.HIRED;
        case EventType.EVENT_EMPLOYEE_FIRED:
        case EventType.EVENT_PUBLIC_JOB_TERMINATED:
            return TriggerType.FIRED;
        default:
            return null;
    }
}

function isLossEvent(eventType: EventType): boolean {
    return [
        EventType.EVENT_EVICTION,
        EventType.EVENT_BUSINESS_BANKRUPT,
        EventType.EVENT_BUSINESS_PAYROLL_MISSED,
        EventType.EVENT_LOAN_DEFAULTED,
        EventType.EVENT_EMPLOYEE_FIRED,
        EventType.EVENT_PUBLIC_JOB_TERMINATED,
        EventType.EVENT_DIVORCE,
        EventType.EVENT_LIFE_EVENT_MISFORTUNE,
    ].includes(eventType);
}
