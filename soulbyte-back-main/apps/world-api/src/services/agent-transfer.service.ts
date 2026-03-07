/**
 * Agent Transfer Service
 * Handles agent-to-agent SBYTE transfers on-chain with fee collection
 */

import { ethers } from 'ethers';
import crypto from 'crypto';
import { prisma } from '../db.js';
import { CONTRACTS, ERC20_ABI } from '../config/contracts.js';
import { calculateFees, getCachedVaultHealth, getDynamicFeeBps } from '../config/fees.js';
import { WalletService } from './wallet.service.js';
import { withRpcRetry } from '../utils/rpc-retry.js';
import { assertReceiptSuccess } from '../utils/onchain.js';
import { formatSbyteForLedger } from '../utils/amounts.js';

// Transaction type enum - matches Prisma OnchainTxType
// After migration, import from '@prisma/client' instead
type OnchainTxType =
    | 'HUMAN_DEPOSIT'
    | 'HUMAN_WITHDRAWAL'
    | 'AGENT_TO_AGENT'
    | 'PLATFORM_FEE'
    | 'CITY_FEE'
    | 'SALARY_PAYMENT'
    | 'RENT_PAYMENT'
    | 'MARKET_PURCHASE'
    | 'BUSINESS_PAYMENT'
    | 'BUSINESS_BUILD'
    | 'BUSINESS_WITHDRAW'
    | 'BUSINESS_INJECT'
    | 'BUSINESS_SALE'
    | 'LOAN_ISSUED'
    | 'LOAN_REPAID'
    | 'LOAN_DEFAULTED'
    | 'LIFE_EVENT_FORTUNE'
    | 'LIFE_EVENT_MISFORTUNE';

/**
 * Transfer reason to transaction type mapping
 */
const REASON_TO_TX_TYPE: Record<string, OnchainTxType> = {
    trade: 'AGENT_TO_AGENT',
    salary: 'SALARY_PAYMENT',
    rent: 'RENT_PAYMENT',
    market: 'MARKET_PURCHASE',
    household: 'AGENT_TO_AGENT',
    theft: 'AGENT_TO_AGENT',
    fraud: 'AGENT_TO_AGENT',
    alliance_fee: 'AGENT_TO_AGENT',
    construction_city: 'AGENT_TO_AGENT',
    business: 'BUSINESS_PAYMENT',
    business_build: 'BUSINESS_BUILD',
    business_withdraw: 'BUSINESS_WITHDRAW',
    business_inject: 'BUSINESS_INJECT',
    business_sale: 'BUSINESS_SALE',
    loan_issued: 'LOAN_ISSUED',
    loan_repaid: 'LOAN_REPAID',
    loan_defaulted: 'LOAN_DEFAULTED',
    life_fortune: 'LIFE_EVENT_FORTUNE',
    life_misfortune: 'LIFE_EVENT_MISFORTUNE',
};

/**
 * Agent Transfer Service class
 */
export class AgentTransferService {
    private walletService: WalletService;

    constructor() {
        this.walletService = new WalletService();
    }

