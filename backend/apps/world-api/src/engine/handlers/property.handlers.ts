/**
 * Property Handlers
 * Manages property ownership, buying, selling, and listing
 * 
 * Rules from ResidenceManager.skill.md v2.0:
 * - Genesis properties initially owned by City (ownerId = null)
 * - Platform fee is env-configured (PLATFORM_FEE_BPS)
 * - City-owned genesis sales split 25% platform / 75% city vault
 * - 3 missed rent days → eviction
 * - Property ownership allows collecting rent from tenants
 * - Empty lots can be built upon (future feature)
 */

import { prisma } from '../../db.js';
import { IntentStatus } from '../../types/intent.types.js';
import { FEE_CONFIG } from '../../config/fees.js';
import { EventType, EventOutcome } from '../../types/event.types.js';
import { IntentHandler, StateUpdate } from '../engine.types.js';
import { Decimal } from 'decimal.js';
import { ethers } from 'ethers';
import { WalletService } from '../../services/wallet.service.js';
import { CONTRACTS } from '../../config/contracts.js';
import { GENESIS_SALE_PRICE_BY_TIER } from '../../config/economy.js';
import { propertyRatingService } from '../../services/property-rating.service.js';
import { getLatestSnapshot } from '../../services/economy-snapshot.service.js';
import { withRpcRetry } from '../../utils/rpc-retry.js';
import { assertReceiptSuccess } from '../../utils/onchain.js';

// ============================================================================
// INTENT_BUY_PROPERTY
// ============================================================================

