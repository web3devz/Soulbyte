import { prisma } from '../db.js';

export async function recordIntentOutcome(params: {
    actorId: string;
    tick: number;
    intentType: string;
    outcome: string;
    contextActorId?: string | null;
    sbyteChange?: number;
    emotionalImpact?: string;
}): Promise<void> {
    await prisma.agentMemory.create({
        data: {
            actorId: params.actorId,
            tick: params.tick,
            intentType: params.intentType,
            outcome: params.outcome,
            contextActorId: params.contextActorId ?? null,
            sbyteChange: params.sbyteChange ?? 0,
            emotionalImpact: params.emotionalImpact ?? null
        }
    });

    const memories = await prisma.agentMemory.findMany({
        where: { actorId: params.actorId },
        orderBy: { tick: 'desc' },
        skip: 50,
        select: { id: true }
    });
    if (memories.length > 0) {
        await prisma.agentMemory.deleteMany({
            where: { id: { in: memories.map(m => m.id) } }
        });
    }
}
