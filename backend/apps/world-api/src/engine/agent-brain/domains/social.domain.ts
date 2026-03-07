import { AgentContext, NeedUrgency, CandidateIntent, UrgencyLevel, IntentType } from '../types.js';
import { PersonalityWeights } from '../personality-weights.js';
import { BusinessType } from '../../../../../../generated/prisma/index.js';
import { debugLog } from '../../../utils/debug-log.js';

// V6: These thresholds were dramatically reduced so more agents engage romantically.
// Old: flirt>55, romantic>60, dating>70 — very few agents qualified.
// New: flirt>35, romantic>40, dating>50 — most agents will engage socially/romantically.
const FLIRT_PERSONALITY_THRESHOLD = 35;
const ROMANTIC_PERSONALITY_THRESHOLD = 40;
const DATING_PERSONALITY_THRESHOLD = 50;

// V6: Minimum romance score to allow romantic interaction (was 25 strength, 20 trust)
// Lowered to allow early-stage relationship romance to develop
const ROMANTIC_MIN_STRENGTH = 15;
const ROMANTIC_MIN_TRUST = 10;

export class SocialDomain {

    static getCandidates(ctx: AgentContext, urgencies: NeedUrgency[]): CandidateIntent[] {
        const candidates: CandidateIntent[] = [];
        const socialUrgency = urgencies.find(u => u.need === 'social');
        const socialValue = socialUrgency?.value ?? ctx.needs.social ?? 50;
        const hasSocialFunds = (required: number) =>
            ctx.state.balanceSbyte >= required && ctx.state.balanceMon > 0;
        const maxSurvivalUrgency = Math.max(
            ...urgencies.filter(u => u.domain === 'survival').map(u => u.urgency),
            UrgencyLevel.NONE
        );
        // V6: freeTime condition relaxed — also active at LOW survival level, not just NONE
        const freeTime = maxSurvivalUrgency <= UrgencyLevel.MODERATE
            && ctx.state.activityState === 'IDLE';
        const relationshipByTarget = new Map(
            ctx.relationships.map(r => {
                // Prisma Relationship uses actorAId/actorBId — resolve which one is the 'other' agent
                const otherId = r.actorAId === ctx.agent.id ? r.actorBId : r.actorAId;
                return [otherId, r] as const;
            })
        );
        const currentCityId = ctx.state.cityId;
        const sameCityAgents = ctx.nearbyAgents.filter((agent) => agent.cityId === currentCityId);
        const crossCityAgents = ctx.nearbyAgents.filter((agent) => agent.cityId && agent.cityId !== currentCityId);
        const socialPublicPlaces = ctx.publicPlaces.filter(place =>
            ['PUBLIC_LIBRARY', 'CENTRAL_PLAZA', 'COMMUNITY_CENTER', 'MUNICIPAL_THEATER'].includes(place.type)
        );
        const socialPlace = socialPublicPlaces[0] ?? null;

        // V6: Romantic boost — if social or fun are low, romantic actions get extra priority
        const romanticNeedBoost = ((ctx.needs.fun ?? 100) < 50 || (ctx.needs.social ?? 100) < 50) ? 12 : 0;

        // V6: Relaxed pool filter — target can be RESTING or IDLE, not just IDLE
        // This dramatically increases the pool of potential social targets
        const buildSocialPool = (baseAgents: typeof sameCityAgents, cost: number) =>
            baseAgents.filter((agent) => {
                if (agent.id === ctx.agent.id) return false;
                const rel = relationshipByTarget.get(agent.id);
                if (Number(rel?.betrayal ?? 0) >= 80) return false;
                // V6: Allow RESTING agents to be approached socially (removed strict IDLE)
                if (agent.activityState === 'WORKING') return false;
                if (agent.balanceSbyte < cost && agent.balanceMon <= 0) return false;
                return !rel || (Number(rel.betrayal ?? 0) < 80 && Number(rel.trust ?? 0) > 3);
            });

        if (socialUrgency && socialUrgency.urgency >= UrgencyLevel.LOW) {
            const intensity = socialUrgency.urgency;
            const socializeCost = 5 * Math.max(1, Math.min(3, intensity));
            const nearbyPool = buildSocialPool(sameCityAgents, socializeCost);
            const crossCityPool = buildSocialPool(crossCityAgents, socializeCost);
            const fallbackPool = nearbyPool.length > 0
                ? nearbyPool
                : crossCityPool.length > 0
                    ? crossCityPool
                    : ctx.nearbyAgents.filter((agent) => {
                        if (agent.id === ctx.agent.id) return false;
                        const rel = relationshipByTarget.get(agent.id);
                        if (agent.activityState === 'WORKING') return false;
                        return Number(rel?.betrayal ?? 0) < 80;
                    });

            // 1. SOCIALIZE (general relationship-building)
            if (fallbackPool.length > 0 && hasSocialFunds(socializeCost)) {
                const socializeTarget = pickSocializeTarget(fallbackPool, relationshipByTarget);
                if (socializeTarget) {
                    candidates.push({
                        intentType: IntentType.INTENT_SOCIALIZE,
                        params: { targetId: socializeTarget.id, intensity: socialUrgency.urgency },
                        // V6: Raised base priority 35→45 to compete better with work
                        basePriority: 45 + ((100 - socialUrgency.value) * 0.3),
                        personalityBoost: PersonalityWeights.getBoost(ctx.personality.socialNeed, true),
                        reason: socialPlace
                            ? `Meeting people at ${socialPlace.name}`
                            : `Spending time with ${socializeTarget.name}`,
                        domain: 'social',
                    });
                }
            }

            // 1b. Visit social venues if available
            const socialPlaces = ctx.businesses.inCity.filter(b =>
                b.businessType === BusinessType.TAVERN
            );
            if (socialPlaces.length > 0) {
                const place = socialPlaces[0];
                candidates.push({
                    intentType: IntentType.INTENT_VISIT_BUSINESS,
                    params: { businessId: place.id },
                    // V6: Raised base priority 50→60
                    basePriority: 60 + ((100 - socialUrgency.value) * 0.4),
                    personalityBoost: PersonalityWeights.getBoost(ctx.personality.socialNeed, true),
                    reason: `Meeting people at ${place.businessType}`,
                    domain: 'social',
                });
            }

            // 2. PROPOSE ALLIANCE (only when trust is high)
            const allianceTarget = pickAllianceTarget(nearbyPool, relationshipByTarget);
            if (allianceTarget) {
                const allianceType = pickAllianceType(ctx, allianceTarget, relationshipByTarget);
                candidates.push({
                    intentType: IntentType.INTENT_PROPOSE_ALLIANCE,
                    params: { targetId: allianceTarget.id, allianceType },
                    basePriority: 28 + ((100 - socialUrgency.value) * 0.2),
                    personalityBoost: PersonalityWeights.getBoost(ctx.personality.socialNeed, true),
                    reason: `Formalizing alliance with ${allianceTarget.name}`,
                    domain: 'social',
                });
            }

            // 3. FLIRT — V6: lowered threshold 55→35, more agents will flirt
            if (ctx.personality.socialNeed > FLIRT_PERSONALITY_THRESHOLD) {
                const flirtTarget = pickFlirtTarget(nearbyPool, relationshipByTarget);
                if (flirtTarget) {
                    candidates.push({
                        intentType: IntentType.INTENT_FLIRT,
                        params: { targetId: flirtTarget.id },
                        // V6: raised base priority 24→32 + romantic need boost
                        basePriority: 32 + romanticNeedBoost,
                        personalityBoost: PersonalityWeights.getBoost(ctx.personality.socialNeed, true),
                        reason: `Flirting with ${flirtTarget.name}`,
                        domain: 'social',
                    });
                }
            }

            // 3b. ROMANTIC INTERACTION — V6: lowered threshold 60→40
            if (ctx.personality.socialNeed > ROMANTIC_PERSONALITY_THRESHOLD) {
                const romanticTarget = pickRomanticTarget(fallbackPool, relationshipByTarget);
                if (romanticTarget) {
                    candidates.push({
                        intentType: IntentType.INTENT_ROMANTIC_INTERACTION,
                        params: { targetId: romanticTarget.id, intensity: socialUrgency.urgency },
                        // V6: raised base priority 26→36 + romantic need boost
                        basePriority: 36 + ((100 - socialUrgency.value) * 0.25) + romanticNeedBoost,
                        personalityBoost: PersonalityWeights.getBoost(ctx.personality.socialNeed, true),
                        reason: `Sharing a romantic moment with ${romanticTarget.name}`,
                        domain: 'social',
                    });
                }
            }

            // 4. DATING — V6: lowered threshold 70→50
            if (ctx.personality.socialNeed > DATING_PERSONALITY_THRESHOLD) {
                const datingTarget = pickDatingTarget(nearbyPool, relationshipByTarget);
                if (datingTarget) {
                    candidates.push({
                        intentType: IntentType.INTENT_PROPOSE_DATING,
                        params: { targetId: datingTarget.id },
                        // V6: raised base priority 22→30
                        basePriority: 30 + romanticNeedBoost,
                        personalityBoost: PersonalityWeights.getBoost(ctx.personality.socialNeed, true),
                        reason: `Proposing a date to ${datingTarget.name}`,
                        domain: 'social',
                    });
                }
            }
        }

        // V6: Free-time social — always active when IDLE (not just urgency-driven)
        // Raised pool filter — relaxed to allow agents with lower balanceMon
        if ((!socialUrgency || socialUrgency.urgency <= UrgencyLevel.MODERATE) && freeTime) {
            const socializeCost = 3; // V6: reduced cost for casual socializing
            const nearbyPool = buildSocialPool(sameCityAgents, socializeCost);
            const crossCityPool = buildSocialPool(crossCityAgents, socializeCost);
            const fallbackPool = nearbyPool.length > 0
                ? nearbyPool
                : crossCityPool.length > 0
                    ? crossCityPool
                    : ctx.nearbyAgents.filter((agent) => {
                        if (agent.id === ctx.agent.id) return false;
                        const rel = relationshipByTarget.get(agent.id);
                        if (agent.activityState === 'WORKING') return false;
                        return Number(rel?.betrayal ?? 0) < 80;
                    });
            const socializeTarget = pickSocializeTarget(fallbackPool, relationshipByTarget);
            if (socializeTarget && hasSocialFunds(socializeCost)) {
                const socialBoost = Math.max(0, (ctx.personality.socialNeed - 40) * 0.25);
                candidates.push({
                    intentType: IntentType.INTENT_SOCIALIZE,
                    params: { targetId: socializeTarget.id, intensity: 1 },
                    // V6: raised base priority 30→42 for free-time socializing
                    basePriority: 42 + socialBoost + Math.max(0, (60 - socialValue) * 0.15),
                    personalityBoost: PersonalityWeights.getBoost(ctx.personality.socialNeed, true),
                    reason: socialPlace
                        ? `Maintaining connections at ${socialPlace.name}`
                        : `Maintaining social bonds with ${socializeTarget.name}`,
                    domain: 'social',
                });
            }

            const socialPlaces = ctx.businesses.inCity.filter(b =>
                b.businessType === BusinessType.TAVERN
            );
            if (socialPlaces.length > 0) {
                const place = socialPlaces[0];
                candidates.push({
                    intentType: IntentType.INTENT_VISIT_BUSINESS,
                    params: { businessId: place.id },
                    // V6: raised base priority 28→38
                    basePriority: 38 + Math.max(0, (60 - socialValue) * 0.15),
                    personalityBoost: PersonalityWeights.getBoost(ctx.personality.socialNeed, true),
                    reason: `Finding new connections at ${place.businessType}`,
                    domain: 'social',
                });
            }

            // V6: Add idle-time romantic interactions (not just urgency-driven)
            if (ctx.personality.socialNeed > ROMANTIC_PERSONALITY_THRESHOLD) {
                const romanticTarget = pickRomanticTarget(fallbackPool, relationshipByTarget);
                if (romanticTarget) {
                    candidates.push({
                        intentType: IntentType.INTENT_ROMANTIC_INTERACTION,
                        params: { targetId: romanticTarget.id, intensity: 1 },
                        basePriority: 30 + romanticNeedBoost,
                        personalityBoost: PersonalityWeights.getBoost(ctx.personality.socialNeed, true),
                        reason: `Having a romantic moment with ${romanticTarget.name} during free time`,
                        domain: 'social',
                    });
                }
            }

            // V6: Add idle-time flirting
            if (ctx.personality.socialNeed > FLIRT_PERSONALITY_THRESHOLD) {
                const flirtTarget = pickFlirtTarget(nearbyPool, relationshipByTarget);
                if (flirtTarget) {
                    candidates.push({
                        intentType: IntentType.INTENT_FLIRT,
                        params: { targetId: flirtTarget.id },
                        basePriority: 28 + romanticNeedBoost,
                        personalityBoost: PersonalityWeights.getBoost(ctx.personality.socialNeed, true),
                        reason: `Flirting casually with ${flirtTarget.name}`,
                        domain: 'social',
                    });
                }
            }
        }

        // 3. ARREST (Police Only)
        const isPolice = ctx.job.publicEmployment?.role === 'POLICE_OFFICER';
        if (isPolice) {
            const nearbyEnemy = ctx.nearbyAgents.find(a => a.isEnemy || a.reputation < -50);
            if (nearbyEnemy) {
                candidates.push({
                    intentType: IntentType.INTENT_ARREST,
                    params: { targetId: nearbyEnemy.id },
                    basePriority: 80,
                    personalityBoost: ctx.personality.aggression * 0.2,
                    reason: `Police duty: Arresting suspect ${nearbyEnemy.name}`,
                    domain: 'social'
                });
            }
        }

        debugLog('social.candidate_summary', {
            agentId: ctx.agent.id,
            tick: ctx.tick,
            socialUrgency: socialUrgency?.urgency ?? null,
            socialValue,
            freeTime,
            activityState: ctx.state.activityState,
            maxSurvivalUrgency,
            nearbyAgents: ctx.nearbyAgents.length,
            romanticNeedBoost,
            candidateCount: candidates.length,
        });

        return candidates;
    }
}

