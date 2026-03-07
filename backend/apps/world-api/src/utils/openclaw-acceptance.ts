type AgentStateLike = {
    health?: number | null;
    energy?: number | null;
    hunger?: number | null;
    social?: number | null;
    fun?: number | null;
    purpose?: number | null;
    activityState?: string | null;
};

export function calculateAcceptanceProbability(state: AgentStateLike | null, intentType: string): number {
    if (!state) return 0.3;

    let probability = 0.8; // Owner suggestions are honored unless unsafe

    const needs = [
        state.health ?? 50,
        state.energy ?? 50,
        state.hunger ?? 50,
        state.social ?? 50,
        state.fun ?? 50,
        state.purpose ?? 50,
    ];
    const avgNeeds = needs.reduce((a, b) => a + b, 0) / needs.length;
    probability += (avgNeeds - 50) / 500;

    const minNeed = Math.min(...needs);
    if (minNeed < 25) {
        probability -= 0.4;
    }

    if (intentType === 'INTENT_MOVE_CITY') {
        if ((state.health ?? 50) < 50) probability -= 0.25;
        if ((state.energy ?? 50) < 35) probability -= 0.2;
        if ((state.hunger ?? 50) < 35) probability -= 0.2;
    }

    if (state.activityState === 'JAILED') {
        probability = 0;
    }

    return Math.max(0, Math.min(1, probability));
}
