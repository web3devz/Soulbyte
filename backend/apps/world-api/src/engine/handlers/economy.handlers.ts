import { prisma } from '../../db.js';
import crypto from 'crypto';
import { IntentStatus } from '../../types/intent.types.js';
import { EventType, EventOutcome } from '../../types/event.types.js';
import { IntentHandler, StateUpdate } from '../engine.types.js';
import { Decimal } from 'decimal.js';
import { calculateFees, getCachedVaultHealth, getDynamicFeeBps } from '../../config/fees.js';

// Initialized service
import { AgentTransferService } from '../../services/agent-transfer.service.js';
import { WalletService } from '../../services/wallet.service.js';
import { CONTRACTS } from '../../config/contracts.js';
import { withRpcRetry } from '../../utils/rpc-retry.js';
import { assertReceiptSuccess } from '../../utils/onchain.js';
import { REAL_DAY_TICKS } from '../../config/time.js';
import { debugLog } from '../../utils/debug-log.js';
import { createOnchainJobUpdate } from '../../services/onchain-queue.service.js';
const agentTransferService = new AgentTransferService();

export const handlePayRent: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    if (!agentState || !wallet) return fail(actor.id, EventType.EVENT_RENT_PAID, 'Missing state/wallet');

    // Find property rented by actor
    const property = await prisma.property.findFirst({
        where: { tenantId: actor.id }
    });

    if (!property) return fail(actor.id, EventType.EVENT_RENT_PAID, 'Not renting any property');

    const lastPaidTick = await getLastRentPaidTick(actor.id);
    if (lastPaidTick !== null && tick - lastPaidTick < REAL_DAY_TICKS) {
        return fail(actor.id, EventType.EVENT_RENT_PAID, 'Rent already paid in the last 24h');
    }

    const rentAmount = new Decimal(property.rentPrice.toString());
    const balance = new Decimal(wallet.balanceSbyte.toString());
    const rentWei = ethers.parseEther(rentAmount.toString());

    // Check marriage for rent splitting
    const marriage = await prisma.consent.findFirst({
        where: {
            OR: [
                { partyAId: actor.id },
                { partyBId: actor.id }
            ],
            type: 'marriage',
            status: 'active'
        }
    });
    const spouseId = marriage
        ? (marriage.partyAId === actor.id ? marriage.partyBId : marriage.partyAId)
        : null;

    // Check balance logic is handled by transfer service too, but good to check early
    // Note: Can't easily check on-chain balance here synchronously without service call overlay, relying on off-chain cache
    if (!spouseId && balance.lessThan(rentAmount)) {
        return {
            stateUpdates: [{
                table: 'property',
                operation: 'update',
                where: { id: property.id },
                data: { missedRentDays: { increment: 1 } }
            }],
            events: [{
                actorId: actor.id,
                type: EventType.EVENT_RENT_PAID,
                targetIds: [property.id],
                outcome: EventOutcome.BLOCKED,
                sideEffects: { reason: 'Insufficient funds' }
            }],
            intentStatus: IntentStatus.BLOCKED
        };
    }

    let rentTxHash: string | null = null;
    let rentFees = { platformFee: 0n, cityFee: 0n };
    let spouseTxHash: string | null = null;
    const useQueue = process.env.ENABLE_ONCHAIN_QUEUE === 'true';
    const jobUpdates: StateUpdate[] = [];
    const jobIds: string[] = [];
    const transactionId = crypto.randomUUID();

    let citySaleSplit: { platformShare: Decimal; cityShare: Decimal } | null = null;
    try {
        // Execute on-chain transfer
        // If ownerId exists, pay owner. Else pay City Vault (Public Vault)
        // For City Vault payment, we send to PUBLIC_VAULT_AND_GOD address and specifying cityId

        let recipientId: string;
        let cityId: string | undefined;

        if (property.ownerId) {
            recipientId = property.ownerId;
        } else {
            const god = await prisma.actor.findFirst({ where: { isGod: true } });
            if (!god) return fail(actor.id, EventType.EVENT_RENT_PAID, 'System offline (God missing)');
            recipientId = god.id;
            cityId = property.cityId;
        }

        const feeBps = getDynamicFeeBps(getCachedVaultHealth());

        if (!spouseId) {
            if (useQueue) {
                const fees = calculateFees(rentWei, feeBps.cityBps, feeBps.platformBps);
                rentFees = { platformFee: fees.platformFee, cityFee: fees.cityFee };
                const job = createOnchainJobUpdate({
                    jobType: 'AGENT_TRANSFER_SBYTE',
                    payload: {
                        fromActorId: actor.id,
                        toActorId: recipientId,
                        amountWei: rentWei.toString(),
                        reason: 'rent',
                        cityId: cityId ?? null,
                    },
                    actorId: actor.id,
                    relatedIntentId: intent.id,
                    relatedTxId: transactionId,
                });
                jobUpdates.push(job.update);
                jobIds.push(job.jobId);
                rentTxHash = null;
            } else {
                const rentTx = await agentTransferService.transfer(
                    actor.id,
                    recipientId,
                    rentWei,
                    'rent',
                    cityId
                );
                rentTxHash = rentTx.txHash;
                rentFees = { platformFee: rentTx.platformFee, cityFee: rentTx.cityFee };
            }
        } else {
            const spouseWallet = await prisma.wallet.findUnique({ where: { actorId: spouseId } });
            const spouseBalance = new Decimal(spouseWallet?.balanceSbyte?.toString() || '0');

            let payA = rentAmount;
            let payB = new Decimal(0);
            if (balance.lessThan(rentAmount)) {
                const half = rentAmount.div(2);
                payA = Decimal.min(half, balance);
                payB = rentAmount.sub(payA);
            }

            if (balance.lessThan(payA) || spouseBalance.lessThan(payB)) {
                return {
                    stateUpdates: [{
                        table: 'property',
                        operation: 'update',
                        where: { id: property.id },
                        data: { missedRentDays: { increment: 1 } }
                    }],
                    events: [{
                        actorId: actor.id,
                        type: EventType.EVENT_RENT_PAID,
                        targetIds: [property.id],
                        outcome: EventOutcome.BLOCKED,
                        sideEffects: { reason: 'Insufficient funds for split rent' }
                    }],
                    intentStatus: IntentStatus.BLOCKED
                };
            }

            if (payA.greaterThan(0)) {
                const payAWei = ethers.parseEther(payA.toString());
                if (useQueue) {
                    const fees = calculateFees(payAWei, feeBps.cityBps, feeBps.platformBps);
                    rentFees = {
                        platformFee: rentFees.platformFee + fees.platformFee,
                        cityFee: rentFees.cityFee + fees.cityFee
                    };
                    const job = createOnchainJobUpdate({
                        jobType: 'AGENT_TRANSFER_SBYTE',
                        payload: {
                            fromActorId: actor.id,
                            toActorId: recipientId,
                            amountWei: payAWei.toString(),
                            reason: 'rent',
                            cityId: cityId ?? null,
                        },
                        actorId: actor.id,
                        relatedIntentId: intent.id,
                        relatedTxId: transactionId,
                    });
                    jobUpdates.push(job.update);
                    jobIds.push(job.jobId);
                    rentTxHash = null;
                } else {
                    const rentTx = await agentTransferService.transfer(
                        actor.id,
                        recipientId,
                        payAWei,
                        'rent',
                        cityId
                    );
                    rentTxHash = rentTx.txHash;
                    rentFees = { platformFee: rentTx.platformFee, cityFee: rentTx.cityFee };
                }
            }

            if (payB.greaterThan(0)) {
                const payBWei = ethers.parseEther(payB.toString());
                if (useQueue) {
                    const fees = calculateFees(payBWei, feeBps.cityBps, feeBps.platformBps);
                    rentFees = {
                        platformFee: rentFees.platformFee + fees.platformFee,
                        cityFee: rentFees.cityFee + fees.cityFee
                    };
                    const job = createOnchainJobUpdate({
                        jobType: 'AGENT_TRANSFER_SBYTE',
                        payload: {
                            fromActorId: spouseId,
                            toActorId: recipientId,
                            amountWei: payBWei.toString(),
                            reason: 'rent',
                            cityId: cityId ?? null,
                        },
                        actorId: spouseId,
                        relatedIntentId: intent.id,
                        relatedTxId: transactionId,
                    });
                    jobUpdates.push(job.update);
                    jobIds.push(job.jobId);
                    spouseTxHash = null;
                } else {
                    const spouseTx = await agentTransferService.transfer(
                        spouseId,
                        recipientId,
                        payBWei,
                        'rent',
                        cityId
                    );
                    spouseTxHash = spouseTx.txHash;
                    if (!rentTxHash) {
                        rentTxHash = spouseTx.txHash;
                    }
                    rentFees = {
                        platformFee: rentFees.platformFee + spouseTx.platformFee,
                        cityFee: rentFees.cityFee + spouseTx.cityFee
                    };
                }
            }
        }

    } catch (e: any) {
        return fail(actor.id, EventType.EVENT_RENT_PAID, `Transfer failed: ${e.message}`);
    }

    // Transfers handled by service. Only return stateUpdates for side effects (none for rent payment other than logging?)
    // Actually, rent payment doesn't change property state (it just keeps valid).
    // If we were paying to MOVE IN, we would update property.tenantId.
    // This handler seems to be "Recurring Rent Payment".

    const feePlatformAmount = new Decimal(ethers.formatEther(rentFees.platformFee));
    const feeCityAmount = new Decimal(ethers.formatEther(rentFees.cityFee));

    const intentStatus = useQueue ? IntentStatus.QUEUED : IntentStatus.EXECUTED;
    return {
        stateUpdates: [
        {
            table: 'property',
            operation: 'update',
            where: { id: property.id },
            data: {
                missedRentDays: 0,
                totalRentCollected: { increment: rentAmount.toNumber() },
                tenantSince: property.tenantSince ?? tick
            }
        },
        {
            table: 'transaction',
            operation: 'create',
            data: {
                id: transactionId,
                fromActorId: actor.id,
                toActorId: property.ownerId || null,
                amount: rentAmount.toNumber(),
                feePlatform: feePlatformAmount.toNumber(),
                feeCity: feeCityAmount.toNumber(),
                cityId: property.cityId,
                tick,
                reason: 'RENT_PAYMENT',
                onchainTxHash: rentTxHash,
                metadata: {
                    propertyId: property.id,
                    rentAmount: rentAmount.toNumber(),
                    splitWith: spouseId,
                    splitTxHash: spouseTxHash,
                    platformFee: feePlatformAmount.toNumber(),
                    cityFee: feeCityAmount.toNumber(),
                    onchainTxHash: rentTxHash,
                    onchainJobIds: jobIds
                }
            }
        },
        {
            table: 'actor',
            operation: 'update',
            where: { id: actor.id },
            data: { reputation: { increment: 0.5 } }
        },
        {
            table: 'agentState',
            operation: 'update',
            where: { actorId: actor.id },
            data: { reputationScore: { increment: 0.5 } }
        },
        ...(property.ownerId ? [{
            table: 'actor',
            operation: 'update',
            where: { id: property.ownerId },
            data: { reputation: { increment: 0.5 } }
        }, {
            table: 'agentState',
            operation: 'update',
            where: { actorId: property.ownerId },
            data: { reputationScore: { increment: 0.5 } }
        }] : [])
        ].concat(jobUpdates),
        events: [
            {
                actorId: actor.id,
                type: EventType.EVENT_REPUTATION_UPDATED,
                targetIds: [],
                outcome: EventOutcome.SUCCESS,
                sideEffects: { delta: 0.5, reason: 'rent_paid' }
            },
            ...(property.ownerId ? [{
                actorId: property.ownerId,
                type: EventType.EVENT_REPUTATION_UPDATED,
                targetIds: [],
                outcome: EventOutcome.SUCCESS,
                sideEffects: { delta: 0.5, reason: 'rent_collected' }
            }] : []),
            {
            actorId: actor.id,
            type: EventType.EVENT_RENT_PAID,
            targetIds: [property.id],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                amount: rentAmount.toString(),
                propertyId: property.id,
                ownerId: property.ownerId,
                queued: useQueue
            }
        }],
        intentStatus
    };
};

