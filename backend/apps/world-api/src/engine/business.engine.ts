import { prisma } from '../db.js';
import { Decimal } from 'decimal.js';
import { AgentTransferService } from '../services/agent-transfer.service.js';
import { WalletService } from '../services/wallet.service.js';
import { CONTRACTS } from '../config/contracts.js';
import { EventType, EventOutcome } from '../types/event.types.js';
import { ethers } from 'ethers';
import crypto from 'crypto';
import { DEFAULT_BUSINESS_PRICES } from '../config/economy.js';
import { BusinessWalletService } from '../services/business-wallet.service.js';
import { withRpcRetry } from '../utils/rpc-retry.js';
import { assertReceiptSuccess } from '../utils/onchain.js';
import { REAL_DAY_TICKS } from '../config/time.js';
import { getLatestSnapshot } from '../services/economy-snapshot.service.js';

const agentTransferService = new AgentTransferService();
const walletService = new WalletService();
const businessWalletService = new BusinessWalletService();


async function recordFailedOnchainTx(data: {
    fromAddress: string;
    toAddress: string;
    amount: string;
    fromActorId?: string | null;
    toActorId?: string | null;
    txType: string;
    cityId?: string | null;
    reason: string;
}) {
    const failedHash = `0x${crypto.randomBytes(32).toString('hex')}`;
    await prisma.onchainTransaction.create({
        data: {
            txHash: failedHash,
            blockNumber: BigInt(0),
            fromAddress: data.fromAddress,
            toAddress: data.toAddress,
            tokenAddress: CONTRACTS.SBYTE_TOKEN,
            amount: data.amount,
            fromActorId: data.fromActorId ?? null,
            toActorId: data.toActorId ?? null,
            txType: data.txType as any,
            platformFee: '0',
            cityFee: '0',
            cityId: data.cityId ?? null,
            status: 'failed',
            failedReason: data.reason,
        },
    });
}

const DEMAND_FACTORS: Record<string, number> = {
    BANK: 0.15,
    CASINO: 0.10,
    STORE: 0.20,
    RESTAURANT: 0.25,
    TAVERN: 0.20,
    GYM: 0.08,
    CLINIC: 0.06,
    REALESTATE: 0.03,
    WORKSHOP: 0.07,
};

const BUSINESS_MAINTENANCE_DAILY: Record<string, number> = {
    RESTAURANT: 30,
    CASINO: 100,
    CLINIC: 80,
    BANK: 50,
    STORE: 20,
    TAVERN: 15,
    GYM: 25,
    REALESTATE: 10,
    WORKSHOP: 30,
};

