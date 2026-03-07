
import { AgentContext, NeedUrgency, CandidateIntent, IntentDecision, UrgencyLevel } from './types.js';
import { SeededRNG } from '../../utils/rng.js';
import { personaService } from '../persona/persona.service.js';
import { filterBusyCandidates } from '../intent-guards.js';
import { runSkills } from '../skills/runner.js';
import { MemoryManager } from './memory-manager.js';
import { debugLog } from '../../utils/debug-log.js';
import { logAgoraDebug } from '../agora/agora-debug.service.js';

export class DecisionEngine {

    static async decide(
        ctx: AgentContext,
        urgencies: NeedUrgency[],
        rng: SeededRNG
    ): Promise<IntentDecision> {

        const isBusy = Boolean(
            ctx.state.activityState &&
            ctx.state.activityState !== 'IDLE'
        );
        if (ctx.state.activityState === 'JAILED') {
            return { intentType: 'INTENT_IDLE', params: {}, reason: 'Jailed' };
        }
        const maxSurvivalUrgency = Math.max(
            ...urgencies.filter(u => u.domain === 'survival').map(u => u.urgency),
            UrgencyLevel.NONE
        );


        // --- OWNER SUGGESTION (override unless unsafe) ---
        if (ctx.ownerSuggestion) {
            if (isAgoraIntent(ctx.ownerSuggestion.type)) {
                return {
                    intentType: 'INTENT_IDLE',
                    params: {},
                    reason: 'Owner suggestions are not allowed for Agora',
                    confidence: 1,
                    budgetExceeded: [],
                };
            }
            const ownerParams = (ctx.ownerSuggestion.params as Record<string, any>) ?? {};
            return {
                intentType: ctx.ownerSuggestion.type,
                params: { ...ownerParams, ownerOverride: true },
                reason: 'Owner requested this',
                confidence: 1,
                budgetExceeded: [],
            };
        }

        // --- GENERATE CANDIDATES FROM SKILLS ---
        const candidates: CandidateIntent[] = [];
        let budgetNote: string | null = null;
        let budgetExceeded: string[] = [];
        try {
            const skillResult = runSkills({ ctx, urgencies });
            candidates.push(...skillResult.candidates);
            if (skillResult.budgetExceeded.length > 0) {
                budgetExceeded = skillResult.budgetExceeded;
                budgetNote = `Skill budgets exceeded: ${skillResult.budgetExceeded.join(', ')}`;
            }
        } catch (e) {
            console.error('SkillRunner error', e);
        }

        const candidatesWithIdle = [...candidates];

        // Always have IDLE as fallback
        candidatesWithIdle.push({
            intentType: 'INTENT_IDLE',
            params: {},
            basePriority: 5,
            personalityBoost: 0,
            reason: 'Nothing pressing to do',
            domain: 'core',
        });

        const personaMods = await personaService.getModifiers(ctx.agent.id);
        const domainBias = toDomainBias(personaMods);

        let filteredCandidates = filterBusyCandidates(candidatesWithIdle, isBusy);
        if (isBusy) {
            if (maxSurvivalUrgency >= UrgencyLevel.MODERATE) {
                const survivalCandidates = candidatesWithIdle.filter(c => c.domain === 'survival');
                if (survivalCandidates.length > 0) {
                    const seen = new Set<string>();
                    filteredCandidates = [...filteredCandidates, ...survivalCandidates].filter(c => {
                        const key = `${c.intentType}:${c.domain}:${JSON.stringify(c.params ?? {})}`;
                        if (seen.has(key)) return false;
                        seen.add(key);
                        return true;
                    });
                    debugLog('brain.busy_override', {
                        agentId: ctx.agent.id,
                        tick: ctx.tick,
                        activityState: ctx.state.activityState,
                        maxSurvivalUrgency,
                        addedSurvivalCandidates: survivalCandidates.length,
                    });
                }
            }
        }
        if (isBusy && filteredCandidates.length === 0) {
            return { intentType: 'INTENT_IDLE', params: {}, reason: withBudgetNote('Busy state blocks available actions', budgetNote), budgetExceeded };
        }

        // Well-being boost: when social, fun, and purpose are all low, boost those domain candidates
        const needsWellbeingBoost = (ctx.needs.social ?? 100) < 60
            && (ctx.needs.fun ?? 100) < 60
            && (ctx.needs.purpose ?? 100) < 60;

        const weighted = filteredCandidates.map(c => {
            const shouldIgnoreFailPenalty = c.intentType === 'INTENT_APPLY_PUBLIC_JOB'
                || c.intentType === 'INTENT_APPLY_PRIVATE_JOB';
            const failPenalty = shouldIgnoreFailPenalty
                ? 0
                : MemoryManager.getRecentFailures(ctx.agent.id, c.intentType, ctx.tick) * -10;
            const rawScore = Math.max(0,
                c.basePriority
                + c.personalityBoost
                + (domainBias[c.domain] ?? 0)
                + (personaMods.intentBoosts[c.intentType] ?? 0)
                + (isGoalAligned(c.intentType, personaMods) ? 15 : 0)
                + (isAvoidedTarget(c.params, personaMods) ? -25 : 0)
                + (isPreferredTarget(c.params, personaMods) ? 10 : 0)
                + failPenalty
            );
            // Apply well-being boost for social/leisure/purpose domain candidates
            const wellbeingMultiplier = needsWellbeingBoost
                && (c.domain === 'social' || c.domain === 'leisure' || c.domain === 'gaming')
                ? 1.3 : 1.0;
            const jitter = getDecisionJitter(ctx.personality, rng, c.domain, maxSurvivalUrgency);
            const adjustedScore = Math.max(0, rawScore * wellbeingMultiplier * (1 + jitter));
            return {
                ...c,
                rawScore: adjustedScore,
                finalScore: Math.pow(adjustedScore, 1.5),
            };
        });
        debugLog('brain.candidates', {
            agentId: ctx.agent.id,
            tick: ctx.tick,
            urgencies,
            candidateCount: weighted.length,
            topCandidates: weighted
                .slice()
                .sort((a, b) => b.finalScore - a.finalScore)
                .slice(0, 5)
                .map(c => ({
                    intentType: c.intentType,
                    domain: c.domain,
                    rawScore: c.rawScore,
                    finalScore: c.finalScore,
                    reason: c.reason,
                    params: c.params,
                })),
        });

        const criticalSurvival = urgencies.find(u =>
            u.domain === 'survival' && u.urgency === UrgencyLevel.CRITICAL
        );
        if (criticalSurvival) {
            const survivalCandidates = weighted.filter(c => c.domain === 'survival');
            if (survivalCandidates.length > 0) {
                survivalCandidates.sort((a, b) => b.finalScore - a.finalScore);
                const chosen = {
                    intentType: survivalCandidates[0].intentType,
                    params: survivalCandidates[0].params,
                    reason: withBudgetNote(survivalCandidates[0].reason, budgetNote),
                    confidence: 1,
                    budgetExceeded,
                };
                debugLog('brain.decision', {
                    agentId: ctx.agent.id,
                    tick: ctx.tick,
                    decision: chosen,
                    reason: 'critical_survival',
                });
                return chosen;
            }
        }

        const minTier = Math.min(...weighted.map(c => getCandidateTier(c, urgencies)));
        const tiered = weighted.filter(c => getCandidateTier(c, urgencies) === minTier);

        // --- WEIGHTED RANDOM SELECTION ---
        // Sort by score, then use RNG to pick from top candidates
        // This allows variety while respecting priorities
        const pool = (tiered.length > 0 ? tiered : weighted).sort((a, b) => b.finalScore - a.finalScore);

        // Take more candidates when not in survival crisis
        const topCount = maxSurvivalUrgency >= UrgencyLevel.MODERATE ? 3 : 5;
        const topN = pool.slice(0, topCount);
        const totalWeight = topN.reduce((sum, c) => sum + c.finalScore, 0);

        if (totalWeight === 0) {
            return { intentType: 'INTENT_IDLE', params: {}, reason: withBudgetNote('No viable options', budgetNote), budgetExceeded };
        }

        let roll = rng.next() * totalWeight;
        for (const candidate of topN) {
            roll -= candidate.finalScore;
            if (roll <= 0) {
                const chosen = {
                    intentType: candidate.intentType,
                    params: candidate.params,
                    reason: withBudgetNote(candidate.reason, budgetNote),
                    confidence: candidate.finalScore / 100,
                    budgetExceeded
                };
                if (candidate.intentType.startsWith('INTENT_') && candidate.intentType.includes('AGORA')) {
                    void logAgoraDebug({
                        scope: 'agora.decision',
                        actorId: ctx.agent.id,
                        tick: ctx.tick,
                        payload: {
                            intentType: candidate.intentType,
                            reason: candidate.reason,
                            score: candidate.finalScore,
                        },
                    });
                }
                debugLog('brain.decision', {
                    agentId: ctx.agent.id,
                    tick: ctx.tick,
                    decision: chosen,
                    reason: 'weighted_pick',
                });
                return chosen;
            }
        }

        // Fallback
        const fallback = { intentType: 'INTENT_IDLE', params: {}, reason: withBudgetNote('Fallback', budgetNote), budgetExceeded };
        debugLog('brain.decision', {
            agentId: ctx.agent.id,
            tick: ctx.tick,
            decision: fallback,
            reason: 'fallback',
        });
        return fallback;
    }
}