import { ethers } from 'ethers';

export const handleBuyItem: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    if (!wallet) return fail(actor.id, EventType.EVENT_ITEM_BOUGHT, 'Missing wallet');

    const params = intent.params as { listingId?: string, quantity?: number };
    if (!params?.listingId) return fail(actor.id, EventType.EVENT_ITEM_BOUGHT, 'Missing listingId');

    const quantity = params.quantity || 1;
    if (quantity <= 0) return fail(actor.id, EventType.EVENT_ITEM_BOUGHT, 'Invalid quantity');

    const listing = await prisma.marketListing.findUnique({
        where: { id: params.listingId },
        include: { itemDef: true }
    });

    if (!listing) {
        console.error(`handleBuyItem: listingId ${params.listingId} not found`, params);
        return fail(actor.id, EventType.EVENT_ITEM_BOUGHT, 'Listing not found');
    }
    if (listing.status !== 'active') return fail(actor.id, EventType.EVENT_ITEM_BOUGHT, 'Listing not active');
    if (listing.quantity < quantity) return fail(actor.id, EventType.EVENT_ITEM_BOUGHT, 'Insufficient listing quantity');
    if (listing.sellerId === actor.id) return fail(actor.id, EventType.EVENT_ITEM_BOUGHT, 'Cannot buy own listing');

    const priceEach = new Decimal(listing.priceEach.toString());
    debugLog('economy.handle_buy_item', {
        actorId: actor.id,
        tick,
        listingId: listing.id,
        itemName: listing.itemDef?.name ?? 'Unknown',
        quantity,
        priceEach: priceEach.toString(),
        sellerId: listing.sellerId,
    });
    if (priceEach.lessThanOrEqualTo(0)) {
        console.error(`handleBuyItem: zero-price listing ${listing.id}`);
        try {
            await prisma.marketListing.update({
                where: { id: listing.id },
                data: { status: 'cancelled' }
            });
        } catch (error) {
            console.error(`handleBuyItem: failed to cancel zero-price listing ${listing.id}`, error);
        }
        return fail(actor.id, EventType.EVENT_ITEM_BOUGHT, 'Invalid listing price');
    }
    const totalCost = priceEach.mul(quantity);
    if (totalCost.lessThanOrEqualTo(0)) {
        try {
            await prisma.marketListing.update({
                where: { id: listing.id },
                data: { status: 'cancelled' }
            });
        } catch (error) {
            console.error(`handleBuyItem: failed to cancel invalid-total listing ${listing.id}`, error);
        }
        return fail(actor.id, EventType.EVENT_ITEM_BOUGHT, 'Invalid purchase total');
    }
    const balance = new Decimal(wallet.balanceSbyte.toString());
    let marketTxUpdate: StateUpdate | null = null;
    let citySaleSplit: { platformShare: Decimal; cityShare: Decimal } | null = null;
    const useQueue = process.env.ENABLE_ONCHAIN_QUEUE === 'true';
    const jobUpdates: StateUpdate[] = [];
    const jobIds: string[] = [];
    const transactionId = crypto.randomUUID();

    if (balance.lessThan(totalCost)) return fail(actor.id, EventType.EVENT_ITEM_BOUGHT, 'Insufficient funds');

    // Taxes
    let taxRate = new Decimal(0.03); // Default
    if (agentState?.cityId) {
        const policy = await prisma.cityPolicy.findUnique({ where: { cityId: agentState.cityId } });
        if (policy) taxRate = new Decimal(policy.tradeTaxRate.toString());
    }

    const taxAmount = totalCost.mul(taxRate); // Informational here, service handles transfer
    const sellerRevenue = totalCost.minus(taxAmount);

    try {
        const sellerActor = await prisma.actor.findUnique({
            where: { id: listing.sellerId },
            select: { isGod: true }
        });
        const isCityGenesisSale = !!sellerActor?.isGod;

        if (isCityGenesisSale) {
            const platformShare = totalCost.mul(0.25);
            const cityShare = totalCost.minus(platformShare);
            citySaleSplit = { platformShare, cityShare };
            const cityShareWei = ethers.parseEther(cityShare.toString());
            const platformShareWei = ethers.parseEther(platformShare.toString());

            let mainTxHash = '0x' + Math.random().toString(16).slice(2).padStart(64, '0');
            let feeTxHash = '0x' + Math.random().toString(16).slice(2).padStart(64, '0');
            let blockNumber = 0n;

            if (useQueue) {
                const mainJob = createOnchainJobUpdate({
                    jobType: 'RAW_SBYTE_TRANSFER',
                    payload: {
                        fromActorId: actor.id,
                        toActorId: listing.sellerId,
                        toAddress: CONTRACTS.PUBLIC_VAULT_AND_GOD,
                        amountWei: cityShareWei.toString(),
                        txType: 'MARKET_PURCHASE',
                        platformFee: platformShare.toString(),
                        cityFee: cityShare.toString(),
                        cityId: listing.cityId || agentState?.cityId || null,
                    },
                    actorId: actor.id,
                    relatedIntentId: intent.id,
                    relatedTxId: transactionId,
                });
                jobUpdates.push(mainJob.update);
                jobIds.push(mainJob.jobId);
                mainTxHash = null;

                if (platformShareWei > 0n) {
                    const feeJob = createOnchainJobUpdate({
                        jobType: 'RAW_SBYTE_TRANSFER',
                        payload: {
                            fromActorId: actor.id,
                            toActorId: null,
                            toAddress: CONTRACTS.PLATFORM_FEE_VAULT,
                            amountWei: platformShareWei.toString(),
                            txType: 'PLATFORM_FEE',
                            platformFee: platformShare.toString(),
                            cityFee: '0',
                            cityId: listing.cityId || agentState?.cityId || null,
                        },
                        actorId: actor.id,
                        relatedIntentId: intent.id,
                        relatedTxId: transactionId,
                    });
                    jobUpdates.push(feeJob.update);
                    jobIds.push(feeJob.jobId);
                    feeTxHash = null;
                }
            } else {
                if (process.env.SKIP_ONCHAIN_EXECUTION !== 'true') {
                    const walletService = new WalletService();
                    const signer = await walletService.getSignerWallet(actor.id);
                    const sbyteContract = new ethers.Contract(CONTRACTS.SBYTE_TOKEN, ['function transfer(address to, uint256 amount) returns (bool)'], signer);

                    const mainTx = await withRpcRetry(
                        () => sbyteContract.transfer(CONTRACTS.PUBLIC_VAULT_AND_GOD, cityShareWei),
                        'marketGenesisTransfer'
                    );
                    const mainReceipt = await withRpcRetry(() => mainTx.wait(), 'marketGenesisWait');
                    assertReceiptSuccess(mainReceipt, 'marketGenesisMain');
                    mainTxHash = mainTx.hash;
                    blockNumber = BigInt(mainReceipt?.blockNumber || 0);

                    if (platformShareWei > 0n) {
                        const feeTx = await withRpcRetry(
                            () => sbyteContract.transfer(CONTRACTS.PLATFORM_FEE_VAULT, platformShareWei),
                            'marketGenesisPlatformTransfer'
                        );
                        const feeReceipt = await withRpcRetry(() => feeTx.wait(), 'marketGenesisPlatformWait');
                        assertReceiptSuccess(feeReceipt, 'marketGenesisPlatform');
                        feeTxHash = feeTx.hash;
                    }
                }

                await prisma.onchainTransaction.create({
                    data: {
                        txHash: mainTxHash,
                        blockNumber: BigInt(blockNumber),
                        fromAddress: (await prisma.agentWallet.findUnique({ where: { actorId: actor.id } }))?.walletAddress || '',
                        toAddress: CONTRACTS.PUBLIC_VAULT_AND_GOD,
                        tokenAddress: CONTRACTS.SBYTE_TOKEN,
                        amount: cityShare.toString(),
                        fromActorId: actor.id,
                        toActorId: listing.sellerId,
                        txType: 'MARKET_PURCHASE',
                        platformFee: platformShare.toString(),
                        cityFee: cityShare.toString(),
                        cityId: listing.cityId || agentState?.cityId || null,
                        status: 'confirmed',
                        confirmedAt: new Date(),
                    }
                });

                if (platformShareWei > 0n) {
                    await prisma.onchainTransaction.create({
                        data: {
                            txHash: feeTxHash,
                            blockNumber: BigInt(blockNumber),
                            fromAddress: (await prisma.agentWallet.findUnique({ where: { actorId: actor.id } }))?.walletAddress || '',
                            toAddress: CONTRACTS.PLATFORM_FEE_VAULT,
                            tokenAddress: CONTRACTS.SBYTE_TOKEN,
                            amount: platformShare.toString(),
                            fromActorId: actor.id,
                            toActorId: null,
                            txType: 'PLATFORM_FEE',
                            platformFee: platformShare.toString(),
                            cityFee: '0',
                            cityId: listing.cityId || agentState?.cityId || null,
                            status: 'confirmed',
                            confirmedAt: new Date(),
                        }
                    });
                }
            }

            marketTxUpdate = {
                table: 'transaction',
                operation: 'create',
                data: {
                    id: transactionId,
                    fromActorId: actor.id,
                    toActorId: listing.sellerId,
                    amount: totalCost.toNumber(),
                    feePlatform: platformShare.toNumber(),
                    feeCity: cityShare.toNumber(),
                    cityId: listing.cityId || agentState?.cityId || null,
                    tick,
                    reason: 'MARKET_PURCHASE',
                    onchainTxHash: mainTxHash,
                    metadata: {
                        listingId: listing.id,
                        itemDefId: listing.itemDefId,
                        quantity,
                        totalCost: totalCost.toNumber(),
                        platformShare: platformShare.toNumber(),
                        cityShare: cityShare.toNumber(),
                        onchainTxHash: mainTxHash,
                        platformFeeTxHash: platformShareWei > 0n ? feeTxHash : null,
                        onchainJobIds: jobIds
                    }
                }
            };
        } else {
            // Execute On-Chain Transfer
            // For Market Buy, we transfer FROM Buyer TO Seller.
            // AgentTransferService handles fees automatically via config.
            // AgentTransferService takes `cityId` and fetches `cityFeeBps` from policy.
            const costWei = ethers.parseEther(totalCost.toString());
            const cityId = listing.cityId || agentState.cityId;
            const feeBps = getDynamicFeeBps(getCachedVaultHealth());
            if (useQueue) {
                const fees = calculateFees(costWei, feeBps.cityBps, feeBps.platformBps);
                const feePlatformAmount = new Decimal(ethers.formatEther(fees.platformFee));
                const feeCityAmount = new Decimal(ethers.formatEther(fees.cityFee));
                const job = createOnchainJobUpdate({
                    jobType: 'AGENT_TRANSFER_SBYTE',
                    payload: {
                        fromActorId: actor.id,
                        toActorId: listing.sellerId,
                        amountWei: costWei.toString(),
                        reason: 'market',
                        cityId: cityId ?? null,
                    },
                    actorId: actor.id,
                    relatedIntentId: intent.id,
                    relatedTxId: transactionId,
                });
                jobUpdates.push(job.update);
                jobIds.push(job.jobId);
                marketTxUpdate = {
                    table: 'transaction',
                    operation: 'create',
                    data: {
                        id: transactionId,
                        fromActorId: actor.id,
                        toActorId: listing.sellerId,
                        amount: totalCost.toNumber(),
                        feePlatform: feePlatformAmount.toNumber(),
                        feeCity: feeCityAmount.toNumber(),
                        cityId: listing.cityId || agentState?.cityId || null,
                        tick,
                        reason: 'MARKET_PURCHASE',
                        onchainTxHash: null,
                        metadata: {
                            listingId: listing.id,
                            itemDefId: listing.itemDefId,
                            quantity,
                            totalCost: totalCost.toNumber(),
                            platformFee: feePlatformAmount.toNumber(),
                            cityFee: feeCityAmount.toNumber(),
                            onchainJobIds: jobIds
                        }
                    }
                };
            } else {
                const marketTx = await agentTransferService.transfer(
                    actor.id,
                    listing.sellerId,
                    costWei,
                    'market',
                    cityId
                );
                const feePlatformAmount = new Decimal(ethers.formatEther(marketTx.platformFee));
                const feeCityAmount = new Decimal(ethers.formatEther(marketTx.cityFee));
                marketTxUpdate = {
                    table: 'transaction',
                    operation: 'create',
                    data: {
                        id: transactionId,
                        fromActorId: actor.id,
                        toActorId: listing.sellerId,
                        amount: totalCost.toNumber(),
                        feePlatform: feePlatformAmount.toNumber(),
                        feeCity: feeCityAmount.toNumber(),
                        cityId: listing.cityId || agentState?.cityId || null,
                        tick,
                        reason: 'MARKET_PURCHASE',
                        onchainTxHash: marketTx.txHash,
                        metadata: {
                            listingId: listing.id,
                            itemDefId: listing.itemDefId,
                            quantity,
                            totalCost: totalCost.toNumber(),
                            platformFee: feePlatformAmount.toNumber(),
                            cityFee: feeCityAmount.toNumber(),
                            onchainTxHash: marketTx.txHash
                        }
                    }
                };
            }
        }
    } catch (e: any) {
        return fail(actor.id, EventType.EVENT_ITEM_BOUGHT, `Transfer failed: ${e.message}`);
    }

    // Transfers done. Only non-monetary updates here.
    const stateUpdates: StateUpdate[] = [
        // Update Listing
        {
            table: 'marketListing',
            operation: 'update',
            where: { id: listing.id },
            data: {
                quantity: listing.quantity - quantity,
                status: listing.quantity - quantity === 0 ? 'sold' : 'active'
            }
        }
    ];

    if (citySaleSplit) {
        const cityIdForVault = listing.cityId || agentState?.cityId || null;
        if (cityIdForVault) {
            stateUpdates.push({
                table: 'cityVault',
                operation: 'update',
                where: { cityId: cityIdForVault },
                data: { balanceSbyte: { increment: citySaleSplit.cityShare.toNumber() } }
            });
        }
        stateUpdates.push({
            table: 'platformVault',
            operation: 'update',
            where: { id: 1 },
            data: { balanceSbyte: { increment: citySaleSplit.platformShare.toNumber() } }
        });
    }

    // Add item to Buyer Inventory
    const existingItem = await prisma.inventoryItem.findUnique({
        where: { actorId_itemDefId: { actorId: actor.id, itemDefId: listing.itemDefId } }
    });

    if (existingItem) {
        stateUpdates.push({
            table: 'inventoryItem',
            operation: 'update',
            where: { id: existingItem.id },
            data: { quantity: { increment: quantity } }
        });
    } else {
        stateUpdates.push({
            table: 'inventoryItem',
            operation: 'create',
            data: {
                actorId: actor.id,
                itemDefId: listing.itemDefId,
                quantity: quantity,
                quality: 50
            }
        });
    }

    if (marketTxUpdate) {
        stateUpdates.push(marketTxUpdate);
    }
    if (jobUpdates.length > 0) {
        stateUpdates.push(...jobUpdates);
    }

    const intentStatus = useQueue ? IntentStatus.QUEUED : IntentStatus.EXECUTED;
    return {
        stateUpdates,
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_ITEM_BOUGHT,
            targetIds: [listing.id, listing.itemDefId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                listingId: listing.id,
                itemDefId: listing.itemDefId,
                itemName: listing.itemDef.name,
                quantity,
                price: totalCost.toString(),
                totalCost: totalCost.toString(),
                sellerId: listing.sellerId,
                queued: useQueue
            }
        }, {
            actorId: listing.sellerId,
            type: EventType.EVENT_TRADE_COMPLETED,
            targetIds: [actor.id],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                type: 'sale',
                revenue: sellerRevenue.toString(), // Estimate
                listingId: listing.id,
                itemDefId: listing.itemDefId,
                itemName: listing.itemDef.name,
                quantity,
                queued: useQueue
            }
        }],
        intentStatus
    };
};

