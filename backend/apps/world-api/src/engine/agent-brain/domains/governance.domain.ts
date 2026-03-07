
import { AgentContext, NeedUrgency, CandidateIntent } from '../types.js';

export class GovernanceDomain {

    static getCandidates(ctx: AgentContext, _urgencies: NeedUrgency[]): CandidateIntent[] {
        const candidates: CandidateIntent[] = [];

        // 1. VOTING (Election Active)
        if (ctx.election && ctx.tick < ctx.election.endTick && ctx.election.candidates.length > 0) {
            const scored = ctx.election.candidates.map((candidate) => {
                const rel = ctx.relationships.find(r => r.targetId === candidate.actorId);
                const trust = Number(rel?.trust ?? 0);
                const strength = Number(rel?.strength ?? 0);
                const romance = Number(rel?.romance ?? 0);
                const score = 10 + (trust * 0.4) + (strength * 0.4) + (romance * 0.2);
                return { candidate, score };
            });
            scored.sort((a, b) => b.score - a.score);
            const topScore = scored[0]?.score ?? 0;
            const topCandidates = scored.filter(s => s.score === topScore).map(s => s.candidate);
            const pickIndex = deterministicPickIndex(`${ctx.agent.id}-${ctx.tick}`, topCandidates.length);
            const candidate = topCandidates[pickIndex];
            if (candidate) {
                candidates.push({
                    intentType: 'INTENT_VOTE',
                    params: { electionId: ctx.election.id, candidateId: candidate.id },
                    basePriority: 45,
                    personalityBoost: 0,
                    reason: `Voting for ${candidate.name} in active election`,
                    domain: 'governance',
                });
            }
        }

        // 2. MAYORAL DUTIES (Minimal)
        const isMayor = ctx.city?.mayorId && ctx.city.mayorId === ctx.agent.id;
        if (isMayor && ctx.economy) {
            if (ctx.economy.unemployment > 0.3) {
                const aidAmount = Math.max(50, Math.round((ctx.economy.avg_wage_public ?? ctx.economy.avg_wage ?? 50) * 0.5));
                candidates.push({
                    intentType: 'INTENT_CITY_SOCIAL_AID',
                    params: {
                        cityId: ctx.state.cityId,
                        payload: {
                            aidAmount,
                            justification: 'unemployment_high',
                        }
                    },
                    basePriority: 35,
                    personalityBoost: 0,
                    reason: 'Mayor proposes social aid due to high unemployment',
                    domain: 'governance',
                });
            }
        }

        return candidates;
    }
}

function deterministicPickIndex(seedInput: string, length: number): number {
    let hash = 0;
    for (let i = 0; i < seedInput.length; i++) {
        hash = (hash * 31 + seedInput.charCodeAt(i)) >>> 0;
    }
    return length > 0 ? hash % length : 0;
}