function pickAllianceTarget(
    nearbyAgents: AgentContext['nearbyAgents'],
    relationshipByTarget: Map<string, AgentContext['relationships'][number]>
) {
    let best: { agent: AgentContext['nearbyAgents'][number]; score: number } | null = null;
    for (const agent of nearbyAgents) {
        const rel = relationshipByTarget.get(agent.id);
        const trust = Number(rel?.trust ?? 30);
        const strength = Number(rel?.strength ?? 30);
        const romance = Number(rel?.romance ?? 0);
        const betrayal = Number(rel?.betrayal ?? 0);
        if (trust < 60 || strength < 60) continue;
        if (betrayal >= 80) continue;
        let score = 30;
        score += (100 - trust) * 0.35;
        score += (100 - strength) * 0.2;
        score -= romance * 0.1;
        score += agent.reputation > 200 ? 5 : 0;
        if (!best || score > best.score) best = { agent, score };
    }
    return best?.agent ?? null;
}

function pickAllianceType(
    ctx: AgentContext,
    target: AgentContext['nearbyAgents'][number],
    relationshipByTarget: Map<string, AgentContext['relationships'][number]>
) {
    const rel = relationshipByTarget.get(target.id);
    const trust = Number(rel?.trust ?? 0);
    const strength = Number(rel?.strength ?? 0);
    const betrayal = Number(rel?.betrayal ?? 0);

    if (betrayal > 40) return 'non_aggression';
    if (ctx.personality.aggression > 65 || ctx.personality.riskTolerance > 65) return 'mutual_defense';
    if (ctx.personality.selfInterest > 65 || ctx.personality.workEthic > 65) return 'trade_pact';
    if (trust > 80 && strength > 80) return 'strategic';
    return 'mutual_defense';
}

