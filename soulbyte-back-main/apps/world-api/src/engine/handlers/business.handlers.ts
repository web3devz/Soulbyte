import { prisma } from '../../db.js';
import crypto from 'crypto';
import { IntentStatus, IntentType } from '../../types/intent.types.js';
import { EventType, EventOutcome } from '../../types/event.types.js';
import { IntentHandler, StateUpdate } from '../engine.types.js';
import { Decimal } from 'decimal.js';
import { ethers } from 'ethers';
import { WalletService, encryptPrivateKey } from '../../services/wallet.service.js';
import { CONTRACTS } from '../../config/contracts.js';
import { AgentTransferService } from '../../services/agent-transfer.service.js';
import { calculateFees, getCachedVaultHealth, getDynamicFeeBps } from '../../config/fees.js';
import { BusinessWalletService } from '../../services/business-wallet.service.js';
import { withRpcRetry } from '../../utils/rpc-retry.js';
import { assertReceiptSuccess } from '../../utils/onchain.js';
import { REAL_DAY_TICKS } from '../../config/time.js';
import { OWNER_WORK_HOURS } from '../../config/work.js';
import { debugLog } from '../../utils/debug-log.js';
import { createOnchainJobUpdate } from '../../services/onchain-queue.service.js';
import { handleBuyProperty } from './property.handlers.js';
import {
    canStartWorkSegment,
    getWorkSegmentDurationTicks,
    registerWorkSegmentCompletion,
    getWorkStrainTierForJobType,
    getWorkStatusCost
} from '../work.utils.js';

const walletService = new WalletService();
const agentTransferService = new AgentTransferService();
const businessWalletService = new BusinessWalletService();

function getFeeBps() {
    return getDynamicFeeBps(getCachedVaultHealth());
}


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
            txType: data.txType,
            platformFee: '0',
            cityFee: '0',
            cityId: data.cityId ?? null,
            status: 'failed',
            failedReason: data.reason,
        },
    });
    await prisma.onchainFailure.create({
        data: {
            actorId: data.fromActorId ?? null,
            txHash: failedHash,
            jobType: data.txType,
            errorMessage: data.reason,
        },
    });
}

const BUSINESS_CONFIG: Record<string, { minWealth: string; buildCost: number; employeesL1: number }> = {
    BANK: { minWealth: 'W5', buildCost: 15000, employeesL1: 2 },
    CASINO: { minWealth: 'W5', buildCost: 20000, employeesL1: 3 },
    STORE: { minWealth: 'W3', buildCost: 2000, employeesL1: 1 },
    RESTAURANT: { minWealth: 'W3', buildCost: 3000, employeesL1: 2 },
    TAVERN: { minWealth: 'W3', buildCost: 2500, employeesL1: 1 },
    GYM: { minWealth: 'W4', buildCost: 5000, employeesL1: 1 },
    CLINIC: { minWealth: 'W4', buildCost: 8000, employeesL1: 2 },
    REALESTATE: { minWealth: 'W5', buildCost: 10000, employeesL1: 1 },
    WORKSHOP: { minWealth: 'W3', buildCost: 3500, employeesL1: 1 },
};

const BUSINESS_MIN_CAPITAL: Record<string, { sbyte: number; mon: number }> = {
    RESTAURANT: { sbyte: 5000, mon: 5 },
    CASINO: { sbyte: 50000, mon: 5 },
    CLINIC: { sbyte: 10000, mon: 5 },
    BANK: { sbyte: 100000, mon: 5 },
    STORE: { sbyte: 3000, mon: 5 },
    TAVERN: { sbyte: 2000, mon: 5 },
    GYM: { sbyte: 2000, mon: 5 },
    REALESTATE: { sbyte: 5000, mon: 5 },
    WORKSHOP: { sbyte: 3000, mon: 5 },
};

const HOUSE_CONVERSION_FEE_RATE = 0.5;

const BUSINESS_NAME_ADJECTIVES = [
    'Bright',
    'Silver',
    'Golden',
    'Quiet',
    'Lucky',
    'Swift',
    'Grand',
    'Crimson',
    'Blue',
    'Emerald',
    'Iron',
    'Humble',
    'Noble',
    'Starlight',
    'Cedar',
    'Maple',
    'River',
    'Harbor',
    'Summit',
    'Amber',
];

const BUSINESS_NAME_NOUNS = [
    'Haven',
    'Corner',
    'Market',
    'House',
    'Guild',
    'Works',
    'Hall',
    'Gardens',
    'Lane',
    'Anchor',
    'Cove',
    'Foundry',
    'Circle',
    'Union',
    'Depot',
    'Crown',
    'Bridge',
    'Beacon',
    'Square',
    'Vista',
];

function generateBusinessName(type: string): string {
    const suffixMap: Record<string, string> = {
        BANK: 'Bank',
        CASINO: 'Casino',
        STORE: 'Store',
        RESTAURANT: 'Kitchen',
        TAVERN: 'Tavern',
        GYM: 'Gym',
        CLINIC: 'Clinic',
        REALESTATE: 'Realty',
        WORKSHOP: 'Workshop',
    };
    const adjective = BUSINESS_NAME_ADJECTIVES[crypto.randomInt(0, BUSINESS_NAME_ADJECTIVES.length)];
    const noun = BUSINESS_NAME_NOUNS[crypto.randomInt(0, BUSINESS_NAME_NOUNS.length)];
    const suffix = suffixMap[type] ?? 'Business';
    return `${adjective} ${noun} ${suffix}`;
}

const JOB_CHANGE_COOLDOWN = 720;
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

function getUnpaidShifts(emp: { lastPaidTick: number | null; hiredTick: number }, currentTick: number): number {
    const lastPaid = emp.lastPaidTick ?? emp.hiredTick;
    if (currentTick <= lastPaid) return 0;
    return Math.floor((currentTick - lastPaid) / REAL_DAY_TICKS);
}

const LOT_MAX_LEVEL: Record<string, number> = {
    SLUM_LOT: 2,
    URBAN_LOT: 3,
    SUBURBAN_LOT: 4,
    LUXURY_LOT: 5,
    ROYAL_LOT: 5,
};

const WEALTH_ORDER = ['W0', 'W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9'];

function meetsWealthRequirement(current: string, required: string): boolean {
    return WEALTH_ORDER.indexOf(current) >= WEALTH_ORDER.indexOf(required);
}

function getRequiredEmployees(level: number, maxEmployees: number): number {
    const requiredByLevel = Math.max(1, Math.ceil(level / 2));
    return Math.min(maxEmployees, requiredByLevel);
}

async function sendSplitTransfers(
    actorId: string,
    amount: Decimal,
    cityId: string,
    reason: string,
    tick: number,
    intentId: string | null
): Promise<StateUpdate[]> {
    const total = amount.toNumber();
    const burnAmount = amount.mul(0.85);
    const cityAmount = amount.mul(0.10);
    const platformAmount = amount.mul(0.05);

    const useQueue = process.env.ENABLE_ONCHAIN_QUEUE === 'true';
    const jobUpdates: StateUpdate[] = [];

    let burnTxHash = '';
    let cityTxHash = '';
    let platformTxHash = '';
    let burnReceipt: any;
    let cityReceipt: any;
    let platformReceipt: any;
    if (useQueue) {
        const burnJob = createOnchainJobUpdate({
            jobType: 'RAW_SBYTE_TRANSFER',
            payload: {
                fromActorId: actorId,
                toActorId: null,
                toAddress: CONTRACTS.BURN_ADDRESS,
                amountWei: ethers.parseEther(burnAmount.toString()).toString(),
                txType: 'BUSINESS_BUILD',
                cityId,
                reason,
                tick,
            },
            actorId,
            relatedIntentId: intentId,
        });
        const cityJob = createOnchainJobUpdate({
            jobType: 'RAW_SBYTE_TRANSFER',
            payload: {
                fromActorId: actorId,
                toActorId: null,
                toAddress: CONTRACTS.PUBLIC_VAULT_AND_GOD,
                amountWei: ethers.parseEther(cityAmount.toString()).toString(),
                txType: 'BUSINESS_BUILD',
                cityFee: cityAmount.toString(),
                cityId,
                reason,
                tick,
            },
            actorId,
            relatedIntentId: intentId,
        });
        const platformJob = createOnchainJobUpdate({
            jobType: 'RAW_SBYTE_TRANSFER',
            payload: {
                fromActorId: actorId,
                toActorId: null,
                toAddress: CONTRACTS.PLATFORM_FEE_VAULT,
                amountWei: ethers.parseEther(platformAmount.toString()).toString(),
                txType: 'BUSINESS_BUILD',
                platformFee: platformAmount.toString(),
                cityId,
                reason,
                tick,
            },
            actorId,
            relatedIntentId: intentId,
        });
        jobUpdates.push(burnJob.update, cityJob.update, platformJob.update);
    } else {
        const signer = await walletService.getSignerWallet(actorId);
        const sbyteContract = new ethers.Contract(CONTRACTS.SBYTE_TOKEN, ['function transfer(address to, uint256 amount) returns (bool)'], signer);
        try {
            const burnTx = await withRpcRetry(
                () => sbyteContract.transfer(CONTRACTS.BURN_ADDRESS, ethers.parseEther(burnAmount.toString())),
                'businessBuildBurn'
            );
            burnReceipt = await withRpcRetry(() => burnTx.wait(), 'businessBuildBurnWait');
            assertReceiptSuccess(burnReceipt, 'businessBuildBurn');
            burnTxHash = burnTx.hash;

            const cityTx = await withRpcRetry(
                () => sbyteContract.transfer(CONTRACTS.PUBLIC_VAULT_AND_GOD, ethers.parseEther(cityAmount.toString())),
                'businessBuildCity'
            );
            cityReceipt = await withRpcRetry(() => cityTx.wait(), 'businessBuildCityWait');
            assertReceiptSuccess(cityReceipt, 'businessBuildCity');
            cityTxHash = cityTx.hash;

            const platformTx = await withRpcRetry(
                () => sbyteContract.transfer(CONTRACTS.PLATFORM_FEE_VAULT, ethers.parseEther(platformAmount.toString())),
                'businessBuildPlatform'
            );
            platformReceipt = await withRpcRetry(() => platformTx.wait(), 'businessBuildPlatformWait');
            assertReceiptSuccess(platformReceipt, 'businessBuildPlatform');
            platformTxHash = platformTx.hash;
        } catch (error: any) {
            await recordFailedOnchainTx({
                fromAddress: signer.address,
                toAddress: CONTRACTS.BURN_ADDRESS,
                amount: total.toString(),
                fromActorId: actorId,
                toActorId: null,
                txType: 'BUSINESS_BUILD',
                cityId,
                reason: String(error?.message || error)
            });
            throw error;
        }

        await prisma.onchainTransaction.createMany({
            data: [
                {
                    txHash: burnTxHash,
                    blockNumber: BigInt(burnReceipt?.blockNumber || 0),
                    fromAddress: signer.address,
                    toAddress: CONTRACTS.BURN_ADDRESS,
                    tokenAddress: CONTRACTS.SBYTE_TOKEN,
                    amount: burnAmount.toString(),
                    fromActorId: actorId,
                    toActorId: null,
                    txType: 'BUSINESS_BUILD',
                    platformFee: '0',
                    cityFee: '0',
                    cityId,
                    status: 'confirmed',
                    confirmedAt: new Date()
                },
                {
                    txHash: cityTxHash,
                    blockNumber: BigInt(cityReceipt?.blockNumber || 0),
                    fromAddress: signer.address,
                    toAddress: CONTRACTS.PUBLIC_VAULT_AND_GOD,
                    tokenAddress: CONTRACTS.SBYTE_TOKEN,
                    amount: cityAmount.toString(),
                    fromActorId: actorId,
                    toActorId: null,
                    txType: 'BUSINESS_BUILD',
                    platformFee: '0',
                    cityFee: cityAmount.toString(),
                    cityId,
                    status: 'confirmed',
                    confirmedAt: new Date()
                },
                {
                    txHash: platformTxHash,
                    blockNumber: BigInt(platformReceipt?.blockNumber || 0),
                    fromAddress: signer.address,
                    toAddress: CONTRACTS.PLATFORM_FEE_VAULT,
                    tokenAddress: CONTRACTS.SBYTE_TOKEN,
                    amount: platformAmount.toString(),
                    fromActorId: actorId,
                    toActorId: null,
                    txType: 'BUSINESS_BUILD',
                    platformFee: platformAmount.toString(),
                    cityFee: '0',
                    cityId,
                    status: 'confirmed',
                    confirmedAt: new Date()
                }
            ]
        });
    }

    await prisma.wallet.update({
        where: { actorId },
        data: { balanceSbyte: { decrement: total } }
    });
    await prisma.agentWallet.update({
        where: { actorId },
        data: { balanceSbyte: { decrement: total } }
    });

    await prisma.cityVault.update({
        where: { cityId },
        data: { balanceSbyte: { increment: cityAmount.toString() } }
    });
    await prisma.platformVault.update({
        where: { id: 1 },
        data: { balanceSbyte: { increment: platformAmount.toString() } }
    });

    await prisma.burnLog.create({
        data: {
            amountSbyte: burnAmount.toString(),
            reason,
            tick
        }
    });

    return jobUpdates;
}