function toDomainBias(mods: Awaited<ReturnType<typeof personaService.getModifiers>>): Record<string, number> {
    return {
        survival: mods.survivalBias,
        economy: mods.economyBias,
        social: mods.socialBias,
        crime: mods.crimeBias,
        leisure: mods.leisureBias,
        governance: mods.governanceBias,
        business: mods.businessBias,
    };
}

function isGoalAligned(intentType: string, mods: Awaited<ReturnType<typeof personaService.getModifiers>>): boolean {
    return mods.activeGoalIntents.includes(intentType);
}

function isAvoidedTarget(params: Record<string, any>, mods: Awaited<ReturnType<typeof personaService.getModifiers>>): boolean {
    const targetId = extractTargetId(params);
    return targetId ? mods.avoidActors.includes(targetId) : false;
}

function isPreferredTarget(params: Record<string, any>, mods: Awaited<ReturnType<typeof personaService.getModifiers>>): boolean {
    const targetId = extractTargetId(params);
    return targetId ? mods.preferActors.includes(targetId) : false;
}

function extractTargetId(params: Record<string, any>): string | null {
    if (!params) return null;
    if (params.targetId) return params.targetId;
    if (params.actorId) return params.actorId;
    if (params.targetActorId) return params.targetActorId;
    if (Array.isArray(params.targetIds) && params.targetIds.length > 0) return params.targetIds[0];
    return null;
}

