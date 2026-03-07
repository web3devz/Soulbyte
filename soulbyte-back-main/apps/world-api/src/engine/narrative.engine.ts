import { prisma } from '../db.js';
import { EventType } from '../types/event.types.js';

const DEFAULT_SEVERITY = 3;

export async function generateTickNarrative(tick: number, events: { actorId: string; type: EventType; targetIds: string[] }[]): Promise<number> {
    let created = 0;
    for (const ev of events) {
        const headline = `${ev.type} by ${ev.actorId}`;
        await prisma.narrativeEvent.create({
            data: {
                eventType: ev.type,
                headline,
                summary: null,
                actorIds: [ev.actorId, ...(ev.targetIds || [])],
                cityId: null,
                tick,
                severity: DEFAULT_SEVERITY,
                tags: ['system']
            }
        });
        created += 1;
    }
    return created;
}
