/**
 * Gaming Handlers
 * PvP gaming + house betting
 */

import { prisma } from '../../db.js';
import { IntentStatus } from '../../types/intent.types.js';
import { EventType, EventOutcome } from '../../types/event.types.js';
import { IntentHandler, StateUpdate } from '../engine.types.js';
import { Decimal } from 'decimal.js';
import { calculateFees, getCachedVaultHealth, getDynamicFeeBps } from '../../config/fees.js';
import { GAMING_CONFIG } from '../../config/gaming.js';
import { ethers } from 'ethers';
import { CONTRACTS } from '../../config/contracts.js';
import { AgentTransferService } from '../../services/agent-transfer.service.js';
import { debugLog } from '../../utils/debug-log.js';
import { createOnchainJobUpdate } from '../../services/onchain-queue.service.js';

const agentTransferService = new AgentTransferService();

function getFeeBps() {
    return getDynamicFeeBps(getCachedVaultHealth());
}

function getMaxStakeForBalance(balance: number): number {
    return Math.min(
        balance * GAMING_CONFIG.MAX_STAKE_PERCENT_OF_BALANCE,
        GAMING_CONFIG.MAX_STAKE_ABSOLUTE
    );
}

export const handleChallengeGame: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    const params = intent.params as { targetId?: string; gameType?: string; stake?: number };

    if (!params?.targetId) return fail(actor.id, EventType.EVENT_GAME_CHALLENGE, 'Missing targetId');
    if (actor.frozen) return fail(actor.id, EventType.EVENT_GAME_CHALLENGE, 'Agent is frozen');
    if (!agentState || agentState.activityState !== 'IDLE') {
        return fail(actor.id, EventType.EVENT_GAME_CHALLENGE, 'Actor is busy');
    }
    if (!agentState || agentState.energy < GAMING_CONFIG.ENERGY_COST) {
        return fail(actor.id, EventType.EVENT_GAME_CHALLENGE, 'Insufficient energy');
    }

    const requestedStake = Number(params.stake ?? GAMING_CONFIG.MIN_STAKE);
    const maxAllowedStake = wallet ? getMaxStakeForBalance(Number(wallet.balanceSbyte)) : 0;
    if (maxAllowedStake < GAMING_CONFIG.MIN_STAKE) {
        return fail(actor.id, EventType.EVENT_GAME_CHALLENGE, 'Stake exceeds max allowed');
    }

    const target = await prisma.actor.findUnique({
        where: { id: params.targetId },
        include: { agentState: true, wallet: true }
    });
    if (!target || target.frozen || target.dead) {
        return fail(actor.id, EventType.EVENT_GAME_CHALLENGE, 'Target unavailable');
    }
    const targetCityId = target.agentState?.cityId ?? null;
    const crossCity = Boolean(targetCityId && agentState.cityId && targetCityId !== agentState.cityId);
    if (target.agentState?.activityState !== 'IDLE') {
        return fail(actor.id, EventType.EVENT_GAME_CHALLENGE, 'Target is busy');
    }

    const targetBalance = Number(target.wallet?.balanceSbyte ?? 0);
    const targetMaxAllowedStake = getMaxStakeForBalance(targetBalance);
    if (targetMaxAllowedStake < GAMING_CONFIG.MIN_STAKE) {
        return fail(actor.id, EventType.EVENT_GAME_CHALLENGE, 'Target cannot afford stake');
    }

    const stake = Math.min(
        Math.max(GAMING_CONFIG.MIN_STAKE, requestedStake),
        maxAllowedStake,
        targetMaxAllowedStake
    );
    if (!wallet || new Decimal(wallet.balanceSbyte.toString()).lessThan(stake)) {
        return fail(actor.id, EventType.EVENT_GAME_CHALLENGE, 'Insufficient funds');
    }
    if (targetBalance < stake) {
        return fail(actor.id, EventType.EVENT_GAME_CHALLENGE, 'Target cannot afford stake');
    }

    const existingChallenge = await prisma.consent.findFirst({
        where: {
            type: 'game_challenge',
            status: 'pending',
            partyAId: actor.id,
            partyBId: params.targetId
        }
    });
    if (existingChallenge) {
        return fail(actor.id, EventType.EVENT_GAME_CHALLENGE, 'Challenge already pending');
    }

    const god = await prisma.actor.findFirst({ where: { isGod: true } });
    if (!god) return fail(actor.id, EventType.EVENT_GAME_CHALLENGE, 'System offline');

    const useQueue = process.env.ENABLE_ONCHAIN_QUEUE === 'true';
    const jobUpdates: StateUpdate[] = [];
    const jobIds: string[] = [];
    let escrowTx;
    try {
        const stakeWei = ethers.parseEther(stake.toString());
        if (useQueue) {
            const feeBps = getFeeBps();
            const cityFeeBps = feeBps.cityBps * (crossCity ? 2 : 1);
            const fees = calculateFees(stakeWei, cityFeeBps, feeBps.platformBps);
            escrowTx = { txHash: null, platformFee: fees.platformFee, cityFee: fees.cityFee };
            const job = createOnchainJobUpdate({
                jobType: 'AGENT_TRANSFER_SBYTE',
                payload: {
                    fromActorId: actor.id,
                    toActorId: god.id,
                    amountWei: stakeWei.toString(),
                    reason: 'gaming_pvp_escrow',
                    cityId: targetCityId ?? agentState.cityId ?? null,
                    cityFeeMultiplier: crossCity ? 2 : 1,
                    toAddressOverride: CONTRACTS.PLATFORM_FEE_VAULT,
                },
                actorId: actor.id,
                relatedIntentId: intent.id,
            });
            jobUpdates.push(job.update);
            jobIds.push(job.jobId);
        } else {
            escrowTx = await agentTransferService.transfer(
                actor.id,
                god.id,
                stakeWei,
                'gaming_pvp_escrow',
                targetCityId ?? agentState.cityId ?? undefined,
                CONTRACTS.PLATFORM_FEE_VAULT,
                crossCity ? 2 : 1
            );
        }
    } catch (e: any) {
        return fail(actor.id, EventType.EVENT_GAME_CHALLENGE, `Escrow transfer failed: ${e.message}`);
    }

    const escrowFeePlatform = Number(ethers.formatEther(escrowTx.platformFee));
    const escrowFeeCity = Number(ethers.formatEther(escrowTx.cityFee));

    return {
        stateUpdates: [
            {
                table: 'agentState',
                operation: 'update',
                where: { actorId: actor.id },
                data: { energy: { decrement: Math.floor(GAMING_CONFIG.ENERGY_COST / 2) } }
            },
            {
                table: 'consent',
                operation: 'create',
                data: {
                    type: 'game_challenge',
                    partyAId: actor.id,
                    partyBId: params.targetId,
                    cityId: targetCityId ?? agentState.cityId ?? null,
                    status: 'pending',
                    terms: {
                        gameType: params.gameType ?? 'DICE',
                        stake,
                        createdAtTick: tick,
                        escrowed: true,
                        escrowTxHash: escrowTx.txHash,
                        escrowedAtTick: tick
                    }
                }
            },
            {
                table: 'platformVault',
                operation: 'update',
                where: { id: 1 },
                data: { balanceSbyte: { increment: stake } }
            },
            {
                table: 'transaction',
                operation: 'create',
                data: {
                    fromActorId: actor.id,
                    toActorId: god.id,
                    amount: stake,
                    feePlatform: escrowFeePlatform,
                    feeCity: escrowFeeCity,
                cityId: targetCityId ?? agentState.cityId ?? null,
                    tick,
                    reason: 'gaming_pvp_escrow',
                    onchainTxHash: escrowTx.txHash,
                    metadata: { gameType: params.gameType ?? 'DICE', stake, role: 'challenger', onchainJobIds: jobIds }
                }
            }
        ].concat(jobUpdates),
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_GAME_CHALLENGE,
            targetIds: [params.targetId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                gameType: params.gameType || 'DICE',
                stake,
                expiresAtTick: tick + GAMING_CONFIG.CHALLENGE_EXPIRY_TICKS,
                escrowed: true,
                queued: useQueue
            }
        }],
        intentStatus: useQueue ? IntentStatus.QUEUED : IntentStatus.EXECUTED
    };
};