export const handleBuyProperty: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    const params = intent.params as { propertyId?: string; maxPrice?: number; suppressMoveIn?: boolean };

    if (!params?.propertyId) {
        return fail(actor.id, EventType.EVENT_PROPERTY_BOUGHT, 'Missing propertyId');
    }

    // Check frozen state
    if (actor.frozen) {
        return fail(actor.id, EventType.EVENT_PROPERTY_BOUGHT, 'Agent is frozen');
    }

    // Check if agent is WORKING (blocked activity)
    if (agentState?.activityState === 'WORKING') {
        return fail(actor.id, EventType.EVENT_PROPERTY_BOUGHT, 'Cannot buy property while working');
    }

    // Get property
    const property = await prisma.property.findUnique({
        where: { id: params.propertyId },
        include: { city: { include: { vault: true } } }
    });

    if (!property) {
        return fail(actor.id, EventType.EVENT_PROPERTY_BOUGHT, 'Property not found');
    }

    // Check if property is for sale (allow city-owned genesis listings, including empty lots)
    const isCityOwnedListing = !property.ownerId && Number(property.salePrice ?? 0) > 0;
    if (!property.forSale && !isCityOwnedListing) {
        return fail(actor.id, EventType.EVENT_PROPERTY_BOUGHT, 'Property is not for sale');
    }

    // Check if buyer is not already the owner
    if (property.ownerId === actor.id) {
        return fail(actor.id, EventType.EVENT_PROPERTY_BOUGHT, 'Already own this property');
    }

    // Check wallet exists
    if (!wallet) {
        return fail(actor.id, EventType.EVENT_PROPERTY_BOUGHT, 'No wallet');
    }

    // Determine price (use salePrice, or genesis pricing if no owner)
    let price = new Decimal(property.salePrice?.toString() || '0');

    // If price is 0 and no owner (genesis property), use tier-based pricing
    if (price.lessThanOrEqualTo(0) && !property.ownerId) {
        price = getGenesisPriceByTier(property.housingTier);
    }

    if (price.lessThanOrEqualTo(0)) {
        return fail(actor.id, EventType.EVENT_PROPERTY_BOUGHT, 'Invalid property price');
    }

    // Check max price constraint
    if (params.maxPrice && price.greaterThan(params.maxPrice)) {
        return fail(actor.id, EventType.EVENT_PROPERTY_BOUGHT, `Price ${price} exceeds max ${params.maxPrice}`);
    }

    // Check buyer has sufficient funds
    const buyerBalance = new Decimal(wallet.balanceSbyte.toString());
    if (buyerBalance.lessThan(price)) {
        return fail(actor.id, EventType.EVENT_PROPERTY_BOUGHT, 'Insufficient funds');
    }

    const isCityGenesisSale = !property.ownerId;

    // Calculate platform fee (env-configured) or city-sale split
    const platformFeeBps = FEE_CONFIG.PLATFORM_FEE_BPS;
    const platformFee = isCityGenesisSale ? new Decimal(0) : price.mul(platformFeeBps).div(10000);
    const platformShare = isCityGenesisSale ? price.mul(0.25) : platformFee;
    const cityShare = isCityGenesisSale ? price.minus(platformShare) : new Decimal(0);
    const totalCost = isCityGenesisSale ? price : price.add(platformFee);

    if (buyerBalance.lessThan(totalCost)) {
        return fail(actor.id, EventType.EVENT_PROPERTY_BOUGHT, 'Insufficient funds including fees');
    }

    const stateUpdates: StateUpdate[] = [];
    let propertyPurchaseTxHash: string | null = null;
    let platformFeeTxHash: string | null = null;

    if (property.ownerId) {
        // On-chain settlement for agent-to-agent property purchase
        const sellerWallet = await prisma.agentWallet.findUnique({ where: { actorId: property.ownerId } });
        if (!sellerWallet) {
            return fail(actor.id, EventType.EVENT_PROPERTY_BOUGHT, 'Seller wallet missing');
        }
        const skipOnchain = process.env.SKIP_ONCHAIN_EXECUTION === 'true';
        const priceWei = ethers.parseEther(price.toString());
        const platformFeeWei = ethers.parseEther(platformFee.toString());
        let mainTxHash = '0x' + Math.random().toString(16).slice(2).padStart(64, '0');
        let feeTxHash = '0x' + Math.random().toString(16).slice(2).padStart(64, '0');
        let blockNumber = 0n;

        if (!skipOnchain) {
            const walletService = new WalletService();
            const signer = await walletService.getSignerWallet(actor.id);
            const sbyteContract = new ethers.Contract(CONTRACTS.SBYTE_TOKEN, ['function transfer(address to, uint256 amount) returns (bool)'], signer);

            const mainTx = await withRpcRetry(
                () => sbyteContract.transfer(sellerWallet.walletAddress, priceWei),
                'propertyBuySellerTransfer'
            );
            const mainReceipt = await withRpcRetry(() => mainTx.wait(), 'propertyBuySellerWait');
            assertReceiptSuccess(mainReceipt, 'propertyBuySeller');
            mainTxHash = mainTx.hash;
            blockNumber = BigInt(mainReceipt?.blockNumber || 0);

            if (platformFeeWei > 0n) {
                const feeTx = await withRpcRetry(
                    () => sbyteContract.transfer(CONTRACTS.PLATFORM_FEE_VAULT, platformFeeWei),
                    'propertyBuyPlatformTransfer'
                );
                const feeReceipt = await withRpcRetry(() => feeTx.wait(), 'propertyBuyPlatformWait');
                assertReceiptSuccess(feeReceipt, 'propertyBuyPlatform');
                feeTxHash = feeTx.hash;
            }
        }

        propertyPurchaseTxHash = mainTxHash;
        platformFeeTxHash = platformFeeWei > 0n ? feeTxHash : null;

        // Record on-chain txs
        await prisma.onchainTransaction.create({
            data: {
                txHash: mainTxHash,
                blockNumber: BigInt(blockNumber),
                fromAddress: (await prisma.agentWallet.findUnique({ where: { actorId: actor.id } }))?.walletAddress || '',
                toAddress: sellerWallet.walletAddress,
                tokenAddress: CONTRACTS.SBYTE_TOKEN,
                amount: ethers.formatEther(priceWei),
                fromActorId: actor.id,
                toActorId: property.ownerId,
                txType: 'AGENT_TO_AGENT',
                platformFee: platformFee.toString(),
                cityFee: '0',
                cityId: property.cityId,
                status: 'confirmed',
                confirmedAt: new Date(),
            }
        });
        if (platformFeeWei > 0n) {
            await prisma.onchainTransaction.create({
                data: {
                    txHash: feeTxHash,
                    blockNumber: BigInt(blockNumber),
                    fromAddress: (await prisma.agentWallet.findUnique({ where: { actorId: actor.id } }))?.walletAddress || '',
                    toAddress: CONTRACTS.PLATFORM_FEE_VAULT,
                    tokenAddress: CONTRACTS.SBYTE_TOKEN,
                    amount: ethers.formatEther(platformFeeWei),
                    fromActorId: actor.id,
                    toActorId: null,
                    txType: 'PLATFORM_FEE',
                    platformFee: platformFee.toString(),
                    cityFee: '0',
                    cityId: property.cityId,
                    status: 'confirmed',
                    confirmedAt: new Date(),
                }
            });
        }

        // Off-chain ledger alignment
        const newBalance = buyerBalance.minus(totalCost);
        stateUpdates.push(
            {
                table: 'wallet',
                operation: 'update',
                where: { actorId: actor.id },
                data: { balanceSbyte: newBalance.toString() }
            },
            {
                table: 'agentWallet',
                operation: 'update',
                where: { actorId: actor.id },
                data: { balanceSbyte: { decrement: totalCost.toString() } }
            },
            {
                table: 'wallet',
                operation: 'update',
                where: { actorId: property.ownerId },
                data: { balanceSbyte: { increment: price.toNumber() } }
            },
            {
                table: 'agentWallet',
                operation: 'update',
                where: { actorId: property.ownerId },
                data: { balanceSbyte: { increment: price.toNumber() } }
            }
        );
    } else {
        // Deduct from buyer (off-chain ledger) for genesis purchase
        const newBalance = buyerBalance.minus(totalCost);
        stateUpdates.push({
            table: 'wallet',
            operation: 'update',
            where: { actorId: actor.id },
            data: { balanceSbyte: newBalance.toString() }
        });
        // Keep agent_wallets cache aligned for on-chain mode
        stateUpdates.push({
            table: 'agentWallet',
            operation: 'update',
            where: { actorId: actor.id },
            data: { balanceSbyte: { decrement: totalCost.toString() } }
        });

        // Pay to city vault (genesis property) - off-chain ledger (75% split)
        if (property.city?.vault) {
            const vaultBalance = new Decimal(property.city.vault.balanceSbyte.toString());
            const newVaultBalance = vaultBalance.plus(cityShare);
            stateUpdates.push({
                table: 'cityVault',
                operation: 'update',
                where: { cityId: property.cityId },
                data: { balanceSbyte: newVaultBalance.toString() }
            });
        }

        // On-chain settlement for genesis properties (buyer -> PUBLIC_VAULT_AND_GOD + PLATFORM_FEE_VAULT)
        const skipOnchain = process.env.SKIP_ONCHAIN_EXECUTION === 'true';
        const cityShareWei = ethers.parseEther(cityShare.toString());
        const platformShareWei = ethers.parseEther(platformShare.toString());

        let mainTxHash = '0x' + Math.random().toString(16).slice(2).padStart(64, '0');
        let feeTxHash = '0x' + Math.random().toString(16).slice(2).padStart(64, '0');
        let blockNumber = 0n;

        if (!skipOnchain) {
            const walletService = new WalletService();
            const signer = await walletService.getSignerWallet(actor.id);
            const sbyteContract = new ethers.Contract(CONTRACTS.SBYTE_TOKEN, ['function transfer(address to, uint256 amount) returns (bool)'], signer);

            const mainTx = await withRpcRetry(
                () => sbyteContract.transfer(CONTRACTS.PUBLIC_VAULT_AND_GOD, cityShareWei),
                'propertyBuyTransfer'
            );
            const mainReceipt = await withRpcRetry(() => mainTx.wait(), 'propertyBuyWait');
            assertReceiptSuccess(mainReceipt, 'propertyBuyMain');
            mainTxHash = mainTx.hash;
            blockNumber = BigInt(mainReceipt?.blockNumber || 0);

            if (platformShareWei > 0n) {
                const feeTx = await withRpcRetry(
                    () => sbyteContract.transfer(CONTRACTS.PLATFORM_FEE_VAULT, platformShareWei),
                    'propertyFeeTransfer'
                );
                const feeReceipt = await withRpcRetry(() => feeTx.wait(), 'propertyFeeWait');
                assertReceiptSuccess(feeReceipt, 'propertyBuyPlatform');
                feeTxHash = feeTx.hash;
            }
        }

        // Record on-chain txs (main + platform fee)
        const god = await prisma.actor.findFirst({ where: { isGod: true } });
        await prisma.onchainTransaction.create({
            data: {
                txHash: mainTxHash,
                blockNumber: BigInt(blockNumber),
                fromAddress: (await prisma.agentWallet.findUnique({ where: { actorId: actor.id } }))?.walletAddress || '',
                toAddress: CONTRACTS.PUBLIC_VAULT_AND_GOD,
                tokenAddress: CONTRACTS.SBYTE_TOKEN,
                amount: ethers.formatEther(cityShareWei),
                fromActorId: actor.id,
                toActorId: god?.id,
                txType: 'MARKET_PURCHASE',
                platformFee: platformShare.toString(),
                cityFee: cityShare.toString(),
                cityId: property.cityId,
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
                    amount: ethers.formatEther(platformShareWei),
                    fromActorId: actor.id,
                    toActorId: null,
                    txType: 'PLATFORM_FEE',
                    platformFee: platformShare.toString(),
                    cityFee: '0',
                    cityId: property.cityId,
                    status: 'confirmed',
                    confirmedAt: new Date(),
                }
            });
        }

        // Record off-chain transaction entry for genesis purchase
        await prisma.transaction.create({
            data: {
                fromActorId: actor.id,
                toActorId: god?.id || null,
                amount: price.toNumber(),
                feePlatform: platformShare.toNumber(),
                feeCity: cityShare.toNumber(),
                cityId: property.cityId,
                tick,
                reason: 'GENESIS_PROPERTY_PURCHASE',
                onchainTxHash: mainTxHash,
                metadata: {
                    propertyId: property.id,
                    salePrice: price.toNumber(),
                    platformShare: platformShare.toNumber(),
                    cityShare: cityShare.toNumber(),
                    onchainTxHash: mainTxHash,
                    platformFeeTxHash: platformShareWei > 0n ? feeTxHash : null,
                }
            }
        });
    }

    if (property.ownerId) {
        // Record off-chain transaction entry for agent-to-agent purchase
        await prisma.transaction.create({
            data: {
                fromActorId: actor.id,
                toActorId: property.ownerId || null,
                amount: price.toNumber(),
                feePlatform: platformFee.toNumber(),
                feeCity: 0,
                cityId: property.cityId,
                tick,
                reason: 'PROPERTY_PURCHASE',
                onchainTxHash: propertyPurchaseTxHash,
                metadata: {
                    propertyId: property.id,
                    salePrice: price.toNumber(),
                    platformFee: platformFee.toNumber(),
                    onchain: true,
                    onchainTxHash: propertyPurchaseTxHash,
                    platformFeeTxHash
                }
            }
        });
    }

    // Platform fee to platform vault
    if (platformShare.greaterThan(0)) {
        stateUpdates.push({
            table: 'platformVault',
            operation: 'update',
            where: { id: 1 },
            data: { balanceSbyte: { increment: platformShare.toNumber() } }
        });
    }

    const shouldMoveIn = !params.suppressMoveIn
        && !property.isEmptyLot
        && !property.tenantId
        && agentState?.housingTier === 'street';

    // Transfer ownership (and evict tenant if occupied by someone else)
    stateUpdates.push({
        table: 'property',
        operation: 'update',
        where: { id: property.id },
        data: {
            ownerId: actor.id,
            forSale: false,
            purchasePrice: price.toNumber(),
            // Use total acquisition outflow so buy action itself does not look like a net-worth loss.
            costBasis: totalCost.toNumber(),
            purchaseTick: tick,
            ...(property.tenantId && property.tenantId !== actor.id ? {
                tenantId: null,
                forRent: true,
                missedRentDays: 0,
                tenantSince: null
            } : shouldMoveIn ? {
                tenantId: actor.id,
                forRent: false,
                tenantSince: tick
            } : {})
            // salePrice: null (Removed to avoid Prisma validation error if issues arise)
        }
    });

    if (shouldMoveIn) {
        stateUpdates.push({
            table: 'agentState',
            operation: 'update',
            where: { actorId: actor.id },
            data: { housingTier: property.housingTier }
        });
    }

    // If property was occupied by someone else, evict tenant with notice (immediate in MVP)
    if (property.tenantId && property.tenantId !== actor.id) {
        if (property.ownerId) {
            await propertyRatingService.autoRateLandlord(property.tenantId, property.id, tick);
            await propertyRatingService.autoRateTenant(property.ownerId, property.tenantId, property.id, tick);
        }
        stateUpdates.push({
            table: 'agentState',
            operation: 'update',
            where: { actorId: property.tenantId },
            data: { housingTier: 'street' }
        });
        if (property.ownerId) {
            stateUpdates.push({
                table: 'actor',
                operation: 'update',
                where: { id: property.ownerId },
                data: { reputation: { increment: -15 } }
            });
            stateUpdates.push({
                table: 'agentState',
                operation: 'update',
                where: { actorId: property.ownerId },
                data: { reputationScore: { increment: -15 } }
            });
        }
    }

    const events = [{
        actorId: actor.id,
        type: EventType.EVENT_PROPERTY_BOUGHT,
        targetIds: [property.id],
        outcome: EventOutcome.SUCCESS,
        sideEffects: {
            propertyId: property.id,
            buyerId: actor.id,
            sellerId: property.ownerId,
            price: price.toNumber(),
            platformFee: platformShare.toNumber(),
            cityFee: cityShare.toNumber(),
            housingTier: property.housingTier,
            propertyType: property.lotType ?? property.housingTier
        }
    }];

    if (property.tenantId) {
        events.push({
            actorId: property.tenantId,
            type: EventType.EVENT_EVICTION,
            targetIds: [property.id],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                propertyId: property.id,
                tenantId: property.tenantId,
                ownerId: property.ownerId,
                missedRentDays: property.missedRentDays,
                reason: 'owner_request',
                evictionReason: 'property_sold'
            }
        });
        if (property.ownerId) {
            events.push({
                actorId: property.ownerId,
                type: EventType.EVENT_REPUTATION_UPDATED,
                targetIds: [],
                outcome: EventOutcome.SUCCESS,
                sideEffects: { delta: -15, reason: 'sold_occupied_property' }
            });
        }
    }

    return {
        stateUpdates,
        events,
        intentStatus: IntentStatus.EXECUTED
    };
};