export const handleBuyFromStore: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    if (!wallet) return fail(actor.id, EventType.EVENT_ITEM_BOUGHT, 'Missing wallet');
    if (!agentState?.cityId) return fail(actor.id, EventType.EVENT_ITEM_BOUGHT, 'Missing city');

    const params = intent.params as { businessId?: string; itemType?: string; quantity?: number };
    if (!params?.businessId) return fail(actor.id, EventType.EVENT_ITEM_BOUGHT, 'Missing businessId');

    const store = await prisma.business.findUnique({ where: { id: params.businessId } });
    if (!store || store.status !== 'ACTIVE' || !store.isOpen) {
        return fail(actor.id, EventType.EVENT_ITEM_BOUGHT, 'Store not found or inactive');
    }
    if (store.businessType !== 'STORE') {
        return fail(actor.id, EventType.EVENT_ITEM_BOUGHT, 'Not a store');
    }
    if (store.cityId !== agentState.cityId) {
        return fail(actor.id, EventType.EVENT_ITEM_BOUGHT, 'Store not in same city');
    }

    const STORE_ITEMS: Record<string, { price: number; hungerGain: number; itemName: string }> = {
        CONS_RATION: { price: 15, hungerGain: 35, itemName: 'CONS_RATION' },
        CONS_MEAL: { price: 30, hungerGain: 50, itemName: 'CONS_MEAL' },
        CONS_ENERGY_DRINK: { price: 20, hungerGain: 0, itemName: 'CONS_ENERGY_DRINK' },
        CONS_MEDKIT: { price: 50, hungerGain: 0, itemName: 'CONS_MEDKIT' },
    };

    const itemType = params.itemType ?? 'CONS_RATION';
    let product = STORE_ITEMS[itemType];
    let fallbackItemDef: { id: string; name: string; baseValue: any; category: string } | null = null;
    if (!product) {
        const itemDef = await prisma.itemDefinition.findFirst({ where: { name: itemType } });
        if (!itemDef || !['material', 'consumable'].includes(itemDef.category)) {
            return fail(actor.id, EventType.EVENT_ITEM_BOUGHT, 'Unknown item type');
        }
        const price = Math.max(1, Number(itemDef.baseValue ?? 1));
        if (!Number.isFinite(price)) {
            return fail(actor.id, EventType.EVENT_ITEM_BOUGHT, 'Invalid item price');
        }
        fallbackItemDef = itemDef;
        product = { price, hungerGain: 0, itemName: itemDef.name };
    }

    const quantity = Number(params.quantity ?? 1);
    if (!Number.isFinite(quantity) || quantity <= 0) {
        return fail(actor.id, EventType.EVENT_ITEM_BOUGHT, 'Invalid quantity');
    }

    const priceEach = new Decimal(product.price);
    const totalPrice = priceEach.mul(quantity);
    if (totalPrice.lessThanOrEqualTo(0)) {
        return fail(actor.id, EventType.EVENT_ITEM_BOUGHT, 'Invalid price');
    }
    const balance = new Decimal(wallet.balanceSbyte.toString());
    if (balance.lessThan(totalPrice)) {
        return fail(actor.id, EventType.EVENT_ITEM_BOUGHT, 'Insufficient funds');
    }
    const useQueue = process.env.ENABLE_ONCHAIN_QUEUE === 'true';
    const jobUpdates: StateUpdate[] = [];
    const jobIds: string[] = [];
    const transactionId = crypto.randomUUID();
    debugLog('economy.store_purchase_attempt', {
        actorId: actor.id,
        tick,
        businessId: params.businessId,
        itemType,
        quantity,
        totalPrice: totalPrice.toString(),
        balance: balance.toString(),
    });

    const itemDef = fallbackItemDef ?? await prisma.itemDefinition.findFirst({
        where: { name: product.itemName }
    });
    if (!itemDef) return fail(actor.id, EventType.EVENT_ITEM_BOUGHT, 'Item definition missing');

    const businessWallet = await prisma.businessWallet.findUnique({ where: { businessId: store.id } });
    const isPublicMarket = Boolean((store.config as any)?.publicMarket);
    const priceWei = ethers.parseEther(totalPrice.toString());
    let txHash = '';
    let netAmount = totalPrice;
    let feePlatform = new Decimal(0);
    let feeCity = new Decimal(0);
    try {
        if (useQueue) {
            const feeBps = getDynamicFeeBps(getCachedVaultHealth());
            const fees = calculateFees(priceWei, feeBps.cityBps, feeBps.platformBps);
            netAmount = new Decimal(ethers.formatEther(fees.netAmount));
            feePlatform = new Decimal(ethers.formatEther(fees.platformFee));
            feeCity = new Decimal(ethers.formatEther(fees.cityFee));
            const job = createOnchainJobUpdate({
                jobType: 'AGENT_TRANSFER_SBYTE',
                payload: {
                    fromActorId: actor.id,
                    toActorId: store.ownerId,
                    amountWei: priceWei.toString(),
                    reason: 'business',
                    cityId: store.cityId,
                    toAddressOverride: businessWallet?.walletAddress ?? null,
                },
                actorId: actor.id,
                relatedIntentId: intent.id,
                relatedTxId: transactionId,
            });
            jobUpdates.push(job.update);
            jobIds.push(job.jobId);
            txHash = '';
        } else {
            const storeTx = await agentTransferService.transfer(
                actor.id,
                store.ownerId,
                priceWei,
                'business',
                store.cityId,
                businessWallet?.walletAddress
            );
            txHash = storeTx.txHash;
            netAmount = new Decimal(ethers.formatEther(storeTx.netAmount));
            feePlatform = new Decimal(ethers.formatEther(storeTx.platformFee));
            feeCity = new Decimal(ethers.formatEther(storeTx.cityFee));
        }
    } catch (e: any) {
        return fail(actor.id, EventType.EVENT_ITEM_BOUGHT, `Transfer failed: ${e.message}`);
    }

    const stateUpdates: StateUpdate[] = [];
    const existing = await prisma.inventoryItem.findUnique({
        where: { actorId_itemDefId: { actorId: actor.id, itemDefId: itemDef.id } }
    });
    if (existing) {
        stateUpdates.push({
            table: 'inventoryItem',
            operation: 'update',
            where: { id: existing.id },
            data: { quantity: { increment: quantity } }
        });
    } else {
        stateUpdates.push({
            table: 'inventoryItem',
            operation: 'create',
            data: { actorId: actor.id, itemDefId: itemDef.id, quantity, quality: 50 }
        });
    }

    if (isPublicMarket) {
        stateUpdates.push({
            table: 'cityVault',
            operation: 'update',
            where: { cityId: store.cityId },
            data: { balanceSbyte: { increment: netAmount.toNumber() } }
        });
        stateUpdates.push({
            table: 'business',
            operation: 'update',
            where: { id: store.id },
            data: { customerVisitsToday: { increment: 1 } }
        });
    } else {
        stateUpdates.push({
            table: 'business',
            operation: 'update',
            where: { id: store.id },
            data: { treasury: { increment: netAmount.toNumber() }, customerVisitsToday: { increment: 1 } }
        });
        if (businessWallet) {
            stateUpdates.push({
                table: 'businessWallet',
                operation: 'update',
                where: { businessId: store.id },
                data: { balanceSbyte: { increment: netAmount.toNumber() } }
            });
        }
    }
    stateUpdates.push({
        table: 'transaction',
        operation: 'create',
        data: {
            id: transactionId,
            fromActorId: actor.id,
            toActorId: store.ownerId,
            amount: totalPrice.toNumber(),
            feePlatform: feePlatform.toNumber(),
            feeCity: feeCity.toNumber(),
            cityId: store.cityId,
            tick,
            reason: 'STORE_PURCHASE',
            onchainTxHash: txHash,
            metadata: {
                businessId: store.id,
                itemName: itemDef.name,
                itemType,
                quantity,
                totalPrice: totalPrice.toNumber(),
                onchainTxHash: txHash,
                onchainJobIds: jobIds
            }
        }
    });
    if (jobUpdates.length > 0) {
        stateUpdates.push(...jobUpdates);
    }

    const intentStatus = useQueue ? IntentStatus.QUEUED : IntentStatus.EXECUTED;
    return {
        stateUpdates,
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_ITEM_BOUGHT,
            targetIds: [store.id, itemDef.id],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                businessId: store.id,
                itemType,
                itemName: itemDef.name,
                quantity,
                price: totalPrice.toString(),
                totalCost: totalPrice.toString(),
                hungerGain: product.hungerGain * quantity,
                onChain: true,
                queued: useQueue
            }
        }],
        intentStatus
    };
};

