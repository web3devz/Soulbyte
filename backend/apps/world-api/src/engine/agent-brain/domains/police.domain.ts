
import { AgentContext, NeedUrgency, CandidateIntent } from '../types.js';
import { PersonalityWeights } from '../personality-weights.js';

export class PoliceDomain {

    static getCandidates(ctx: AgentContext, urgencies: NeedUrgency[]): CandidateIntent[] {
        const candidates: CandidateIntent[] = [];

        // Only for police officers
        if (ctx.job.publicEmployment?.role !== 'POLICE_OFFICER') return candidates;

        // PATROL
        // If decent energy and not busy
        candidates.push({
            intentType: 'INTENT_PATROL',
            params: {},
            basePriority: 50, // Standard duty
            personalityBoost: PersonalityWeights.getBoost(ctx.personality.workEthic, true),
            reason: 'On duty patrol',
            domain: 'police',
        });

        // ARREST (evidence signal)
        const recentCrimeCount = ctx.crimeSignals?.recentCount ?? 0;
        if (recentCrimeCount > 0) {
            const suspect = ctx.nearbyAgents.find((agent) => agent.isEnemy || agent.reputation < -20);
            if (suspect) {
                const securityBoost = (ctx.city.securityLevel ?? 0) >= 70 ? 10 : 0;
                candidates.push({
                    intentType: 'INTENT_ARREST',
                    params: { targetId: suspect.id },
                    basePriority: 65 + Math.min(15, recentCrimeCount * 2) + securityBoost,
                    personalityBoost: PersonalityWeights.getBoost(ctx.personality.workEthic, true),
                    reason: `Arresting suspect after recent crimes`,
                    domain: 'police',
                });
            }
        }

        return candidates;
    }
}