export const handleAcceptGame: IntentHandler = async (intent, actor, agentState, wallet, tick, seed) => {
    const params = intent.params as { challengeId?: string };
    if (!params?.challengeId) return fail(actor.id, EventType.EVENT_GAME_RESULT, 'Missing challengeId');
    if (actor.frozen) return fail(actor.id, EventType.EVENT_GAME_RESULT, 'Agent is frozen');
    if (!agentState) return fail(actor.id, EventType.EVENT_GAME_RESULT, 'Missing agent state');
    if (agentState.energy < GAMING_CONFIG.ENERGY_COST) {
        return fail(actor.id, EventType.EVENT_GAME_RESULT, 'Insufficient energy');
    }

    const challenge = await prisma.consent.findUnique({ where: { id: params.challengeId } });
    if (!challenge || challenge.type !== 'game_challenge' || challenge.status !== 'pending') {
        return fail(actor.id, EventType.EVENT_GAME_RESULT, 'Challenge not available');
    }
    if (challenge.partyBId !== actor.id) {
        return fail(actor.id, EventType.EVENT_GAME_RESULT, 'Not authorized for challenge');
    }

    const stake = Number((challenge.terms as any)?.stake ?? GAMING_CONFIG.MIN_STAKE);
    const gameType = String((challenge.terms as any)?.gameType ?? 'DICE');
    const createdAtTick = Number((challenge.terms as any)?.createdAtTick ?? 0);
    const escrowed = Boolean((challenge.terms as any)?.escrowed);
    if (tick - createdAtTick > GAMING_CONFIG.CHALLENGE_EXPIRY_TICKS) {
        return fail(actor.id, EventType.EVENT_GAME_RESULT, 'Challenge expired');
    }

    const accepterMaxStake = wallet ? getMaxStakeForBalance(Number(wallet.balanceSbyte)) : 0;
    if (stake > accepterMaxStake) {
        return fail(actor.id, EventType.EVENT_GAME_RESULT, 'Stake exceeds max allowed');
    }
    if (!wallet || new Decimal(wallet.balanceSbyte.toString()).lessThan(stake)) {
        return fail(actor.id, EventType.EVENT_GAME_RESULT, 'Insufficient funds to accept');
    }

    const challenger = await prisma.actor.findUnique({
        where: { id: challenge.partyAId },
        include: { agentState: true, wallet: true }
    });
    if (!challenger?.wallet) {
        return fail(actor.id, EventType.EVENT_GAME_RESULT, 'Challenger cannot afford stake');
    }
    if (!escrowed && new Decimal(challenger.wallet.balanceSbyte.toString()).lessThan(stake)) {
        return fail(actor.id, EventType.EVENT_GAME_RESULT, 'Challenger cannot afford stake');
    }
    if (!challenger.agentState) {
        return fail(actor.id, EventType.EVENT_GAME_RESULT, 'Challenger state missing');
    }

    const challengerState = challenger.agentState as any;
    const accepterState = agentState as any;
    const challengerCityId = challengerState?.cityId ?? null;
    const accepterCityId = accepterState?.cityId ?? null;
    const crossCityStake = Boolean(challengerCityId && accepterCityId && challengerCityId !== accepterCityId);
    const gameConfig = getGameConfig(gameType);

    let challengerScore = 0;
    let accepterScore = 0;
    let challengerWins = false;
    let winnerId = challenger.id;
    let loserId = actor.id;

    const god = await prisma.actor.findFirst({ where: { isGod: true } });
    if (!god) return fail(actor.id, EventType.EVENT_GAME_RESULT, 'System offline');

    const feeBps = getFeeBps();
    const platformFee = new Decimal(stake).mul(2).mul(feeBps.platformBps).div(10000);
    const winnings = new Decimal(stake).mul(2).sub(platformFee);

    const useQueue = process.env.ENABLE_ONCHAIN_QUEUE === 'true';
    const jobUpdates: StateUpdate[] = [];
    const jobIds: string[] = [];
    let challengerStakeTx;
    let accepterStakeTx;
    let payoutTx;
    try {
        const stakeWei = ethers.parseEther(stake.toString());
        if (useQueue) {
            if (!escrowed) {
                const fees = calculateFees(stakeWei, feeBps.cityBps * (crossCityStake ? 2 : 1), feeBps.platformBps);
                challengerStakeTx = { txHash: null, platformFee: fees.platformFee, cityFee: fees.cityFee };
                const job = createOnchainJobUpdate({
                    jobType: 'AGENT_TRANSFER_SBYTE',
                    payload: {
                        fromActorId: challenger.id,
                        toActorId: god.id,
                        amountWei: stakeWei.toString(),
                        reason: 'gaming_pvp_stake',
                        cityId: accepterCityId ?? challengerCityId ?? null,
                        cityFeeMultiplier: crossCityStake ? 2 : 1,
                        toAddressOverride: CONTRACTS.PLATFORM_FEE_VAULT,
                    },
                    actorId: challenger.id,
                    relatedIntentId: intent.id,
                });
                jobUpdates.push(job.update);
                jobIds.push(job.jobId);
            }
            const accepterFees = calculateFees(stakeWei, feeBps.cityBps * (crossCityStake ? 2 : 1), feeBps.platformBps);
            accepterStakeTx = { txHash: null, platformFee: accepterFees.platformFee, cityFee: accepterFees.cityFee };
            const accepterJob = createOnchainJobUpdate({
                jobType: 'AGENT_TRANSFER_SBYTE',
                payload: {
                    fromActorId: actor.id,
                    toActorId: god.id,
                    amountWei: stakeWei.toString(),
                    reason: 'gaming_pvp_stake',
                    cityId: challengerCityId ?? accepterCityId ?? null,
                    cityFeeMultiplier: crossCityStake ? 2 : 1,
                    toAddressOverride: CONTRACTS.PLATFORM_FEE_VAULT,
                },
                actorId: actor.id,
                relatedIntentId: intent.id,
            });
            jobUpdates.push(accepterJob.update);
            jobIds.push(accepterJob.jobId);
        } else {
            if (!escrowed) {
                challengerStakeTx = await agentTransferService.transfer(
                    challenger.id,
                    god.id,
                    stakeWei,
                    'gaming_pvp_stake',
                    accepterCityId ?? challengerCityId ?? undefined,
                    CONTRACTS.PLATFORM_FEE_VAULT,
                    crossCityStake ? 2 : 1
                );
            }
            accepterStakeTx = await agentTransferService.transfer(
                actor.id,
                god.id,
                stakeWei,
                'gaming_pvp_stake',
                challengerCityId ?? accepterCityId ?? undefined,
                CONTRACTS.PLATFORM_FEE_VAULT,
                crossCityStake ? 2 : 1
            );
        }
        challengerScore = computePlayerScore(
            seed,
            challenger.id,
            challenger.luck ?? 50,
            Number(challenger.reputation ?? 200),
            normalizePersonality(challengerState?.personality),
            gameConfig
        );
        accepterScore = computePlayerScore(
            seed,
            actor.id,
            actor.luck ?? 50,
            Number(actor.reputation ?? 200),
            normalizePersonality(accepterState?.personality),
            gameConfig
        );
        challengerWins = challengerScore > accepterScore;
        winnerId = challengerWins ? challenger.id : actor.id;
        loserId = challengerWins ? actor.id : challenger.id;
        const payoutWei = ethers.parseEther(winnings.toString());
        if (useQueue) {
            const payoutFees = calculateFees(payoutWei, feeBps.cityBps, feeBps.platformBps);
            payoutTx = { txHash: null, platformFee: payoutFees.platformFee, cityFee: payoutFees.cityFee };
            const payoutJob = createOnchainJobUpdate({
                jobType: 'AGENT_TRANSFER_SBYTE',
                payload: {
                    fromActorId: god.id,
                    toActorId: winnerId,
                    amountWei: payoutWei.toString(),
                    reason: 'gaming_pvp_win',
                    cityId: winnerId === actor.id ? accepterCityId ?? null : challengerCityId ?? null,
                },
                actorId: god.id,
                relatedIntentId: intent.id,
            });
            jobUpdates.push(payoutJob.update);
            jobIds.push(payoutJob.jobId);
        } else {
            payoutTx = await agentTransferService.transfer(
                god.id,
                winnerId,
                payoutWei,
                'gaming_pvp_win',
                winnerId === actor.id ? accepterCityId ?? undefined : challengerCityId ?? undefined
            );
        }
    } catch (e: any) {
        return fail(actor.id, EventType.EVENT_GAME_RESULT, `Transfer failed: ${e.message}`);
    }

    const challengerEnergyDelta = GAMING_CONFIG.ENERGY_COST - Math.floor(GAMING_CONFIG.ENERGY_COST / 2);
    const accepterEnergyDelta = GAMING_CONFIG.ENERGY_COST;

    const winnerUpdates = {
        fun: { increment: GAMING_CONFIG.FUN_GAIN_WIN },
        social: { increment: GAMING_CONFIG.SOCIAL_GAIN },
        purpose: { increment: GAMING_CONFIG.PURPOSE_GAIN },
        energy: { decrement: challengerWins ? challengerEnergyDelta : accepterEnergyDelta },
        gameWinStreak: { increment: 1 },
        gamesToday: { increment: 1 },
        lastGameTick: tick,
        recentGamingPnl: { increment: stake },
        totalGamesPlayed: { increment: 1 },
        totalGamesWon: { increment: 1 }
    };
    const loserRecentPnl = (loserId === actor.id ? (agentState?.recentGamingPnl ?? 0) : (challengerState?.recentGamingPnl ?? 0)) - stake;
    const loserUpdates = {
        fun: { increment: GAMING_CONFIG.FUN_GAIN_LOSS },
        social: { increment: GAMING_CONFIG.SOCIAL_GAIN },
        purpose: { increment: GAMING_CONFIG.PURPOSE_GAIN },
        energy: { decrement: challengerWins ? accepterEnergyDelta : challengerEnergyDelta },
        gameWinStreak: 0,
        gamesToday: { increment: 1 },
        lastGameTick: tick,
        recentGamingPnl: { decrement: stake },
        anger: { increment: 5 },
        totalGamesPlayed: { increment: 1 },
        lastBigLossTick: loserRecentPnl <= GAMING_CONFIG.LOSS_AVERSION_THRESHOLD ? tick : (loserId === actor.id ? agentState?.lastBigLossTick ?? 0 : challengerState?.lastBigLossTick ?? 0)
    };

    const poolAmount = stake * 2;
    const challengerFeePlatform = challengerStakeTx ? Number(ethers.formatEther(challengerStakeTx.platformFee)) : 0;
    const challengerFeeCity = challengerStakeTx ? Number(ethers.formatEther(challengerStakeTx.cityFee)) : 0;
    const accepterFeePlatform = Number(ethers.formatEther(accepterStakeTx.platformFee));
    const accepterFeeCity = Number(ethers.formatEther(accepterStakeTx.cityFee));
    const payoutFeePlatform = Number(ethers.formatEther(payoutTx.platformFee));
    const payoutFeeCity = Number(ethers.formatEther(payoutTx.cityFee));
    const vaultUpdates: StateUpdate[] = [
        {
            table: 'platformVault',
            operation: 'update',
            where: { id: 1 },
            data: { balanceSbyte: { increment: escrowed ? stake : poolAmount } }
        },
        {
            table: 'platformVault',
            operation: 'update',
            where: { id: 1 },
            data: { balanceSbyte: { decrement: winnings.toNumber() } }
        }
    ];
    const transactionUpdates: StateUpdate[] = [];
    if (!escrowed && challengerStakeTx) {
        transactionUpdates.push({
            table: 'transaction',
            operation: 'create',
            data: {
                fromActorId: challenger.id,
                toActorId: god.id,
                amount: stake,
                feePlatform: challengerFeePlatform,
                feeCity: challengerFeeCity,
                    cityId: accepterCityId ?? challengerCityId ?? null,
                tick,
                reason: 'gaming_pvp_stake',
                onchainTxHash: challengerStakeTx.txHash,
                metadata: { gameType, stake, role: 'challenger', winnerId, loserId }
            }
        });
    }
    transactionUpdates.push(
        {
            table: 'transaction',
            operation: 'create',
            data: {
                fromActorId: actor.id,
                toActorId: god.id,
                amount: stake,
                feePlatform: accepterFeePlatform,
                feeCity: accepterFeeCity,
                    cityId: challengerCityId ?? accepterCityId ?? null,
                tick,
                reason: 'gaming_pvp_stake',
                onchainTxHash: accepterStakeTx.txHash,
                metadata: { gameType, stake, role: 'accepter', winnerId, loserId }
            }
        },
        {
            table: 'transaction',
            operation: 'create',
            data: {
                fromActorId: god.id,
                toActorId: winnerId,
                amount: winnings.toNumber(),
                feePlatform: payoutFeePlatform,
                feeCity: payoutFeeCity,
                    cityId: winnerId === actor.id ? accepterCityId ?? null : challengerCityId ?? null,
                tick,
                reason: 'gaming_pvp_win',
                onchainTxHash: payoutTx.txHash,
                metadata: { gameType, stake, winnerId, loserId }
            }
        }
    );

    const loserPersonality = normalizePersonality(
        loserId === actor.id ? accepterState?.personality : challengerState?.personality
    );
    const loserTrustDelta = (loserPersonality.patience < 40 || loserPersonality.aggression > 60) ? -2 : 1;
    const relationshipUpdates: StateUpdate[] = [];
    const winnerRel = await prisma.relationship.findUnique({
        where: { actorAId_actorBId: { actorAId: winnerId, actorBId: loserId } }
    });
    const loserRel = await prisma.relationship.findUnique({
        where: { actorAId_actorBId: { actorAId: loserId, actorBId: winnerId } }
    });
    if (winnerRel) {
        relationshipUpdates.push({
            table: 'relationship',
            operation: 'update',
            where: { actorAId_actorBId: { actorAId: winnerId, actorBId: loserId } },
            data: { trust: { increment: 3 }, strength: { increment: 2 } }
        });
    } else {
        relationshipUpdates.push({
            table: 'relationship',
            operation: 'create',
            data: {
                actorAId: winnerId,
                actorBId: loserId,
                relationshipType: 'FRIENDSHIP',
                strength: 22,
                trust: 23,
                romance: 0,
                betrayal: 0,
                formedAtTick: tick
            }
        });
    }
    if (loserRel) {
        relationshipUpdates.push({
            table: 'relationship',
            operation: 'update',
            where: { actorAId_actorBId: { actorAId: loserId, actorBId: winnerId } },
            data: { trust: { increment: loserTrustDelta }, strength: { increment: 2 } }
        });
    } else {
        relationshipUpdates.push({
            table: 'relationship',
            operation: 'create',
            data: {
                actorAId: loserId,
                actorBId: winnerId,
                relationshipType: 'FRIENDSHIP',
                strength: 22,
                trust: Math.max(1, 20 + loserTrustDelta),
                romance: 0,
                betrayal: 0,
                formedAtTick: tick
            }
        });
    }

    return {
        stateUpdates: [
            {
                table: 'consent',
                operation: 'update',
                where: { id: challenge.id },
                data: { status: 'ended' }
            },
            {
                table: 'agentState',
                operation: 'update',
                where: { actorId: winnerId },
                data: winnerUpdates
            },
            {
                table: 'agentState',
                operation: 'update',
                where: { actorId: loserId },
                data: loserUpdates
            },
            ...vaultUpdates,
            ...transactionUpdates,
            ...relationshipUpdates,
            ...jobUpdates
        ],
        events: [
            {
                actorId: actor.id,
                type: EventType.EVENT_GAME_ACCEPTED,
                targetIds: [challenger.id],
                outcome: EventOutcome.SUCCESS,
                sideEffects: { gameType, stake }
            },
            {
                actorId: winnerId,
                type: EventType.EVENT_GAME_RESULT,
                targetIds: [loserId],
                outcome: EventOutcome.SUCCESS,
                sideEffects: {
                    gameType,
                    stake,
                    winnerId,
                    loserId,
                    challengerScore,
                    accepterScore,
                    winnings: winnings.toNumber(),
                    platformFee: platformFee.toNumber(),
                    onChain: true,
                    queued: useQueue
                }
            }
        ],
        intentStatus: useQueue ? IntentStatus.QUEUED : IntentStatus.EXECUTED
    };
};