async function sendConversionFeeTransfers(
    actorId: string,
    amount: Decimal,
    cityId: string,
    reason: string,
    tick: number,
    intentId: string | null
): Promise<StateUpdate[]> {
    const total = amount.toNumber();
    const cityAmount = amount.mul(0.5);
    const platformAmount = amount.minus(cityAmount);

    const useQueue = process.env.ENABLE_ONCHAIN_QUEUE === 'true';
    const jobUpdates: StateUpdate[] = [];

    let cityTxHash = '';
    let platformTxHash = '';
    let cityReceipt: any;
    let platformReceipt: any;
    if (useQueue) {
        const cityJob = createOnchainJobUpdate({
            jobType: 'RAW_SBYTE_TRANSFER',
            payload: {
                fromActorId: actorId,
                toActorId: null,
                toAddress: CONTRACTS.PUBLIC_VAULT_AND_GOD,
                amountWei: ethers.parseEther(cityAmount.toString()).toString(),
                txType: 'BUSINESS_BUILD',
                cityFee: cityAmount.toString(),
                cityId,
                reason,
                tick,
            },
            actorId,
            relatedIntentId: intentId,
        });
        const platformJob = createOnchainJobUpdate({
            jobType: 'RAW_SBYTE_TRANSFER',
            payload: {
                fromActorId: actorId,
                toActorId: null,
                toAddress: CONTRACTS.PLATFORM_FEE_VAULT,
                amountWei: ethers.parseEther(platformAmount.toString()).toString(),
                txType: 'BUSINESS_BUILD',
                platformFee: platformAmount.toString(),
                cityId,
                reason,
                tick,
            },
            actorId,
            relatedIntentId: intentId,
        });
        jobUpdates.push(cityJob.update, platformJob.update);
    } else {
        const signer = await walletService.getSignerWallet(actorId);
        const sbyteContract = new ethers.Contract(CONTRACTS.SBYTE_TOKEN, ['function transfer(address to, uint256 amount) returns (bool)'], signer);
        try {
            const cityTx = await withRpcRetry(
                () => sbyteContract.transfer(CONTRACTS.PUBLIC_VAULT_AND_GOD, ethers.parseEther(cityAmount.toString())),
                'businessConversionCity'
            );
            cityReceipt = await withRpcRetry(() => cityTx.wait(), 'businessConversionCityWait');
            assertReceiptSuccess(cityReceipt, 'businessConversionCity');
            cityTxHash = cityTx.hash;

            const platformTx = await withRpcRetry(
                () => sbyteContract.transfer(CONTRACTS.PLATFORM_FEE_VAULT, ethers.parseEther(platformAmount.toString())),
                'businessConversionPlatform'
            );
            platformReceipt = await withRpcRetry(() => platformTx.wait(), 'businessConversionPlatformWait');
            assertReceiptSuccess(platformReceipt, 'businessConversionPlatform');
            platformTxHash = platformTx.hash;
        } catch (error: any) {
            await recordFailedOnchainTx({
                fromAddress: signer.address,
                toAddress: CONTRACTS.PUBLIC_VAULT_AND_GOD,
                amount: total.toString(),
                fromActorId: actorId,
                toActorId: null,
                txType: 'BUSINESS_BUILD',
                cityId,
                reason: String(error?.message || error)
            });
            throw error;
        }

        await prisma.onchainTransaction.createMany({
            data: [
                {
                    txHash: cityTxHash,
                    blockNumber: BigInt(cityReceipt?.blockNumber || 0),
                    fromAddress: signer.address,
                    toAddress: CONTRACTS.PUBLIC_VAULT_AND_GOD,
                    tokenAddress: CONTRACTS.SBYTE_TOKEN,
                    amount: cityAmount.toString(),
                    fromActorId: actorId,
                    toActorId: null,
                    txType: 'BUSINESS_BUILD',
                    platformFee: '0',
                    cityFee: cityAmount.toString(),
                    cityId,
                    status: 'confirmed',
                    confirmedAt: new Date()
                },
                {
                    txHash: platformTxHash,
                    blockNumber: BigInt(platformReceipt?.blockNumber || 0),
                    fromAddress: signer.address,
                    toAddress: CONTRACTS.PLATFORM_FEE_VAULT,
                    tokenAddress: CONTRACTS.SBYTE_TOKEN,
                    amount: platformAmount.toString(),
                    fromActorId: actorId,
                    toActorId: null,
                    txType: 'BUSINESS_BUILD',
                    platformFee: platformAmount.toString(),
                    cityFee: '0',
                    cityId,
                    status: 'confirmed',
                    confirmedAt: new Date()
                }
            ]
        });
    }

    await prisma.wallet.update({
        where: { actorId },
        data: { balanceSbyte: { decrement: total } }
    });
    await prisma.agentWallet.update({
        where: { actorId },
        data: { balanceSbyte: { decrement: total } }
    });

    await prisma.cityVault.update({
        where: { cityId },
        data: { balanceSbyte: { increment: cityAmount.toString() } }
    });
    await prisma.platformVault.update({
        where: { id: 1 },
        data: { balanceSbyte: { increment: platformAmount.toString() } }
    });

    return jobUpdates;
}

export const handleFoundBusiness: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    const params = intent.params as { businessType?: string; cityId?: string; landId?: string; proposedName?: string };
    const intentEventType = intent.type === IntentType.INTENT_CONVERT_BUSINESS
        ? EventType.EVENT_BUSINESS_CONVERTED
        : EventType.EVENT_BUSINESS_FOUNDED;
    if (!params?.businessType || !params.cityId || !params.landId) {
        return fail(actor.id, intentEventType, 'Missing params');
    }
    if (actor.frozen) return fail(actor.id, intentEventType, 'Agent frozen');
    const jail = await prisma.jail.findUnique({ where: { actorId: actor.id } });
    if (jail && jail.releaseTick > tick) return fail(actor.id, intentEventType, 'Agent jailed');
    if (!agentState) return fail(actor.id, intentEventType, 'Missing agent state');

    const config = BUSINESS_CONFIG[params.businessType];
    if (!config) return fail(actor.id, intentEventType, 'Invalid business type');
    if (!meetsWealthRequirement(agentState.wealthTier || 'W0', config.minWealth)) {
        return fail(actor.id, intentEventType, `Wealth tier too low (${config.minWealth})`);
    }
    const fullActor = await prisma.actor.findUnique({ where: { id: actor.id } });

    const existing = await prisma.business.findFirst({
        where: { ownerId: actor.id, businessType: params.businessType }
    });
    if (existing) return fail(actor.id, intentEventType, 'Already owns this business type');

    const property = await prisma.property.findUnique({ where: { id: params.landId } });
    if (!property || property.cityId !== params.cityId) {
        return fail(actor.id, intentEventType, 'Invalid land');
    }
    if (property.underConstruction) {
        return fail(actor.id, intentEventType, 'Property under construction');
    }

    const isHouseConversion = !property.isEmptyLot;
    const ownsProperty = property.ownerId === actor.id;
    const rentsProperty = property.tenantId === actor.id;
    if (isHouseConversion && property.tenantId && property.tenantId !== actor.id) {
        return fail(actor.id, intentEventType, 'House is occupied');
    }
    if (isHouseConversion && intent.type !== IntentType.INTENT_CONVERT_BUSINESS) {
        return fail(actor.id, intentEventType, 'Use conversion intent for houses');
    }
    if (!isHouseConversion && intent.type === IntentType.INTENT_CONVERT_BUSINESS) {
        return fail(actor.id, intentEventType, 'Conversion requires a house property');
    }

    const eventType = isHouseConversion ? EventType.EVENT_BUSINESS_CONVERTED : EventType.EVENT_BUSINESS_FOUNDED;

    const purchaseStateUpdates: StateUpdate[] = [];
    const purchaseEvents: any[] = [];
    let purchased = false;
    const needsPurchase = isHouseConversion
        ? !ownsProperty
        : !ownsProperty && !rentsProperty;
    if (needsPurchase) {
        const purchaseIntent = {
            params: { propertyId: property.id, suppressMoveIn: true }
        } as any;
        const purchaseResult = await handleBuyProperty(purchaseIntent, actor, agentState, wallet, tick);
        if (purchaseResult.intentStatus !== IntentStatus.EXECUTED) {
            const reason = purchaseResult.events?.[0]?.sideEffects?.reason || 'Property purchase failed';
            return fail(actor.id, intentEventType, reason);
        }
        purchaseStateUpdates.push(...purchaseResult.stateUpdates);
        purchaseEvents.push(...purchaseResult.events);
        purchased = true;
    }

    if (isHouseConversion) {
        if (!ownsProperty && !purchased) {
            return fail(actor.id, intentEventType, 'Must own the house to convert');
        }
    } else if (!ownsProperty && !rentsProperty && !purchased) {
        return fail(actor.id, intentEventType, 'Must own or rent lot');
    }

    if (!wallet) return fail(actor.id, intentEventType, 'No wallet');
    const agentWallet = await prisma.agentWallet.findUnique({ where: { actorId: actor.id } });
    if (!agentWallet) return fail(actor.id, intentEventType, 'No on-chain wallet');

    const buildCost = new Decimal(config.buildCost);
    const conversionFee = buildCost.mul(HOUSE_CONVERSION_FEE_RATE);
    const baseCost = isHouseConversion ? conversionFee : buildCost;
    const minCap = BUSINESS_MIN_CAPITAL[params.businessType] ?? { sbyte: 0, mon: 0 };
    const feeBps = getFeeBps();
    const totalFeeBps = feeBps.platformBps + feeBps.cityBps;
    const feeRate = new Decimal(totalFeeBps).div(10000);
    const grossInject = feeRate.gte(1)
        ? new Decimal(minCap.sbyte)
        : new Decimal(minCap.sbyte).div(new Decimal(1).minus(feeRate));
    const balance = new Decimal(wallet.balanceSbyte.toString());
    const totalRequired = baseCost.plus(grossInject);
    if (balance.lessThan(totalRequired)) {
        return fail(actor.id, intentEventType, 'Insufficient funds');
    }
    if (new Decimal(agentWallet.balanceMon.toString()).lessThan(minCap.mon)) {
        return fail(actor.id, intentEventType, 'Insufficient MON for business gas');
    }

    const skipOnchain = process.env.SKIP_ONCHAIN_EXECUTION === 'true';
    const useQueue = process.env.ENABLE_ONCHAIN_QUEUE === 'true';
    const jobUpdates: StateUpdate[] = [];
    if (!skipOnchain) {
        const costJobUpdates = isHouseConversion
            ? await sendConversionFeeTransfers(
                actor.id,
                baseCost,
                params.cityId,
                `business_convert_${params.businessType}`,
                tick,
                intent.id
            )
            : await sendSplitTransfers(
                actor.id,
                baseCost,
                params.cityId,
                `business_build_${params.businessType}`,
                tick,
                intent.id
            );
        jobUpdates.push(...costJobUpdates);
    }

    const businessId = crypto.randomUUID();
    const businessName = params.proposedName || generateBusinessName(params.businessType);
    const businessWallet = ethers.Wallet.createRandom();
    const { encrypted, nonce } = encryptPrivateKey(businessWallet.privateKey);

    let injectedSbyte = 0;
    if (useQueue) {
        const injectWei = ethers.parseEther(grossInject.toFixed(6));
        const fees = calculateFees(injectWei, feeBps.cityBps, feeBps.platformBps);
        injectedSbyte = Number(ethers.formatEther(fees.netAmount));
        const injectJob = createOnchainJobUpdate({
            jobType: 'AGENT_TRANSFER_SBYTE',
            payload: {
                fromActorId: actor.id,
                toActorId: null,
                amountWei: injectWei.toString(),
                reason: 'business_inject',
                cityId: params.cityId,
                toAddressOverride: businessWallet.address
            },
            actorId: actor.id,
            relatedIntentId: intent.id,
        });
        jobUpdates.push(injectJob.update);

        const monJob = createOnchainJobUpdate({
            jobType: 'AGENT_TRANSFER_MON',
            payload: {
                fromActorId: actor.id,
                toAddress: businessWallet.address,
                amountWei: ethers.parseEther(minCap.mon.toString()).toString(),
                reason: 'business_inject',
                cityId: params.cityId,
            },
            actorId: actor.id,
            relatedIntentId: intent.id,
        });
        jobUpdates.push(monJob.update);
    } else {
        const injectTx = await agentTransferService.transfer(
            actor.id,
            null,
            ethers.parseEther(grossInject.toFixed(6)),
            'business_inject',
            params.cityId,
            businessWallet.address
        );
        injectedSbyte = Number(ethers.formatEther(injectTx.netAmount));
        await agentTransferService.transferMon(
            actor.id,
            businessWallet.address,
            ethers.parseEther(minCap.mon.toString()),
            'business_inject',
            params.cityId
        );
    }

    const stateUpdates: StateUpdate[] = [
        {
            table: 'business',
            operation: 'create',
            data: {
                id: businessId,
                name: businessName,
                businessType: params.businessType,
                ownerId: actor.id,
                cityId: params.cityId,
                landId: params.landId,
                reputation: 100,
                level: 1,
                maxEmployees: config.employeesL1,
                treasury: injectedSbyte,
                // Cost basis tracks owner investment, not post-fee treasury net.
                // This keeps founding/injecting neutral in net-worth deltas.
                costBasis: baseCost.toNumber() + grossInject.toNumber(),
                qualityScore: 50,
                isOpen: true,
                foundedTick: tick,
                status: 'ACTIVE',
                config: {
                    finance: {
                        totalInjected: grossInject.toNumber(),
                        totalWithdrawn: 0
                    }
                }
            }
        },
        {
            table: 'businessWallet',
            operation: 'create',
            data: {
                businessId,
                walletAddress: businessWallet.address,
                encryptedPk: encrypted,
                pkNonce: nonce,
                balanceSbyte: injectedSbyte,
                balanceMon: minCap.mon
            }
        },
        {
            table: 'property',
            operation: 'update',
            where: { id: params.landId },
            data: isHouseConversion
                ? { forSale: false, forRent: false, tenantId: null }
                : { isEmptyLot: false }
        }
    ];

    const existingMarkers = (agentState as any)?.markers ?? {};
    if (existingMarkers?.nextBusinessIntent) {
        stateUpdates.push({
            table: 'agentState',
            operation: 'update',
            where: { actorId: actor.id },
            data: { markers: { ...existingMarkers, nextBusinessIntent: null } }
        });
    }

    if (skipOnchain) {
        stateUpdates.push(
            { table: 'wallet', operation: 'update', where: { actorId: actor.id }, data: { balanceSbyte: { decrement: baseCost.toNumber() } } },
            { table: 'agentWallet', operation: 'update', where: { actorId: actor.id }, data: { balanceSbyte: { decrement: baseCost.toNumber() } } }
        );
        if (isHouseConversion) {
            stateUpdates.push(
                {
                    table: 'cityVault',
                    operation: 'update',
                    where: { cityId: params.cityId },
                    data: { balanceSbyte: { increment: baseCost.mul(0.5).toString() } }
                },
                {
                    table: 'platformVault',
                    operation: 'update',
                    where: { id: 1 },
                    data: { balanceSbyte: { increment: baseCost.mul(0.5).toString() } }
                }
            );
        }
    }

    return {
        stateUpdates: purchaseStateUpdates.concat(stateUpdates, jobUpdates),
        events: purchaseEvents.concat([{
            actorId: actor.id,
            type: eventType,
            targetIds: [businessId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                businessType: params.businessType,
                businessName,
                landId: params.landId,
                conversion: isHouseConversion,
                businessWallet: businessWallet.address,
                initialCapital: injectedSbyte,
                queued: useQueue
            }
        }, {
            actorId: actor.id,
            type: EventType.EVENT_BUSINESS_OPENED,
            targetIds: [businessId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                businessType: params.businessType,
                businessName,
                landId: params.landId,
                status: 'operational'
            }
        }]),
        intentStatus: useQueue ? IntentStatus.QUEUED : IntentStatus.EXECUTED
    };
};

export const handleUpgradeBusiness: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    const params = intent.params as { businessId?: string; targetLevel?: number };
    if (!params?.businessId || !params.targetLevel) return fail(actor.id, EventType.EVENT_BUSINESS_UPGRADED, 'Missing params');
    const business = await prisma.business.findUnique({ where: { id: params.businessId } });
    if (!business) return fail(actor.id, EventType.EVENT_BUSINESS_UPGRADED, 'Business not found');
    if (business.ownerId !== actor.id) return fail(actor.id, EventType.EVENT_BUSINESS_UPGRADED, 'Not owner');

    const maxLevel = LOT_MAX_LEVEL[(await prisma.property.findUnique({ where: { id: business.landId } }))?.lotType || 'ROYAL_LOT'] || 5;
    if (params.targetLevel > maxLevel) return fail(actor.id, EventType.EVENT_BUSINESS_UPGRADED, 'Lot max level exceeded');
    if (params.targetLevel <= business.level) return fail(actor.id, EventType.EVENT_BUSINESS_UPGRADED, 'Already at level');

    const upgradeCosts = { 2: 3000, 3: 10000, 4: 30000, 5: 100000 };
    const cost = new Decimal(upgradeCosts[params.targetLevel as 2 | 3 | 4 | 5] || 0);
    if (cost.lte(0)) return fail(actor.id, EventType.EVENT_BUSINESS_UPGRADED, 'Invalid upgrade level');
    if (new Decimal(business.treasury.toString()).lessThan(cost)) {
        return fail(actor.id, EventType.EVENT_BUSINESS_UPGRADED, 'Insufficient business treasury');
    }

    const skipOnchain = process.env.SKIP_ONCHAIN_EXECUTION === 'true';
    const useQueue = process.env.ENABLE_ONCHAIN_QUEUE === 'true';
    const jobUpdates: StateUpdate[] = [];
    if (!skipOnchain) {
        const splitJobUpdates = await sendSplitTransfers(
            actor.id,
            cost,
            business.cityId,
            `business_upgrade_${business.id}`,
            tick,
            intent.id
        );
        jobUpdates.push(...splitJobUpdates);
    }

    const stateUpdates: StateUpdate[] = [{
        table: 'business',
        operation: 'update',
        where: { id: business.id },
        data: {
            level: params.targetLevel,
            maxEmployees: business.maxEmployees + Math.floor(business.maxEmployees * 0.5),
            treasury: { decrement: cost.toNumber() }
        }
    }];

    if (skipOnchain) {
        stateUpdates.push(
            { table: 'wallet', operation: 'update', where: { actorId: actor.id }, data: { balanceSbyte: { decrement: cost.toNumber() } } },
            { table: 'agentWallet', operation: 'update', where: { actorId: actor.id }, data: { balanceSbyte: { decrement: cost.toNumber() } } }
        );
    }

    return {
        stateUpdates: stateUpdates.concat(jobUpdates),
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_BUSINESS_UPGRADED,
            targetIds: [business.id],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { targetLevel: params.targetLevel, cost: cost.toString(), queued: useQueue }
        }],
        intentStatus: useQueue ? IntentStatus.QUEUED : IntentStatus.EXECUTED
    };
};