export const handleListItem: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    const params = intent.params as { itemDefId?: string, quantity?: number, price?: number };
    if (!params?.itemDefId || params.quantity === undefined || params.price === undefined) {
        return fail(actor.id, EventType.EVENT_LISTING_CREATED, 'Missing params');
    }
    if (params.quantity <= 0) {
        return fail(actor.id, EventType.EVENT_LISTING_CREATED, 'Invalid quantity');
    }
    if (params.price <= 0) {
        return fail(actor.id, EventType.EVENT_LISTING_CREATED, 'Invalid price');
    }

    if (!agentState?.cityId) return fail(actor.id, EventType.EVENT_LISTING_CREATED, 'Must be in a city to list');

    // Check inventory
    const item = await prisma.inventoryItem.findUnique({
        where: { actorId_itemDefId: { actorId: actor.id, itemDefId: params.itemDefId } }
    });

    if (!item || item.quantity < params.quantity) {
        return fail(actor.id, EventType.EVENT_LISTING_CREATED, 'Insufficient inventory');
    }

    const stateUpdates: StateUpdate[] = [
        // Decrement inventory
        {
            table: 'inventoryItem',
            operation: 'update',
            where: { id: item.id },
            data: { quantity: { decrement: params.quantity } }
        },
        // Create Listing
        {
            table: 'marketListing',
            operation: 'create',
            data: {
                sellerId: actor.id,
                itemDefId: params.itemDefId,
                quantity: params.quantity,
                priceEach: new Decimal(params.price),
                cityId: agentState.cityId,
                status: 'active'
            }
        }
    ];

    const itemDef = await prisma.itemDefinition.findUnique({
        where: { id: params.itemDefId },
        select: { id: true, name: true }
    });

    return {
        stateUpdates,
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_LISTING_CREATED,
            targetIds: [params.itemDefId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                itemDefId: params.itemDefId,
                itemName: itemDef?.name ?? null,
                quantity: params.quantity,
                price: params.price
            }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleTrade: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    const params = intent.params as { targetId?: string; amount?: number; reason?: string };
    const amount = Number(params?.amount ?? 0);
    const suspicious = amount > 0;
    const reputationPenalty = suspicious ? -20 : 0;

    const stateUpdates: StateUpdate[] = [];
    const events: any[] = [];

    if (reputationPenalty !== 0) {
        stateUpdates.push({
            table: 'actor',
            operation: 'update',
            where: { id: actor.id },
            data: { reputation: { increment: reputationPenalty } }
        });
        stateUpdates.push({
            table: 'agentState',
            operation: 'update',
            where: { actorId: actor.id },
            data: { reputationScore: { increment: reputationPenalty } }
        });
        events.push({
            actorId: actor.id,
            type: EventType.EVENT_REPUTATION_UPDATED,
            targetIds: [],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { delta: reputationPenalty, reason: 'scam_attempt' }
        });
    }

    events.push({
        actorId: actor.id,
        type: EventType.EVENT_TRADE_COMPLETED,
        targetIds: params?.targetId ? [params.targetId] : [],
        outcome: EventOutcome.BLOCKED,
        sideEffects: { reason: 'Direct trade not implemented. Use Market.' }
    });

    return {
        stateUpdates,
        events,
        intentStatus: IntentStatus.BLOCKED
    };
};