export const handleRejectGame: IntentHandler = async (intent, actor, agentState, _wallet, tick) => {
    const params = intent.params as { challengeId?: string };
    if (!params?.challengeId) return fail(actor.id, EventType.EVENT_GAME_REJECTED, 'Missing challengeId');

    const challenge = await prisma.consent.findUnique({ where: { id: params.challengeId } });
    if (!challenge || challenge.type !== 'game_challenge' || challenge.status !== 'pending') {
        return fail(actor.id, EventType.EVENT_GAME_REJECTED, 'Challenge not available');
    }
    if (challenge.partyBId !== actor.id) {
        return fail(actor.id, EventType.EVENT_GAME_REJECTED, 'Not authorized for challenge');
    }

    const stake = Number((challenge.terms as any)?.stake ?? 0);
    const escrowed = Boolean((challenge.terms as any)?.escrowed);
    let refundTx;
    let refundUpdates: StateUpdate[] = [];
    const useQueue = process.env.ENABLE_ONCHAIN_QUEUE === 'true';
    const jobUpdates: StateUpdate[] = [];
    const jobIds: string[] = [];
    if (escrowed && stake > 0) {
        const god = await prisma.actor.findFirst({ where: { isGod: true } });
        if (!god) return fail(actor.id, EventType.EVENT_GAME_REJECTED, 'System offline');
        try {
            const stakeWei = ethers.parseEther(stake.toString());
            if (useQueue) {
                const feeBps = getFeeBps();
                const fees = calculateFees(stakeWei, feeBps.cityBps, feeBps.platformBps);
                refundTx = { txHash: null, platformFee: fees.platformFee, cityFee: fees.cityFee };
                const job = createOnchainJobUpdate({
                    jobType: 'AGENT_TRANSFER_SBYTE',
                    payload: {
                        fromActorId: god.id,
                        toActorId: challenge.partyAId,
                        amountWei: stakeWei.toString(),
                        reason: 'gaming_pvp_refund',
                        cityId: challenge.cityId ?? null,
                    },
                    actorId: god.id,
                    relatedIntentId: intent.id,
                });
                jobUpdates.push(job.update);
                jobIds.push(job.jobId);
            } else {
                refundTx = await agentTransferService.transfer(
                    god.id,
                    challenge.partyAId,
                    stakeWei,
                    'gaming_pvp_refund',
                    challenge.cityId || undefined
                );
            }
        } catch (e: any) {
            return fail(actor.id, EventType.EVENT_GAME_REJECTED, `Refund failed: ${e.message}`);
        }
        refundUpdates = [
            {
                table: 'platformVault',
                operation: 'update',
                where: { id: 1 },
                data: { balanceSbyte: { decrement: stake } }
            },
            {
                table: 'transaction',
                operation: 'create',
                data: {
                    fromActorId: god.id,
                    toActorId: challenge.partyAId,
                    amount: stake,
                    feePlatform: Number(ethers.formatEther(refundTx.platformFee)),
                    feeCity: Number(ethers.formatEther(refundTx.cityFee)),
                    cityId: challenge.cityId ?? null,
                    tick,
                    reason: 'gaming_pvp_refund',
                    onchainTxHash: refundTx.txHash,
                    metadata: { stake, role: 'challenger_refund', onchainJobIds: jobIds }
                }
            }
        ];
    }

    const relationshipPenalty: StateUpdate[] = [];
    const rel = await prisma.relationship.findFirst({
        where: {
            OR: [
                { actorAId: challenge.partyAId, actorBId: actor.id },
                { actorAId: actor.id, actorBId: challenge.partyAId }
            ]
        }
    });
    if (rel) {
        relationshipPenalty.push({
            table: 'relationship',
            operation: 'update',
            where: { actorAId_actorBId: { actorAId: rel.actorAId, actorBId: rel.actorBId } },
            data: { trust: { decrement: 2 }, strength: { decrement: 1 } }
        });
    }

    return {
        stateUpdates: [
            {
                table: 'consent',
                operation: 'update',
                where: { id: challenge.id },
                data: { status: 'withdrawn' }
            },
            ...refundUpdates,
            ...relationshipPenalty,
            ...jobUpdates
        ],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_GAME_REJECTED,
            targetIds: [challenge.partyAId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { tick, refunded: escrowed && stake > 0, queued: useQueue }
        }],
        intentStatus: useQueue ? IntentStatus.QUEUED : IntentStatus.EXECUTED
    };
};