    /**
     * Execute an agent-to-agent SBYTE transfer on-chain
     * @param fromActorId - Sender agent ID
     * @param toActorId - Recipient agent ID
     * @param amount - Amount to transfer (wei)
     * @param reason - Transfer reason (trade, salary, rent, market)
     * @param cityId - Optional city ID for city fee allocation
     * @returns Transaction hash
     */
    async transfer(
        fromActorId: string,
        toActorId: string | null,
        amount: bigint,
        reason: string,
        cityId?: string,
        toAddressOverride?: string,
        cityFeeMultiplier: number = 1
    ): Promise<{ txHash: string; netAmount: bigint; platformFee: bigint; cityFee: bigint }> {
        // Get sender wallet
        const fromWallet = await prisma.agentWallet.findUnique({
            where: { actorId: fromActorId },
        });
        if (!fromWallet) {
            throw new Error('Sender has no linked wallet');
        }

        // Get recipient wallet (if exists) or valid address
        let toAddress: string;
        let toWallet: any = null;

        if (toAddressOverride) {
            toAddress = toAddressOverride;
            // Optionally check if this address maps to an agent? 
            // For efficiency, we assume override is specific (e.g. Vault)
        } else {
            toWallet = await prisma.agentWallet.findUnique({
                where: { actorId: toActorId as string },
            });
            if (!toWallet) {
                throw new Error('Recipient has no linked wallet');
            }
            toAddress = toWallet.walletAddress;
        }

        // Check balance
        const senderBalance = ethers.parseEther(fromWallet.balanceSbyte.toString());
        if (senderBalance < amount) {
            throw new Error('Insufficient balance');
        }

        // Get dynamic fee rate based on vault health
        const vaultHealthDays = getCachedVaultHealth();
        const dynamicFeeBps = getDynamicFeeBps(vaultHealthDays);

        // Calculate fees (dynamic platform + city)
        const multiplier = Number.isFinite(cityFeeMultiplier) && cityFeeMultiplier > 0 ? cityFeeMultiplier : 1;
        const fees = calculateFees(amount, dynamicFeeBps.cityBps * multiplier, dynamicFeeBps.platformBps);

        let txHash = '0x' + Array(64).fill('0').join('');
        let blockNumber = 0n;

        let cityFeeConfirmed = false;
        if (process.env.SKIP_ONCHAIN_EXECUTION === 'true') {
            console.log(`[SIM] Skipping on-chain transfer for ${amount} wei`);
            // Mock hash
            txHash = '0x' + Math.random().toString(16).substr(2, 64).padStart(64, '0');
        } else {
            try {
                // Get signer wallet
                const signer = await this.walletService.getSignerWallet(fromActorId);
                const sbyteContract = new ethers.Contract(
                    CONTRACTS.SBYTE_TOKEN,
                    ERC20_ABI,
                    signer
                );

                const onchainBalance = await withRpcRetry(
                    () => sbyteContract.balanceOf(fromWallet.walletAddress),
                    'balanceOf',
                    { attempts: 3 }
                );
                if (onchainBalance < amount) {
                    throw new Error('On-chain balance insufficient');
                }

                // Gas estimation with buffer
                const gasEstimate = await withRpcRetry(
                    () => sbyteContract.transfer.estimateGas(toAddress, fees.netAmount),
                    'estimateGas',
                    { attempts: 4 }
                );
                const gasLimit = (gasEstimate * 120n) / 100n; // 1.2x buffer

                // Execute main transfer (net amount to recipient)
                const mainTx = await withRpcRetry(
                    () => sbyteContract.transfer(toAddress, fees.netAmount, { gasLimit }),
                    'transfer',
                    { attempts: 4 }
                );

                // Wait for confirmation
                const receipt = await withRpcRetry(() => mainTx.wait(), 'waitReceipt', { attempts: 4 });
                assertReceiptSuccess(receipt, 'agentTransferMain');
                txHash = mainTx.hash;
                blockNumber = BigInt(receipt?.blockNumber || 0);

                // Transfer platform fee
                if (fees.platformFee > 0n) {
                    try {
                        const platformTx = await withRpcRetry(
                            () => sbyteContract.transfer(CONTRACTS.PLATFORM_FEE_VAULT, fees.platformFee),
                            'platformFeeTransfer',
                            { attempts: 4 }
                        );
                        const platformReceipt = await withRpcRetry(() => platformTx.wait(), 'platformFeeWait', { attempts: 4 });
                        assertReceiptSuccess(platformReceipt, 'agentTransferPlatformFee');
                    } catch (error) {
                        console.error('Failed to transfer platform fee:', error);
                    }
                }

                // Transfer city fee to public vault (tracked per city in DB)
                if (fees.cityFee > 0n) {
                    try {
                        const cityTx = await withRpcRetry(
                            () => sbyteContract.transfer(CONTRACTS.PUBLIC_VAULT_AND_GOD, fees.cityFee),
                            'cityFeeTransfer',
                            { attempts: 4 }
                        );
                        const cityReceipt = await withRpcRetry(() => cityTx.wait(), 'cityFeeWait', { attempts: 4 });
                        assertReceiptSuccess(cityReceipt, 'agentTransferCityFee');
                        cityFeeConfirmed = true;
                    } catch (error) {
                        console.error('Failed to transfer city fee:', error);
                    }
                }
            } catch (error: any) {
                const failedHash = `0x${crypto.randomBytes(32).toString('hex')}`;
                await prisma.onchainTransaction.create({
                    data: {
                        txHash: failedHash,
                        blockNumber: BigInt(0),
                        fromAddress: fromWallet.walletAddress,
                        toAddress,
                        tokenAddress: CONTRACTS.SBYTE_TOKEN,
                        amount: ethers.formatEther(amount),
                        fromActorId,
                        toActorId,
                        txType: REASON_TO_TX_TYPE[reason] ?? ('AGENT_TO_AGENT' as OnchainTxType),
                        platformFee: ethers.formatEther(fees.platformFee),
                        cityFee: ethers.formatEther(fees.cityFee),
                        cityId,
                        status: 'failed',
                        failedReason: String(error?.message || error),
                    },
                });
                throw error;
            }
        }

        // Record transaction
        const amountFormatted = ethers.formatEther(amount);
        const netFormatted = ethers.formatEther(fees.netAmount);
        const cityFeeFormatted = ethers.formatEther(fees.cityFee);
        await prisma.$transaction(async (tx) => {
            await tx.onchainTransaction.create({
                data: {
                    txHash: txHash,
                    blockNumber: BigInt(blockNumber),
                    fromAddress: fromWallet.walletAddress,
                    toAddress: toAddress,
                    tokenAddress: CONTRACTS.SBYTE_TOKEN,
                    amount: amountFormatted,
                    fromActorId,
                    toActorId,
                    txType: REASON_TO_TX_TYPE[reason] ?? ('AGENT_TO_AGENT' as OnchainTxType),
                    platformFee: ethers.formatEther(fees.platformFee),
                    cityFee: cityFeeFormatted,
                    cityId,
                    status: 'confirmed',
                    confirmedAt: new Date(),
                },
            });

            await tx.agentWallet.update({
                where: { actorId: fromActorId },
                data: { balanceSbyte: { decrement: amountFormatted } },
            });

            await tx.wallet.update({
                where: { actorId: fromActorId },
                data: { balanceSbyte: { decrement: formatSbyteForLedger(amountFormatted) } },
            });

            if (toWallet) {
                await tx.agentWallet.update({
                    where: { actorId: toActorId },
                    data: { balanceSbyte: { increment: netFormatted } },
                });

                await tx.wallet.update({
                    where: { actorId: toActorId },
                    data: { balanceSbyte: { increment: formatSbyteForLedger(netFormatted) } },
                });
            }

            if (cityId && fees.cityFee > 0n && cityFeeConfirmed) {
                await tx.cityVault.update({
                    where: { cityId },
                    data: { balanceSbyte: { increment: formatSbyteForLedger(cityFeeFormatted) } },
                });
            }
        });

        console.log(`Transfer: ${amount} SBYTE from ${fromActorId} to ${toActorId} (tx: ${txHash})`);

        return {
            txHash: txHash,
            netAmount: fees.netAmount,
            platformFee: fees.platformFee,
            cityFee: fees.cityFee,
        };
    }

