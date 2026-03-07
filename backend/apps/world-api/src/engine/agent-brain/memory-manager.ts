
import { IntentDecision } from './types.js';

export class MemoryManager {
    static recentDecisions = new Map<string, { intentType: string; tick: number; result: string }[]>();

    /**
     * Commits the decision to the agent's memory.
     * In MVP, this relies on the World Engine's event log, but we can hook in here
     * for immediate "short-term" updates if needed before the DB transaction clears.
     * 
     * Currently, the World Engine handles the persistent event generation.
     * This class acts as a placeholder for future vector memory or more complex state tracking.
     */
    static async rememberDecision(agentId: string, decision: IntentDecision, tick: number, result: string = 'pending') {
        const history = this.recentDecisions.get(agentId) ?? [];
        history.push({ intentType: decision.intentType, tick, result });
        if (history.length > 20) history.shift();
        this.recentDecisions.set(agentId, history);
    }

    /**
     * Retrieves specific recent memories relevant to a context.
     * (Placeholder for future expansion)
     */
    static async recall(agentId: string, query: string) {
        return [];
    }

    static recordIntentResult(agentId: string, intentType: string, tick: number, result: string) {
        const history = this.recentDecisions.get(agentId) ?? [];
        history.push({ intentType, tick, result });
        if (history.length > 20) history.shift();
        this.recentDecisions.set(agentId, history);
    }

    static getRecentFailures(agentId: string, intentType: string, currentTick: number, windowTicks: number = 100): number {
        const history = this.recentDecisions.get(agentId) ?? [];
        const cutoff = windowTicks <= 0 ? 0 : Math.max(0, currentTick - windowTicks);
        return history.filter(h => h.intentType === intentType && h.result === 'blocked' && h.tick >= cutoff).length;
    }
}