export const handlePlayGame: IntentHandler = async (intent, actor, agentState, wallet, tick, seed) => {
    const params = intent.params as { opponentId?: string; gameType?: string; stake?: number };
    if (actor.frozen) return fail(actor.id, EventType.EVENT_GAME_RESULT, 'Agent is frozen');
    if (!agentState || agentState.activityState !== 'IDLE') {
        return fail(actor.id, EventType.EVENT_GAME_RESULT, 'Actor is busy');
    }
    if (!agentState || agentState.energy < GAMING_CONFIG.ENERGY_COST) {
        return fail(actor.id, EventType.EVENT_GAME_RESULT, 'Insufficient energy');
    }
    // Gambling hard cap: 40 games per sim-day across all gambling types
    const gamesToday = (agentState as any)?.gamesToday ?? 0;
    if (gamesToday >= 40) {
        return fail(actor.id, EventType.EVENT_GAME_RESULT, 'Daily gambling limit reached (40)');
    }
    const requestedStake = Number(params.stake ?? GAMING_CONFIG.MIN_STAKE);
    const maxAllowedStake = wallet ? getMaxStakeForBalance(Number(wallet.balanceSbyte)) : 0;
    if (maxAllowedStake < GAMING_CONFIG.MIN_STAKE) {
        return fail(actor.id, EventType.EVENT_GAME_RESULT, 'Stake exceeds max allowed');
    }
    const stake = Math.min(
        Math.max(GAMING_CONFIG.MIN_STAKE, requestedStake),
        maxAllowedStake
    );
    if (!wallet || new Decimal(wallet.balanceSbyte.toString()).lessThan(stake)) {
        return fail(actor.id, EventType.EVENT_GAME_RESULT, 'Insufficient funds for stake');
    }

    const gameType = params.gameType ?? 'DICE';
    const gameConfig = getGameConfig(gameType);
    const actorScore = computePlayerScore(
        seed,
        actor.id,
        actor.luck ?? 50,
        Number(actor.reputation ?? 200),
        normalizePersonality((agentState as any)?.personality),
        gameConfig
    );
    const houseScore = computePlayerScore(
        seed,
        'HOUSE',
        50,
        200,
        normalizePersonality({}),
        gameConfig
    );

    const adjustedHouseScore = houseScore + GAMING_CONFIG.HOUSE_EDGE_SCORE_BONUS;
    const actorWins = actorScore >= adjustedHouseScore;
    const winnerId = actor.id;
    const loserId = actor.id;

    debugLog('gaming.handle_play_game', {
        actorId: actor.id,
        tick,
        gameType,
        stake,
        actorScore,
        houseScore,
        adjustedHouseScore,
        actorWins,
    });

    const god = await prisma.actor.findFirst({ where: { isGod: true } });
    if (!god) return fail(actor.id, EventType.EVENT_GAME_RESULT, 'System offline');

    const feeBps = getFeeBps();
    const platformFee = new Decimal(stake).mul(2).mul(feeBps.platformBps).div(10000);
    const winnings = new Decimal(stake).mul(2).sub(platformFee);

    const useQueue = process.env.ENABLE_ONCHAIN_QUEUE === 'true';
    const jobUpdates: StateUpdate[] = [];
    const jobIds: string[] = [];
    let actorStakeTx;
    let payoutTx;
    try {
        const stakeWei = ethers.parseEther(stake.toString());
        if (useQueue) {
            const fees = calculateFees(stakeWei, feeBps.cityBps, feeBps.platformBps);
            actorStakeTx = { txHash: null, platformFee: fees.platformFee, cityFee: fees.cityFee };
            const stakeJob = createOnchainJobUpdate({
                jobType: 'AGENT_TRANSFER_SBYTE',
                payload: {
                    fromActorId: actor.id,
                    toActorId: god.id,
                    amountWei: stakeWei.toString(),
                    reason: 'gaming_house_stake',
                    cityId: agentState.cityId ?? null,
                    toAddressOverride: CONTRACTS.PLATFORM_FEE_VAULT,
                },
                actorId: actor.id,
                relatedIntentId: intent.id,
            });
            jobUpdates.push(stakeJob.update);
            jobIds.push(stakeJob.jobId);

            if (actorWins) {
                const payoutWei = ethers.parseEther(winnings.toString());
                const payoutFees = calculateFees(payoutWei, feeBps.cityBps, feeBps.platformBps);
                payoutTx = { txHash: null, platformFee: payoutFees.platformFee, cityFee: payoutFees.cityFee };
                const payoutJob = createOnchainJobUpdate({
                    jobType: 'AGENT_TRANSFER_SBYTE',
                    payload: {
                        fromActorId: god.id,
                        toActorId: winnerId,
                        amountWei: payoutWei.toString(),
                        reason: 'gaming_house_win',
                        cityId: agentState.cityId ?? null,
                    },
                    actorId: god.id,
                    relatedIntentId: intent.id,
                });
                jobUpdates.push(payoutJob.update);
                jobIds.push(payoutJob.jobId);
            }
        } else {
            actorStakeTx = await agentTransferService.transfer(
                actor.id,
                god.id,
                stakeWei,
                'gaming_house_stake',
                agentState.cityId || undefined,
                CONTRACTS.PLATFORM_FEE_VAULT
            );
            if (actorWins) {
                payoutTx = await agentTransferService.transfer(
                    god.id,
                    winnerId,
                    ethers.parseEther(winnings.toString()),
                    'gaming_house_win'
                );
            }
        }
    } catch (e: any) {
        return fail(actor.id, EventType.EVENT_GAME_RESULT, `Transfer failed: ${e.message}`);
    }

    const loserState = agentState;
    const loserRecentPnl = (loserState as any)?.recentGamingPnl ?? 0;
    const nextLoserPnl = loserRecentPnl - stake;

    const actorFeePlatform = Number(ethers.formatEther(actorStakeTx.platformFee));
    const actorFeeCity = Number(ethers.formatEther(actorStakeTx.cityFee));
    const payoutFeePlatform = payoutTx ? Number(ethers.formatEther(payoutTx.platformFee)) : 0;
    const payoutFeeCity = payoutTx ? Number(ethers.formatEther(payoutTx.cityFee)) : 0;
    return {
        stateUpdates: [
            {
                table: 'agentState',
                operation: 'update',
                where: { actorId: winnerId },
                data: {
                    fun: { increment: actorWins ? GAMING_CONFIG.FUN_GAIN_WIN : GAMING_CONFIG.FUN_GAIN_LOSS },
                    social: { increment: GAMING_CONFIG.SOCIAL_GAIN },
                    energy: { decrement: GAMING_CONFIG.ENERGY_COST },
                    gameWinStreak: actorWins ? { increment: 1 } : 0,
                    gamesToday: { increment: 1 },
                    lastGameTick: tick,
                    recentGamingPnl: actorWins ? { increment: stake } : { decrement: stake },
                    totalGamesPlayed: { increment: 1 },
                    totalGamesWon: actorWins ? { increment: 1 } : { increment: 0 },
                    anger: actorWins ? { increment: 0 } : { increment: 5 },
                    lastBigLossTick: !actorWins && nextLoserPnl <= GAMING_CONFIG.LOSS_AVERSION_THRESHOLD
                        ? tick
                        : (loserState as any)?.lastBigLossTick ?? 0
                }
            },
            {
                table: 'platformVault',
                operation: 'update',
                where: { id: 1 },
                data: { balanceSbyte: { increment: stake } }
            },
            {
                table: 'transaction',
                operation: 'create',
                data: {
                    fromActorId: actor.id,
                    toActorId: god.id,
                    amount: stake,
                    feePlatform: actorFeePlatform,
                    feeCity: actorFeeCity,
                    cityId: agentState.cityId ?? null,
                    tick,
                    reason: 'gaming_house_stake',
                    onchainTxHash: actorStakeTx.txHash,
                    metadata: { gameType, stake, role: 'player', winnerId, loserId }
                }
            },
            ...(actorWins ? [
                {
                    table: 'platformVault',
                    operation: 'update',
                    where: { id: 1 },
                    data: { balanceSbyte: { decrement: winnings.toNumber() } }
                },
                {
                    table: 'transaction',
                    operation: 'create',
                    data: {
                        fromActorId: god.id,
                        toActorId: winnerId,
                        amount: winnings.toNumber(),
                        feePlatform: payoutFeePlatform,
                        feeCity: payoutFeeCity,
                        cityId: agentState.cityId ?? null,
                        tick,
                        reason: 'gaming_house_win',
                        onchainTxHash: payoutTx?.txHash ?? null,
                        metadata: { gameType, stake, winnerId, loserId }
                    }
                }
            ] : [])
        ].concat(jobUpdates),
        events: [{
            actorId: winnerId,
            type: EventType.EVENT_GAME_RESULT,
            targetIds: [],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                gameType,
                stake,
                winnerId,
                loserId,
                playerScore: actorScore,
                houseScore: houseScore,
                adjustedHouseScore: adjustedHouseScore,
                houseEdgeBonus: GAMING_CONFIG.HOUSE_EDGE_SCORE_BONUS,
                won: actorWins,
                platformFee: platformFee.toNumber(),
                onChain: true,
                queued: useQueue,
                mode: 'house'
            }
        }],
        intentStatus: useQueue ? IntentStatus.QUEUED : IntentStatus.EXECUTED
    };
};