// ============================================================================
// INTENT_SELL_PROPERTY
// ============================================================================

export const handleSellProperty: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    const params = intent.params as { propertyId?: string, salePrice?: number };

    if (!params?.propertyId || params.salePrice === undefined) {
        return fail(actor.id, EventType.EVENT_PROPERTY_SOLD, 'Missing propertyId or salePrice');
    }

    // Check if agent is WORKING (blocked activity)
    if (agentState?.activityState === 'WORKING') {
        return fail(actor.id, EventType.EVENT_PROPERTY_SOLD, 'Cannot sell property while working');
    }

    // Get property
    const property = await prisma.property.findUnique({
        where: { id: params.propertyId }
    });

    if (!property) {
        return fail(actor.id, EventType.EVENT_PROPERTY_SOLD, 'Property not found');
    }

    // Check ownership
    if (property.ownerId !== actor.id) {
        return fail(actor.id, EventType.EVENT_PROPERTY_SOLD, 'Not the owner');
    }

    // Validate sale price
    if (params.salePrice <= 0) {
        return fail(actor.id, EventType.EVENT_PROPERTY_SOLD, 'Sale price must be positive');
    }

    return {
        stateUpdates: [{
            table: 'property',
            operation: 'update',
            where: { id: property.id },
            data: {
                forSale: true,
                salePrice: params.salePrice
            }
        }],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_PROPERTY_SOLD,
            targetIds: [property.id],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                propertyId: property.id,
                sellerId: actor.id,
                buyerId: '', // Will be filled when bought
                price: params.salePrice,
                netProceeds: 0, // Will be calculated when sale completes
                propertyType: property.lotType ?? property.housingTier
            }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