export const handleSetPrices: IntentHandler = async (intent, actor) => {
    const params = intent.params as { businessId?: string; pricePerService?: number; minBet?: number; maxBet?: number };
    if (!params?.businessId) return fail(actor.id, EventType.EVENT_BUSINESS_REVENUE_EARNED, 'Missing businessId');
    const business = await prisma.business.findUnique({ where: { id: params.businessId } });
    if (!business || business.ownerId !== actor.id) return fail(actor.id, EventType.EVENT_BUSINESS_REVENUE_EARNED, 'Not owner');

    const config = (business.config || {}) as Record<string, unknown>;
    if (params.pricePerService !== undefined) {
        let nextPrice = params.pricePerService;
        if (business.businessType === 'RESTAURANT') {
            const level = Math.max(1, Number(business.level ?? 1));
            const reputation = Math.max(0, Number(business.reputation ?? 0));
            const repSteps = Math.floor(reputation / 25);
            const cap = Math.min(20000, Math.max(500, 500 + level * 1500 + repSteps * 250));
            nextPrice = Math.min(nextPrice, cap);
        }
        config.pricePerService = Math.max(1, nextPrice);
    }
    if (params.minBet !== undefined) config.minBet = params.minBet;
    if (params.maxBet !== undefined) config.maxBet = params.maxBet;

    return {
        stateUpdates: [{
            table: 'business',
            operation: 'update',
            where: { id: business.id },
            data: { config }
        }],
        events: [],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleWorkOwnBusiness: IntentHandler = async (intent, actor, agentState, _wallet, tick) => {
    const params = intent.params as { businessId?: string };
    if (!params?.businessId) return fail(actor.id, EventType.EVENT_BUSINESS_OWNER_WORKED, 'Missing businessId');
    const business = await prisma.business.findUnique({ where: { id: params.businessId } });
    if (!business || business.ownerId !== actor.id) return fail(actor.id, EventType.EVENT_BUSINESS_OWNER_WORKED, 'Not owner');
    if (!agentState) return fail(actor.id, EventType.EVENT_BUSINESS_OWNER_WORKED, 'Missing agent state');
    if (actor.frozen) return fail(actor.id, EventType.EVENT_BUSINESS_OWNER_WORKED, 'Agent frozen');

    const jail = await prisma.jail.findUnique({ where: { actorId: actor.id } });
    if (jail && jail.releaseTick > tick) return fail(actor.id, EventType.EVENT_BUSINESS_OWNER_WORKED, 'Agent jailed');

    if (agentState.activityState === 'WORKING') {
        return fail(actor.id, EventType.EVENT_BUSINESS_OWNER_WORKED, 'Already working');
    }

    const requiredEmployees = getRequiredEmployees(business.level, business.maxEmployees);
    const activeEmployees = await prisma.privateEmployment.count({
        where: { businessId: business.id, status: 'ACTIVE' }
    });
    if (activeEmployees >= requiredEmployees) {
        return fail(actor.id, EventType.EVENT_BUSINESS_OWNER_WORKED, 'Owner work not required');
    }

    const jobKey = `owner:${business.id}`;
    const segmentGate = canStartWorkSegment(agentState, jobKey, tick);
    if (!segmentGate.allowed) {
        return fail(actor.id, EventType.EVENT_BUSINESS_OWNER_WORKED, segmentGate.reason ?? 'Work segment limit reached');
    }

    const ownedItems = await prisma.inventoryItem.findMany({
        where: { actorId: actor.id, quantity: { gt: 0 } },
        include: { itemDef: true }
    });
    const ownedItemNames = ownedItems.map((item) => item.itemDef.name);
    const workCost = getWorkStatusCost(
        getWorkStrainTierForJobType(agentState.jobType),
        ownedItemNames,
        true
    );
    const wouldDropUnsafe = (agentState.energy - workCost.energy) <= 0
        || (agentState.health - workCost.health) <= 0
        || (agentState.hunger - workCost.hunger) <= 0;
    if (wouldDropUnsafe) {
        return fail(actor.id, EventType.EVENT_BUSINESS_OWNER_WORKED, 'Unsafe to work with current status');
    }

    const workEndTick = tick + getWorkSegmentDurationTicks(OWNER_WORK_HOURS);
    const segmentResult = registerWorkSegmentCompletion(agentState, jobKey, tick);

    const stateUpdates: StateUpdate[] = [
        {
            table: 'agentState',
            operation: 'update',
            where: { actorId: actor.id },
            data: {
                activityState: 'WORKING',
                activityEndTick: workEndTick,
                energy: Math.max(0, agentState.energy - workCost.energy),
                hunger: Math.max(0, agentState.hunger - workCost.hunger),
                health: Math.max(0, agentState.health - workCost.health),
                fun: Math.max(0, agentState.fun - workCost.fun),
                ...segmentResult.updates
            }
        }
    ];
    if (segmentResult.completedDay) {
        stateUpdates.push({
            table: 'business',
            operation: 'update',
            where: { id: business.id },
            data: { ownerLastWorkedTick: tick }
        });
    }

    return {
        stateUpdates,
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_BUSINESS_OWNER_WORKED,
            targetIds: [business.id],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                workHours: OWNER_WORK_HOURS,
                profession: 'OWNER',
                sector: 'private',
                segmentIndex: segmentResult.nextCompleted,
                segmentComplete: segmentResult.completedDay
            }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleManageRestaurant: IntentHandler = async (intent, actor) => {
    const params = intent.params as { businessId?: string; decisions?: Record<string, unknown> };
    if (!params?.businessId) return fail(actor.id, EventType.EVENT_BUSINESS_REVENUE_EARNED, 'Missing businessId');
    const business = await prisma.business.findUnique({ where: { id: params.businessId } });
    if (!business || business.ownerId !== actor.id) return fail(actor.id, EventType.EVENT_BUSINESS_REVENUE_EARNED, 'Not owner');
    if (business.businessType !== 'RESTAURANT') return fail(actor.id, EventType.EVENT_BUSINESS_REVENUE_EARNED, 'Not restaurant');

    const config = (business.config || {}) as Record<string, unknown>;
    config.restaurant = params.decisions ?? {};

    return {
        stateUpdates: [{ table: 'business', operation: 'update', where: { id: business.id }, data: { config } }],
        events: [],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleManageClinic: IntentHandler = async (intent, actor) => {
    const params = intent.params as { businessId?: string; decisions?: Record<string, unknown> };
    if (!params?.businessId) return fail(actor.id, EventType.EVENT_BUSINESS_REVENUE_EARNED, 'Missing businessId');
    const business = await prisma.business.findUnique({ where: { id: params.businessId } });
    if (!business || business.ownerId !== actor.id) return fail(actor.id, EventType.EVENT_BUSINESS_REVENUE_EARNED, 'Not owner');
    if (business.businessType !== 'CLINIC') return fail(actor.id, EventType.EVENT_BUSINESS_REVENUE_EARNED, 'Not clinic');

    const config = (business.config || {}) as Record<string, unknown>;
    config.clinic = params.decisions ?? {};

    return {
        stateUpdates: [{ table: 'business', operation: 'update', where: { id: business.id }, data: { config } }],
        events: [],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleImproveBusiness: IntentHandler = async (intent, actor) => {
    const params = intent.params as { businessId?: string; category?: string; targetLevel?: number };
    if (!params?.businessId || !params.category || !params.targetLevel) {
        return fail(actor.id, EventType.EVENT_BUSINESS_REVENUE_EARNED, 'Missing params');
    }
    const business = await prisma.business.findUnique({ where: { id: params.businessId } });
    if (!business || business.ownerId !== actor.id) return fail(actor.id, EventType.EVENT_BUSINESS_REVENUE_EARNED, 'Not owner');

    const baseCost = new Decimal(BUSINESS_CONFIG[business.businessType].buildCost).mul(0.10);
    const cost = baseCost.mul(params.targetLevel);
    if (new Decimal(business.treasury.toString()).lessThan(cost)) {
        return fail(actor.id, EventType.EVENT_BUSINESS_REVENUE_EARNED, 'Insufficient treasury');
    }

    const existing = await prisma.businessImprovement.findUnique({
        where: { businessId_category: { businessId: business.id, category: params.category } }
    });

    const stateUpdates: StateUpdate[] = [
        {
            table: 'business',
            operation: 'update',
            where: { id: business.id },
            data: { treasury: { decrement: cost.toNumber() } }
        }
    ];

    if (existing) {
        stateUpdates.push({
            table: 'businessImprovement',
            operation: 'update',
            where: { businessId_category: { businessId: business.id, category: params.category } },
            data: { level: params.targetLevel, appliedTick: tick }
        });
    } else {
        stateUpdates.push({
            table: 'businessImprovement',
            operation: 'create',
            data: { businessId: business.id, category: params.category, level: params.targetLevel, appliedTick: tick }
        });
    }

    return {
        stateUpdates,
        events: [],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleHireEmployee: IntentHandler = async (intent, actor, _agentState, _wallet, tick) => {
    const params = intent.params as { businessId?: string; targetAgentId?: string; offeredSalary?: number };
    if (!params?.businessId || !params.targetAgentId || !params.offeredSalary) {
        return fail(actor.id, EventType.EVENT_EMPLOYEE_HIRED, 'Missing params');
    }
    const business = await prisma.business.findUnique({
        where: { id: params.businessId },
        select: { id: true, ownerId: true, maxEmployees: true, name: true, businessType: true }
    });
    if (!business || business.ownerId !== actor.id) return fail(actor.id, EventType.EVENT_EMPLOYEE_HIRED, 'Not owner');

    const activePublicEmployment = await prisma.publicEmployment.findUnique({
        where: { actorId: params.targetAgentId }
    });

    const activeEmployees = await prisma.privateEmployment.count({
        where: { businessId: business.id, status: 'ACTIVE' }
    });
    if (activeEmployees >= Number(business.maxEmployees ?? 0)) {
        return fail(actor.id, EventType.EVENT_EMPLOYEE_HIRED, 'Business at max employees');
    }

    const existingEmployment = await prisma.privateEmployment.findUnique({
        where: { businessId_agentId: { businessId: business.id, agentId: params.targetAgentId } }
    });
    if (existingEmployment?.status === 'ACTIVE') {
        return fail(actor.id, EventType.EVENT_EMPLOYEE_HIRED, 'Already employed');
    }

    const employmentUpdate: StateUpdate = existingEmployment
        ? {
            table: 'privateEmployment',
            operation: 'update',
            where: { businessId_agentId: { businessId: business.id, agentId: params.targetAgentId } },
            data: { status: 'ACTIVE', hiredTick: tick, salaryDaily: params.offeredSalary }
        }
        : {
            table: 'privateEmployment',
            operation: 'create',
            data: {
                businessId: business.id,
                agentId: params.targetAgentId,
                salaryDaily: params.offeredSalary,
                hiredTick: tick,
                status: 'ACTIVE'
            }
        };

    const publicEmploymentEndUpdate: StateUpdate | null = activePublicEmployment && activePublicEmployment.endedAtTick === null
        ? {
            table: 'publicEmployment',
            operation: 'update',
            where: { actorId: params.targetAgentId },
            data: { endedAtTick: tick }
        }
        : null;
    return {
        stateUpdates: [
            employmentUpdate,
            {
                table: 'agentState',
                operation: 'update',
                where: { actorId: params.targetAgentId },
                data: { lastJobChangeTick: tick }
            },
            ...(publicEmploymentEndUpdate ? [publicEmploymentEndUpdate] : [])
        ],
        events: [
            {
                actorId: actor.id,
                type: EventType.EVENT_EMPLOYEE_HIRED,
                targetIds: [params.targetAgentId],
                outcome: EventOutcome.SUCCESS,
                sideEffects: { businessId: business.id, offeredSalary: params.offeredSalary }
            },
            {
                actorId: params.targetAgentId,
                type: EventType.EVENT_PRIVATE_JOB_ACCEPTED,
                targetIds: [business.id],
                outcome: EventOutcome.SUCCESS,
                sideEffects: { businessId: business.id, businessName: business.name }
            }
        ],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleAdjustSalary: IntentHandler = async (intent, actor) => {
    const params = intent.params as { businessId?: string; agentId?: string; newSalary?: number };
    if (!params?.businessId || !params.agentId || params.newSalary === undefined) {
        return fail(actor.id, EventType.EVENT_EMPLOYEE_SALARY_ADJUSTED, 'Missing params');
    }
    const business = await prisma.business.findUnique({ where: { id: params.businessId } });
    if (!business || business.ownerId !== actor.id) {
        return fail(actor.id, EventType.EVENT_EMPLOYEE_SALARY_ADJUSTED, 'Not owner');
    }

    return {
        stateUpdates: [{
            table: 'privateEmployment',
            operation: 'update',
            where: { businessId_agentId: { businessId: params.businessId, agentId: params.agentId } },
            data: { salaryDaily: params.newSalary }
        }],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_EMPLOYEE_SALARY_ADJUSTED,
            targetIds: [params.agentId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { businessId: params.businessId, newSalary: params.newSalary }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleApplyPrivateJob: IntentHandler = async (intent, actor, agentState, _wallet, tick) => {
    const params = intent.params as { businessId?: string; expectedSalary?: number };
    const JOB_APPLICATION_COOLDOWN = 720;
    if (!params?.businessId) return fail(actor.id, EventType.EVENT_EMPLOYEE_HIRED, 'Missing businessId');
    if (agentState?.lastJobChangeTick && tick - agentState.lastJobChangeTick < JOB_CHANGE_COOLDOWN) {
        return fail(actor.id, EventType.EVENT_EMPLOYEE_HIRED, 'job_change_cooldown');
    }
    const existingActive = await prisma.privateEmployment.findFirst({
        where: { agentId: actor.id, status: 'ACTIVE' },
        select: { id: true }
    });
    if (existingActive) return fail(actor.id, EventType.EVENT_EMPLOYEE_HIRED, 'Already employed');
    const recentApply = await prisma.privateEmployment.findFirst({
        where: { agentId: actor.id, status: 'APPLIED' },
        orderBy: { hiredTick: 'desc' },
        select: { hiredTick: true }
    });
    if (recentApply && tick - recentApply.hiredTick < JOB_APPLICATION_COOLDOWN) {
        return { stateUpdates: [], events: [], intentStatus: IntentStatus.BLOCKED };
    }
    debugLog('private_employment.apply', {
        actorId: actor.id,
        tick,
        businessId: params.businessId,
        expectedSalary: params.expectedSalary ?? 10,
    });
    return {
        stateUpdates: [
            {
                table: 'privateEmployment',
                operation: 'create',
                data: {
                    businessId: params.businessId,
                    agentId: actor.id,
                    salaryDaily: params.expectedSalary ?? 10,
                    hiredTick: tick,
                    status: 'APPLIED',
                    performance: 1,
                    satisfaction: 0
                }
            },
            {
                table: 'agentState',
                operation: 'update',
                where: { actorId: actor.id },
                data: { purpose: Math.min(100, (agentState?.purpose ?? 0) + 2) }
            }
        ],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_PRIVATE_JOB_APPLIED,
            targetIds: [params.businessId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                businessId: params.businessId,
                expectedSalary: params.expectedSalary ?? 10
            }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};
export const handleAcceptJob: IntentHandler = async (intent, actor, agentState, _wallet, tick) => {
    const params = intent.params as { businessId?: string };
    if (!params?.businessId) return fail(actor.id, EventType.EVENT_EMPLOYEE_HIRED, 'Missing businessId');
    if (agentState?.lastJobChangeTick && tick - agentState.lastJobChangeTick < JOB_CHANGE_COOLDOWN) {
        return fail(actor.id, EventType.EVENT_EMPLOYEE_HIRED, 'job_change_cooldown');
    }
    const employment = await prisma.privateEmployment.findUnique({
        where: { businessId_agentId: { businessId: params.businessId, agentId: actor.id } }
    });
    if (!employment) return fail(actor.id, EventType.EVENT_EMPLOYEE_HIRED, 'Employment not found');
    const business = await prisma.business.findUnique({
        where: { id: params.businessId },
        select: { reputation: true }
    });
    const expectedSalary = new Decimal(employment.salaryDaily.toString());
    const reputation = Number(business?.reputation ?? 0);
    const offerMultiplier = Math.min(1.15, Math.max(0.85, 0.9 + (reputation / 1000) * 0.2));
    const offeredSalary = expectedSalary.mul(offerMultiplier);
    const angerFactor = 1 + ((agentState?.anger ?? 0) / 200);
    const baseMin = agentState?.jobType === 'unemployed' ? 0.85 : 1.05;
    const minAccept = expectedSalary.mul(baseMin * angerFactor);
    if (offeredSalary.lessThan(minAccept)) {
        return fail(actor.id, EventType.EVENT_EMPLOYEE_HIRED, 'Offer below expectation');
    }
    return {
        stateUpdates: [
            {
                table: 'privateEmployment',
                operation: 'update',
                where: { businessId_agentId: { businessId: params.businessId, agentId: actor.id } },
                data: { status: 'ACTIVE', hiredTick: tick, salaryDaily: offeredSalary.toNumber() }
            },
            {
                table: 'agentState',
                operation: 'update',
                where: { actorId: actor.id },
                data: { lastJobChangeTick: tick }
            }
        ],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_PRIVATE_JOB_ACCEPTED,
            targetIds: [params.businessId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { businessId: params.businessId, offeredSalary: offeredSalary.toString() }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleRejectJob: IntentHandler = async (intent, actor) => {
    const params = intent.params as { businessId?: string };
    if (!params?.businessId) return fail(actor.id, EventType.EVENT_EMPLOYEE_HIRED, 'Missing businessId');
    return {
        stateUpdates: [{
            table: 'privateEmployment',
            operation: 'update',
            where: { businessId_agentId: { businessId: params.businessId, agentId: actor.id } },
            data: { status: 'REJECTED', endedTick: tick }
        }],
        events: [],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleFireEmployee: IntentHandler = async (intent, actor, _agentState, _wallet, tick) => {
    const params = intent.params as { businessId?: string; agentId?: string };
    if (!params?.businessId || !params.agentId) return fail(actor.id, EventType.EVENT_EMPLOYEE_FIRED, 'Missing params');
    const business = await prisma.business.findUnique({ where: { id: params.businessId } });
    if (!business || business.ownerId !== actor.id) return fail(actor.id, EventType.EVENT_EMPLOYEE_FIRED, 'Not owner');

    const employment = await prisma.privateEmployment.findUnique({
        where: { businessId_agentId: { businessId: params.businessId, agentId: params.agentId } },
    });
    if (!employment) return fail(actor.id, EventType.EVENT_EMPLOYEE_FIRED, 'Employment not found');

    const unpaidShifts = getUnpaidShifts(employment, tick);
    const owedSalary = new Decimal(employment.salaryDaily.toString()).mul(unpaidShifts);
    const bWallet = await prisma.businessWallet.findUnique({ where: { businessId: params.businessId } });
    if (!bWallet) return fail(actor.id, EventType.EVENT_EMPLOYEE_FIRED, 'Business wallet missing');
    if (owedSalary.greaterThan(0) && new Decimal(bWallet.balanceSbyte.toString()).lessThan(owedSalary)) {
        return fail(actor.id, EventType.EVENT_EMPLOYEE_FIRED, 'unpaid_salary');
    }

    let salaryTxHash: string | null = null;
    const useQueue = process.env.ENABLE_ONCHAIN_QUEUE === 'true';
    const jobUpdates: StateUpdate[] = [];
    if (owedSalary.greaterThan(0) && process.env.SKIP_ONCHAIN_EXECUTION !== 'true') {
        const targetWallet = await prisma.agentWallet.findUnique({ where: { actorId: params.agentId } });
        if (!targetWallet) return fail(actor.id, EventType.EVENT_EMPLOYEE_FIRED, 'Target wallet missing');
        if (useQueue) {
            const job = createOnchainJobUpdate({
                jobType: 'BUSINESS_TRANSFER_SBYTE',
                payload: {
                    businessId: params.businessId,
                    toAddress: targetWallet.walletAddress,
                    amountWei: ethers.parseEther(owedSalary.toString()).toString(),
                },
                actorId: actor.id,
                relatedIntentId: intent.id,
            });
            jobUpdates.push(job.update);
            salaryTxHash = null;
        } else {
            const transfer = await businessWalletService.transferFromBusiness(
                params.businessId,
                targetWallet.walletAddress,
                ethers.parseEther(owedSalary.toString())
            );
            salaryTxHash = transfer.txHash;
        }
    }

    return {
        stateUpdates: [
            {
                table: 'privateEmployment',
                operation: 'update',
                where: { businessId_agentId: { businessId: params.businessId, agentId: params.agentId } },
                data: { status: 'FIRED', endedTick: tick, lastPaidTick: unpaidShifts > 0 ? tick : employment.lastPaidTick }
            },
            {
                table: 'agentState',
                operation: 'update',
                where: { actorId: params.agentId },
                data: { lastJobChangeTick: tick }
            },
            ...(owedSalary.greaterThan(0)
                ? [
                    {
                        table: 'businessWallet',
                        operation: 'update',
                        where: { businessId: params.businessId },
                        data: { balanceSbyte: { decrement: owedSalary.toNumber() } }
                    },
                    {
                        table: 'business',
                        operation: 'update',
                        where: { id: params.businessId },
                        data: { treasury: { decrement: owedSalary.toNumber() } }
                    },
                    {
                        table: 'wallet',
                        operation: 'update',
                        where: { actorId: params.agentId },
                        data: { balanceSbyte: { increment: owedSalary.toNumber() } }
                    },
                    {
                        table: 'agentWallet',
                        operation: 'update',
                        where: { actorId: params.agentId },
                        data: { balanceSbyte: { increment: owedSalary.toNumber() } }
                    },
                    {
                        table: 'transaction',
                        operation: 'create',
                        data: {
                            fromActorId: business.ownerId,
                            toActorId: params.agentId,
                            amount: owedSalary.toNumber(),
                            feePlatform: 0,
                            feeCity: 0,
                            cityId: business.cityId,
                            tick,
                            reason: 'SALARY_PAYMENT',
                            onchainTxHash: salaryTxHash,
                            metadata: { unpaidShifts }
                        }
                    }
                ]
                : [])
        ].concat(jobUpdates),
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_EMPLOYEE_FIRED,
            targetIds: [params.agentId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { businessId: params.businessId, unpaidShifts, queued: useQueue }
        }],
        intentStatus: useQueue ? IntentStatus.QUEUED : IntentStatus.EXECUTED
    };
};

export const handleQuitJob: IntentHandler = async (intent, actor, agentState, _wallet, tick) => {
    const params = intent.params as {
        businessId?: string;
        reason?: string;
        businessStartupPlan?: Record<string, unknown>;
        businessStartupCooldownUntilTick?: number;
    };
    if (!params?.businessId) return fail(actor.id, EventType.EVENT_EMPLOYEE_QUIT, 'Missing businessId');
    const business = await prisma.business.findUnique({ where: { id: params.businessId } });
    if (!business) return fail(actor.id, EventType.EVENT_EMPLOYEE_QUIT, 'Business not found');
    const employment = await prisma.privateEmployment.findUnique({
        where: { businessId_agentId: { businessId: params.businessId, agentId: actor.id } },
    });
    if (!employment) return fail(actor.id, EventType.EVENT_EMPLOYEE_QUIT, 'Employment not found');

    const unpaidShifts = getUnpaidShifts(employment, tick);
    const owedSalary = new Decimal(employment.salaryDaily.toString()).mul(unpaidShifts);
    const bWallet = await prisma.businessWallet.findUnique({ where: { businessId: params.businessId } });
    if (!bWallet) return fail(actor.id, EventType.EVENT_EMPLOYEE_QUIT, 'Business wallet missing');
    if (owedSalary.greaterThan(0) && new Decimal(bWallet.balanceSbyte.toString()).lessThan(owedSalary)) {
        return fail(actor.id, EventType.EVENT_EMPLOYEE_QUIT, 'unpaid_salary');
    }

    let salaryTxHash: string | null = null;
    const useQueue = process.env.ENABLE_ONCHAIN_QUEUE === 'true';
    const jobUpdates: StateUpdate[] = [];
    if (owedSalary.greaterThan(0) && process.env.SKIP_ONCHAIN_EXECUTION !== 'true') {
        const targetWallet = await prisma.agentWallet.findUnique({ where: { actorId: actor.id } });
        if (!targetWallet) return fail(actor.id, EventType.EVENT_EMPLOYEE_QUIT, 'Target wallet missing');
        if (useQueue) {
            const job = createOnchainJobUpdate({
                jobType: 'BUSINESS_TRANSFER_SBYTE',
                payload: {
                    businessId: params.businessId,
                    toAddress: targetWallet.walletAddress,
                    amountWei: ethers.parseEther(owedSalary.toString()).toString(),
                },
                actorId: actor.id,
                relatedIntentId: intent.id,
            });
            jobUpdates.push(job.update);
            salaryTxHash = null;
        } else {
            const transfer = await businessWalletService.transferFromBusiness(
                params.businessId,
                targetWallet.walletAddress,
                ethers.parseEther(owedSalary.toString())
            );
            salaryTxHash = transfer.txHash;
        }
    }

    const existingMarkers = (agentState as any)?.markers ?? {};
    const markerUpdate = params.businessStartupPlan
        ? {
            ...existingMarkers,
            nextBusinessIntent: params.businessStartupPlan,
            businessStartupCooldownUntilTick: params.businessStartupCooldownUntilTick ?? existingMarkers.businessStartupCooldownUntilTick
        }
        : null;

    return {
        stateUpdates: [
            {
                table: 'privateEmployment',
                operation: 'update',
                where: { businessId_agentId: { businessId: params.businessId, agentId: actor.id } },
                data: { status: 'QUIT', endedTick: tick, lastPaidTick: unpaidShifts > 0 ? tick : employment.lastPaidTick }
            },
            {
                table: 'agentState',
                operation: 'update',
                where: { actorId: actor.id },
                data: {
                    lastJobChangeTick: tick,
                    ...(markerUpdate ? { markers: markerUpdate } : {})
                }
            },
            ...(owedSalary.greaterThan(0)
                ? [
                    {
                        table: 'businessWallet',
                        operation: 'update',
                        where: { businessId: params.businessId },
                        data: { balanceSbyte: { decrement: owedSalary.toNumber() } }
                    },
                    {
                        table: 'business',
                        operation: 'update',
                        where: { id: params.businessId },
                        data: { treasury: { decrement: owedSalary.toNumber() } }
                    },
                    {
                        table: 'wallet',
                        operation: 'update',
                        where: { actorId: actor.id },
                        data: { balanceSbyte: { increment: owedSalary.toNumber() } }
                    },
                    {
                        table: 'agentWallet',
                        operation: 'update',
                        where: { actorId: actor.id },
                        data: { balanceSbyte: { increment: owedSalary.toNumber() } }
                    },
                    {
                        table: 'transaction',
                        operation: 'create',
                        data: {
                            fromActorId: business.ownerId,
                            toActorId: actor.id,
                            amount: owedSalary.toNumber(),
                            feePlatform: 0,
                            feeCity: 0,
                            cityId: business.cityId,
                            tick,
                            reason: 'SALARY_PAYMENT',
                            onchainTxHash: salaryTxHash,
                            metadata: { unpaidShifts }
                        }
                    }
                ]
                : [])
        ].concat(jobUpdates),
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_EMPLOYEE_QUIT,
            targetIds: [params.businessId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { businessId: params.businessId, unpaidShifts, queued: useQueue }
        }],
        intentStatus: useQueue ? IntentStatus.QUEUED : IntentStatus.EXECUTED
    };
};

export const handleSellBusiness: IntentHandler = async (intent, actor) => {
    const params = intent.params as { businessId?: string; askingPrice?: number };
    if (!params?.businessId || !params.askingPrice) return fail(actor.id, EventType.EVENT_BUSINESS_SOLD, 'Missing params');
    const business = await prisma.business.findUnique({ where: { id: params.businessId } });
    if (!business || business.ownerId !== actor.id) return fail(actor.id, EventType.EVENT_BUSINESS_SOLD, 'Not owner');

    return {
        stateUpdates: [{
            table: 'businessListing',
            operation: 'create',
            data: { businessId: business.id, sellerId: actor.id, askingPrice: params.askingPrice, status: 'ACTIVE' }
        }],
        events: [],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleBuyBusiness: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    const params = intent.params as { listingId?: string };
    if (!params?.listingId) return fail(actor.id, EventType.EVENT_BUSINESS_SOLD, 'Missing listingId');
    const listing = await prisma.businessListing.findUnique({ where: { id: params.listingId } });
    if (!listing || listing.status !== 'ACTIVE') return fail(actor.id, EventType.EVENT_BUSINESS_SOLD, 'Listing not active');
    const business = await prisma.business.findUnique({ where: { id: listing.businessId } });
    if (!business) return fail(actor.id, EventType.EVENT_BUSINESS_SOLD, 'Business not found');
    if (!wallet) return fail(actor.id, EventType.EVENT_BUSINESS_SOLD, 'No wallet');

    const price = new Decimal(listing.askingPrice.toString());
    const balance = new Decimal(wallet.balanceSbyte.toString());
    if (balance.lessThan(price)) return fail(actor.id, EventType.EVENT_BUSINESS_SOLD, 'Insufficient funds');

    const feeBps = getFeeBps();
    const cityFeeRate = new Decimal(feeBps.cityBps).div(10000);
    const platformFeeRate = new Decimal(feeBps.platformBps).div(10000);
    const platformFee = price.mul(platformFeeRate);
    const cityFee = price.mul(cityFeeRate);
    const net = price.minus(platformFee).minus(cityFee);

    const useQueue = process.env.ENABLE_ONCHAIN_QUEUE === 'true';
    const jobUpdates: StateUpdate[] = [];
    let netTxHash = '0x' + Math.random().toString(16).slice(2).padStart(64, '0');
    let platformTxHash = '0x' + Math.random().toString(16).slice(2).padStart(64, '0');
    let cityTxHash = '0x' + Math.random().toString(16).slice(2).padStart(64, '0');
    let blockNumber = 0n;

    if (useQueue) {
        const netJob = createOnchainJobUpdate({
            jobType: 'RAW_SBYTE_TRANSFER',
            payload: {
                fromActorId: actor.id,
                toActorId: listing.sellerId,
                toAddress: (await prisma.agentWallet.findUnique({ where: { actorId: listing.sellerId } }))!.walletAddress,
                amountWei: ethers.parseEther(net.toString()).toString(),
                txType: 'BUSINESS_SALE',
                platformFee: platformFee.toString(),
                cityFee: cityFee.toString(),
                cityId: business.cityId,
            },
            actorId: actor.id,
            relatedIntentId: intent.id,
        });
        jobUpdates.push(netJob.update);
        netTxHash = null;

        const platformJob = createOnchainJobUpdate({
            jobType: 'RAW_SBYTE_TRANSFER',
            payload: {
                fromActorId: actor.id,
                toActorId: null,
                toAddress: CONTRACTS.PLATFORM_FEE_VAULT,
                amountWei: ethers.parseEther(platformFee.toString()).toString(),
                txType: 'PLATFORM_FEE',
                platformFee: platformFee.toString(),
                cityId: business.cityId,
            },
            actorId: actor.id,
            relatedIntentId: intent.id,
        });
        jobUpdates.push(platformJob.update);
        platformTxHash = null;

        const cityJob = createOnchainJobUpdate({
            jobType: 'RAW_SBYTE_TRANSFER',
            payload: {
                fromActorId: actor.id,
                toActorId: null,
                toAddress: CONTRACTS.PUBLIC_VAULT_AND_GOD,
                amountWei: ethers.parseEther(cityFee.toString()).toString(),
                txType: 'CITY_FEE',
                cityFee: cityFee.toString(),
                cityId: business.cityId,
            },
            actorId: actor.id,
            relatedIntentId: intent.id,
        });
        jobUpdates.push(cityJob.update);
        cityTxHash = null;
    } else if (process.env.SKIP_ONCHAIN_EXECUTION !== 'true') {
        const signer = await walletService.getSignerWallet(actor.id);
        const sbyteContract = new ethers.Contract(CONTRACTS.SBYTE_TOKEN, ['function transfer(address to, uint256 amount) returns (bool)'], signer);

        const sellerWallet = await prisma.agentWallet.findUnique({ where: { actorId: listing.sellerId } });
        if (!sellerWallet) return fail(actor.id, EventType.EVENT_BUSINESS_SOLD, 'Seller wallet missing');

        try {
            const netTx = await withRpcRetry(
                () => sbyteContract.transfer(sellerWallet.walletAddress, ethers.parseEther(net.toString())),
                'businessSaleNet'
            );
            const netReceipt = await withRpcRetry(() => netTx.wait(), 'businessSaleNetWait');
            assertReceiptSuccess(netReceipt, 'businessSaleNet');
            netTxHash = netTx.hash;
            blockNumber = BigInt(netReceipt?.blockNumber || 0);

            const platformTx = await withRpcRetry(
                () => sbyteContract.transfer(CONTRACTS.PLATFORM_FEE_VAULT, ethers.parseEther(platformFee.toString())),
                'businessSalePlatform'
            );
            const platformReceipt = await withRpcRetry(() => platformTx.wait(), 'businessSalePlatformWait');
            assertReceiptSuccess(platformReceipt, 'businessSalePlatform');
            platformTxHash = platformTx.hash;
            blockNumber = BigInt(platformReceipt?.blockNumber || blockNumber);

            const cityTx = await withRpcRetry(
                () => sbyteContract.transfer(CONTRACTS.PUBLIC_VAULT_AND_GOD, ethers.parseEther(cityFee.toString())),
                'businessSaleCity'
            );
            const cityReceipt = await withRpcRetry(() => cityTx.wait(), 'businessSaleCityWait');
            assertReceiptSuccess(cityReceipt, 'businessSaleCity');
            cityTxHash = cityTx.hash;
            blockNumber = BigInt(cityReceipt?.blockNumber || blockNumber);
        } catch (error: any) {
            await recordFailedOnchainTx({
                fromAddress: signer.address,
                toAddress: sellerWallet.walletAddress,
                amount: price.toString(),
                fromActorId: actor.id,
                toActorId: listing.sellerId,
                txType: 'BUSINESS_SALE',
                cityId: business.cityId,
                reason: String(error?.message || error)
            });
            throw error;
        }
    }

    if (!useQueue) {
        await prisma.onchainTransaction.createMany({
            data: [
                {
                    txHash: netTxHash,
                    blockNumber: BigInt(blockNumber),
                    fromAddress: (await prisma.agentWallet.findUnique({ where: { actorId: actor.id } }))!.walletAddress,
                    toAddress: (await prisma.agentWallet.findUnique({ where: { actorId: listing.sellerId } }))!.walletAddress,
                    tokenAddress: CONTRACTS.SBYTE_TOKEN,
                    amount: net.toString(),
                    fromActorId: actor.id,
                    toActorId: listing.sellerId,
                    txType: 'BUSINESS_SALE',
                    platformFee: platformFee.toString(),
                    cityFee: cityFee.toString(),
                    cityId: business.cityId,
                    status: 'confirmed',
                    confirmedAt: new Date()
                },
                {
                    txHash: platformTxHash,
                    blockNumber: BigInt(blockNumber),
                    fromAddress: (await prisma.agentWallet.findUnique({ where: { actorId: actor.id } }))!.walletAddress,
                    toAddress: CONTRACTS.PLATFORM_FEE_VAULT,
                    tokenAddress: CONTRACTS.SBYTE_TOKEN,
                    amount: platformFee.toString(),
                    fromActorId: actor.id,
                    toActorId: null,
                    txType: 'PLATFORM_FEE',
                    platformFee: platformFee.toString(),
                    cityFee: '0',
                    cityId: business.cityId,
                    status: 'confirmed',
                    confirmedAt: new Date()
                },
                {
                    txHash: cityTxHash,
                    blockNumber: BigInt(blockNumber),
                    fromAddress: (await prisma.agentWallet.findUnique({ where: { actorId: actor.id } }))!.walletAddress,
                    toAddress: CONTRACTS.PUBLIC_VAULT_AND_GOD,
                    tokenAddress: CONTRACTS.SBYTE_TOKEN,
                    amount: cityFee.toString(),
                    fromActorId: actor.id,
                    toActorId: null,
                    txType: 'CITY_FEE',
                    platformFee: '0',
                    cityFee: cityFee.toString(),
                    cityId: business.cityId,
                    status: 'confirmed',
                    confirmedAt: new Date()
                }
            ]
        });
    }

    return {
        stateUpdates: [
            { table: 'wallet', operation: 'update', where: { actorId: actor.id }, data: { balanceSbyte: { decrement: price.toNumber() } } },
            { table: 'agentWallet', operation: 'update', where: { actorId: actor.id }, data: { balanceSbyte: { decrement: price.toNumber() } } },
            { table: 'wallet', operation: 'update', where: { actorId: listing.sellerId }, data: { balanceSbyte: { increment: net.toNumber() } } },
            { table: 'agentWallet', operation: 'update', where: { actorId: listing.sellerId }, data: { balanceSbyte: { increment: net.toNumber() } } },
            { table: 'business', operation: 'update', where: { id: business.id }, data: { ownerId: actor.id, status: 'SOLD' } },
            { table: 'businessListing', operation: 'update', where: { id: listing.id }, data: { status: 'SOLD' } }
        ].concat(jobUpdates),
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_BUSINESS_SOLD,
            targetIds: [business.id],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { price: price.toString(), sellerId: listing.sellerId, platformFee: platformFee.toString(), cityFee: cityFee.toString(), net: net.toString(), queued: useQueue }
        }],
        intentStatus: useQueue ? IntentStatus.QUEUED : IntentStatus.EXECUTED
    };
};

export const handleDissolveBusiness: IntentHandler = async (intent, actor) => {
    const params = intent.params as { businessId?: string };
    if (!params?.businessId) return fail(actor.id, EventType.EVENT_BUSINESS_DISSOLVED, 'Missing businessId');
    const business = await prisma.business.findUnique({ where: { id: params.businessId } });
    if (!business || business.ownerId !== actor.id) return fail(actor.id, EventType.EVENT_BUSINESS_DISSOLVED, 'Not owner');

    const treasury = new Decimal(business.treasury.toString());
    const tax = treasury.mul(0.05);
    const net = treasury.minus(tax);
    const useQueue = process.env.ENABLE_ONCHAIN_QUEUE === 'true';
    const jobUpdates: StateUpdate[] = [];
    if (process.env.SKIP_ONCHAIN_EXECUTION !== 'true' && tax.greaterThan(0)) {
        const signer = await walletService.getSignerWallet(actor.id);
        const sbyteContract = new ethers.Contract(CONTRACTS.SBYTE_TOKEN, ['function transfer(address to, uint256 amount) returns (bool)'], signer);
        try {
            if (useQueue) {
                const job = createOnchainJobUpdate({
                    jobType: 'RAW_SBYTE_TRANSFER',
                    payload: {
                        fromActorId: actor.id,
                        toActorId: null,
                        toAddress: CONTRACTS.PUBLIC_VAULT_AND_GOD,
                        amountWei: ethers.parseEther(tax.toString()).toString(),
                        txType: 'BUSINESS_WITHDRAW',
                        cityFee: tax.toString(),
                        cityId: business.cityId,
                    },
                    actorId: actor.id,
                    relatedIntentId: intent.id,
                });
                jobUpdates.push(job.update);
            } else {
                const tx = await withRpcRetry(
                    () => sbyteContract.transfer(CONTRACTS.PUBLIC_VAULT_AND_GOD, ethers.parseEther(tax.toString())),
                    'businessDissolveTax'
                );
                const receipt = await withRpcRetry(() => tx.wait(), 'businessDissolveTaxWait');
                assertReceiptSuccess(receipt, 'businessDissolveTax');
                await prisma.onchainTransaction.create({
                    data: {
                        txHash: tx.hash,
                        blockNumber: BigInt(receipt?.blockNumber || 0),
                        fromAddress: signer.address,
                        toAddress: CONTRACTS.PUBLIC_VAULT_AND_GOD,
                        tokenAddress: CONTRACTS.SBYTE_TOKEN,
                        amount: tax.toString(),
                        fromActorId: actor.id,
                        toActorId: null,
                        txType: 'BUSINESS_WITHDRAW',
                        platformFee: '0',
                        cityFee: tax.toString(),
                        cityId: business.cityId,
                        status: 'confirmed',
                        confirmedAt: new Date()
                    }
                });
            }
        } catch (error: any) {
            await recordFailedOnchainTx({
                fromAddress: signer.address,
                toAddress: CONTRACTS.PUBLIC_VAULT_AND_GOD,
                amount: tax.toString(),
                fromActorId: actor.id,
                toActorId: null,
                txType: 'BUSINESS_WITHDRAW',
                cityId: business.cityId,
                reason: String(error?.message || error)
            });
            throw error;
        }
    }

    return {
        stateUpdates: [
            { table: 'business', operation: 'update', where: { id: business.id }, data: { status: 'DISSOLVED', dissolvedTick: tick, isOpen: false, treasury: 0, costBasis: 0 } },
            { table: 'property', operation: 'update', where: { id: business.landId }, data: { isEmptyLot: true } },
            { table: 'wallet', operation: 'update', where: { actorId: actor.id }, data: { balanceSbyte: { increment: net.toNumber() } } },
            { table: 'agentWallet', operation: 'update', where: { actorId: actor.id }, data: { balanceSbyte: { increment: net.toNumber() } } },
            { table: 'cityVault', operation: 'update', where: { cityId: business.cityId }, data: { balanceSbyte: { increment: tax.toNumber() } } }
        ].concat(jobUpdates),
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_BUSINESS_DISSOLVED,
            targetIds: [business.id],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { queued: useQueue }
        }],
        intentStatus: useQueue ? IntentStatus.QUEUED : IntentStatus.EXECUTED
    };
};

export const handleCloseBusiness: IntentHandler = async (intent, actor, _agentState, _wallet, tick) => {
    const params = intent.params as { businessId?: string; reason?: string };
    if (!params?.businessId) return fail(actor.id, EventType.EVENT_BUSINESS_CLOSED, 'Missing businessId');

    const business = await prisma.business.findUnique({
        where: { id: params.businessId },
        include: {
            employments: { where: { status: 'ACTIVE' }, orderBy: { hiredTick: 'asc' } }
        }
    });
    if (!business || business.ownerId !== actor.id) return fail(actor.id, EventType.EVENT_BUSINESS_CLOSED, 'Not owner');

    const bWallet = await prisma.businessWallet.findUnique({ where: { businessId: business.id } });
    if (!bWallet) return fail(actor.id, EventType.EVENT_BUSINESS_CLOSED, 'Business wallet missing');

    const useQueue = process.env.ENABLE_ONCHAIN_QUEUE === 'true';
    const jobUpdates: StateUpdate[] = [];
    let walletBalance = new Decimal(bWallet.balanceSbyte.toString());

    const stateUpdates: StateUpdate[] = [];

    // Step 1: Pay employees
    let employeesPaid = 0;
    for (const emp of business.employments) {
        const owedSalary = new Decimal(emp.salaryDaily.toString());
        if (walletBalance.lessThan(owedSalary)) {
            continue;
        }
        const empWallet = await prisma.agentWallet.findUnique({ where: { actorId: emp.agentId } });
        if (!empWallet) {
            continue;
        }
        if (process.env.SKIP_ONCHAIN_EXECUTION !== 'true') {
            if (useQueue) {
                const job = createOnchainJobUpdate({
                    jobType: 'BUSINESS_TRANSFER_SBYTE',
                    payload: {
                        businessId: business.id,
                        toAddress: empWallet.walletAddress,
                        amountWei: ethers.parseEther(owedSalary.toString()).toString(),
                    },
                    actorId: business.ownerId,
                    relatedIntentId: intent.id,
                });
                jobUpdates.push(job.update);
            } else {
                await businessWalletService.transferFromBusiness(
                    business.id,
                    empWallet.walletAddress,
                    ethers.parseEther(owedSalary.toString())
                );
            }
        }
        walletBalance = walletBalance.minus(owedSalary);
        employeesPaid += 1;
        stateUpdates.push(
            { table: 'wallet', operation: 'update', where: { actorId: emp.agentId }, data: { balanceSbyte: { increment: owedSalary.toNumber() } } },
            { table: 'agentWallet', operation: 'update', where: { actorId: emp.agentId }, data: { balanceSbyte: { increment: owedSalary.toNumber() } } },
            {
                table: 'privateEmployment',
                operation: 'update',
                where: { businessId_agentId: { businessId: business.id, agentId: emp.agentId } },
                data: { status: 'FIRED', endedTick: tick }
            },
            {
                table: 'agentState',
                operation: 'update',
                where: { actorId: emp.agentId },
                data: { lastJobChangeTick: tick }
            }
        );
    }

    // Step 2: Pay outstanding taxes (best effort)
    const cityPolicy = await prisma.cityPolicy.findUnique({ where: { cityId: business.cityId } });
    const taxRate = Number(cityPolicy?.businessTaxRate ?? 0);
    const owedTax = new Decimal(business.dailyRevenue.toString()).mul(taxRate).mul(business.missedTaxDays || 0);
    if (owedTax.greaterThan(0) && walletBalance.greaterThanOrEqualTo(owedTax)) {
        if (process.env.SKIP_ONCHAIN_EXECUTION !== 'true') {
            if (useQueue) {
                const job = createOnchainJobUpdate({
                    jobType: 'BUSINESS_TRANSFER_SBYTE',
                    payload: {
                        businessId: business.id,
                        toAddress: CONTRACTS.PUBLIC_VAULT_AND_GOD,
                        amountWei: ethers.parseEther(owedTax.toString()).toString(),
                    },
                    actorId: business.ownerId,
                    relatedIntentId: intent.id,
                });
                jobUpdates.push(job.update);
            } else {
                await businessWalletService.transferFromBusiness(
                    business.id,
                    CONTRACTS.PUBLIC_VAULT_AND_GOD,
                    ethers.parseEther(owedTax.toString())
                );
            }
        }
        walletBalance = walletBalance.minus(owedTax);
        stateUpdates.push({
            table: 'cityVault',
            operation: 'update',
            where: { cityId: business.cityId },
            data: { balanceSbyte: { increment: owedTax.toNumber() } }
        });
    }

    // Step 3: Distribute remaining SBYTE
    const remainingSbyte = walletBalance;
    if (remainingSbyte.greaterThan(0)) {
        const publicShare = remainingSbyte.mul(0.15);
        const platformShare = remainingSbyte.mul(0.15);
        const ownerShare = remainingSbyte.mul(0.70);
        const ownerWallet = await prisma.agentWallet.findUnique({ where: { actorId: business.ownerId } });

        if (process.env.SKIP_ONCHAIN_EXECUTION !== 'true') {
            if (publicShare.greaterThan(0)) {
                if (useQueue) {
                    const job = createOnchainJobUpdate({
                        jobType: 'BUSINESS_TRANSFER_SBYTE',
                        payload: {
                            businessId: business.id,
                            toAddress: CONTRACTS.PUBLIC_VAULT_AND_GOD,
                            amountWei: ethers.parseEther(publicShare.toString()).toString(),
                        },
                        actorId: business.ownerId,
                        relatedIntentId: intent.id,
                    });
                    jobUpdates.push(job.update);
                } else {
                    await businessWalletService.transferFromBusiness(
                        business.id,
                        CONTRACTS.PUBLIC_VAULT_AND_GOD,
                        ethers.parseEther(publicShare.toString())
                    );
                }
            }
            if (platformShare.greaterThan(0)) {
                if (useQueue) {
                    const job = createOnchainJobUpdate({
                        jobType: 'BUSINESS_TRANSFER_SBYTE',
                        payload: {
                            businessId: business.id,
                            toAddress: CONTRACTS.PLATFORM_FEE_VAULT,
                            amountWei: ethers.parseEther(platformShare.toString()).toString(),
                        },
                        actorId: business.ownerId,
                        relatedIntentId: intent.id,
                    });
                    jobUpdates.push(job.update);
                } else {
                    await businessWalletService.transferFromBusiness(
                        business.id,
                        CONTRACTS.PLATFORM_FEE_VAULT,
                        ethers.parseEther(platformShare.toString())
                    );
                }
            }
            if (ownerShare.greaterThan(0) && ownerWallet) {
                if (useQueue) {
                    const job = createOnchainJobUpdate({
                        jobType: 'BUSINESS_TRANSFER_SBYTE',
                        payload: {
                            businessId: business.id,
                            toAddress: ownerWallet.walletAddress,
                            amountWei: ethers.parseEther(ownerShare.toString()).toString(),
                        },
                        actorId: business.ownerId,
                        relatedIntentId: intent.id,
                    });
                    jobUpdates.push(job.update);
                } else {
                    await businessWalletService.transferFromBusiness(
                        business.id,
                        ownerWallet.walletAddress,
                        ethers.parseEther(ownerShare.toString())
                    );
                }
            }
        }

        stateUpdates.push(
            { table: 'cityVault', operation: 'update', where: { cityId: business.cityId }, data: { balanceSbyte: { increment: publicShare.toNumber() } } },
            { table: 'platformVault', operation: 'update', where: { id: 1 }, data: { balanceSbyte: { increment: platformShare.toNumber() } } }
        );
        if (ownerWallet) {
            stateUpdates.push(
                { table: 'wallet', operation: 'update', where: { actorId: business.ownerId }, data: { balanceSbyte: { increment: ownerShare.toNumber() } } },
                { table: 'agentWallet', operation: 'update', where: { actorId: business.ownerId }, data: { balanceSbyte: { increment: ownerShare.toNumber() } } }
            );
        }
    }

    // Step 4: Transfer remaining MON to owner
    const remainingMon = new Decimal(bWallet.balanceMon.toString());
    const gasReserve = new Decimal('0.001');
    if (remainingMon.greaterThan(gasReserve)) {
        const monToTransfer = remainingMon.minus(gasReserve);
        const ownerWallet = await prisma.agentWallet.findUnique({ where: { actorId: business.ownerId } });
        if (ownerWallet && process.env.SKIP_ONCHAIN_EXECUTION !== 'true') {
            if (useQueue) {
                const job = createOnchainJobUpdate({
                    jobType: 'BUSINESS_TRANSFER_MON',
                    payload: {
                        businessId: business.id,
                        toAddress: ownerWallet.walletAddress,
                        amountWei: ethers.parseEther(monToTransfer.toString()).toString(),
                    },
                    actorId: business.ownerId,
                    relatedIntentId: intent.id,
                });
                jobUpdates.push(job.update);
            } else {
                await businessWalletService.transferMonFromBusiness(
                    business.id,
                    ownerWallet.walletAddress,
                    ethers.parseEther(monToTransfer.toString())
                );
            }
        }
        stateUpdates.push(
            { table: 'agentWallet', operation: 'update', where: { actorId: business.ownerId }, data: { balanceMon: { increment: monToTransfer.toNumber() } } }
        );
    }

    // Step 5: Mark business closed
    stateUpdates.push({
        table: 'business',
        operation: 'update',
        where: { id: business.id },
        data: {
            isOpen: false,
            status: 'DISSOLVED',
            closedTick: tick,
            closedReason: params.reason || 'closed_by_owner',
            costBasis: 0
        }
    });

    // Step 6: Release land
    if (business.landId) {
        stateUpdates.push({
            table: 'property',
            operation: 'update',
            where: { id: business.landId },
            data: { ownerId: null, tenantId: null, isEmptyLot: true, forSale: true }
        });
    }

    // Step 7: Zero out business wallet
    stateUpdates.push({
        table: 'businessWallet',
        operation: 'update',
        where: { businessId: business.id },
        data: { balanceSbyte: 0, balanceMon: 0 }
    });

    return {
        stateUpdates: stateUpdates.concat(jobUpdates),
        events: [{
            actorId: business.ownerId,
            type: EventType.EVENT_BUSINESS_CLOSED,
            targetIds: [business.id],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                reason: params.reason || 'closed_by_owner',
                employeesPaid,
                queued: useQueue,
            }
        }],
        intentStatus: useQueue ? IntentStatus.QUEUED : IntentStatus.EXECUTED
    };
};

export const handleWithdrawBusinessFunds: IntentHandler = async (intent, actor, _agentState, _wallet, tick) => {
    const params = intent.params as { businessId?: string; amount?: number };
    if (!params?.businessId || !params.amount) return fail(actor.id, EventType.EVENT_BUSINESS_WITHDRAW, 'Missing params');
    const business = await prisma.business.findUnique({ where: { id: params.businessId } });
    if (!business || business.ownerId !== actor.id) return fail(actor.id, EventType.EVENT_BUSINESS_WITHDRAW, 'Not owner');
    const amt = new Decimal(params.amount);
    const bWallet = await prisma.businessWallet.findUnique({ where: { businessId: business.id } });
    if (!bWallet) return fail(actor.id, EventType.EVENT_BUSINESS_WITHDRAW, 'Business wallet missing');
    if (new Decimal(bWallet.balanceSbyte.toString()).lessThan(amt)) {
        return fail(actor.id, EventType.EVENT_BUSINESS_WITHDRAW, 'Insufficient business funds');
    }

    const employees = await prisma.privateEmployment.findMany({
        where: { businessId: business.id, status: 'ACTIVE' },
    });
    if (employees.some(e => e.missedPayDays > 0)) {
        return fail(actor.id, EventType.EVENT_BUSINESS_WITHDRAW, 'employees_unpaid');
    }

    const cityPolicy = await prisma.cityPolicy.findUnique({ where: { cityId: business.cityId } });
    const maintenanceCost = getBusinessMaintenanceCost(business.businessType, business.level);
    const payroll = employees.reduce((sum, e) => sum + Number(e.salaryDaily), 0);
    const taxRate = Number(cityPolicy?.businessTaxRate ?? 0);
    const dailyTax = Number(business.dailyRevenue) * taxRate;
    const dailyBurn = payroll + maintenanceCost + dailyTax;
    const minReserve = dailyBurn * 3;
    if (new Decimal(bWallet.balanceSbyte.toString()).minus(amt).lessThan(minReserve)) {
        return fail(actor.id, EventType.EVENT_BUSINESS_WITHDRAW, 'withdrawal_would_breach_minimum_reserve');
    }

    const config = (business.config || {}) as Record<string, any>;
    const finance = config.finance || { totalInjected: 0, totalWithdrawn: 0 };
    const availableProfit = Math.max(0, Number(business.treasury) - Number(finance.totalInjected || 0));
    if (amt.toNumber() > availableProfit * 0.5) {
        return fail(actor.id, EventType.EVENT_BUSINESS_WITHDRAW, 'max_withdrawal_50pct_of_profit');
    }

    const useQueue = process.env.ENABLE_ONCHAIN_QUEUE === 'true';
    const jobUpdates: StateUpdate[] = [];
    let txHash: string | null = null;
    if (process.env.SKIP_ONCHAIN_EXECUTION !== 'true') {
        const ownerWallet = await prisma.agentWallet.findUnique({ where: { actorId: actor.id } });
        if (!ownerWallet) return fail(actor.id, EventType.EVENT_BUSINESS_WITHDRAW, 'Owner wallet missing');
        if (useQueue) {
            const job = createOnchainJobUpdate({
                jobType: 'BUSINESS_TRANSFER_SBYTE',
                payload: {
                    businessId: business.id,
                    toAddress: ownerWallet.walletAddress,
                    amountWei: ethers.parseEther(amt.toString()).toString(),
                },
                actorId: actor.id,
                relatedIntentId: intent.id,
            });
            jobUpdates.push(job.update);
            txHash = null;
        } else {
            const transfer = await businessWalletService.transferFromBusiness(
                business.id,
                ownerWallet.walletAddress,
                ethers.parseEther(amt.toString())
            );
            txHash = transfer.txHash;
        }
    }

    finance.totalWithdrawn = Number(finance.totalWithdrawn || 0) + amt.toNumber();
    config.finance = finance;

    return {
        stateUpdates: [
            { table: 'business', operation: 'update', where: { id: business.id }, data: { treasury: { decrement: amt.toNumber() }, config } },
            { table: 'businessWallet', operation: 'update', where: { businessId: business.id }, data: { balanceSbyte: { decrement: amt.toNumber() } } },
            { table: 'wallet', operation: 'update', where: { actorId: actor.id }, data: { balanceSbyte: { increment: amt.toNumber() } } },
            { table: 'agentWallet', operation: 'update', where: { actorId: actor.id }, data: { balanceSbyte: { increment: amt.toNumber() } } },
            {
                table: 'transaction',
                operation: 'create',
                data: {
                    fromActorId: business.ownerId,
                    toActorId: actor.id,
                    amount: amt.toNumber(),
                    feePlatform: 0,
                    feeCity: 0,
                    cityId: business.cityId,
                    tick,
                    reason: 'BUSINESS_WITHDRAW',
                    onchainTxHash: txHash,
                    metadata: { availableProfit }
                }
            }
        ].concat(jobUpdates),
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_BUSINESS_WITHDRAW,
            targetIds: [business.id],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { amount: amt.toNumber(), queued: useQueue }
        }],
        intentStatus: useQueue ? IntentStatus.QUEUED : IntentStatus.EXECUTED
    };
};

export const handleInjectBusinessFunds: IntentHandler = async (intent, actor, agentState, wallet) => {
    const params = intent.params as { businessId?: string; amount?: number };
    if (!params?.businessId || !params.amount) return fail(actor.id, EventType.EVENT_BUSINESS_INJECT, 'Missing params');
    const business = await prisma.business.findUnique({ where: { id: params.businessId } });
    if (!business || business.ownerId !== actor.id) return fail(actor.id, EventType.EVENT_BUSINESS_INJECT, 'Not owner');
    if (!wallet) return fail(actor.id, EventType.EVENT_BUSINESS_INJECT, 'No wallet');
    const amt = new Decimal(params.amount);
    if (new Decimal(wallet.balanceSbyte.toString()).lessThan(amt)) return fail(actor.id, EventType.EVENT_BUSINESS_INJECT, 'Insufficient funds');
    const bWallet = await prisma.businessWallet.findUnique({ where: { businessId: business.id } });
    if (!bWallet) return fail(actor.id, EventType.EVENT_BUSINESS_INJECT, 'Business wallet missing');

    const useQueue = process.env.ENABLE_ONCHAIN_QUEUE === 'true';
    let netInjected = 0;
    const jobUpdates: StateUpdate[] = [];
    if (useQueue) {
        const injectWei = ethers.parseEther(amt.toString());
        const feeBps = getFeeBps();
        const fees = calculateFees(injectWei, feeBps.cityBps, feeBps.platformBps);
        netInjected = Number(ethers.formatEther(fees.netAmount));
        const job = createOnchainJobUpdate({
            jobType: 'AGENT_TRANSFER_SBYTE',
            payload: {
                fromActorId: actor.id,
                toActorId: null,
                amountWei: injectWei.toString(),
                reason: 'business_inject',
                cityId: business.cityId,
                toAddressOverride: bWallet.walletAddress
            },
            actorId: actor.id,
            relatedIntentId: intent.id,
        });
        jobUpdates.push(job.update);
    } else {
        const injectTx = await agentTransferService.transfer(
            actor.id,
            null,
            ethers.parseEther(amt.toString()),
            'business_inject',
            business.cityId,
            bWallet.walletAddress
        );
        netInjected = Number(ethers.formatEther(injectTx.netAmount));
    }

    const config = (business.config || {}) as Record<string, any>;
    const finance = config.finance || { totalInjected: 0, totalWithdrawn: 0 };
    finance.totalInjected = Number(finance.totalInjected || 0) + amt.toNumber();
    config.finance = finance;

    return {
        stateUpdates: [
            {
                table: 'business',
                operation: 'update',
                where: { id: business.id },
                data: {
                    treasury: { increment: netInjected },
                    costBasis: { increment: amt.toNumber() },
                    config
                }
            },
            { table: 'businessWallet', operation: 'update', where: { businessId: business.id }, data: { balanceSbyte: { increment: netInjected } } }
        ].concat(jobUpdates),
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_BUSINESS_INJECT,
            targetIds: [business.id],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { amount: netInjected, queued: useQueue }
        }],
        intentStatus: useQueue ? IntentStatus.QUEUED : IntentStatus.EXECUTED
    };
};

export const handleSetLoanTerms: IntentHandler = async (intent, actor) => {
    const params = intent.params as { businessId?: string; minRate?: number; maxRate?: number };
    if (!params?.businessId) return fail(actor.id, EventType.EVENT_LOAN_ISSUED, 'Missing businessId');
    const business = await prisma.business.findUnique({ where: { id: params.businessId } });
    if (!business || business.ownerId !== actor.id || business.businessType !== 'BANK') {
        return fail(actor.id, EventType.EVENT_LOAN_ISSUED, 'Not a bank owner');
    }
    const config = (business.config || {}) as Record<string, unknown>;
    if (params.minRate !== undefined) config.minLoanRate = params.minRate;
    if (params.maxRate !== undefined) config.maxLoanRate = params.maxRate;

    return {
        stateUpdates: [{ table: 'business', operation: 'update', where: { id: business.id }, data: { config } }],
        events: [],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleApproveLoan: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    const params = intent.params as { businessId?: string; borrowerId?: string; principal?: number; dailyInterestRate?: number; dueTick?: number };
    if (!params?.businessId || !params.borrowerId || !params.principal || !params.dailyInterestRate || !params.dueTick) {
        return fail(actor.id, EventType.EVENT_LOAN_ISSUED, 'Missing params');
    }
    const business = await prisma.business.findUnique({ where: { id: params.businessId } });
    if (!business || business.ownerId !== actor.id || business.businessType !== 'BANK') {
        return fail(actor.id, EventType.EVENT_LOAN_ISSUED, 'Not a bank owner');
    }
    const bWallet = await prisma.businessWallet.findUnique({ where: { businessId: business.id } });
    if (!bWallet) return fail(actor.id, EventType.EVENT_LOAN_ISSUED, 'Business wallet missing');
    const borrowerWallet = await prisma.agentWallet.findUnique({ where: { actorId: params.borrowerId } });
    if (!borrowerWallet) return fail(actor.id, EventType.EVENT_LOAN_ISSUED, 'Borrower wallet missing');

    const useQueue = process.env.ENABLE_ONCHAIN_QUEUE === 'true';
    const jobUpdates: StateUpdate[] = [];
    let loanTxHash: string | null = null;
    if (process.env.SKIP_ONCHAIN_EXECUTION !== 'true') {
        if (useQueue) {
            const job = createOnchainJobUpdate({
                jobType: 'BUSINESS_TRANSFER_SBYTE',
                payload: {
                    businessId: business.id,
                    toAddress: borrowerWallet.walletAddress,
                    amountWei: ethers.parseEther(params.principal.toString()).toString(),
                },
                actorId: actor.id,
                relatedIntentId: intent.id,
            });
            jobUpdates.push(job.update);
            loanTxHash = null;
        } else {
            const transfer = await businessWalletService.transferFromBusiness(
                business.id,
                borrowerWallet.walletAddress,
                ethers.parseEther(params.principal.toString())
            );
            loanTxHash = transfer.txHash;
        }
    }

    return {
        stateUpdates: [{
            table: 'loan',
            operation: 'create',
            data: {
                bankBusinessId: business.id,
                borrowerId: params.borrowerId,
                principal: params.principal,
                dailyInterestRate: params.dailyInterestRate,
                outstanding: params.principal,
                issuedTick: tick,
                dueTick: params.dueTick,
                status: 'ACTIVE'
            }
        }, {
            table: 'businessWallet',
            operation: 'update',
            where: { businessId: business.id },
            data: { balanceSbyte: { decrement: params.principal } }
        }, {
            table: 'business',
            operation: 'update',
            where: { id: business.id },
            data: { treasury: { decrement: params.principal } }
        }].concat(jobUpdates),
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_LOAN_ISSUED,
            targetIds: [params.borrowerId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { principal: params.principal, txHash: loanTxHash, queued: useQueue }
        }],
        intentStatus: useQueue ? IntentStatus.QUEUED : IntentStatus.EXECUTED
    };
};

export const handleDenyLoan: IntentHandler = async (intent, actor) => {
    const params = intent.params as { businessId?: string; borrowerId?: string; reason?: string };
    if (!params?.businessId || !params.borrowerId) return fail(actor.id, EventType.EVENT_LOAN_DEFAULTED, 'Missing params');
    return {
        stateUpdates: [],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_LOAN_DEFAULTED,
            targetIds: [params.borrowerId],
            outcome: EventOutcome.BLOCKED,
            sideEffects: { reason: params.reason || 'denied' }
        }],
        intentStatus: IntentStatus.BLOCKED
    };
};

export const handleSetHouseEdge: IntentHandler = async (intent, actor) => {
    const params = intent.params as { businessId?: string; houseEdge?: number };
    if (!params?.businessId || params.houseEdge === undefined) return fail(actor.id, EventType.EVENT_BUSINESS_REVENUE_EARNED, 'Missing params');
    const business = await prisma.business.findUnique({ where: { id: params.businessId } });
    if (!business || business.ownerId !== actor.id || business.businessType !== 'CASINO') {
        return fail(actor.id, EventType.EVENT_BUSINESS_REVENUE_EARNED, 'Not a casino owner');
    }
    const config = (business.config || {}) as Record<string, unknown>;
    // Clamp house edge to 1-10% range
    config.houseEdge = Math.max(1, Math.min(10, Number(params.houseEdge)));
    return {
        stateUpdates: [{ table: 'business', operation: 'update', where: { id: business.id }, data: { config } }],
        events: [],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleHostEvent: IntentHandler = async (intent, actor) => {
    const params = intent.params as { businessId?: string; eventName?: string; price?: number };
    if (!params?.businessId) return fail(actor.id, EventType.EVENT_BUSINESS_CUSTOMER_VISIT, 'Missing businessId');
    const business = await prisma.business.findUnique({ where: { id: params.businessId } });
    if (!business || business.ownerId !== actor.id) return fail(actor.id, EventType.EVENT_BUSINESS_CUSTOMER_VISIT, 'Not owner');
    const config = (business.config || {}) as Record<string, unknown>;
    config.hostedEvent = { name: params.eventName || 'event', price: params.price || 0 };
    return {
        stateUpdates: [{ table: 'business', operation: 'update', where: { id: business.id }, data: { config } }],
        events: [],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleVisitBusiness: IntentHandler = async (intent, actor, agentState, wallet, tick, seed) => {
    const params = intent.params as { businessId?: string; bet?: number };
    if (!params?.businessId) return fail(actor.id, EventType.EVENT_BUSINESS_CUSTOMER_VISIT, 'Missing businessId');
    const business = await prisma.business.findUnique({ where: { id: params.businessId } });
    if (!business || !business.isOpen) return fail(actor.id, EventType.EVENT_BUSINESS_CUSTOMER_VISIT, 'Business closed');
    if (!wallet) return fail(actor.id, EventType.EVENT_BUSINESS_CUSTOMER_VISIT, 'No wallet');
    if (!agentState) return fail(actor.id, EventType.EVENT_BUSINESS_CUSTOMER_VISIT, 'No agent state');
    const crossCity = Boolean(agentState.cityId && business.cityId && agentState.cityId !== business.cityId);
    const isSelfOwnedBusiness = business.ownerId === actor.id;

    // Gambling hard cap: 40 games per sim-day across all gambling types
    const gamesToday = (agentState as any)?.gamesToday ?? 0;
    if (business.businessType === 'CASINO' && gamesToday >= 40) {
        return fail(actor.id, EventType.EVENT_BUSINESS_CUSTOMER_VISIT, 'Daily gambling limit reached (40)');
    }

    const bWallet = await prisma.businessWallet.findUnique({ where: { businessId: business.id } });
    if (!bWallet) return fail(actor.id, EventType.EVENT_BUSINESS_CUSTOMER_VISIT, 'Business wallet missing');

    // ========== CASINO GAMBLING BRANCH ==========
    if (business.businessType === 'CASINO') {
        const config = (business.config || {}) as Record<string, any>;
        const houseEdge = Math.max(1, Math.min(10, Number(config.houseEdge ?? 7))); // 1-10%
        const minBet = 100;
        const maxBet = 300;
        const seedBet = minBet + Math.floor(Number(seed % BigInt(maxBet - minBet + 1)));
        const betAmount = Math.max(minBet, Math.min(maxBet, Number(params.bet ?? seedBet)));
        const playerBalance = new Decimal(wallet.balanceSbyte.toString());
        if (playerBalance.lessThan(betAmount)) {
            return fail(actor.id, EventType.EVENT_BUSINESS_CUSTOMER_VISIT, 'Insufficient funds for casino bet');
        }
        const houseTreasury = Number(business.treasury);

        // Deterministic win/loss using seed
        const roll = Number(seed % BigInt(100));
        const winChance = 100 - (houseEdge * 10); // houseEdge 7% => 30% win chance (scaling for meaningful gameplay)
        const playerWins = roll < winChance;
        // Owner gambling at their own casino is treated as an internal move and must be net-worth neutral.
        // We keep gameplay telemetry (win/loss event + need effects) but avoid economic deltas.
        if (isSelfOwnedBusiness) {
            const selfPlayFunGain = playerWins ? 55 : 40;
            const selfPlaySocialGain = playerWins ? 10 : 5;
            return {
                stateUpdates: [
                    {
                        table: 'business',
                        operation: 'update',
                        where: { id: business.id },
                        data: { customerVisitsToday: { increment: 1 } }
                    },
                    {
                        table: 'agentState',
                        operation: 'update',
                        where: { actorId: actor.id },
                        data: {
                            fun: Math.min(agentState.fun + selfPlayFunGain, 100),
                            social: Math.min(agentState.social + selfPlaySocialGain, 100),
                            gamesToday: { increment: 1 },
                            lastGameTick: tick,
                        }
                    }
                ],
                events: [{
                    actorId: actor.id,
                    type: EventType.EVENT_BUSINESS_CUSTOMER_VISIT,
                    targetIds: [business.id],
                    outcome: EventOutcome.SUCCESS,
                    sideEffects: {
                        casinoResult: playerWins ? 'WIN' : 'LOSS',
                        bet: betAmount,
                        selfPlay: true,
                        economicDelta: 0
                    }
                }],
                intentStatus: IntentStatus.EXECUTED
            };
        }

        const useQueue = process.env.ENABLE_ONCHAIN_QUEUE === 'true';
        const feeBps = getFeeBps();
        const stateUpdates: StateUpdate[] = [];
        const jobUpdates: StateUpdate[] = [];
        let txHash: string | null = null;

        if (playerWins) {
            // Win: payout = bet x multiplier (2x-5x), from house wallet
            const multiplier = 2 + Number(seed % BigInt(4)); // 2-5x
            const grossPayout = betAmount * multiplier;
            const actualPayout = Math.min(grossPayout, houseTreasury * 0.1); // Cap at 10% of house treasury
            if (actualPayout <= 0) {
                return fail(actor.id, EventType.EVENT_BUSINESS_CUSTOMER_VISIT, 'Casino house cannot cover payout');
            }

            const payoutFees = calculateFees(ethers.parseEther(actualPayout.toString()), feeBps.cityBps, feeBps.platformBps);
            const netPayout = Number(ethers.formatEther(payoutFees.netAmount));
            const feePlatform = Number(ethers.formatEther(payoutFees.platformFee));
            const feeCity = Number(ethers.formatEther(payoutFees.cityFee));

            if (useQueue) {
                const agentWallet = await prisma.agentWallet.findUnique({ where: { actorId: actor.id } });
                if (!agentWallet) {
                    return fail(actor.id, EventType.EVENT_BUSINESS_CUSTOMER_VISIT, 'Target wallet missing');
                }
                const job = createOnchainJobUpdate({
                    jobType: 'BUSINESS_TRANSFER_SBYTE',
                    payload: {
                        businessId: business.id,
                        toAddress: agentWallet.walletAddress,
                        amountWei: ethers.parseEther(actualPayout.toString()).toString(),
                    },
                    actorId: actor.id,
                    relatedIntentId: intent.id,
                });
                jobUpdates.push(job.update);
            } else {
                try {
                    const agentWallet = await prisma.agentWallet.findUnique({ where: { actorId: actor.id } });
                    if (agentWallet) {
                        const payoutTx = await businessWalletService.transferFromBusiness(
                            business.id,
                            agentWallet.walletAddress,
                            ethers.parseEther(actualPayout.toString())
                        );
                        txHash = payoutTx.txHash;
                    }
                } catch (err) {
                    console.warn(`Casino payout transfer failed for ${business.id}`, err);
                    txHash = `0x${crypto.randomBytes(32).toString('hex')}`;
                }
            }

            stateUpdates.push(
                { table: 'business', operation: 'update', where: { id: business.id }, data: { treasury: { decrement: actualPayout }, customerVisitsToday: { increment: 1 } } },
                { table: 'businessWallet', operation: 'update', where: { businessId: business.id }, data: { balanceSbyte: { decrement: actualPayout } } },
                { table: 'wallet', operation: 'update', where: { actorId: actor.id }, data: { balanceSbyte: { increment: netPayout } } },
                { table: 'agentWallet', operation: 'update', where: { actorId: actor.id }, data: { balanceSbyte: { increment: netPayout } } },
                {
                    table: 'transaction', operation: 'create', data: {
                        fromActorId: business.ownerId, toActorId: actor.id,
                        amount: actualPayout, feePlatform, feeCity,
                        cityId: business.cityId, tick, reason: 'CASINO_WIN_PAYOUT',
                        onchainTxHash: txHash,
                        metadata: { businessId: business.id, businessName: business.name, bet: betAmount, multiplier, grossPayout, actualPayout }
                    }
                },
                {
                    table: 'agentState', operation: 'update', where: { actorId: actor.id }, data: {
                        fun: Math.min(agentState.fun + 55, 100),
                        social: Math.min(agentState.social + 10, 100),
                        gamesToday: { increment: 1 },
                        lastGameTick: tick,
                    }
                },
                // Reputation boost: business +1, owner +0.5 (rounded to 1)
                { table: 'business', operation: 'update', where: { id: business.id }, data: { reputation: { increment: 1 } } },
                { table: 'actor', operation: 'update', where: { id: business.ownerId }, data: { reputation: { increment: 1 } } }
            );

            return {
                stateUpdates: stateUpdates.concat(jobUpdates),
                events: [{
                    actorId: actor.id,
                    type: EventType.EVENT_BUSINESS_CUSTOMER_VISIT,
                    targetIds: [business.id],
                    outcome: EventOutcome.SUCCESS,
                    sideEffects: { casinoResult: 'WIN', bet: betAmount, multiplier, payout: actualPayout, netPayout, txHash, queued: useQueue }
                }],
                intentStatus: useQueue ? IntentStatus.QUEUED : IntentStatus.EXECUTED
            };
        } else {
            // Loss: bet goes to house wallet
            if (useQueue) {
                const job = createOnchainJobUpdate({
                    jobType: 'AGENT_TRANSFER_SBYTE',
                    payload: {
                        fromActorId: actor.id,
                        toActorId: null,
                        amountWei: ethers.parseEther(betAmount.toString()).toString(),
                        reason: 'casino_loss',
                        cityId: business.cityId,
                        cityFeeMultiplier: crossCity ? 2 : 1,
                        toAddressOverride: bWallet.walletAddress,
                    },
                    actorId: actor.id,
                    relatedIntentId: intent.id,
                });
                jobUpdates.push(job.update);
            } else {
                try {
                    const tx = await agentTransferService.transfer(
                        actor.id, null,
                        ethers.parseEther(betAmount.toString()),
                        'casino_loss', business.cityId, bWallet.walletAddress
                        , crossCity ? 2 : 1
                    );
                    txHash = tx.txHash;
                } catch (err) {
                    console.warn(`Casino bet transfer failed for ${business.id}`, err);
                    txHash = `0x${crypto.randomBytes(32).toString('hex')}`;
                }
            }

            const betFees = calculateFees(ethers.parseEther(betAmount.toString()), feeBps.cityBps * (crossCity ? 2 : 1), feeBps.platformBps);
            const netBet = Number(ethers.formatEther(betFees.netAmount));
            const feePlatform = Number(ethers.formatEther(betFees.platformFee));
            const feeCity = Number(ethers.formatEther(betFees.cityFee));

            stateUpdates.push(
                { table: 'business', operation: 'update', where: { id: business.id }, data: { treasury: { increment: netBet }, customerVisitsToday: { increment: 1 } } },
                { table: 'businessWallet', operation: 'update', where: { businessId: business.id }, data: { balanceSbyte: { increment: netBet } } },
                {
                    table: 'transaction', operation: 'create', data: {
                        fromActorId: actor.id, toActorId: business.ownerId ?? null,
                        amount: betAmount, feePlatform, feeCity,
                        cityId: business.cityId, tick, reason: 'CASINO_BET_LOST',
                        onchainTxHash: txHash,
                        metadata: { businessId: business.id, businessName: business.name, bet: betAmount, casinoResult: 'LOSS' }
                    }
                },
                {
                    table: 'agentState', operation: 'update', where: { actorId: actor.id }, data: {
                        fun: Math.min(agentState.fun + 40, 100),
                        social: Math.min(agentState.social + 5, 100),
                        gamesToday: { increment: 1 },
                        lastGameTick: tick,
                    }
                },
                // Reputation boost: business +1, owner +0.5 (rounded to 1)
                { table: 'business', operation: 'update', where: { id: business.id }, data: { reputation: { increment: 1 } } },
                { table: 'actor', operation: 'update', where: { id: business.ownerId }, data: { reputation: { increment: 1 } } }
            );

            return {
                stateUpdates: stateUpdates.concat(jobUpdates),
                events: [{
                    actorId: actor.id,
                    type: EventType.EVENT_BUSINESS_CUSTOMER_VISIT,
                    targetIds: [business.id],
                    outcome: EventOutcome.SUCCESS,
                    sideEffects: { casinoResult: 'LOSS', bet: betAmount, txHash, queued: useQueue }
                }],
                intentStatus: useQueue ? IntentStatus.QUEUED : IntentStatus.EXECUTED
            };
        }
    }

    // ========== STANDARD BUSINESS VISIT (non-casino) ==========
    const price = new Decimal(((business.config as any)?.pricePerService ?? 20));
    if (new Decimal(wallet.balanceSbyte.toString()).lessThan(price)) {
        return fail(actor.id, EventType.EVENT_BUSINESS_CUSTOMER_VISIT, 'Insufficient funds');
    }

    const needEffects: Record<string, Partial<{ hunger: number; health: number; fun: number; social: number; purpose: number }>> = {
        RESTAURANT: { hunger: 50, fun: 10, social: 5 },
        TAVERN: { fun: 30, social: 20, purpose: 5 },
        CLINIC: { health: 30 },
        GYM: { health: 10, purpose: 15 },
    };
    const effects = needEffects[business.businessType] || {};

    const useQueue = process.env.ENABLE_ONCHAIN_QUEUE === 'true';
    const jobUpdates: StateUpdate[] = [];
    let netAmount = 0;
    let feePlatform = 0;
    let feeCity = 0;
    let txHash: string | null = null;
    if (!isSelfOwnedBusiness) {
        if (useQueue) {
            const feeBps = getFeeBps();
            const fees = calculateFees(ethers.parseEther(price.toString()), feeBps.cityBps * (crossCity ? 2 : 1), feeBps.platformBps);
            netAmount = Number(ethers.formatEther(fees.netAmount));
            feePlatform = Number(ethers.formatEther(fees.platformFee));
            feeCity = Number(ethers.formatEther(fees.cityFee));
            const job = createOnchainJobUpdate({
                jobType: 'AGENT_TRANSFER_SBYTE',
                payload: {
                    fromActorId: actor.id,
                    toActorId: null,
                    amountWei: ethers.parseEther(price.toString()).toString(),
                    reason: 'business',
                    cityId: business.cityId,
                    cityFeeMultiplier: crossCity ? 2 : 1,
                    toAddressOverride: bWallet.walletAddress,
                },
                actorId: actor.id,
                relatedIntentId: intent.id,
            });
            jobUpdates.push(job.update);
            txHash = null;
        } else {
            const tx = await agentTransferService.transfer(
                actor.id,
                null,
                ethers.parseEther(price.toString()),
                'business',
                business.cityId,
                bWallet.walletAddress,
                crossCity ? 2 : 1
            );
            netAmount = Number(ethers.formatEther(tx.netAmount));
            feePlatform = Number(ethers.formatEther(tx.platformFee));
            feeCity = Number(ethers.formatEther(tx.cityFee));
            txHash = tx.txHash;
        }
    }
    return {
        stateUpdates: [
            {
                table: 'business',
                operation: 'update',
                where: { id: business.id },
                data: isSelfOwnedBusiness
                    ? { customerVisitsToday: { increment: 1 } }
                    : { treasury: { increment: netAmount }, customerVisitsToday: { increment: 1 } }
            },
            ...(!isSelfOwnedBusiness ? [{
                table: 'businessWallet',
                operation: 'update',
                where: { businessId: business.id },
                data: { balanceSbyte: { increment: netAmount } }
            }, {
                table: 'transaction',
                operation: 'create',
                data: {
                    fromActorId: actor.id,
                    toActorId: business.ownerId ?? null,
                    amount: price.toNumber(),
                    feePlatform,
                    feeCity,
                    cityId: business.cityId,
                    tick,
                    reason: 'BUSINESS_VISIT',
                    onchainTxHash: txHash,
                    metadata: {
                        businessId: business.id,
                        businessName: business.name,
                        businessType: business.businessType,
                        price: price.toNumber(),
                        onchainTxHash: txHash
                    }
                }
            }] : []),
            {
                table: 'agentState',
                operation: 'update',
                where: { actorId: actor.id },
                data: {
                    hunger: effects.hunger ? Math.min(agentState.hunger + effects.hunger, 100) : agentState.hunger,
                    health: effects.health ? Math.min(agentState.health + effects.health, 100) : agentState.health,
                    fun: effects.fun ? Math.min(agentState.fun + effects.fun, 100) : agentState.fun,
                    social: effects.social ? Math.min(agentState.social + effects.social, 100) : agentState.social,
                    purpose: effects.purpose ? Math.min(agentState.purpose + effects.purpose, 100) : agentState.purpose,
                }
            },
            // Reputation boost per visit: business +1, owner +1
            { table: 'business', operation: 'update', where: { id: business.id }, data: { reputation: { increment: 1 } } },
            { table: 'actor', operation: 'update', where: { id: business.ownerId }, data: { reputation: { increment: 1 } } }
        ].concat(jobUpdates),
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_BUSINESS_CUSTOMER_VISIT,
            targetIds: [business.id],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                price: price.toString(),
                txHash,
                effects,
                queued: useQueue && !isSelfOwnedBusiness,
                selfVisit: isSelfOwnedBusiness,
                economicDelta: isSelfOwnedBusiness ? 0 : undefined
            }
        }],
        intentStatus: useQueue ? IntentStatus.QUEUED : IntentStatus.EXECUTED
    };
};

export const handleBuyStoreItem: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    const params = intent.params as { businessId?: string; itemDefId?: string; itemName?: string; quantity?: number };
    if (!params?.businessId) return fail(actor.id, EventType.EVENT_BUSINESS_CUSTOMER_VISIT, 'Missing businessId');
    if (!agentState) return fail(actor.id, EventType.EVENT_BUSINESS_CUSTOMER_VISIT, 'No agent state');
    if (!wallet) return fail(actor.id, EventType.EVENT_BUSINESS_CUSTOMER_VISIT, 'No wallet');

    const quantity = Number(params.quantity ?? 1);
    if (!Number.isFinite(quantity) || quantity <= 0) {
        return fail(actor.id, EventType.EVENT_BUSINESS_CUSTOMER_VISIT, 'Invalid quantity');
    }

    const business = await prisma.business.findUnique({ where: { id: params.businessId } });
    if (!business || !business.isOpen) return fail(actor.id, EventType.EVENT_BUSINESS_CUSTOMER_VISIT, 'Business closed');
    if (business.businessType !== 'STORE') return fail(actor.id, EventType.EVENT_BUSINESS_CUSTOMER_VISIT, 'Not a store');
    const crossCity = Boolean(agentState.cityId && business.cityId && agentState.cityId !== business.cityId);
    const isSelfOwnedBusiness = business.ownerId === actor.id;

    const itemDef = params.itemDefId
        ? await prisma.itemDefinition.findUnique({ where: { id: params.itemDefId } })
        : params.itemName
            ? await prisma.itemDefinition.findFirst({ where: { name: params.itemName } })
            : null;
    if (!itemDef || itemDef.category !== 'consumable') {
        return fail(actor.id, EventType.EVENT_BUSINESS_CUSTOMER_VISIT, 'Invalid store item');
    }

    const bWallet = await prisma.businessWallet.findUnique({ where: { businessId: business.id } });
    if (!bWallet) return fail(actor.id, EventType.EVENT_BUSINESS_CUSTOMER_VISIT, 'Business wallet missing');

    const priceMultiplier = Number((business.config as any)?.priceMultiplier ?? 1);
    const rawPrice = new Decimal(Math.max(1, Number(itemDef.baseValue ?? 10)) * Math.max(0.1, priceMultiplier));
    const priceEach = Decimal.max(rawPrice, new Decimal(1));
    const totalPrice = priceEach.mul(quantity);
    if (totalPrice.lessThanOrEqualTo(0)) {
        return fail(actor.id, EventType.EVENT_BUSINESS_CUSTOMER_VISIT, 'Invalid store price');
    }
    if (new Decimal(wallet.balanceSbyte.toString()).lessThan(totalPrice)) {
        return fail(actor.id, EventType.EVENT_BUSINESS_CUSTOMER_VISIT, 'Insufficient funds');
    }

    const useQueue = process.env.ENABLE_ONCHAIN_QUEUE === 'true';
    const jobUpdates: StateUpdate[] = [];
    let netAmount = 0;
    let feePlatform = 0;
    let feeCity = 0;
    let txHash: string | null = null;
    if (!isSelfOwnedBusiness) {
        if (useQueue) {
            const feeBps = getFeeBps();
            const fees = calculateFees(ethers.parseEther(totalPrice.toString()), feeBps.cityBps * (crossCity ? 2 : 1), feeBps.platformBps);
            netAmount = Number(ethers.formatEther(fees.netAmount));
            feePlatform = Number(ethers.formatEther(fees.platformFee));
            feeCity = Number(ethers.formatEther(fees.cityFee));
            const job = createOnchainJobUpdate({
                jobType: 'AGENT_TRANSFER_SBYTE',
                payload: {
                    fromActorId: actor.id,
                    toActorId: null,
                    amountWei: ethers.parseEther(totalPrice.toString()).toString(),
                    reason: 'business',
                    cityId: business.cityId,
                    cityFeeMultiplier: crossCity ? 2 : 1,
                    toAddressOverride: bWallet.walletAddress,
                },
                actorId: actor.id,
                relatedIntentId: intent.id,
            });
            jobUpdates.push(job.update);
            txHash = null;
        } else {
            const tx = await agentTransferService.transfer(
                actor.id,
                null,
                ethers.parseEther(totalPrice.toString()),
                'business',
                business.cityId,
                bWallet.walletAddress,
                crossCity ? 2 : 1
            );
            netAmount = Number(ethers.formatEther(tx.netAmount));
            feePlatform = Number(ethers.formatEther(tx.platformFee));
            feeCity = Number(ethers.formatEther(tx.cityFee));
            txHash = tx.txHash;
        }
    }

    const existingItem = await prisma.inventoryItem.findUnique({
        where: { actorId_itemDefId: { actorId: actor.id, itemDefId: itemDef.id } }
    });

    const stateUpdates: StateUpdate[] = [
        {
            table: 'business',
            operation: 'update',
            where: { id: business.id },
            data: isSelfOwnedBusiness
                ? { customerVisitsToday: { increment: 1 } }
                : { treasury: { increment: netAmount }, customerVisitsToday: { increment: 1 } }
        },
        ...(!isSelfOwnedBusiness ? [{
            table: 'businessWallet',
            operation: 'update',
            where: { businessId: business.id },
            data: { balanceSbyte: { increment: netAmount } }
        }, {
            table: 'transaction',
            operation: 'create',
            data: {
                fromActorId: actor.id,
                toActorId: business.ownerId ?? null,
                amount: totalPrice.toNumber(),
                feePlatform,
                feeCity,
                cityId: business.cityId,
                tick,
                reason: 'STORE_PURCHASE',
                onchainTxHash: txHash,
                metadata: {
                    businessId: business.id,
                    businessName: business.name,
                    itemDefId: itemDef.id,
                    quantity,
                    totalPrice: totalPrice.toNumber(),
                    onchainTxHash: txHash
                }
            }
        }] : []),
        existingItem ? {
            table: 'inventoryItem',
            operation: 'update',
            where: { id: existingItem.id },
            data: { quantity: { increment: quantity } }
        } : {
            table: 'inventoryItem',
            operation: 'create',
            data: { actorId: actor.id, itemDefId: itemDef.id, quantity, quality: 50 }
        }
    ];

    return {
        stateUpdates: stateUpdates.concat(jobUpdates),
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_BUSINESS_CUSTOMER_VISIT,
            targetIds: [business.id, itemDef.id],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                itemName: itemDef.name,
                quantity,
                price: totalPrice.toString(),
                totalCost: totalPrice.toString(),
                txHash,
                queued: useQueue && !isSelfOwnedBusiness,
                selfVisit: isSelfOwnedBusiness,
                economicDelta: isSelfOwnedBusiness ? 0 : undefined
            }
        }],
        intentStatus: useQueue ? IntentStatus.QUEUED : IntentStatus.EXECUTED
    };
};

/**
 * Handle INTENT_TRANSFER_MON_TO_BUSINESS
 * Owner transfers MON (native token) to their business wallet for gas funding.
 */
export const handleTransferMonToBusiness: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    const params = intent.params as { businessId?: string; amount?: number };
    if (!params?.businessId) return fail(actor.id, EventType.EVENT_BUSINESS_REVENUE_EARNED, 'Missing businessId');
    const amount = Number(params.amount ?? 2); // Default 2 MON
    if (amount <= 0 || amount > 10) return fail(actor.id, EventType.EVENT_BUSINESS_REVENUE_EARNED, 'Invalid MON amount (0-10)');

    const business = await prisma.business.findUnique({ where: { id: params.businessId } });
    if (!business || business.ownerId !== actor.id) {
        return fail(actor.id, EventType.EVENT_BUSINESS_REVENUE_EARNED, 'Not business owner');
    }
    const bWallet = await prisma.businessWallet.findUnique({ where: { businessId: business.id } });
    if (!bWallet) return fail(actor.id, EventType.EVENT_BUSINESS_REVENUE_EARNED, 'Business wallet missing');

    // Transfer MON from owner wallet to business wallet on-chain
    let txHash: string | null = null;
    if (process.env.SKIP_ONCHAIN_EXECUTION !== 'true') {
        try {
            const ownerSigner = await walletService.getSignerWallet(actor.id);
            const tx = await ownerSigner.sendTransaction({
                to: bWallet.walletAddress,
                value: ethers.parseEther(amount.toString())
            });
            const receipt = await tx.wait();
            txHash = tx.hash;
        } catch (err) {
            console.warn(`MON transfer to business failed for ${business.id}`, err);
            return fail(actor.id, EventType.EVENT_BUSINESS_REVENUE_EARNED, 'MON transfer failed on-chain');
        }
    } else {
        txHash = `0x${crypto.randomBytes(32).toString('hex')}`;
    }

    return {
        stateUpdates: [
            {
                table: 'businessWallet',
                operation: 'update',
                where: { businessId: business.id },
                data: { balanceMon: { increment: amount } }
            }
        ],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_BUSINESS_REVENUE_EARNED,
            targetIds: [business.id],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { monAmount: amount, txHash, reason: 'MON_TOP_UP' }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

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