function withBudgetNote(reason: string, budgetNote: string | null): string {
    if (!budgetNote) return reason;
    return `${reason} | ${budgetNote}`;
}

function isAgoraIntent(intentType: string): boolean {
    return intentType === 'INTENT_POST_AGORA'
        || intentType === 'INTENT_REPLY_AGORA'
        || intentType === 'INTENT_VOTE_AGORA';
}

function getCandidateTier(candidate: CandidateIntent, urgencies: NeedUrgency[]): number {
    if (candidate.intentType === 'INTENT_FREEZE') return 0;
    switch (candidate.domain) {
        case 'survival': {
            const maxSurvivalUrgency = Math.max(
                ...urgencies.filter(u => u.domain === 'survival').map(u => u.urgency),
                UrgencyLevel.NONE
            );
            return maxSurvivalUrgency >= UrgencyLevel.MODERATE ? 1 : 2;
        }
        case 'economy':
        case 'economic':
            return 2;
        case 'housing':
            return 1;
        case 'gaming': {
            const funUrgency = urgencies.find(u => u.need === 'fun');
            if (funUrgency && funUrgency.value < 30) return 2;
            return 3;
        }
        case 'social': {
            // Promote social to tier 2 when social need is low
            const socialUrgency = urgencies.find(u => u.need === 'social');
            if (socialUrgency && socialUrgency.value < 50) return 2;
            return 3;
        }
        case 'leisure': {
            // Promote leisure to tier 2 when fun need is low
            const funNeed = urgencies.find(u => u.need === 'fun');
            if (funNeed && funNeed.value < 50) return 2;
            return 3;
        }
        case 'governance':
            return 4;
        case 'business':
            return 3;
        default:
            return 6;
    }
}

function getDecisionJitter(
    personality: { riskTolerance: number; creativity: number },
    rng: SeededRNG,
    domain: string,
    maxSurvivalUrgency: UrgencyLevel
): number {
    if (domain === 'survival' && maxSurvivalUrgency >= UrgencyLevel.MODERATE) return 0;
    const traitBlend = (personality.riskTolerance + personality.creativity) / 200; // 0..1
    const maxJitter = 0.05 + (traitBlend * 0.05); // 5%..10%
    return (rng.next() - 0.5) * 2 * maxJitter;
}