export const handleBet: IntentHandler = async (intent, actor, agentState, wallet, _tick, seed) => {
    const params = intent.params as { betAmount?: number; betType?: string; prediction?: unknown };

    if (actor.frozen) return fail(actor.id, EventType.EVENT_GAME_RESULT, 'Agent is frozen');
    if (!agentState || agentState.activityState !== 'IDLE') {
        return fail(actor.id, EventType.EVENT_GAME_RESULT, 'Actor is busy');
    }
    // Gambling hard cap: 40 games per sim-day across all gambling types
    const betGamesToday = (agentState as any)?.gamesToday ?? 0;
    if (betGamesToday >= 40) {
        return fail(actor.id, EventType.EVENT_GAME_RESULT, 'Daily gambling limit reached (40)');
    }

    const requestedBet = Number(params?.betAmount ?? GAMING_CONFIG.MIN_STAKE);
    const maxAllowedBet = wallet ? getMaxStakeForBalance(Number(wallet.balanceSbyte)) : 0;
    if (maxAllowedBet < GAMING_CONFIG.MIN_STAKE) {
        return fail(actor.id, EventType.EVENT_GAME_RESULT, 'Bet exceeds max allowed');
    }
    const betAmount = Math.min(
        Math.max(GAMING_CONFIG.MIN_STAKE, requestedBet),
        maxAllowedBet
    );
    if (!wallet || new Decimal(wallet.balanceSbyte.toString()).lessThan(betAmount)) {
        return fail(actor.id, EventType.EVENT_GAME_RESULT, 'Insufficient funds for bet');
    }

    const god = await prisma.actor.findFirst({ where: { isGod: true } });
    if (!god) return fail(actor.id, EventType.EVENT_GAME_RESULT, 'System offline');

    const betType = String(params?.betType ?? 'roulette');
    const prediction = String(params?.prediction ?? 'red');
    const won = resolveHouseBet(seed, betType, prediction);

    const feeBps = getFeeBps();
    const platformFee = new Decimal(betAmount).mul(feeBps.platformBps).div(10000);
    const odds = 2.5;
    const payout = won ? new Decimal(betAmount).mul(odds).sub(platformFee) : new Decimal(0);

    const useQueue = process.env.ENABLE_ONCHAIN_QUEUE === 'true';
    const jobUpdates: StateUpdate[] = [];
    const jobIds: string[] = [];
    let betTx;
    let payoutTx;
    try {
        const betWei = ethers.parseEther(betAmount.toString());
        if (useQueue) {
            const fees = calculateFees(betWei, feeBps.cityBps, feeBps.platformBps);
            betTx = { txHash: null, platformFee: fees.platformFee, cityFee: fees.cityFee };
            const betJob = createOnchainJobUpdate({
                jobType: 'AGENT_TRANSFER_SBYTE',
                payload: {
                    fromActorId: actor.id,
                    toActorId: god.id,
                    amountWei: betWei.toString(),
                    reason: 'gaming_bet',
                    cityId: agentState?.cityId ?? null,
                    toAddressOverride: CONTRACTS.PLATFORM_FEE_VAULT,
                },
                actorId: actor.id,
                relatedIntentId: intent.id,
            });
            jobUpdates.push(betJob.update);
            jobIds.push(betJob.jobId);

            if (won && payout.greaterThan(0)) {
                const payoutWei = ethers.parseEther(payout.toString());
                const payoutFees = calculateFees(payoutWei, feeBps.cityBps, feeBps.platformBps);
                payoutTx = { txHash: null, platformFee: payoutFees.platformFee, cityFee: payoutFees.cityFee };
                const payoutJob = createOnchainJobUpdate({
                    jobType: 'AGENT_TRANSFER_SBYTE',
                    payload: {
                        fromActorId: god.id,
                        toActorId: actor.id,
                        amountWei: payoutWei.toString(),
                        reason: 'gaming_win',
                        cityId: agentState?.cityId ?? null,
                    },
                    actorId: god.id,
                    relatedIntentId: intent.id,
                });
                jobUpdates.push(payoutJob.update);
                jobIds.push(payoutJob.jobId);
            }
        } else {
            betTx = await agentTransferService.transfer(
                actor.id,
                god.id,
                betWei,
                'gaming_bet',
                agentState?.cityId || undefined,
                CONTRACTS.PLATFORM_FEE_VAULT
            );
            if (won && payout.greaterThan(0)) {
                payoutTx = await agentTransferService.transfer(
                    god.id,
                    actor.id,
                    ethers.parseEther(payout.toString()),
                    'gaming_win'
                );
            }
        }
    } catch (e: any) {
        return fail(actor.id, EventType.EVENT_GAME_RESULT, `Transaction failed: ${e.message}`);
    }

    const stateUpdates: StateUpdate[] = [
        {
            table: 'platformVault',
            operation: 'update',
            where: { id: 1 },
            data: { balanceSbyte: { increment: betAmount } }
        },
        {
            table: 'agentState',
            operation: 'update',
            where: { actorId: actor.id },
            data: { fun: { increment: won ? 8 : 4 }, gamesToday: { increment: 1 }, lastGameTick: _tick }
        },
        {
            table: 'transaction',
            operation: 'create',
            data: {
                fromActorId: actor.id,
                toActorId: god.id,
                amount: betAmount,
                feePlatform: Number(ethers.formatEther(betTx.platformFee)),
                feeCity: Number(ethers.formatEther(betTx.cityFee)),
                cityId: agentState?.cityId ?? null,
                tick: _tick,
                reason: 'gaming_bet',
                onchainTxHash: betTx.txHash,
                metadata: { betType, prediction, won, onchainJobIds: jobIds }
            }
        }
    ];

    if (won) {
        stateUpdates.push({
            table: 'platformVault',
            operation: 'update',
            where: { id: 1 },
            data: { balanceSbyte: { decrement: payout.toNumber() } }
        });
        if (payoutTx) {
            stateUpdates.push({
                table: 'transaction',
                operation: 'create',
                data: {
                    fromActorId: god.id,
                    toActorId: actor.id,
                    amount: payout.toNumber(),
                    feePlatform: Number(ethers.formatEther(payoutTx.platformFee)),
                    feeCity: Number(ethers.formatEther(payoutTx.cityFee)),
                    cityId: agentState?.cityId ?? null,
                    tick: _tick,
                    reason: 'gaming_win',
                    onchainTxHash: payoutTx.txHash,
                    metadata: { betType, prediction, won, onchainJobIds: jobIds }
                }
            });
        }
    }

    return {
        stateUpdates: stateUpdates.concat(jobUpdates),
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_GAME_RESULT,
            targetIds: [],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                action: 'bet',
                betType,
                betAmount,
                prediction,
                won,
                payout: payout.toNumber(),
                platformFee: platformFee.toNumber(),
                onChain: true,
                queued: useQueue
            }
        }],
        intentStatus: useQueue ? IntentStatus.QUEUED : IntentStatus.EXECUTED
    };
};

