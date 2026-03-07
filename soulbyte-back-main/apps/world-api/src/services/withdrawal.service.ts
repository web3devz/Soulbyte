/**
 * Withdrawal Service
 * Handles human withdrawal requests from agent wallets
 * Agents have free will to accept or decline withdrawals
 */

import { ethers } from 'ethers';
import { Decimal } from 'decimal.js';
import { prisma } from '../db.js';
import { CONTRACTS, ERC20_ABI } from '../config/contracts.js';
import { WalletService } from './wallet.service.js';
import { withRpcRetry } from '../utils/rpc-retry.js';
import { assertReceiptSuccess } from '../utils/onchain.js';
import { formatSbyteForLedger } from '../utils/amounts.js';

/** Withdrawal request expiration time (24 hours) */
const WITHDRAWAL_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * Withdrawal Service class
 */
export class WithdrawalService {
    private walletService: WalletService;

    constructor() {
        this.walletService = new WalletService();
    }

    /**
     * Request a withdrawal from agent wallet
     * Creates a pending request that the agent will process
     * @param actorId - The agent's actor ID
     * @param humanAddress - Destination address for withdrawal
     * @param amount - Amount to withdraw (wei)
     * @returns The withdrawal request
     */
    async requestWithdrawal(
        actorId: string,
        humanAddress: string,
        amount: string
    ): Promise<{ requestId: string; status: string; expiresAt: Date }> {
        // Validate address
        if (!ethers.isAddress(humanAddress)) {
            throw new Error('Invalid destination address');
        }

        // Check agent has wallet
        const agentWallet = await prisma.agentWallet.findUnique({
            where: { actorId },
        });
        if (!agentWallet) {
            throw new Error('Agent has no linked wallet');
        }

        // Check sufficient balance
        const currentBalance = new Decimal(agentWallet.balanceSbyte.toString());
        const requestedAmount = new Decimal(amount);
        if (!requestedAmount.isFinite() || requestedAmount.lte(0)) {
            throw new Error('Invalid withdrawal amount');
        }
        if (currentBalance.lessThan(requestedAmount)) {
            throw new Error('Insufficient balance for withdrawal');
        }

        // Check for existing pending request
        const pendingRequest = await prisma.withdrawalRequest.findFirst({
            where: {
                actorId,
                status: 'pending',
            },
        });
        if (pendingRequest) {
            throw new Error('Agent already has a pending withdrawal request');
        }

        // Create withdrawal request
        const expiresAt = new Date(Date.now() + WITHDRAWAL_EXPIRY_MS);
        const request = await prisma.withdrawalRequest.create({
            data: {
                actorId,
                humanAddress: humanAddress.toLowerCase(),
                amount: amount,
                status: 'pending',
                expiresAt,
            },
        });

        console.log(`Withdrawal request created: ${request.id} for ${amount} SBYTE from agent ${actorId}`);

        return {
            requestId: request.id,
            status: 'pending',
            expiresAt,
        };
    }

    /**
     * Execute an approved withdrawal
     * Called by withdrawal handler after agent accepts
     * @param requestId - The withdrawal request ID
     * @returns Transaction hash
     */
    async executeWithdrawal(requestId: string): Promise<{ txHash: string }> {
        const request = await prisma.withdrawalRequest.findUnique({
            where: { id: requestId },
            include: { actor: true },
        });

        if (!request) {
            throw new Error('Withdrawal request not found');
        }

        if (request.status !== 'accepted') {
            throw new Error(`Cannot execute withdrawal with status: ${request.status}`);
        }

        // Get signer wallet
        const signer = await this.walletService.getSignerWallet(request.actorId);

        // Create contract instance with signer
        const sbyteContract = new ethers.Contract(
            CONTRACTS.SBYTE_TOKEN,
            ERC20_ABI,
            signer
        );

        // Execute transfer
        const amount = new Decimal(request.amount.toString());
        const amountWei = ethers.parseUnits(amount.toString(), 18);
        const tx = await withRpcRetry(
            () => sbyteContract.transfer(request.humanAddress, amountWei),
            'withdrawalTransfer'
        );
        const receipt = await withRpcRetry(() => tx.wait(), 'withdrawalTransferWait');
        assertReceiptSuccess(receipt, 'withdrawalTransfer');

        // Update request status
        await prisma.$transaction(async (tx) => {
            await tx.withdrawalRequest.update({
                where: { id: requestId },
                data: {
                    status: 'completed',
                    txHash: tx.hash,
                    completedAt: new Date(),
                },
            });

            const agentWallet = await tx.agentWallet.findUnique({
                where: { actorId: request.actorId },
            });

            await tx.onchainTransaction.create({
                data: {
                    txHash: tx.hash,
                    blockNumber: BigInt(receipt?.blockNumber || 0),
                    fromAddress: agentWallet?.walletAddress || '',
                    toAddress: request.humanAddress,
                    tokenAddress: CONTRACTS.SBYTE_TOKEN,
                    amount: request.amount.toString(),
                    fromActorId: request.actorId,
                    txType: 'HUMAN_WITHDRAWAL',
                    status: 'confirmed',
                    confirmedAt: new Date(),
                },
            });

            await tx.agentWallet.update({
                where: { actorId: request.actorId },
                data: {
                    balanceSbyte: { decrement: request.amount.toString() },
                },
            });

            await tx.wallet.update({
                where: { actorId: request.actorId },
                data: {
                    balanceSbyte: { decrement: formatSbyteForLedger(request.amount.toString()) },
                },
            });
        });

        console.log(`Withdrawal executed: ${tx.hash} for ${amount.toString()} SBYTE to ${request.humanAddress}`);

        return { txHash: tx.hash };
    }

    /**
     * Accept a withdrawal request (called by agent/handler)
     * @param requestId - The withdrawal request ID
     */
    async acceptWithdrawal(requestId: string): Promise<void> {
        await prisma.withdrawalRequest.update({
            where: { id: requestId },
            data: {
                status: 'accepted',
                acceptedAt: new Date(),
            },
        });
    }

    /**
     * Decline a withdrawal request (called by agent/handler)
     * @param requestId - The withdrawal request ID
     * @param reason - Reason for declining
     */
    async declineWithdrawal(requestId: string, reason: string): Promise<void> {
        await prisma.withdrawalRequest.update({
            where: { id: requestId },
            data: {
                status: 'declined',
                declinedAt: new Date(),
                declinedReason: reason,
            },
        });
    }

    /**
     * Expire old pending requests
     * Called by background job
     */
    async expirePendingRequests(): Promise<number> {
        const result = await prisma.withdrawalRequest.updateMany({
            where: {
                status: 'pending',
                expiresAt: { lt: new Date() },
            },
            data: {
                status: 'expired',
            },
        });

        if (result.count > 0) {
            console.log(`Expired ${result.count} withdrawal requests`);
        }

        return result.count;
    }

    /**
     * Get pending withdrawal requests for an agent
     * @param actorId - The agent's actor ID
     */
    async getPendingRequests(actorId: string) {
        return prisma.withdrawalRequest.findMany({
            where: {
                actorId,
                status: 'pending',
            },
            orderBy: { createdAt: 'desc' },
        });
    }
}
