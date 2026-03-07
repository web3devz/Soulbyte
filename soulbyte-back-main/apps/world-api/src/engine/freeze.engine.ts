/**
 * Freeze Engine - Handles economic and health freeze states
 * MVP: All terminal states result in freeze, not death
 * 
 * Freeze conditions (per STATUS_AND_WEALTH_SPEC):
 * - balance_sbyte == 0
 * - housing_tier == 'street' (homeless)
 * - all statuses ≤ 5
 */
import { prisma } from '../db.js';
import { EventType, EventOutcome } from '../types/event.types.js';
import type { Prisma } from '../../../../generated/prisma/index.js';
import { AgentTransferService } from '../services/agent-transfer.service.js';
import { CONTRACTS } from '../config/contracts.js';
import { Decimal } from 'decimal.js';
import { ethers } from 'ethers';

type TransactionClient = Prisma.TransactionClient;
const agentTransferService = new AgentTransferService();
const REBIRTH_FEE = new Decimal(10000);

/**
 * Check all agents for freeze conditions
 * Returns count of newly frozen agents
 */
export async function checkFreeze(currentTick: number): Promise<number> {
    let freezeCount = 0;

    // Get all non-frozen agents with their state
    const agents = await prisma.actor.findMany({
        where: {
            kind: 'agent',
            frozen: false,
        },
        include: {
            agentState: true,
            wallet: true,
        },
    });

    for (const agent of agents) {
        const state = agent.agentState;
        const wallet = agent.wallet;

        if (!state || !wallet) continue;

        // Check economic freeze conditions
        const economicFreezeCondition = checkEconomicFreeze(state, wallet);
        const healthFreezeCondition = checkHealthFreeze(state);

        if (economicFreezeCondition || healthFreezeCondition) {
            const reason = economicFreezeCondition ? 'economic_freeze' : 'health_collapse';

            await prisma.$transaction(async (tx: TransactionClient) => {
                // Set frozen flag
                await tx.actor.update({
                    where: { id: agent.id },
                    data: {
                        frozen: true,
                        frozenReason: reason,
                    },
                });

                // Create freeze event
                await tx.event.create({
                    data: {
                        actorId: agent.id,
                        type: EventType.EVENT_FROZEN,
                        targetIds: [],
                        tick: currentTick,
                        outcome: EventOutcome.SUCCESS,
                        sideEffects: {
                            reason,
                            balance: wallet.balanceSbyte.toString(),
                            housingTier: state.housingTier,
                            health: state.health,
                            energy: state.energy,
                            hunger: state.hunger,
                            social: state.social,
                            fun: state.fun,
                            purpose: state.purpose,
                        },
                    },
                });
            });

            freezeCount++;
            console.log(`  Agent ${agent.name} (${agent.id}) frozen: ${reason}`);
        }
    }

    return freezeCount;
}

/**
 * Check economic freeze conditions
 * Per STATUS_AND_WEALTH_SPEC Section 11:
 * - balance_sbyte == 0
 * - no housing (street)
 * - all statuses ≤ 5
 */
function checkEconomicFreeze(
    state: {
        housingTier: string;
        health: number;
        energy: number;
        hunger: number;
        social: number;
        fun: number;
        purpose: number;
    },
    wallet: { balanceSbyte: unknown }
): boolean {
    const balance = parseFloat(String(wallet.balanceSbyte));

    // Must be bankrupt
    if (balance > 0) return false;

    // Must be homeless
    if (state.housingTier !== 'street') return false;

    // All statuses must be ≤ 5
    const allStatusesCollapsed = (
        state.health <= 5 &&
        state.energy <= 5 &&
        state.hunger <= 5 &&
        state.social <= 5 &&
        state.fun <= 5 &&
        state.purpose <= 5
    );

    return allStatusesCollapsed;
}

/**
 * Check health freeze condition
 * Per HealthEvaluator v2.0.0: health=0 triggers freeze
 */
function checkHealthFreeze(
    state: { health: number }
): boolean {
    return state.health <= 0;
}

/**
 * Revival handler - called when human deposits SBYTE
 * Clears frozen flag and sets baseline stats
 */