// ============================================================================
// INTENT_LIST_PROPERTY
// ============================================================================

export const handleListProperty: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    const params = intent.params as {
        propertyId?: string,
        rentPrice?: number,
        forRent?: boolean,
        forSale?: boolean,
        salePrice?: number
    };

    if (!params?.propertyId) {
        return fail(actor.id, EventType.EVENT_PROPERTY_LISTED, 'Missing propertyId');
    }

    // Check if agent is WORKING (blocked activity)
    if (agentState?.activityState === 'WORKING') {
        return fail(actor.id, EventType.EVENT_PROPERTY_LISTED, 'Cannot list property while working');
    }

    // Get property
    const property = await prisma.property.findUnique({
        where: { id: params.propertyId }
    });

    if (!property) {
        return fail(actor.id, EventType.EVENT_PROPERTY_LISTED, 'Property not found');
    }

    // Check ownership
    if (property.ownerId !== actor.id) {
        return fail(actor.id, EventType.EVENT_PROPERTY_LISTED, 'Not the owner');
    }

    // Validate prices
    if (params.forRent && (params.rentPrice === undefined || params.rentPrice < 0)) {
        return fail(actor.id, EventType.EVENT_PROPERTY_LISTED, 'Invalid rent price');
    }
    if (params.forRent && property.isEmptyLot) {
        return fail(actor.id, EventType.EVENT_PROPERTY_LISTED, 'Cannot rent an empty lot');
    }
    if (params.forSale && (params.salePrice === undefined || params.salePrice <= 0)) {
        return fail(actor.id, EventType.EVENT_PROPERTY_LISTED, 'Invalid sale price');
    }

    return {
        stateUpdates: [{
            table: 'property',
            operation: 'update',
            where: { id: property.id },
            data: {
                forRent: params.forRent ?? property.forRent,
                forSale: params.forSale ?? property.forSale,
                rentPrice: params.rentPrice ?? property.rentPrice,
                salePrice: params.forSale ? params.salePrice : null
            }
        }],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_PROPERTY_LISTED,
            targetIds: [property.id],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                propertyId: property.id,
                forRent: params.forRent ?? property.forRent,
                forSale: params.forSale ?? property.forSale,
                rentPrice: params.rentPrice ?? Number(property.rentPrice),
                salePrice: params.forSale ? params.salePrice : null,
                propertyType: property.lotType ?? property.housingTier
            }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