    /**
     * Check if transfer is possible (validation only, no execution)
     * @param fromActorId - Sender agent ID
     * @param amount - Amount to transfer
     */
    async canTransfer(fromActorId: string, amount: bigint): Promise<boolean> {
        const wallet = await prisma.agentWallet.findUnique({
            where: { actorId: fromActorId },
        });

        if (!wallet) {
            return false;
        }

        const balance = BigInt(wallet.balanceSbyte.toString());
        return balance >= amount;
    }

    async transferMon(
        fromActorId: string,
        toAddress: string,
        amount: bigint,
        reason: string,
        cityId?: string
    ): Promise<{ txHash: string }> {
        const fromWallet = await prisma.agentWallet.findUnique({
            where: { actorId: fromActorId },
        });
        if (!fromWallet) {
            throw new Error('Sender has no linked wallet');
        }

        let txHash = '0x' + Array(64).fill('0').join('');
        let blockNumber = 0n;

        if (process.env.SKIP_ONCHAIN_EXECUTION === 'true') {
            txHash = '0x' + Math.random().toString(16).substr(2, 64).padStart(64, '0');
        } else {
            const signer = await this.walletService.getSignerWallet(fromActorId);
            const tx = await withRpcRetry(
                () => signer.sendTransaction({ to: toAddress, value: amount }),
                'transferMon',
                { attempts: 4 }
            );
            const receipt = await withRpcRetry(() => tx.wait(), 'transferMonWait', { attempts: 4 });
            assertReceiptSuccess(receipt, 'transferMon');
            txHash = tx.hash;
            blockNumber = BigInt(receipt?.blockNumber || 0);
        }

        await prisma.onchainTransaction.create({
            data: {
                txHash,
                blockNumber: BigInt(blockNumber),
                fromAddress: fromWallet.walletAddress,
                toAddress,
                tokenAddress: null,
                amount: ethers.formatEther(amount),
                fromActorId,
                toActorId: null,
                txType: REASON_TO_TX_TYPE[reason] ?? ('AGENT_TO_AGENT' as OnchainTxType),
                platformFee: '0',
                cityFee: '0',
                cityId,
                status: 'confirmed',
                confirmedAt: new Date(),
            },
        });

        await prisma.agentWallet.update({
            where: { actorId: fromActorId },
            data: { balanceMon: { decrement: ethers.formatEther(amount) } },
        });

        return { txHash };
    }
}
