
import { WorldReader } from './world-reader.js';
import { NeedsController } from './needs-controller.js';
import { UrgencyLevel } from './types.js';
import { DecisionEngine } from './decision-engine.js';
import { SafetyGate } from './safety-gate.js';
import { MemoryManager } from './memory-manager.js';
import { SeededRNG } from '../../utils/rng.js';

export interface IntentSubmission {
    intentType: string;
    params: any;
    priority: number;
    reason: string;
    skillName?: string;
    budgetExceeded?: string[];
}

export class AgentBrain {

    /**
     * Called by tick-runner.ts for each active agent per tick.
     * Returns exactly one intent (or INTENT_IDLE).
     * 
     * MUST be deterministic: same (agent, worldState, tick, seed) -> same intent
     */
    async decideAction(
        agentId: string,
        tick: number,
        seed: string
    ): Promise<IntentSubmission> {

        try {
            // 1. WORLD READER — Load everything the agent "sees"
            const context = await WorldReader.loadContext(agentId, tick);
            // Returns: { agent, needs, personality, city, economy, relationships,
            //            businesses, housing, job, inventory, memory, ownerSuggestion }

            // 2. NEEDS CONTROLLER — What's urgent?
            const urgencies = NeedsController.evaluate(context);
            // Returns: prioritized list of { need, level, domain, urgency }

            // 3. DECISION ENGINE — Pick the best action
            // We need a unique seed for this specific decision event to ensure independence from other agents
            const decisionSeed = `${seed}-${agentId}-${tick}`;
            const rng = new SeededRNG(decisionSeed);

            const decision = await DecisionEngine.decide(context, urgencies, rng);
            // Returns: { intentType, params, reason, confidence }

            // 4. SAFETY GATE — Is this intent valid right now?
            const validated = SafetyGate.validate(decision, context);
            // Checks: is agent working? jailed? frozen? Can afford it?

            // 5. MEMORY UPDATE (Short term)
            // Fire and forget, or await if strictly necessary
            MemoryManager.rememberDecision(agentId, decision, tick);

            return {
                intentType: validated.intentType,
                params: validated.params,
                priority: decision.confidence || 0.5,
                reason: validated.reason,
                skillName: 'agent_brain',
                budgetExceeded: decision.budgetExceeded
            };

        } catch (error) {
            console.error(`BRAIN CRASH for agent ${agentId}:`, error);
            return {
                intentType: 'INTENT_IDLE',
                params: {},
                priority: 0,
                reason: 'Brain Crash Fallback'
            };
        }
    }
}
