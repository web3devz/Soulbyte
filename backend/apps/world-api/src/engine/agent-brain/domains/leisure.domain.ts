import { AgentContext, NeedUrgency, CandidateIntent, UrgencyLevel, IntentType } from '../types.js';
import { PersonalityWeights } from '../personality-weights.js';
import { BusinessType } from '../../../../../../generated/prisma/index.js';
import { GAMING_CONFIG } from '../../../config/gaming.js';
import { debugLog } from '../../../utils/debug-log.js';

export class LeisureDomain {

    static getCandidates(ctx: AgentContext, urgencies: NeedUrgency[]): CandidateIntent[] {
        const candidates: CandidateIntent[] = [];
        const funUrgency = urgencies.find(u => u.need === 'fun');
        const purposeUrgency = urgencies.find(u => u.need === 'purpose');
        const funValue = funUrgency?.value ?? ctx.needs.fun ?? 60;
        const maxSurvivalUrgency = Math.max(
            ...urgencies.filter(u => u.domain === 'survival').map(u => u.urgency),
            UrgencyLevel.NONE
        );
        const freeTime = maxSurvivalUrgency <= UrgencyLevel.LOW
            && ctx.state.activityState === 'IDLE';
        const publicFunPlaces = ctx.publicPlaces.filter(place =>
            ['MUNICIPAL_THEATER', 'COMMUNITY_CENTER', 'CENTRAL_PLAZA'].includes(place.type)
        );
        const publicFunPlace = publicFunPlaces[0] ?? null;

        // Personality-based casino affinity: riskTolerance drives casino preference
        const riskTolerance = ctx.personality.riskTolerance ?? 50;
        const casinoAffinityBoost = Math.max(0, (riskTolerance - 30) * 0.3); // 0-21 range

        // Whether agent can visit casinos (not on cooldown)
        const canVisitCasino = !(ctx.state.noGamesUntilTick && ctx.tick < ctx.state.noGamesUntilTick);

        // 1. VISIT CASINO / TAVERN (urgent fun)
        if (funUrgency && funUrgency.urgency >= UrgencyLevel.LOW) {
            const funPlaces = ctx.businesses.inCity.filter(b =>
                canVisitCasino
                    ? (b.businessType === BusinessType.CASINO || b.businessType === BusinessType.TAVERN)
                    : (b.businessType === BusinessType.TAVERN)
            );

            if (funPlaces.length > 0) {
                // Sort: casinos first (highest fun gain), then taverns
                const sorted = [...funPlaces].sort((a, b) => {
                    const order: Record<string, number> = { CASINO: 0, TAVERN: 1 };
                    return (order[a.businessType] ?? 3) - (order[b.businessType] ?? 3);
                });
                const place = sorted[0];

                // Casinos get higher priority due to higher fun gain
                const isCasino = place.businessType === BusinessType.CASINO;
                const casinoBonus = isCasino ? 15 + casinoAffinityBoost : 0;

                candidates.push({
                    intentType: IntentType.INTENT_VISIT_BUSINESS,
                    params: isCasino
                        ? { businessId: place.id, bet: 100 + Math.floor(riskTolerance * 2) }
                        : { businessId: place.id },
                    basePriority: 45 + casinoBonus + ((100 - funUrgency.value) * 0.35),
                    personalityBoost: PersonalityWeights.getBoost(ctx.personality.creativity, true),
                    reason: isCasino
                        ? `Gambling at casino (risk tolerance: ${riskTolerance})`
                        : `Having fun at ${place.businessType}`,
                    domain: 'leisure',
                });
            }
        }

        // 1b. VISIT GYM for purpose
        if (purposeUrgency && purposeUrgency.urgency >= UrgencyLevel.MODERATE) {
            const purposePlaces = ctx.businesses.inCity.filter(b =>
                b.businessType === BusinessType.GYM
            );
            if (purposePlaces.length > 0) {
                const place = purposePlaces[0];
                candidates.push({
                    intentType: IntentType.INTENT_VISIT_BUSINESS,
                    params: { businessId: place.id },
                    basePriority: 38 + ((100 - purposeUrgency.value) * 0.35),
                    personalityBoost: PersonalityWeights.getBoost(ctx.personality.patience, true),
                    reason: `Seeking purpose at ${place.businessType}`,
                    domain: 'leisure',
                });
            }
        }

        // 3. FREE TIME - Prefer casino > tavern > PvP
        if ((!funUrgency || funUrgency.urgency === UrgencyLevel.NONE) && freeTime) {
            const funPlaces = ctx.businesses.inCity.filter(b =>
                canVisitCasino
                    ? (b.businessType === BusinessType.CASINO || b.businessType === BusinessType.TAVERN)
                    : (b.businessType === BusinessType.TAVERN)
            );
            if (funPlaces.length > 0) {
                // Sort: casinos first
                const sorted = [...funPlaces].sort((a, b) => {
                    const order: Record<string, number> = { CASINO: 0, TAVERN: 1 };
                    return (order[a.businessType] ?? 3) - (order[b.businessType] ?? 3);
                });
                const place = sorted[0];
                const isCasino = place.businessType === BusinessType.CASINO;
                const casinoBonus = isCasino ? 10 + casinoAffinityBoost : 0;
                const freeTimeBoost = Math.max(0, (ctx.personality.creativity - 50) * 0.2);

                candidates.push({
                    intentType: IntentType.INTENT_VISIT_BUSINESS,
                    params: isCasino
                        ? { businessId: place.id, bet: 100 + Math.floor(riskTolerance * 2) }
                        : { businessId: place.id },
                    basePriority: 28 + casinoBonus + freeTimeBoost + Math.max(0, (60 - funValue) * 0.1),
                    personalityBoost: PersonalityWeights.getBoost(ctx.personality.creativity, true),
                    reason: isCasino
                        ? `Free time gambling (risk: ${riskTolerance})`
                        : `Spending free time at ${place.businessType}`,
                    domain: 'leisure',
                });
            } else if (ctx.state.balanceSbyte >= GAMING_CONFIG.MIN_STAKE && ctx.needs.energy >= 45) {
                // PvP fallback: only when no casino/tavern in city
                const hasPvpCandidate = ctx.nearbyAgents.some(agent => {
                    if (agent.id === ctx.agent.id) return false;
                    if (agent.isEnemy) return false;
                    if (agent.activityState === 'WORKING') return false;
                    return true;
                });
                const hasPendingChallenge = (ctx.pendingGameChallenges?.length ?? 0) > 0;
                if (hasPvpCandidate || hasPendingChallenge) {
                    return candidates;
                }
                const stake = Math.max(GAMING_CONFIG.MIN_STAKE, Math.round(ctx.state.balanceSbyte * 0.02));
                candidates.push({
                    intentType: IntentType.INTENT_PLAY_GAME,
                    params: { gameType: 'DICE', stake },
                    basePriority: 24 + Math.max(0, (60 - funValue) * 0.1),
                    personalityBoost: PersonalityWeights.getBoost(ctx.personality.creativity, true),
                    reason: publicFunPlace
                        ? `Playing games at ${publicFunPlace.name}`
                        : `Playing a quick game for fun`,
                    domain: 'leisure',
                });
            }
        }

        // 2. IDLE (Relax) - Always an option for leisure/fun if poor
        if (funUrgency && funUrgency.urgency >= UrgencyLevel.MODERATE) {
            candidates.push({
                intentType: IntentType.INTENT_IDLE,
                params: {},
                basePriority: 22 + ((100 - funUrgency.value) * 0.25),
                personalityBoost: PersonalityWeights.getBoost(ctx.personality.patience, true),
                reason: `Relaxing to improve mood`,
                domain: 'leisure',
            });
        }

        debugLog('leisure.candidate_summary', {
            agentId: ctx.agent.id,
            tick: ctx.tick,
            funUrgency: funUrgency?.urgency ?? null,
            funValue,
            freeTime,
            activityState: ctx.state.activityState,
            maxSurvivalUrgency,
            casinoAffinityBoost,
            canVisitCasino,
            funPlaces: ctx.businesses.inCity.filter(b =>
                canVisitCasino
                    ? (b.businessType === BusinessType.CASINO || b.businessType === BusinessType.TAVERN)
                    : (b.businessType === BusinessType.TAVERN)
            ).length,
            publicFunPlaces: publicFunPlaces.length,
            candidateCount: candidates.length,
        });

        return candidates;
    }
}