function getBusinessMaintenanceCost(type: string, level: number): number {
    const base = BUSINESS_MAINTENANCE_DAILY[type] ?? 20;
    return base * (1 + (level - 1) * 0.3);
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function getMarketPrice(type: string, snapshot: ReturnType<typeof getLatestSnapshot> | null): number {
    if (!snapshot) return DEFAULT_BUSINESS_PRICES[type] ?? 20;
    if (['RESTAURANT', 'TAVERN'].includes(type)) {
        return snapshot.avg_meal_price || DEFAULT_BUSINESS_PRICES[type] || 20;
    }
    if (['STORE', 'WORKSHOP'].includes(type)) {
        return snapshot.avg_item_price || DEFAULT_BUSINESS_PRICES[type] || 20;
    }
    if (['GYM', 'CLINIC'].includes(type)) {
        const wage = snapshot.avg_wage_private || snapshot.avg_wage_public || 0;
        return wage > 0 ? wage * 0.3 : DEFAULT_BUSINESS_PRICES[type] || 20;
    }
    if (['BANK', 'CASINO', 'REALESTATE'].includes(type)) {
        const base = snapshot.median_agent_balance || snapshot.avg_agent_balance || 0;
        return base > 0 ? base * 0.03 : DEFAULT_BUSINESS_PRICES[type] || 20;
    }
    return DEFAULT_BUSINESS_PRICES[type] ?? 20;
}

function getEffectivePrice(business: any, snapshot: ReturnType<typeof getLatestSnapshot> | null): Decimal {
    const market = getMarketPrice(business.businessType, snapshot);
    const configPrice = Number((business.config as any)?.pricePerService ?? 0);
    const base = configPrice > 0 ? configPrice : market;
    const qualityAdj = clamp(0.85 + (business.qualityScore / 100) * 0.35, 0.7, 1.2);
    const repAdj = clamp(0.9 + (business.reputation / 1000) * 0.35, 0.8, 1.25);
    const inflationAdj = snapshot ? clamp(1 + (snapshot.inflation_pressure ?? 0) * 0.5, 0.7, 1.4) : 1;
    const price = Math.max(1, Math.round(base * qualityAdj * repAdj * inflationAdj));
    return new Decimal(price);
}


function deterministicSort(seed: bigint, ids: string[]): string[] {
    return ids.sort((a, b) => {
        const ha = BigInt.asUintN(64, seed ^ BigInt(a.charCodeAt(0)));
        const hb = BigInt.asUintN(64, seed ^ BigInt(b.charCodeAt(0)));
        return Number(ha - hb);
    });
}

function getRequiredEmployees(level: number, maxEmployees: number): number {
    const requiredByLevel = Math.max(1, Math.ceil(level / 2));
    return Math.min(maxEmployees, requiredByLevel);
}

async function sendProfessionTax(fromActorId: string, amount: Decimal, cityId: string, tick: number) {
    if (amount.lte(0)) return;
    const signer = await walletService.getSignerWallet(fromActorId);
    const sbyteContract = new ethers.Contract(CONTRACTS.SBYTE_TOKEN, ['function transfer(address to, uint256 amount) returns (bool)'], signer);
    if (process.env.SKIP_ONCHAIN_EXECUTION === 'true') {
        const mockHash = `0x${crypto.randomBytes(32).toString('hex')}`;
        await prisma.onchainTransaction.create({
            data: {
                txHash: mockHash,
                blockNumber: BigInt(0),
                fromAddress: signer.address,
                toAddress: CONTRACTS.PUBLIC_VAULT_AND_GOD,
                tokenAddress: CONTRACTS.SBYTE_TOKEN,
                amount: amount.toString(),
                fromActorId,
                toActorId: null,
                txType: 'CITY_FEE',
                platformFee: '0',
                cityFee: amount.toString(),
                cityId,
                status: 'confirmed',
                confirmedAt: new Date()
            }
        });
        await prisma.transaction.create({
            data: {
                fromActorId,
                toActorId: null,
                amount: amount.toNumber(),
                feePlatform: 0,
                feeCity: 0,
                cityId,
                tick,
                reason: 'PROFESSION_TAX',
                onchainTxHash: mockHash,
                metadata: { source: 'business_profession_tax' }
            }
        });
        await prisma.cityVault.update({
            where: { cityId },
            data: { balanceSbyte: { increment: amount.toString() } }
        });
        return;
    }
    try {
        const tx = await withRpcRetry(
            () => sbyteContract.transfer(CONTRACTS.PUBLIC_VAULT_AND_GOD, ethers.parseEther(amount.toString())),
            'businessProfessionTax'
        );
        const receipt = await withRpcRetry(() => tx.wait(), 'businessProfessionTaxWait');
        assertReceiptSuccess(receipt, 'businessProfessionTax');

        await prisma.onchainTransaction.create({
            data: {
                txHash: tx.hash,
                blockNumber: BigInt(receipt?.blockNumber || 0),
                fromAddress: signer.address,
                toAddress: CONTRACTS.PUBLIC_VAULT_AND_GOD,
                tokenAddress: CONTRACTS.SBYTE_TOKEN,
                amount: amount.toString(),
                fromActorId,
                toActorId: null,
                txType: 'CITY_FEE',
                platformFee: '0',
                cityFee: amount.toString(),
                cityId,
                status: 'confirmed',
                confirmedAt: new Date()
            }
        });
        await prisma.transaction.create({
            data: {
                fromActorId,
                toActorId: null,
                amount: amount.toNumber(),
                feePlatform: 0,
                feeCity: 0,
                cityId,
                tick,
                reason: 'PROFESSION_TAX',
                onchainTxHash: tx.hash,
                metadata: { source: 'business_profession_tax' }
            }
        });

        await prisma.cityVault.update({
            where: { cityId },
            data: { balanceSbyte: { increment: amount.toString() } }
        });
    } catch (error: any) {
        await recordFailedOnchainTx({
            fromAddress: signer.address,
            toAddress: CONTRACTS.PUBLIC_VAULT_AND_GOD,
            amount: amount.toString(),
            fromActorId,
            toActorId: null,
            txType: 'CITY_FEE',
            cityId,
            reason: String(error?.message || error)
        });
        throw error;
    }
}

export async function processBusinessDaily(currentTick: number, seed: bigint): Promise<number> {
    const businesses = await prisma.business.findMany({
        where: { isOpen: true, status: 'ACTIVE' },
        include: {
            city: { include: { policies: true } },
            employments: { where: { status: 'ACTIVE' } },
            wallet: true
        }
    });

    let processed = 0;
    for (const business of businesses) {
        const city = business.city;
        if (!city) continue;
        if (!business.wallet) {
            console.warn(`Business ${business.id} missing wallet`);
            continue;
        }

        let walletBalance = new Decimal(business.wallet.balanceSbyte.toString());
        let walletMon = new Decimal(business.wallet.balanceMon.toString());

        const requiredEmployees = getRequiredEmployees(business.level, business.maxEmployees);
        const requiresOwnerWork = business.employments.length < requiredEmployees;
        const ownerWorkedRecently =
            business.ownerLastWorkedTick !== null &&
            currentTick - business.ownerLastWorkedTick < REAL_DAY_TICKS;

        const cityPopulation = city.population || 0;
        const demand = DEMAND_FACTORS[business.businessType] || 0.1;
        const quality = business.qualityScore / 100;
        const repMult = Math.max(0, business.reputation / 500);
        const competition = await prisma.business.count({ where: { cityId: business.cityId, businessType: business.businessType } });
        const competitionFactor = 1 / (1 + competition);
        const baseCustomers = cityPopulation * demand * quality;
        const snapshot = getLatestSnapshot(business.cityId);
        const marketPrice = getMarketPrice(business.businessType, snapshot);
        const price = getEffectivePrice(business, snapshot);
        const priceElasticity = marketPrice > 0 ? clamp(marketPrice / price.toNumber(), 0.5, 1.25) : 1;
        const dailyCustomers = Math.floor(baseCustomers * repMult * competitionFactor * priceElasticity);

        const agents = await prisma.actor.findMany({
            where: { kind: 'agent', frozen: false },
            include: { agentState: true, wallet: true }
        });
        const cityAgents = agents.filter(a => a.agentState?.cityId === business.cityId);
        const affordableAgents = cityAgents.filter(a => {
            const balance = Number(a.wallet?.balanceSbyte ?? 0);
            return balance >= price.toNumber();
        });
        const affordabilityRate = cityAgents.length > 0 ? affordableAgents.length / cityAgents.length : 0;
        const adjustedCustomers = Math.floor(dailyCustomers * clamp(affordabilityRate, 0.25, 1));
        const customerIds = requiresOwnerWork && !ownerWorkedRecently
            ? []
            : deterministicSort(seed, affordableAgents.map(a => a.id)).slice(0, Math.min(adjustedCustomers, affordableAgents.length));
        const professionTaxRate = new Decimal(city.policies?.professionTaxRate?.toString() || '0.05');

        let revenue = new Decimal(0);
        for (const customerId of customerIds) {
            const customer = cityAgents.find(a => a.id === customerId);
            if (!customer?.wallet) continue;
            const balance = new Decimal(customer.wallet.balanceSbyte.toString());
            if (balance.lessThan(price)) continue;

            try {
                const tx = await agentTransferService.transfer(
                    customer.id,
                    null,
                    ethers.parseEther(price.toString()),
                    'business',
                    business.cityId,
                    business.wallet.walletAddress
                );
                const net = new Decimal(ethers.formatEther(tx.netAmount));
                const professionTax = price.mul(professionTaxRate);
                await sendProfessionTax(customer.id, professionTax, business.cityId, currentTick);

                revenue = revenue.plus(net.minus(professionTax));
                walletBalance = walletBalance.plus(net);
                await prisma.event.create({
                    data: {
                        actorId: customer.id,
                        type: EventType.EVENT_BUSINESS_CUSTOMER_VISIT,
                        targetIds: [business.id],
                        tick: currentTick,
                        outcome: EventOutcome.SUCCESS,
                        sideEffects: { price: price.toString(), txHash: tx.txHash }
                    }
                });
                const platformFeeAmount = new Decimal(ethers.formatEther(tx.platformFee));
                const cityFeeAmount = new Decimal(ethers.formatEther(tx.cityFee));
                await prisma.transaction.create({
                    data: {
                        fromActorId: customer.id,
                        toActorId: null,
                        amount: price.toNumber(),
                        feePlatform: platformFeeAmount.toNumber(),
                        feeCity: cityFeeAmount.toNumber(),
                        cityId: business.cityId,
                        tick: currentTick,
                        reason: 'BUSINESS_CUSTOMER_PAYMENT',
                        onchainTxHash: tx.txHash,
                        metadata: {
                            businessId: business.id,
                            netAmount: net.toString(),
                            professionTax: professionTax.toString()
                        }
                    }
                });
            } catch (error) {
                console.warn(`Business customer transfer failed for ${business.id}`, error);
                continue;
            }
        }

        // Payroll
        let expenses = new Decimal(0);
        if (business.employments.length > 0) {
            const payableEmployments: typeof business.employments = [];
            for (const emp of business.employments) {
                const state = await prisma.agentState.findUnique({
                    where: { actorId: emp.agentId },
                    select: { lastWorkedTick: true, lastWorkJobKey: true }
                });
                const lastWorkedTick = state?.lastWorkedTick ?? null;
                const lastWorkJobKey = state?.lastWorkJobKey ?? null;
                const lastPaidTick = emp.lastPaidTick ?? 0;
                const workedRecently = lastWorkedTick !== null
                    && lastWorkJobKey === `private:${emp.id}`
                    && (currentTick - lastWorkedTick < REAL_DAY_TICKS);
                const dueForPay = currentTick - lastPaidTick >= REAL_DAY_TICKS;
                if (workedRecently && dueForPay) {
                    payableEmployments.push(emp);
                }
            }

            const totalPayroll = payableEmployments.reduce((sum, e) => sum.plus(new Decimal(e.salaryDaily.toString())), new Decimal(0));
            if (payableEmployments.length > 0 && walletBalance.greaterThanOrEqualTo(totalPayroll)) {
                for (const emp of payableEmployments) {
                    try {
                        const targetWallet = await prisma.agentWallet.findUnique({ where: { actorId: emp.agentId } });
                        if (!targetWallet) {
                            throw new Error('Employee wallet missing');
                        }
                        let payrollTxHash: string | null = null;
                        let payrollBlockNumber = BigInt(0);
                        if (process.env.SKIP_ONCHAIN_EXECUTION !== 'true') {
                            if (walletMon.lte(0)) {
                                throw new Error('Business wallet has insufficient MON for gas');
                            }
                            const payrollTx = await businessWalletService.transferFromBusiness(
                                business.id,
                                targetWallet.walletAddress,
                                ethers.parseEther(emp.salaryDaily.toString())
                            );
                            payrollTxHash = payrollTx.txHash;
                            payrollBlockNumber = payrollTx.blockNumber;
                        } else {
                            payrollTxHash = `0x${crypto.randomBytes(32).toString('hex')}`;
                        }
                        if (payrollTxHash) {
                            await prisma.onchainTransaction.create({
                                data: {
                                    txHash: payrollTxHash,
                                    blockNumber: payrollBlockNumber,
                                    fromAddress: business.wallet.walletAddress,
                                    toAddress: targetWallet.walletAddress,
                                    tokenAddress: CONTRACTS.SBYTE_TOKEN,
                                    amount: emp.salaryDaily.toString(),
                                    fromActorId: business.ownerId,
                                    toActorId: emp.agentId,
                                    txType: 'BUSINESS_PAYMENT',
                                    platformFee: '0',
                                    cityFee: '0',
                                    cityId: business.cityId,
                                    status: 'confirmed',
                                    confirmedAt: new Date()
                                }
                            });
                            await prisma.transaction.create({
                                data: {
                                    fromActorId: business.ownerId,
                                    toActorId: emp.agentId,
                                    amount: Number(emp.salaryDaily),
                                    feePlatform: 0,
                                    feeCity: 0,
                                    cityId: business.cityId,
                                    tick: currentTick,
                                    reason: 'BUSINESS_PAYROLL',
                                    onchainTxHash: payrollTxHash,
                                    metadata: {
                                        businessId: business.id,
                                        privateEmploymentId: emp.id
                                    }
                                }
                            });
                        }
                        await prisma.agentWallet.update({
                            where: { actorId: emp.agentId },
                            data: { balanceSbyte: { increment: Number(emp.salaryDaily) } }
                        });
                        await prisma.wallet.update({
                            where: { actorId: emp.agentId },
                            data: { balanceSbyte: { increment: Number(emp.salaryDaily) } }
                        });
                        walletBalance = walletBalance.minus(emp.salaryDaily.toString());
                        const currentLevel = Math.max(1, Math.min(4, Number(emp.performance ?? 1)));
                        const currentProgress = Math.max(0, Math.min(100, Number(emp.satisfaction ?? 0)));
                        const progressGain = 25;
                        let nextLevel = currentLevel;
                        let nextProgress = currentProgress + progressGain;
                        let nextSalary = new Decimal(emp.salaryDaily.toString());
                        const promotionRaise = 0.15;
                        if (nextProgress >= 100 && currentLevel < 4) {
                            nextLevel = currentLevel + 1;
                            nextProgress = 0;
                            nextSalary = nextSalary.mul(1 + promotionRaise);
                        }
                        await prisma.privateEmployment.update({
                            where: { businessId_agentId: { businessId: business.id, agentId: emp.agentId } },
                            data: {
                                lastPaidTick: currentTick,
                                missedPayDays: 0,
                                performance: nextLevel,
                                satisfaction: nextProgress,
                                salaryDaily: nextSalary.toNumber(),
                            }
                        });
                    } catch (error) {
                        await prisma.privateEmployment.update({
                            where: { businessId_agentId: { businessId: business.id, agentId: emp.agentId } },
                            data: { missedPayDays: { increment: 1 } }
                        });
                        console.warn(`Payroll transfer failed for ${business.id} -> ${emp.agentId}`, error);
                    }
                }
                expenses = expenses.plus(totalPayroll);
                await prisma.event.create({
                    data: {
                        actorId: business.ownerId,
                        type: EventType.EVENT_BUSINESS_PAYROLL_PAID,
                        targetIds: [business.id],
                        tick: currentTick,
                        outcome: EventOutcome.SUCCESS,
                        sideEffects: { totalPayroll: totalPayroll.toString() }
                    }
                });
                if (currentTick > 0 && currentTick % (30 * 1440) === 0) {
                    await updateBusinessReputation(business.id, 1, 'PAYROLL_SUCCESS', 'Monthly payroll success', currentTick);
                }
            } else if (payableEmployments.length > 0) {
                for (const emp of payableEmployments) {
                    const updatedEmp = await prisma.privateEmployment.update({
                        where: { businessId_agentId: { businessId: business.id, agentId: emp.agentId } },
                        data: { missedPayDays: { increment: 1 } }
                    });
                    if (updatedEmp.missedPayDays >= 3) {
                        await prisma.privateEmployment.update({
                            where: { businessId_agentId: { businessId: business.id, agentId: emp.agentId } },
                            data: { status: 'QUIT', endedTick: currentTick }
                        });
                        await prisma.agentState.update({
                            where: { actorId: emp.agentId },
                            data: { lastJobChangeTick: currentTick }
                        });
                        await prisma.event.create({
                            data: {
                                actorId: emp.agentId,
                                type: EventType.EVENT_EMPLOYEE_QUIT_UNPAID,
                                targetIds: [business.id],
                                tick: currentTick,
                                outcome: EventOutcome.SUCCESS,
                                sideEffects: { missedPayDays: updatedEmp.missedPayDays }
                            }
                        });
                    }
                }
                await updateBusinessReputation(business.id, -10, 'PAYROLL_MISSED', 'Missed payroll', currentTick);
                await prisma.event.create({
                    data: {
                        actorId: business.ownerId,
                        type: EventType.EVENT_BUSINESS_PAYROLL_MISSED,
                        targetIds: [business.id],
                        tick: currentTick,
                        outcome: EventOutcome.SUCCESS,
                        sideEffects: {}
                    }
                });
            }
        }

        // Maintenance
        const maintenanceCost = new Decimal(getBusinessMaintenanceCost(business.businessType, business.level));
        if (maintenanceCost.greaterThan(0)) {
            if (walletBalance.greaterThanOrEqualTo(maintenanceCost)) {
                walletBalance = walletBalance.minus(maintenanceCost);
                expenses = expenses.plus(maintenanceCost);
                await prisma.event.create({
                    data: {
                        actorId: business.ownerId,
                        type: EventType.EVENT_BUSINESS_MAINTENANCE_PAID,
                        targetIds: [business.id],
                        tick: currentTick,
                        outcome: EventOutcome.SUCCESS,
                        sideEffects: { amount: maintenanceCost.toString() }
                    }
                });
            } else {
                await prisma.business.update({
                    where: { id: business.id },
                    data: { qualityScore: { decrement: 5 } }
                });
                await prisma.event.create({
                    data: {
                        actorId: business.ownerId,
                        type: EventType.EVENT_BUSINESS_QUALITY_DROP,
                        targetIds: [business.id],
                        tick: currentTick,
                        outcome: EventOutcome.SUCCESS,
                        sideEffects: { amount: maintenanceCost.toString() }
                    }
                });
            }
        }

        // Business tax
        const taxRate = Number(city.policies?.businessTaxRate ?? 0);
        const taxDue = revenue.mul(taxRate);
        if (taxRate > 0 && taxDue.greaterThan(0)) {
            if (walletBalance.greaterThanOrEqualTo(taxDue)) {
                let taxTxHash: string | null = null;
                let taxBlockNumber = BigInt(0);
                try {
                    if (process.env.SKIP_ONCHAIN_EXECUTION !== 'true') {
                        if (walletMon.lte(0)) {
                            throw new Error('Business wallet has insufficient MON for gas');
                        }
                        const taxTx = await businessWalletService.transferFromBusiness(
                            business.id,
                            CONTRACTS.PUBLIC_VAULT_AND_GOD,
                            ethers.parseEther(taxDue.toString())
                        );
                        taxTxHash = taxTx.txHash;
                        taxBlockNumber = taxTx.blockNumber;
                    } else {
                        taxTxHash = `0x${crypto.randomBytes(32).toString('hex')}`;
                    }
                    if (taxTxHash) {
                        await prisma.onchainTransaction.create({
                            data: {
                                txHash: taxTxHash,
                                blockNumber: taxBlockNumber,
                                fromAddress: business.wallet.walletAddress,
                                toAddress: CONTRACTS.PUBLIC_VAULT_AND_GOD,
                                tokenAddress: CONTRACTS.SBYTE_TOKEN,
                                amount: taxDue.toString(),
                                fromActorId: business.ownerId,
                                toActorId: null,
                                txType: 'CITY_FEE',
                                platformFee: '0',
                                cityFee: taxDue.toString(),
                                cityId: business.cityId,
                                status: 'confirmed',
                                confirmedAt: new Date()
                            }
                        });
                        await prisma.transaction.create({
                            data: {
                                fromActorId: business.ownerId,
                                toActorId: null,
                                amount: taxDue.toNumber(),
                                feePlatform: 0,
                                feeCity: 0,
                                cityId: business.cityId,
                                tick: currentTick,
                                reason: 'BUSINESS_TAX',
                                onchainTxHash: taxTxHash,
                                metadata: { businessId: business.id }
                            }
                        });
                    }
                    walletBalance = walletBalance.minus(taxDue);
                    expenses = expenses.plus(taxDue);
                    await prisma.cityVault.update({
                        where: { cityId: business.cityId },
                        data: { balanceSbyte: { increment: taxDue.toNumber() } }
                    });
                    await prisma.business.update({
                        where: { id: business.id },
                        data: { missedTaxDays: 0 }
                    });
                    await prisma.event.create({
                        data: {
                            actorId: business.ownerId,
                            type: EventType.EVENT_BUSINESS_TAX_PAID,
                            targetIds: [business.id],
                            tick: currentTick,
                            outcome: EventOutcome.SUCCESS,
                            sideEffects: { amount: taxDue.toString() }
                        }
                    });
                } catch (error) {
                    console.warn(`Business tax transfer failed for ${business.id}`, error);
                    await prisma.business.update({
                        where: { id: business.id },
                        data: { missedTaxDays: { increment: 1 } }
                    });
                    await prisma.event.create({
                        data: {
                            actorId: business.ownerId,
                            type: EventType.EVENT_BUSINESS_TAX_MISSED,
                            targetIds: [business.id],
                            tick: currentTick,
                            outcome: EventOutcome.SUCCESS,
                            sideEffects: { amount: taxDue.toString() }
                        }
                    });
                }
            } else {
                await prisma.business.update({
                    where: { id: business.id },
                    data: { missedTaxDays: { increment: 1 } }
                });
                await prisma.event.create({
                    data: {
                        actorId: business.ownerId,
                        type: EventType.EVENT_BUSINESS_TAX_MISSED,
                        targetIds: [business.id],
                        tick: currentTick,
                        outcome: EventOutcome.SUCCESS,
                        sideEffects: { amount: taxDue.toString() }
                    }
                });
            }
        }

        const dailyBurn = expenses.toNumber();
        const runwayDays = dailyBurn > 0 ? walletBalance.toNumber() / dailyBurn : Infinity;
        if (runwayDays < 3) {
            await prisma.event.create({
                data: {
                    actorId: business.ownerId,
                    type: EventType.EVENT_BUSINESS_CRITICAL_FUNDS,
                    targetIds: [business.id],
                    tick: currentTick,
                    outcome: EventOutcome.SUCCESS,
                    sideEffects: { runway: runwayDays, dailyBurn, balance: walletBalance.toNumber() }
                }
            });
        }
        if (walletMon.lessThan(0.5)) {
            await prisma.event.create({
                data: {
                    actorId: business.ownerId,
                    type: EventType.EVENT_BUSINESS_LOW_GAS,
                    targetIds: [business.id],
                    tick: currentTick,
                    outcome: EventOutcome.SUCCESS,
                    sideEffects: { monBalance: walletMon.toNumber() }
                }
            });
        }

        await prisma.business.update({
            where: { id: business.id },
            data: {
                treasury: walletBalance.toNumber(),
                dailyRevenue: revenue.toNumber(),
                dailyExpenses: expenses.toNumber(),
                cumulativeRevenue: { increment: revenue.toNumber() },
                customerVisitsToday: customerIds.length
            }
        });
        await prisma.businessWallet.update({
            where: { businessId: business.id },
            data: {
                balanceSbyte: walletBalance.toNumber(),
                balanceMon: walletMon.toNumber()
            }
        });

        // Insolvency tracking
        const updated = await prisma.business.findUnique({ where: { id: business.id } });
        if (updated) {
            if (new Decimal(updated.treasury.toString()).lessThan(0)) {
                await prisma.business.update({
                    where: { id: business.id },
                    data: { insolvencyDays: { increment: 1 } }
                });
            } else if (updated.insolvencyDays > 0) {
                await prisma.business.update({
                    where: { id: business.id },
                    data: { insolvencyDays: 0 }
                });
            }

            if (updated.insolvencyDays >= 3) {
                const activeEmployees = await prisma.privateEmployment.findMany({
                    where: { businessId: updated.id, status: 'ACTIVE' },
                    select: { agentId: true }
                });
                await prisma.privateEmployment.updateMany({
                    where: { businessId: updated.id, status: 'ACTIVE' },
                    data: { status: 'FIRED', endedTick: currentTick }
                });
                if (activeEmployees.length > 0) {
                    await prisma.agentState.updateMany({
                        where: { actorId: { in: activeEmployees.map(e => e.agentId) } },
                        data: { lastJobChangeTick: currentTick }
                    });
                }
                await prisma.business.update({
                    where: { id: updated.id },
                    data: { status: 'BANKRUPT', isOpen: false, dissolvedTick: currentTick }
                });
                await updateBusinessReputation(updated.id, -50, 'BUSINESS_BANKRUPT', 'Bankruptcy', currentTick);
                await prisma.actor.update({
                    where: { id: updated.ownerId },
                    data: { reputation: { increment: -75 } }
                });
                await prisma.event.create({
                    data: {
                        actorId: updated.ownerId,
                        type: EventType.EVENT_BUSINESS_BANKRUPT,
                        targetIds: [updated.id],
                        tick: currentTick,
                        outcome: EventOutcome.SUCCESS,
                        sideEffects: {}
                    }
                });
            }
        }

        // Process loans (bank only)
        if (business.businessType === 'BANK') {
            const loans = await prisma.loan.findMany({ where: { bankBusinessId: business.id, status: 'ACTIVE' } });
            for (const loan of loans) {
                const outstanding = new Decimal(loan.outstanding.toString()).mul(new Decimal(1).plus(new Decimal(loan.dailyInterestRate.toString())));
                await prisma.loan.update({
                    where: { id: loan.id },
                    data: { outstanding: outstanding.toNumber() }
                });

                if (currentTick >= loan.dueTick) {
                    const borrowerWallet = await prisma.wallet.findUnique({ where: { actorId: loan.borrowerId } });
                    if (borrowerWallet && new Decimal(borrowerWallet.balanceSbyte.toString()).greaterThanOrEqualTo(outstanding)) {
                        try {
                            const tx = await agentTransferService.transfer(
                                loan.borrowerId,
                                null,
                                ethers.parseEther(outstanding.toString()),
                                'loan_repaid',
                                business.cityId,
                                business.wallet.walletAddress
                            );
                            await prisma.loan.update({ where: { id: loan.id }, data: { status: 'REPAID', outstanding: 0 } });
                            await prisma.business.update({
                                where: { id: business.id },
                                data: { treasury: { increment: Number(ethers.formatEther(tx.netAmount)) } }
                            });
                            await prisma.businessWallet.update({
                                where: { businessId: business.id },
                                data: { balanceSbyte: { increment: Number(ethers.formatEther(tx.netAmount)) } }
                            });
                            await prisma.event.create({
                                data: {
                                    actorId: business.ownerId,
                                    type: EventType.EVENT_LOAN_REPAID,
                                    targetIds: [loan.borrowerId],
                                    tick: currentTick,
                                    outcome: EventOutcome.SUCCESS,
                                    sideEffects: { amount: outstanding.toString() }
                                }
                            });
                        } catch (error) {
                            console.warn(`Loan repayment transfer failed for ${loan.id}`, error);
                        }
                    } else {
                        await prisma.loan.update({ where: { id: loan.id }, data: { status: 'DEFAULTED' } });
                        await updateBusinessReputation(business.id, -50, 'LOAN_DEFAULT', 'Loan default', currentTick);
                        await prisma.actor.update({ where: { id: business.ownerId }, data: { reputation: { increment: -20 } } });
                        await prisma.event.create({
                            data: {
                                actorId: business.ownerId,
                                type: EventType.EVENT_LOAN_DEFAULTED,
                                targetIds: [loan.borrowerId],
                                tick: currentTick,
                                outcome: EventOutcome.SUCCESS,
                                sideEffects: { amount: outstanding.toString() }
                            }
                        });
                    }
                }
            }
        }

        processed++;
    }

    return processed;
}

async function updateBusinessReputation(
    businessId: string,
    change: number,
    eventType: string,
    reason: string,
    tick: number
): Promise<void> {
    const business = await prisma.business.findUnique({ where: { id: businessId } });
    if (!business) return;
    const next = Math.max(0, Math.min(1000, business.reputation + change));
    await prisma.business.update({ where: { id: businessId }, data: { reputation: next } });
    await prisma.businessReputationLog.create({
        data: {
            businessId,
            tick,
            eventType,
            reputationChange: change,
            reason
        }
    });
    if (business.cityId) {
        const rawDelta = change * 0.02;
        const bounded = Math.max(-5, Math.min(5, rawDelta));
        const delta = Math.round(bounded);
        if (delta !== 0) {
            await prisma.city.update({
                where: { id: business.cityId },
                data: { reputationScore: { increment: delta } }
            });
        }
    }
}
