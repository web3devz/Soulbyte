import { AgentContext, NeedUrgency, CandidateIntent, IntentType } from '../types.js';
import { PersonalityWeights } from '../personality-weights.js';
import { GAMING_CONFIG } from '../../../config/gaming.js';

export class GamingDomain {
    static getCandidates(ctx: AgentContext, urgencies: NeedUrgency[]): CandidateIntent[] {
        const candidates: CandidateIntent[] = [];
        if (process.env.DEBUG_GAMING === 'true') {
            console.log(`[GAMING] Agent ${ctx.agent.id}: balance=${ctx.state.balanceSbyte}, energy=${ctx.needs.energy}, nearby=${ctx.nearbyAgents.length}, activityState=${ctx.state.activityState}`);
        }
        if (ctx.state.noGamesUntilTick && ctx.tick < ctx.state.noGamesUntilTick) {
            return candidates;
        }

        const pendingChallenges = ctx.pendingGameChallenges ?? [];
        for (const challenge of pendingChallenges) {
            if (ctx.tick - challenge.createdAtTick > GAMING_CONFIG.CHALLENGE_EXPIRY_TICKS) {
                continue;
            }
            const stake = challenge.stake ?? GAMING_CONFIG.MIN_STAKE;
            const canAfford = ctx.state.balanceSbyte >= stake * 1.1;
            const riskWillingness = ctx.personality.riskTolerance / 100;
            const socialNeed = (100 - (ctx.needs.social ?? 50)) / 100;
            const funNeed = (100 - (ctx.needs.fun ?? 50)) / 100;
            const rel = ctx.relationships.find(r => r.targetId === challenge.challengerId);
            const trust = Number(rel?.trust ?? 30) / 100;

            const acceptScore =
                riskWillingness * 30 +
                (canAfford ? 25 : -20) +
                socialNeed * 15 +
                funNeed * 15 +
                trust * 15;

            if (acceptScore > 40) {
                candidates.push({
                    intentType: IntentType.INTENT_ACCEPT_GAME,
                    params: { challengeId: challenge.id },
                    basePriority: 55 + acceptScore * 0.3,
                    personalityBoost: PersonalityWeights.getBoost(ctx.personality.riskTolerance, true),
                    reason: `Accepting game challenge from ${challenge.challengerName}`,
                    domain: 'gaming',
                });
            } else {
                candidates.push({
                    intentType: IntentType.INTENT_REJECT_GAME,
                    params: { challengeId: challenge.id },
                    basePriority: 40,
                    personalityBoost: 0,
                    reason: `Declining game challenge from ${challenge.challengerName}`,
                    domain: 'gaming',
                });
            }
        }

        const appetite = (ctx.personality.riskTolerance + ctx.personality.funNeed + ctx.personality.speed) / 3;
        const minTicksBetweenGames = Math.max(
            30,
            Math.round(GAMING_CONFIG.MIN_TICKS_BETWEEN_GAMES - (appetite / 100) * 30)
        );
        const maxGamesPerDay = Math.max(
            10,
            Math.min(40, Math.round(10 + (appetite / 100) * 30))
        );
        if (ctx.state.balanceSbyte < GAMING_CONFIG.BROKE_PROTECTION_FLOOR) return candidates;
        if (ctx.needs.energy < GAMING_CONFIG.ENERGY_COST + 20) return candidates;
        if (ctx.needs.hunger < 25 || ctx.needs.health < 25) return candidates;

        const lastGameTick = ctx.state.lastGameTick ?? 0;
        if (ctx.tick - lastGameTick < minTicksBetweenGames) return candidates;

        const gamesToday = ctx.state.gamesToday ?? 0;
        if (gamesToday >= maxGamesPerDay) return candidates;

        const recentGamingPnl = ctx.state.recentGamingPnl ?? 0;
        if (recentGamingPnl < GAMING_CONFIG.LOSS_AVERSION_THRESHOLD) {
            const ticksSinceBigLoss = ctx.tick - (ctx.state.lastBigLossTick ?? 0);
            if (ticksSinceBigLoss < GAMING_CONFIG.LOSS_AVERSION_COOLDOWN_TICKS) {
                return candidates;
            }
        }

        const currentCityId = ctx.state.cityId;
        const sameCityOpponents = ctx.nearbyAgents.filter(agent => {
            if (agent.id === ctx.agent.id) return false;
            if (agent.isEnemy) return false;
            if (agent.activityState !== 'IDLE') return false;
            return agent.cityId === currentCityId;
        });
        const crossCityOpponents = ctx.nearbyAgents.filter(agent => {
            if (agent.id === ctx.agent.id) return false;
            if (agent.isEnemy) return false;
            if (agent.activityState !== 'IDLE') return false;
            return agent.cityId && agent.cityId !== currentCityId;
        });
        const eligibleOpponents = sameCityOpponents.length > 0 ? sameCityOpponents : crossCityOpponents;

        if (eligibleOpponents.length === 0) return candidates;

        const relationshipByTarget = new Map(
            (ctx.relationships || []).map(r => [r.targetId, r])
        );
        const scoredOpponents = eligibleOpponents.map(opponent => {
            let score = 0;
            const rel = relationshipByTarget.get(opponent.id);
            if (rel) {
                const trust = Number(rel.trust ?? 0);
                const strength = Number(rel.strength ?? 0);
                score += trust * 0.15 + strength * 0.1;
            } else {
                score += 10;
            }

            const myRank = getWealthRank(ctx.state.wealthTier);
            const theirRank = getWealthRank(opponent.wealthTier);
            if (theirRank <= myRank) score += 15;
            if (theirRank > myRank + 2) score -= 10;

            const repDiff = Math.abs(ctx.agent.reputation - opponent.reputation);
            if (repDiff < 50) score += 10;

            score += (ctx.personality.riskTolerance - 50) * 0.1;

            return { opponent, score };
        });

        scoredOpponents.sort((a, b) => b.score - a.score);
        const bestOpponent = scoredOpponents[0];
        if (!bestOpponent || bestOpponent.score < 0) return candidates;

        const maxStake = Math.floor(Math.min(
            ctx.state.balanceSbyte * GAMING_CONFIG.MAX_STAKE_PERCENT_OF_BALANCE,
            GAMING_CONFIG.MAX_STAKE_ABSOLUTE
        ));
        const personalityStakeMult = 0.3 + (ctx.personality.riskTolerance / 100) * 0.7;
        let stake = Math.max(
            GAMING_CONFIG.MIN_STAKE,
            Math.round(maxStake * personalityStakeMult)
        );

        if (recentGamingPnl < 0) {
            const lossFactor = Math.max(0.3, 1 + (recentGamingPnl / 500));
            stake = Math.max(GAMING_CONFIG.MIN_STAKE, Math.round(stake * lossFactor));
        }

        const winStreak = ctx.state.gameWinStreak ?? 0;
        if (winStreak > 0) {
            stake = Math.round(stake * (1 + Math.min(winStreak, 3) * 0.1));
        }

        const gameType = chooseGameType(ctx);
        const funUrgency = urgencies.find(u => u.need === 'fun');
        const funValue = funUrgency?.value ?? 50;
        const socialValue = ctx.needs.social ?? 50;

        let basePriority = 30;
        if (funValue < 50) basePriority += (50 - funValue) * 0.4;
        if (funValue < 25) basePriority += 10;
        if (socialValue < 50) basePriority += (50 - socialValue) * 0.15;
        basePriority += Math.min(winStreak, 3) * GAMING_CONFIG.WIN_STREAK_BOOST;

        const riskBoost = PersonalityWeights.getBoost(ctx.personality.riskTolerance, true);
        const creativityBoost = PersonalityWeights.getBoost(ctx.personality.creativity, true) * 0.3;

        candidates.push({
            intentType: IntentType.INTENT_CHALLENGE_GAME,
            params: {
                targetId: bestOpponent.opponent.id,
                gameType,
                stake,
            },
            basePriority,
            personalityBoost: riskBoost + creativityBoost,
            reason: `Challenging ${bestOpponent.opponent.name} to ${gameType} for ${stake} SBYTE`,
            domain: 'gaming',
        });

        const casino = ctx.businesses?.inCity?.find(
            b => b.businessType === 'CASINO'
        );
        if (casino && ctx.state.balanceSbyte > 50) {
            const betAmount = Math.max(
                GAMING_CONFIG.MIN_STAKE,
                Math.round(ctx.state.balanceSbyte * 0.05 * personalityStakeMult)
            );
            candidates.push({
                intentType: IntentType.INTENT_BET,
                params: {
                    betAmount,
                    betType: gameType === 'DICE' ? 'dice' : 'roulette',
                    prediction: ctx.personality.luck > 50 ? 'high' : 'low',
                },
                basePriority: basePriority - 10,
                personalityBoost: riskBoost,
                reason: `Gambling at casino (${betAmount} SBYTE)`,
                domain: 'gaming',
            });
        }

        return candidates;
    }
}

function getWealthRank(tier: string): number {
    return parseInt(tier?.replace('W', '') ?? '0', 10) || 0;
}

function chooseGameType(ctx: AgentContext): string {
    const luck = ctx.personality.luck;
    const creativity = ctx.personality.creativity;
    const patience = ctx.personality.patience;

    const scores = {
        DICE: luck * 0.5 + (100 - patience) * 0.3,
        CARDS: creativity * 0.4 + luck * 0.3 + (100 - ctx.personality.aggression) * 0.2,
        STRATEGY: patience * 0.5 + creativity * 0.3,
    };

    let best = 'DICE';
    let bestScore = scores.DICE;
    for (const [type, score] of Object.entries(scores)) {
        if (score > bestScore) {
            best = type;
            bestScore = score;
        }
    }
    return best;
}
