
import { Actor } from '../../../../../generated/prisma/index.js';
import { AgentPersonality } from './types.js';

// Deterministic DNA extraction from wallet address (or seed)
// Implementation matches the "Wallet DNA" concept in CORE_SOULBYTE_CONCEPT

export class PersonalityWeights {

    /**
     * Extracts personality traits from the agent's seed/DNA.
     * If wallet DNA isn't directly stored, we use the actor's seed.
     */
    static extract(actor: Actor): AgentPersonality {
        const dna = BigInt(actor.seed);

        // Helper to get 0-100 from specific bits of the seed
        const getTrait = (shift: number) => Number((dna >> BigInt(shift)) % 101n);

        // Core Traits (stored in seed)
        const aggression = getTrait(0);
        const creativity = getTrait(8);
        const patience = getTrait(16);
        const luck = actor.luck; // Luck is stored independently
        const speed = getTrait(24);
        const riskTolerance = getTrait(32);

        // Derived Traits (Logic mappings)

        // Loyalty: High patience + low risk
        const loyalty = Math.min(100, Math.max(0, (patience + (100 - riskTolerance)) / 2));

        // Self Interest: High aggression + high risk
        const selfInterest = Math.min(100, Math.max(0, (aggression + riskTolerance) / 2));

        // Energy Management: High patience + low speed (deliberate)
        const energyManagement = Math.min(100, Math.max(0, (patience + (100 - speed)) / 2));

        // Work Ethic: High patience + low creativity (steady worker vs dreamer)
        const workEthic = Math.min(100, Math.max(0, (patience + (100 - creativity)) / 2));

        // Social Need: High speed (extrovert?) + low aggression (friendly) - rough heuristic
        const socialNeed = Math.min(100, Math.max(0, (speed + (100 - aggression)) / 2));

        return {
            aggression,
            creativity,
            patience,
            luck,
            speed,
            riskTolerance,
            loyalty,
            selfInterest,
            energyManagement,
            workEthic,
            socialNeed
        };
    }

    /**
     * Calculates a priority boost based on a primary trait match.
     * @param value The trait value (0-100)
     * @param preferredHigh If true, higher trait = higher boost. If false, lower trait = higher boost.
     */
    static getBoost(value: number, preferredHigh: boolean = true): number {
        const centered = value - 50; // -50 to +50
        const raw = preferredHigh ? centered : -centered;
        return raw * 0.4; // Scale to -20 to +20 range
    }
}