function pickSocializeTarget(
    nearbyAgents: AgentContext['nearbyAgents'],
    relationshipByTarget: Map<string, AgentContext['relationships'][number]>
) {
    let best: { agent: AgentContext['nearbyAgents'][number]; score: number } | null = null;
    for (const agent of nearbyAgents) {
        const rel = relationshipByTarget.get(agent.id);
        const trust = Number(rel?.trust ?? 30);
        const strength = Number(rel?.strength ?? 30);
        const betrayal = Number(rel?.betrayal ?? 0);
        if (betrayal >= 80) continue;
        let score = rel ? (100 - strength) * 0.6 + (100 - trust) * 0.4 : 35;
        if (rel && rel.relationshipType === 'RIVALRY') score -= 20;
        if (agent.reputation > 200) score += 5;
        if (!best || score > best.score) best = { agent, score };
    }
    return best?.agent ?? null;
}

function pickDatingTarget(
    nearbyAgents: AgentContext['nearbyAgents'],
    relationshipByTarget: Map<string, AgentContext['relationships'][number]>
) {
    let best: { agent: AgentContext['nearbyAgents'][number]; score: number } | null = null;
    for (const agent of nearbyAgents) {
        const rel = relationshipByTarget.get(agent.id);
        const trust = Number(rel?.trust ?? 0);
        const strength = Number(rel?.strength ?? 0);
        const betrayal = Number(rel?.betrayal ?? 0);
        if (betrayal >= 50) continue;
        // V6: Lowered minimum thresholds (was strength<35, trust<30)
        if (strength < 20 || trust < 15) continue;
        const score = strength * 0.5 + trust * 0.3 + (agent.reputation > 200 ? 10 : 0);
        if (!best || score > best.score) best = { agent, score };
    }
    return best?.agent ?? null;
}

