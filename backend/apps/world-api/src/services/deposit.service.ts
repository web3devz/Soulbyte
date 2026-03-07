/**
 * Deposit Service
 * Handles incoming SBYTE and MON deposits to agent wallets
 */

import { prisma } from '../db.js';
import { CONTRACTS } from '../config/contracts.js';
import { ethers } from 'ethers';
import { formatSbyteForLedger } from '../utils/amounts.js';
import { reviveAgent } from '../engine/freeze.engine.js';

/**
 * Deposit Service class
 */
export class DepositService {
    private unknownDepositLogCache = new Map<string, number>();
    private readonly unknownDepositLogIntervalMs = Number(process.env.UNKNOWN_DEPOSIT_LOG_INTERVAL_MS ?? 60_000);

    private shouldLogUnknown(address: string): boolean {
        const now = Date.now();
        const last = this.unknownDepositLogCache.get(address) ?? 0;
        if (now - last < this.unknownDepositLogIntervalMs) {
            return false;
        }
        this.unknownDepositLogCache.set(address, now);
        return true;
    }

    private isSystemAddress(address: string): boolean {
        const lower = address.toLowerCase();
        const system = new Set([
            CONTRACTS.PUBLIC_VAULT_AND_GOD,
            CONTRACTS.SBYTE_BONDING_CURVE,
            CONTRACTS.PLATFORM_FEE_VAULT,
            CONTRACTS.BURN_ADDRESS,
            CONTRACTS.DEPLOYER,
            CONTRACTS.SBYTE_DISTRIBUTOR,
        ].filter(Boolean).map((addr) => addr.toLowerCase()));
        return system.has(lower);
    }

    /**
     * Process an incoming deposit
     * Called by BlockchainListenerService when transfer detected
     * @param txHash - Transaction hash
     * @param toAddress - Recipient wallet address
     * @param tokenAddress - Token contract (null for native MON)
     * @param amount - Amount in wei
     * @param blockNumber - Block number
     */
    async processDeposit(
        txHash: string,
        toAddress: string,
        tokenAddress: string | null,
        amount: bigint,
        blockNumber: bigint
    ): Promise<void> {
        // Find agent by wallet address
        const agentWallet = await prisma.agentWallet.findUnique({
            where: { walletAddress: toAddress.toLowerCase() },
            include: { actor: true },
        });

        if (!agentWallet) {
            if (!this.isSystemAddress(toAddress) && this.shouldLogUnknown(toAddress.toLowerCase())) {
                console.log(`Deposit to unknown address ${toAddress}, ignoring`);
            }
            return;
        }

        // Check if we already processed this tx
        const existingTx = await prisma.onchainTransaction.findUnique({
            where: { txHash },
        });
        if (existingTx) {
            console.log(`Transaction ${txHash} already processed, skipping`);
            return;
        }

        const isMonDeposit = tokenAddress === null;
        const isSbyteDeposit = tokenAddress?.toLowerCase() === CONTRACTS.SBYTE_TOKEN.toLowerCase();

        if (!isMonDeposit && !isSbyteDeposit) {
            console.log(`Unknown token deposit ${tokenAddress}, ignoring`);
            return;
        }

        // Record the transaction
        const amountFormatted = isSbyteDeposit
            ? ethers.formatUnits(amount, 18)
            : ethers.formatEther(amount);

        await prisma.onchainTransaction.create({
            data: {
                txHash,
                blockNumber,
                fromAddress: '0x0000000000000000000000000000000000000000', // External deposit
                toAddress: toAddress.toLowerCase(),
                tokenAddress: tokenAddress?.toLowerCase() ?? null,
                amount: amountFormatted,
                toActorId: agentWallet.actorId,
                txType: 'HUMAN_DEPOSIT',
                status: 'confirmed',
                confirmedAt: new Date(),
            },
        });

        // Update agent wallet balance
        if (isSbyteDeposit) {
            await prisma.agentWallet.update({
                where: { actorId: agentWallet.actorId },
                data: {
                    balanceSbyte: { increment: amountFormatted },
                    lastSyncedBlock: blockNumber,
                    lastSyncedAt: new Date(),
                },
            });

            // Update game wallet
            await prisma.wallet.update({
                where: { actorId: agentWallet.actorId },
                data: {
                    balanceSbyte: { increment: formatSbyteForLedger(amountFormatted) },
                },
            });

            // Check if this revives a frozen agent
            await this.checkFreezeRevival(agentWallet.actorId, amountFormatted);

            console.log(`SBYTE deposit: ${amount} to agent ${agentWallet.actorId} (tx: ${txHash})`);
        } else {
            // MON deposit
            await prisma.agentWallet.update({
                where: { actorId: agentWallet.actorId },
                data: {
                    balanceMon: { increment: amountFormatted },
                    lastSyncedBlock: blockNumber,
                    lastSyncedAt: new Date(),
                },
            });

            console.log(`MON deposit: ${amount} to agent ${agentWallet.actorId} (tx: ${txHash})`);
        }
    }

    /**
     * Check if deposit should revive a frozen agent
     * Agents are frozen when they reach W0 wealth tier (economic death)
     * A deposit can revive them if it brings balance above threshold
     * @param actorId - The agent's actor ID
     * @param depositAmount - Amount deposited
     */
    async checkFreezeRevival(actorId: string, depositAmount: string): Promise<void> {
        const actor = await prisma.actor.findUnique({
            where: { id: actorId },
            include: {
                agentState: true,
                wallet: true,
            },
        });

        if (!actor || !actor.frozen) {
            return; // Not frozen, nothing to do
        }
        const worldState = await prisma.worldState.findFirst({ where: { id: 1 }, select: { tick: true } });
        const currentTick = worldState?.tick ?? 0;
        const revived = await reviveAgent(
            actorId,
            Number(depositAmount || 0),
            'human_deposit',
            currentTick,
            false
        );
        if (revived) {
            console.log(`Agent ${actorId} revived after rebirth fee payment`);
        }
    }
}
