
import { AgentContext, NeedUrgency, CandidateIntent, UrgencyLevel } from '../types.js';

export class CrimeDomain {

    static getCandidates(ctx: AgentContext, urgencies: NeedUrgency[]): CandidateIntent[] {
        const candidates: CandidateIntent[] = [];

        // Crime preconditions
        if (this.shouldSkipCrime(ctx)) return candidates;

        // Find a target (nearby agent with more money)
        const target = this.findTarget(ctx);
        if (!target) return candidates;

        const isDesperate = urgencies.some(u => u.urgency === UrgencyLevel.CRITICAL);
        const riskScore = this.computeRiskScore(ctx);
        if (riskScore > 75 && !isDesperate) return candidates;
        const hasHighAggression = ctx.personality.aggression > 60;

        // --- THEFT ---
        candidates.push(this.createTheftIntent(ctx, target.actorId, isDesperate));

        // --- ASSAULT ---
        if (hasHighAggression) {
            candidates.push(this.createAssaultIntent(ctx, target.actorId, isDesperate));
        }

        // --- FRAUD ---
        if (ctx.personality.creativity > 50) {
            candidates.push(this.createFraudIntent(ctx, target.actorId, isDesperate));
        }

        return candidates;
    }

    private static shouldSkipCrime(ctx: AgentContext): boolean {
        const isPolice = ctx.job.publicEmployment?.role === 'POLICE_OFFICER';
        if (isPolice) return true;

        // V6: Poverty threshold — any agent below 1000 SBYTE is eligible for crime
        // regardless of wealth tier (desperation overrides tier-based suppression)
        const isPoverty = ctx.state.balanceSbyte < 1000;

        const isBroke = ctx.state.wealthTier === 'W0' || ctx.state.wealthTier === 'W1' || ctx.state.wealthTier === 'W2';
        const hasHighAggression = ctx.personality.aggression > 60;
        const securityLevel = ctx.city.securityLevel ?? 0;
        const highSecurity = securityLevel >= 70;

        // Crime becomes an option when:
        // 1. In poverty regardless of wealth tier (V6: NEW)
        // 2. Broke (W0-W2, legacy behaviour)
        // 3. High aggression (personality-driven crime)
        // High security suppresses opportunistic crime (but not poverty crime)
        if (isPoverty) {
            // Even high security doesn't fully suppress poverty crime
            return highSecurity && ctx.personality.riskTolerance < 55;
        }

        if (highSecurity && !isBroke && ctx.personality.riskTolerance < 70) return true;
        return !isBroke && !hasHighAggression;
    }

    private static computeRiskScore(ctx: AgentContext): number {
        const securityLevel = ctx.city.securityLevel ?? 0;
        const recentArrests = ctx.crimeSignals?.recentArrestCount ?? 0;
        const recentCrimes = ctx.crimeSignals?.recentCount ?? 0;
        const riskTolerance = ctx.personality.riskTolerance ?? 50;
        const baseRisk = securityLevel * 0.4 + recentArrests * 5 + recentCrimes * 1.5;
        const toleranceOffset = (riskTolerance - 50) * 0.4;
        return Math.max(0, Math.min(100, baseRisk - toleranceOffset));
    }

    private static findTarget(ctx: AgentContext) {
        // Find a target (nearby agent with more money)
        const currentRank = getWealthTierRank(ctx.state.wealthTier);
        const targets = ctx.nearbyAgents.filter(a => {
            const targetRank = getWealthTierRank(a.wealthTier);
            return (
                a.actorId !== ctx.agent.id &&
                a.activityState !== 'WORKING' &&
                targetRank > currentRank
            );
        });
        return targets.length > 0 ? targets[0] : null;
    }

    private static createTheftIntent(ctx: AgentContext, targetId: string, isDesperate: boolean): CandidateIntent {
        return {
            intentType: 'INTENT_STEAL',
            params: { targetId },
            basePriority: isDesperate ? 45 : 20,  // Desperation raises priority
            personalityBoost:
                (ctx.personality.aggression - 50) * 0.2  // Aggressive: up to +10
                + (ctx.personality.riskTolerance - 50) * 0.2  // Risk-tolerant: up to +10
                + (isDesperate ? 15 : 0),  // Desperation bonus
            reason: isDesperate ? 'Desperate — stealing to survive' : 'Opportunity for theft',
            domain: 'crime',
        };
    }

    private static createAssaultIntent(ctx: AgentContext, targetId: string, isDesperate: boolean): CandidateIntent {
        return {
            intentType: 'INTENT_ASSAULT',
            params: { targetId },
            basePriority: isDesperate ? 35 : 10,
            personalityBoost:
                (ctx.personality.aggression - 50) * 0.3  // Aggressive agents strongly prefer this
                + (isDesperate ? 10 : 0),
            reason: isDesperate ? 'Desperate — mugging to survive' : 'Aggressive impulse',
            domain: 'crime',
        };
    }

    private static createFraudIntent(ctx: AgentContext, targetId: string, isDesperate: boolean): CandidateIntent {
        return {
            intentType: 'INTENT_FRAUD',
            params: { targetId },
            basePriority: isDesperate ? 30 : 15,
            personalityBoost:
                (ctx.personality.creativity - 50) * 0.2
                + (ctx.personality.riskTolerance - 50) * 0.15,
            reason: 'Running a fraud scheme',
            domain: 'crime',
        };
    }
}

function getWealthTierRank(tier?: string | null): number {
    if (!tier) return 0;
    const numeric = Number(tier.replace('W', ''));
    return Number.isFinite(numeric) ? numeric : 0;
}