export async function reviveAgent(
    actorId: string,
    depositAmount: number,
    depositorInfo: string,
    currentTick: number,
    applyDeposit: boolean = true
): Promise<boolean> {
    const actor = await prisma.actor.findUnique({
        where: { id: actorId },
        include: { agentState: true, wallet: true, agentWallet: true },
    });

    if (!actor || !actor.frozen) {
        return false;
    }
    if (!actor.wallet || !actor.agentWallet) {
        return false;
    }

    const balance = new Decimal(actor.wallet.balanceSbyte.toString());
    if (balance.lessThan(REBIRTH_FEE)) {
        return false;
    }
    const onchainMon = new Decimal(actor.agentWallet.balanceMon.toString());
    if (onchainMon.lte(0)) {
        return false;
    }
    const onchainSbyte = new Decimal(actor.agentWallet.balanceSbyte.toString());
    if (onchainSbyte.lessThan(REBIRTH_FEE)) {
        return false;
    }
    const cityId = actor.agentState?.cityId ?? null;
    const clinic = cityId
        ? await prisma.business.findFirst({
            where: {
                cityId,
                businessType: 'CLINIC',
                status: 'ACTIVE',
                isOpen: true,
            },
        })
        : null;
    const clinicWallet = clinic
        ? await prisma.businessWallet.findUnique({ where: { businessId: clinic.id } })
        : null;
    const paymentTarget = clinic && clinicWallet ? 'clinic' : 'public_vault';
    let transfer;
    try {
        transfer = await agentTransferService.transfer(
            actorId,
            null,
            ethers.parseEther(REBIRTH_FEE.toString()),
            'rebirth_fee',
            cityId ?? undefined,
            paymentTarget === 'clinic' ? clinicWallet?.walletAddress : CONTRACTS.PUBLIC_VAULT_AND_GOD
        );
    } catch (error) {
        await prisma.actor.update({
            where: { id: actorId },
            data: { frozenReason: `rebirth_fee_transfer_failed:${currentTick}` },
        });
        console.warn(`Rebirth fee transfer failed for ${actorId}`, error);
        return false;
    }
    const netAmount = new Decimal(ethers.formatEther(transfer.netAmount));
    const feePlatform = new Decimal(ethers.formatEther(transfer.platformFee));
    const feeCity = new Decimal(ethers.formatEther(transfer.cityFee));

    await prisma.$transaction(async (tx: TransactionClient) => {
        if (applyDeposit && depositAmount > 0) {
            // Add deposited SBYTE
            await tx.wallet.update({
                where: { actorId },
                data: {
                    balanceSbyte: { increment: depositAmount },
                },
            });
        }

        // Reset to baseline stats
        await tx.agentState.update({
            where: { actorId },
            data: {
                health: 30,
                energy: 30,
                hunger: 30,
                social: 20,
                fun: 20,
                purpose: 20,
                // Housing remains street, must find housing
            },
        });

        // Clear frozen flag
        await tx.actor.update({
            where: { id: actorId },
            data: {
                frozen: false,
                frozenReason: null,
            },
        });

        // Create revival event
        await tx.event.create({
            data: {
                actorId,
                type: EventType.EVENT_UNFROZEN,
                targetIds: [],
                tick: currentTick,
                outcome: EventOutcome.SUCCESS,
                sideEffects: {
                    reason: 'rebirth_fee',
                    depositAmount,
                    depositorInfo,
                    fee: REBIRTH_FEE.toNumber(),
                    paymentTarget,
                    clinicId: clinic?.id ?? null,
                    clinicName: clinic?.name ?? null,
                    cityId,
                    txHash: transfer.txHash,
                    netAmount: netAmount.toNumber(),
                    feePlatform: feePlatform.toNumber(),
                    feeCity: feeCity.toNumber(),
                },
            },
        });

        if (clinic && clinicWallet) {
            await tx.business.update({
                where: { id: clinic.id },
                data: { treasury: { increment: netAmount.toNumber() } },
            });
            await tx.businessWallet.update({
                where: { businessId: clinic.id },
                data: { balanceSbyte: { increment: netAmount.toNumber() } },
            });
            await tx.transaction.create({
                data: {
                    fromActorId: actorId,
                    toActorId: clinic.ownerId ?? null,
                    amount: REBIRTH_FEE.toNumber(),
                    feePlatform: feePlatform.toNumber(),
                    feeCity: feeCity.toNumber(),
                    cityId,
                    tick: currentTick,
                    reason: 'REBIRTH_FEE',
                    onchainTxHash: transfer.txHash,
                    metadata: {
                        clinicId: clinic.id,
                        clinicName: clinic.name,
                        paymentTarget,
                    },
                },
            });
        } else {
            await tx.transaction.create({
                data: {
                    fromActorId: actorId,
                    toActorId: null,
                    amount: REBIRTH_FEE.toNumber(),
                    feePlatform: feePlatform.toNumber(),
                    feeCity: feeCity.toNumber(),
                    cityId,
                    tick: currentTick,
                    reason: 'REBIRTH_FEE',
                    onchainTxHash: transfer.txHash,
                    metadata: {
                        paymentTarget,
                    },
                },
            });
        }
    });

    console.log(`Agent ${actorId} revived via deposit of ${depositAmount} SBYTE`);
    return true;
}

/**
 * Auto-revive frozen agents when balance is positive.
 * This is a safety net for manual deposits that bypass explicit revive calls.
 */
export async function reviveFrozenAgents(currentTick: number): Promise<number> {
    const frozenAgents = await prisma.actor.findMany({
        where: {
            kind: 'agent',
            frozen: true,
            wallet: { balanceSbyte: { gt: 0 } },
        },
        include: { agentState: true, wallet: true, agentWallet: true },
    });

    let revived = 0;
    for (const agent of frozenAgents) {
        if (!agent.agentState || !agent.wallet || !agent.agentWallet) continue;
        if (typeof agent.frozenReason === 'string' && agent.frozenReason.startsWith('rebirth_fee_transfer_failed:')) {
            const [, rawTick] = agent.frozenReason.split(':');
            const lastTick = Number(rawTick);
            if (Number.isFinite(lastTick) && currentTick - lastTick < 120) {
                continue;
            }
        }
        const onchainSbyte = new Decimal(agent.agentWallet.balanceSbyte.toString());
        if (onchainSbyte.lessThan(REBIRTH_FEE)) continue;
        await reviveAgent(
            agent.id,
            0,
            'balance_positive',
            currentTick,
            false
        );
        revived += 1;
    }

    return revived;
}