// ============================================================================
// INTENT_ADJUST_RENT
// ============================================================================

export const handleAdjustRent: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    const params = intent.params as { propertyId?: string; newRent?: number };
    if (!params?.propertyId || params.newRent === undefined) {
        return fail(actor.id, EventType.EVENT_RENT_ADJUSTED, 'Missing propertyId or newRent');
    }
    if (params.newRent < 0) {
        return fail(actor.id, EventType.EVENT_RENT_ADJUSTED, 'Invalid rent');
    }

    const property = await prisma.property.findUnique({
        where: { id: params.propertyId }
    });
    if (!property) return fail(actor.id, EventType.EVENT_RENT_ADJUSTED, 'Property not found');
    if (property.ownerId !== actor.id) return fail(actor.id, EventType.EVENT_RENT_ADJUSTED, 'Not the owner');

    const currentRent = new Decimal(property.rentPrice.toString());
    const newRent = new Decimal(params.newRent);
    const increaseRatio = currentRent.equals(0) ? 0 : newRent.div(currentRent).toNumber();

    const stateUpdates: StateUpdate[] = [
        {
            table: 'property',
            operation: 'update',
            where: { id: property.id },
            data: { rentPrice: newRent.toNumber() }
        }
    ];

    const events = [{
        actorId: actor.id,
        type: EventType.EVENT_RENT_ADJUSTED,
        targetIds: [property.id],
        outcome: EventOutcome.SUCCESS,
        sideEffects: {
            propertyId: property.id,
            previousRent: currentRent.toNumber(),
            newRent: newRent.toNumber()
        }
    }];

    if (increaseRatio > 1.2 && property.tenantId) {
        await propertyRatingService.autoRateLandlord(property.tenantId, property.id, tick);
        await propertyRatingService.autoRateTenant(actor.id, property.tenantId, property.id, tick);
        stateUpdates.push({
            table: 'property',
            operation: 'update',
            where: { id: property.id },
            data: {
                tenantId: null,
                forRent: true,
                missedRentDays: 0,
                tenantSince: null
            }
        });
        stateUpdates.push({
            table: 'agentState',
            operation: 'update',
            where: { actorId: property.tenantId },
            data: { housingTier: 'street' }
        });
        events.push({
            actorId: property.tenantId,
            type: EventType.EVENT_EVICTION,
            targetIds: [property.id],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                propertyId: property.id,
                tenantId: property.tenantId,
                ownerId: property.ownerId,
                missedRentDays: property.missedRentDays,
                reason: 'owner_request',
                evictionReason: 'rent_increase'
            }
        });
    }

    if (increaseRatio > 1.3) {
        stateUpdates.push({
            table: 'actor',
            operation: 'update',
            where: { id: actor.id },
            data: { reputation: { increment: -10 } }
        });
        stateUpdates.push({
            table: 'agentState',
            operation: 'update',
            where: { actorId: actor.id },
            data: { reputationScore: { increment: -10 } }
        });
        events.push({
            actorId: actor.id,
            type: EventType.EVENT_REPUTATION_UPDATED,
            targetIds: [],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { delta: -10, reason: 'rent_gouging' }
        });
    }

    return {
        stateUpdates,
        events,
        intentStatus: IntentStatus.EXECUTED
    };
};