export const handleChangeHousing: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    const params = intent.params as { propertyId?: string };
    if (!params?.propertyId) return fail(actor.id, EventType.EVENT_HOUSING_CHANGED, 'Missing propertyId');
    const useQueue = process.env.ENABLE_ONCHAIN_QUEUE === 'true';
    const jobUpdates: StateUpdate[] = [];
    const jobIds: string[] = [];
    const transactionId = crypto.randomUUID();
    const MOVE_COOLDOWN_TICKS = 5;

    const targetProp = await prisma.property.findUnique({
        where: { id: params.propertyId }
    });

    if (!targetProp) return fail(actor.id, EventType.EVENT_HOUSING_CHANGED, 'Property not found');
    if (targetProp.isEmptyLot) {
        return fail(actor.id, EventType.EVENT_HOUSING_CHANGED, 'Cannot move into an empty lot');
    }
    const lastHousingChangeTick = await getLastHousingChangeTick(actor.id);
    if (lastHousingChangeTick !== null && tick - lastHousingChangeTick < MOVE_COOLDOWN_TICKS) {
        return fail(actor.id, EventType.EVENT_HOUSING_CHANGED, 'Housing move cooldown active');
    }
    const isSelfOwned = targetProp.ownerId === actor.id;
    const isCityOwnedRental = !targetProp.ownerId && !targetProp.isEmptyLot && Number(targetProp.rentPrice ?? 0) > 0;
    if (!isSelfOwned && !targetProp.forRent) {
        if (!isCityOwnedRental) {
            return fail(actor.id, EventType.EVENT_HOUSING_CHANGED, 'Property not for rent');
        }
    }
    if (targetProp.tenantId && targetProp.tenantId !== actor.id) {
        return fail(actor.id, EventType.EVENT_HOUSING_CHANGED, 'Property occupied');
    }

    let rent: Decimal | null = null;
    let feePlatformAmount = new Decimal(0);
    let feeCityAmount = new Decimal(0);
    let moveInTxHash: string | null = null;

    if (!isSelfOwned) {
        // Check affordability (1st month rent)
        rent = new Decimal(targetProp.rentPrice.toString());
        const balance = new Decimal(wallet?.balanceSbyte.toString() || '0');
        const rentWei = ethers.parseEther(rent.toString());

        if (balance.lessThan(rent)) return fail(actor.id, EventType.EVENT_HOUSING_CHANGED, 'Cannot afford move-in cost');

        let moveInFees = { platformFee: 0n, cityFee: 0n };
        try {
            // Execute on-chain transfer
            let recipientId: string;
            let cityId: string | undefined;

            if (targetProp.ownerId) {
                recipientId = targetProp.ownerId;
            } else {
                const god = await prisma.actor.findFirst({ where: { isGod: true } });
                if (!god) return fail(actor.id, EventType.EVENT_HOUSING_CHANGED, 'System offline (God missing)');
                recipientId = god.id;
                cityId = targetProp.cityId;
            }

            if (useQueue) {
                const feeBps = getDynamicFeeBps(getCachedVaultHealth());
                const fees = calculateFees(rentWei, feeBps.cityBps, feeBps.platformBps);
                moveInFees = { platformFee: fees.platformFee, cityFee: fees.cityFee };
                const job = createOnchainJobUpdate({
                    jobType: 'AGENT_TRANSFER_SBYTE',
                    payload: {
                        fromActorId: actor.id,
                        toActorId: recipientId,
                        amountWei: rentWei.toString(),
                        reason: 'rent',
                        cityId: cityId ?? null,
                    },
                    actorId: actor.id,
                    relatedIntentId: intent.id,
                    relatedTxId: transactionId,
                });
                jobUpdates.push(job.update);
                jobIds.push(job.jobId);
                moveInTxHash = null;
            } else {
                const rentTx = await agentTransferService.transfer(
                    actor.id,
                    recipientId,
                    rentWei,
                    'rent', // 'rent' or 'household'
                    cityId
                );
                moveInTxHash = rentTx.txHash;
                moveInFees = { platformFee: rentTx.platformFee, cityFee: rentTx.cityFee };
            }
        } catch (e: any) {
            return fail(actor.id, EventType.EVENT_HOUSING_CHANGED, `Transfer failed: ${e.message}`);
        }

        feePlatformAmount = new Decimal(ethers.formatEther(moveInFees.platformFee));
        feeCityAmount = new Decimal(ethers.formatEther(moveInFees.cityFee));
    }

    const stateUpdates: StateUpdate[] = [
        // Update Property
        {
            table: 'property',
            operation: 'update',
            where: { id: targetProp.id },
            data: {
                tenantId: actor.id,
                forRent: false,
                tenantSince: tick
            }
        },
        // Update Agent State
        {
            table: 'agentState',
            operation: 'update',
            where: { actorId: actor.id },
            data: { housingTier: targetProp.housingTier }
        }
    ];
    if (!isSelfOwned && rent) {
        stateUpdates.push({
            table: 'transaction',
            operation: 'create',
            data: {
                id: transactionId,
                fromActorId: actor.id,
                toActorId: targetProp.ownerId || null,
                amount: rent.toNumber(),
                feePlatform: feePlatformAmount.toNumber(),
                feeCity: feeCityAmount.toNumber(),
                cityId: targetProp.cityId,
                tick,
                reason: 'MOVE_IN_RENT',
                onchainTxHash: moveInTxHash,
                metadata: {
                    propertyId: targetProp.id,
                    rentAmount: rent.toNumber(),
                    platformFee: feePlatformAmount.toNumber(),
                    cityFee: feeCityAmount.toNumber(),
                    onchainTxHash: moveInTxHash,
                    onchainJobIds: jobIds
                }
            }
        });
    }

    // Leave old property if any
    const oldProp = await prisma.property.findFirst({
        where: { tenantId: actor.id, id: { not: targetProp.id } }
    });

    if (oldProp) {
        stateUpdates.push({
            table: 'property',
            operation: 'update',
            where: { id: oldProp.id },
            data: { tenantId: null, forRent: true }
        });
    }

    if (jobUpdates.length > 0) {
        stateUpdates.push(...jobUpdates);
    }

    const intentStatus = useQueue ? IntentStatus.QUEUED : IntentStatus.EXECUTED;
    return {
        stateUpdates,
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_HOUSING_CHANGED,
            targetIds: [targetProp.id],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                fromPropertyId: oldProp?.id || null,
                toPropertyId: targetProp.id,
                cost: rent ? rent.toString() : '0',
                tier: targetProp.housingTier,
                queued: useQueue
            }
        }],
        intentStatus
    };
};

// Helper
function fail(actorId: string, type: EventType, reason: string) {
    return {
        stateUpdates: [],
        events: [{
            actorId,
            type,
            targetIds: [],
            outcome: EventOutcome.BLOCKED,
            sideEffects: { reason }
        }],
        intentStatus: IntentStatus.BLOCKED
    };
}

async function getLastRentPaidTick(actorId: string): Promise<number | null> {
    const lastEvent = await prisma.event.findFirst({
        where: {
            actorId,
            type: EventType.EVENT_RENT_PAID,
            outcome: EventOutcome.SUCCESS,
        },
        orderBy: { tick: 'desc' },
        select: { tick: true }
    });
    return lastEvent?.tick ?? null;
}

async function getLastHousingChangeTick(actorId: string): Promise<number | null> {
    const lastEvent = await prisma.event.findFirst({
        where: {
            actorId,
            type: EventType.EVENT_HOUSING_CHANGED,
            outcome: EventOutcome.SUCCESS,
        },
        orderBy: { tick: 'desc' },
        select: { tick: true }
    });
    return lastEvent?.tick ?? null;
}