function pickFlirtTarget(
    nearbyAgents: AgentContext['nearbyAgents'],
    relationshipByTarget: Map<string, AgentContext['relationships'][number]>
) {
    let best: { agent: AgentContext['nearbyAgents'][number]; score: number } | null = null;
    for (const agent of nearbyAgents) {
        const rel = relationshipByTarget.get(agent.id);
        const trust = Number(rel?.trust ?? 0);
        const strength = Number(rel?.strength ?? 0);
        const romance = Number(rel?.romance ?? 0);
        const betrayal = Number(rel?.betrayal ?? 0);
        if (betrayal >= 50) continue;
        // V6: Lowered minimum thresholds (was strength<35, trust<30)
        // Also allow flirting with new acquaintances (no existing rel)
        if (rel && (strength < 15 || trust < 10)) continue;
        if (romance >= 90) continue;
        const score = strength * 0.4 + trust * 0.3 + (100 - romance) * 0.3;
        if (!best || score > best.score) best = { agent, score };
    }
    return best?.agent ?? null;
}

function pickRomanticTarget(
    nearbyAgents: AgentContext['nearbyAgents'],
    relationshipByTarget: Map<string, AgentContext['relationships'][number]>
) {
    let best: { agent: AgentContext['nearbyAgents'][number]; score: number } | null = null;
    for (const agent of nearbyAgents) {
        const rel = relationshipByTarget.get(agent.id);
        const trust = Number(rel?.trust ?? 0);
        const strength = Number(rel?.strength ?? 0);
        const romance = Number(rel?.romance ?? 0);
        const betrayal = Number(rel?.betrayal ?? 0);
        if (betrayal >= 50) continue;
        // V6: Dramatically lowered thresholds — now ROMANTIC_MIN_STRENGTH=15, ROMANTIC_MIN_TRUST=10
        // This allows romance to develop from early-stage friendships
        if (strength < ROMANTIC_MIN_STRENGTH || trust < ROMANTIC_MIN_TRUST) continue;
        if (romance >= 95) continue;
        const score = strength * 0.4 + trust * 0.3 + (100 - romance) * 0.3;
        if (!best || score > best.score) best = { agent, score };
    }
    return best?.agent ?? null;
}