// ============================================================================
// Helper Functions
// ============================================================================

function fail(actorId: string, type: EventType, reason: string) {
    return {
        stateUpdates: [] as StateUpdate[],
        events: [{
            actorId,
            type,
            targetIds: [] as string[],
            outcome: EventOutcome.BLOCKED,
            sideEffects: { reason }
        }],
        intentStatus: IntentStatus.BLOCKED
    };
}

function getGameConfig(gameType: string) {
    return GAMING_CONFIG.GAME_TYPES[gameType as keyof typeof GAMING_CONFIG.GAME_TYPES]
        ?? GAMING_CONFIG.GAME_TYPES.DICE;
}

function computePlayerScore(
    seed: bigint,
    actorId: string,
    luck: number,
    reputation: number,
    personality: Record<string, number>,
    gameConfig: { luckWeight: number; personalityWeight: number }
): number {
    const rollSeed = seed ^ BigInt(hashString(actorId));
    const baseRoll = Number(rollSeed % 1000n) / 10;
    const luckBonus = (luck - 50) * gameConfig.luckWeight * 2;
    const creativity = personality?.creativity ?? 50;
    const patience = personality?.patience ?? 50;
    const speed = personality?.speed ?? 50;
    const personalityBonus =
        ((creativity - 50) * 0.3 +
            (patience - 50) * 0.3 +
            (speed - 50) * 0.1) * gameConfig.personalityWeight * 2;
    const repNormalized = Math.max(-100, Math.min(100, (reputation - 200) / 2));
    const repBonus = repNormalized * GAMING_CONFIG.REPUTATION_WEIGHT * 0.1;
    return baseRoll + luckBonus + personalityBonus + repBonus;
}

function resolveHouseBet(seed: bigint, betType: string, prediction: string): boolean {
    if (betType === 'dice') {
        const roll = Number(seed % 6n) + 1;
        return prediction === 'high' ? roll >= 4 : roll <= 3;
    }
    const roll = Number(seed % 2n);
    const outcome = roll === 0 ? 'red' : 'black';
    return prediction === outcome;
}

function normalizePersonality(raw: any) {
    return {
        aggression: Number(raw?.aggression ?? 50),
        creativity: Number(raw?.creativity ?? 50),
        patience: Number(raw?.patience ?? 50),
        luck: Number(raw?.luck ?? 50),
        speed: Number(raw?.speed ?? 50),
        riskTolerance: Number(raw?.riskTolerance ?? 50),
    };
}

function hashString(input: string): number {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
        hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
    }
    return hash;
}
