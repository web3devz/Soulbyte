import { prisma } from '../db.js';

const DECAY = {
    anger: 2,
    fear: 1,
    confidence: 1,
    desperation: 0.5,
    pride: 1,
    loneliness: 0.5
};

function clamp(value: number): number {
    return Math.max(0, Math.min(100, value));
}

export async function applyEmotionalDecay(currentTick: number): Promise<number> {
    const agents = await prisma.actor.findMany({
        where: { kind: 'agent', frozen: false },
        include: { agentState: true }
    });

    let updated = 0;
    for (const agent of agents) {
        const state = agent.agentState;
        if (!state) continue;
        if (state.activityState === 'RESTING') continue;
        const emotions = (state.emotions as any) || {};
        const next = {
            anger: clamp((emotions.anger ?? 0) - DECAY.anger),
            fear: clamp((emotions.fear ?? 0) - DECAY.fear),
            confidence: clamp((emotions.confidence ?? 0) - DECAY.confidence),
            desperation: clamp((emotions.desperation ?? 0) - DECAY.desperation),
            pride: clamp((emotions.pride ?? 0) - DECAY.pride),
            loneliness: clamp((emotions.loneliness ?? 0) - DECAY.loneliness),
        };

        // Conflicts: confidence suppresses fear
        if (next.confidence > 50) {
            next.fear = clamp(next.fear * 0.5);
        }

        // Max 3 emotions above 50
        const above = Object.entries(next).filter(([, v]) => v > 50);
        if (above.length > 3) {
            const sorted = above.sort((a, b) => a[1] - b[1]);
            for (let i = 0; i < sorted.length - 3; i++) {
                next[sorted[i][0] as keyof typeof next] = 50;
            }
        }

        await prisma.agentState.update({
            where: { actorId: agent.id },
            data: { emotions: next }
        });
        updated += 1;
    }
    return updated;
}