// ============================================================================
// INTENT_MAINTAIN_PROPERTY
// ============================================================================

const MAINTENANCE_COST_BY_TIER: Record<string, number> = {
    shelter: 2,
    slum_room: 5,
    apartment: 15,
    condo: 50,
    house: 150,
    villa: 500,
    estate: 2000,
    palace: 5000,
    citadel: 15000,
};

export const handleMaintainProperty: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    const params = intent.params as { propertyId?: string };
    if (!params?.propertyId) return fail(actor.id, EventType.EVENT_PROPERTY_MAINTAINED, 'Missing propertyId');

    const property = await prisma.property.findUnique({ where: { id: params.propertyId } });
    if (!property) return fail(actor.id, EventType.EVENT_PROPERTY_MAINTAINED, 'Property not found');
    if (property.ownerId !== actor.id) return fail(actor.id, EventType.EVENT_PROPERTY_MAINTAINED, 'Not the owner');

    if (property.lastMaintenanceTick && tick - property.lastMaintenanceTick < 8640) {
        return fail(actor.id, EventType.EVENT_PROPERTY_MAINTAINED, 'MAINTENANCE_COOLDOWN');
    }

    const cost = MAINTENANCE_COST_BY_TIER[property.housingTier] ?? 0;
    if (cost <= 0) return fail(actor.id, EventType.EVENT_PROPERTY_MAINTAINED, 'Invalid maintenance cost');

    const balance = new Decimal(wallet?.balanceSbyte.toString() || '0');
    if (balance.lessThan(cost)) return fail(actor.id, EventType.EVENT_PROPERTY_MAINTAINED, 'Insufficient funds');

    const snapshot = getLatestSnapshot(property.cityId);
    const avgRent = snapshot?.avg_rent_by_tier?.[property.housingTier] ?? Number(property.rentPrice);
    const policy = await prisma.cityPolicy.findUnique({ where: { cityId: property.cityId } });
    if (avgRent > 0) {
        const fmv = Number(property.fairMarketValue ?? 0);
        const taxRate = Number(policy?.propertyTaxRate ?? 0.02) / 365;
        const taxDue = Math.min(fmv * taxRate, avgRent);
        if (cost > avgRent || (cost + taxDue) > avgRent) {
            return fail(actor.id, EventType.EVENT_PROPERTY_MAINTAINED, 'MAINTENANCE_NOT_ECONOMIC');
        }
    }

    const newCondition = Math.min(100, (property.condition ?? 100) + 15);

    return {
        stateUpdates: [
            {
                table: 'wallet',
                operation: 'update',
                where: { actorId: actor.id },
                data: { balanceSbyte: { decrement: cost } }
            },
            {
                table: 'agentWallet',
                operation: 'update',
                where: { actorId: actor.id },
                data: { balanceSbyte: { decrement: cost } }
            },
            {
                table: 'cityVault',
                operation: 'update',
                where: { cityId: property.cityId },
                data: { balanceSbyte: { increment: cost } }
            },
            {
                table: 'property',
                operation: 'update',
                where: { id: property.id },
                data: { condition: newCondition, lastMaintenanceTick: tick }
            },
            {
                table: 'transaction',
                operation: 'create',
                data: {
                    fromActorId: actor.id,
                    toActorId: null,
                    amount: cost,
                    feePlatform: 0,
                    feeCity: cost,
                    cityId: property.cityId,
                    tick,
                    reason: 'PROPERTY_MAINTENANCE',
                    onchainTxHash: null,
                    metadata: { propertyId: property.id }
                }
            }
        ],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_PROPERTY_MAINTAINED,
            targetIds: [property.id],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { propertyId: property.id, cost, newCondition }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

// ============================================================================
// INTENT_EVICT
// ============================================================================

export const handleEvict: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    const params = intent.params as { propertyId?: string };
    if (!params?.propertyId) {
        return fail(actor.id, EventType.EVENT_EVICTION, 'Missing propertyId');
    }

    const property = await prisma.property.findUnique({
        where: { id: params.propertyId }
    });
    if (!property) return fail(actor.id, EventType.EVENT_EVICTION, 'Property not found');
    if (!property.tenantId) return fail(actor.id, EventType.EVENT_EVICTION, 'No tenant to evict');
    if (property.missedRentDays < 3) {
        return fail(actor.id, EventType.EVENT_EVICTION, 'Missed rent days below eviction threshold');
    }

    const actorRecord = await prisma.actor.findUnique({ where: { id: actor.id } });
    const isGod = actorRecord?.isGod === true;
    if (!isGod && property.ownerId !== actor.id) {
        return fail(actor.id, EventType.EVENT_EVICTION, 'Only owner or God can evict');
    }

    if (property.ownerId && property.tenantId) {
        await propertyRatingService.autoRateLandlord(property.tenantId, property.id, tick);
        await propertyRatingService.autoRateTenant(property.ownerId, property.tenantId, property.id, tick);
    }

    return {
        stateUpdates: [
            {
                table: 'property',
                operation: 'update',
                where: { id: property.id },
                data: {
                    tenantId: null,
                    forRent: true,
                    missedRentDays: 0
                }
            },
            {
                table: 'agentState',
                operation: 'update',
                where: { actorId: property.tenantId },
                data: { housingTier: 'street' }
            }
        ],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_EVICTION,
            targetIds: [property.id],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                propertyId: property.id,
                tenantId: property.tenantId
            }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get genesis price by housing tier
 * Based on STATUS_AND_WEALTH_SPEC.md pricing
 */
function getGenesisPriceByTier(tier: string): Decimal {
    const price = GENESIS_SALE_PRICE_BY_TIER[tier] ?? 0;
    return new Decimal(price);
}

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
