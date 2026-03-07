/**
 * God On-Chain Service
 * Administrative operations for platform treasury and city vaults
 */

import { prisma } from '../db.js';
import { Decimal } from 'decimal.js';

const GOD_NAME_FALLBACK = 'GOD';
const UUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * God On-Chain Service class
 */
export class GodOnchainService {
    private async resolveGodActorId(): Promise<string | null> {
        const envGodId = process.env.GOD_ACTOR_ID?.trim();
        if (envGodId && UUID_REGEX.test(envGodId)) {
            return envGodId;
        }

        const godActor = await prisma.actor.findFirst({ where: { isGod: true } });
        if (godActor) {
            return godActor.id;
        }

        const godByName = await prisma.actor.findFirst({ where: { name: GOD_NAME_FALLBACK } });
        if (godByName) {
            return godByName.id;
        }

        console.warn('God actor not found; skipping admin log entry.');
        return null;
    }

    /**
     * Distribute collected city fees from public vault to city vaults
     * Called by God Service periodically
     * 
     * Note: For MVP, city fees are tracked off-chain in the database.
     * The actual SBYTE sits in PUBLIC_VAULT_AND_GOD address.
     * God allocates them to cities in the database for tracking.
     */
    async distributeCityFees(): Promise<{ distributed: number; totalAmount: bigint }> {
        const cities = await prisma.city.findMany({
            include: { vault: true },
        });

        let distributed = 0;
        let totalAmount = new Decimal(0);

        for (const city of cities) {
            // Calculate pending fees for this city from transactions
            const pendingFees = await prisma.onchainTransaction.aggregate({
                where: {
                    cityId: city.id,
                    status: 'confirmed',
                    cityFee: { gt: 0 },
                    cityFeeDistributedAt: null,
                },
                _sum: { cityFee: true },
            });

            const feeAmount = pendingFees._sum.cityFee;
            if (feeAmount && parseFloat(feeAmount.toString()) > 0) {
                const feeDecimal = new Decimal(feeAmount.toString());
                await prisma.$transaction(async (tx) => {
                    await tx.cityVault.update({
                        where: { cityId: city.id },
                        data: { balanceSbyte: { increment: feeDecimal.toNumber() } },
                    });
                    await tx.onchainTransaction.updateMany({
                        where: {
                            cityId: city.id,
                            status: 'confirmed',
                            cityFee: { gt: 0 },
                            cityFeeDistributedAt: null,
                        },
                        data: { cityFeeDistributedAt: new Date() },
                    });
                });

                // Log God action
                const godId = await this.resolveGodActorId();
                if (godId) {
                    await prisma.adminLog.create({
                        data: {
                            godId,
                            action: 'DISTRIBUTE_CITY_FEES',
                            payload: {
                                cityId: city.id,
                                cityName: city.name,
                                amount: feeAmount.toString(),
                            },
                        },
                    });
                }

                distributed++;
                totalAmount = totalAmount.add(feeDecimal);
            }
        }

        if (distributed > 0) {
            console.log(`God distributed fees to ${distributed} cities (total: ${totalAmount.toString()})`);
        }

        return { distributed, totalAmount: BigInt(totalAmount.toFixed(0)) };
    }

    /**
     * Burn SBYTE for city upgrades
     * God transfers SBYTE to dead address (tracked off-chain for MVP)
     * 
     * @param cityId - City performing the upgrade
     * @param amount - Amount to burn
     * @param upgradeType - Type of upgrade (e.g., 'expand_housing', 'improve_security')
     */
    async burnForUpgrade(
        cityId: string,
        amount: bigint,
        upgradeType: string
    ): Promise<{ txHash: string }> {
        // Get city
        const city = await prisma.city.findUnique({
            where: { id: cityId },
            include: { vault: true },
        });

        if (!city) {
            throw new Error('City not found');
        }

        // Check city vault has sufficient balance
        const vaultBalance = BigInt(city.vault?.balanceSbyte.toString() || '0');
        if (vaultBalance < amount) {
            throw new Error('Insufficient city vault balance for burn');
        }

        // Update city vault (decrease)
        await prisma.cityVault.update({
            where: { cityId },
            data: { balanceSbyte: { decrement: amount.toString() } },
        });

        // Get current tick for burn log
        const worldState = await prisma.worldState.findFirst({ where: { id: 1 } });
        const currentTick = worldState?.tick || 0;

        // Log burn
        await prisma.burnLog.create({
            data: {
                amountSbyte: amount.toString(),
                reason: `city_upgrade:${upgradeType}:${cityId}`,
                tick: currentTick,
            },
        });

        // Log God action
        const godId = await this.resolveGodActorId();
        if (godId) {
            await prisma.adminLog.create({
                data: {
                    godId,
                    action: 'BURN_FOR_UPGRADE',
                    payload: {
                        cityId,
                        cityName: city.name,
                        amount: amount.toString(),
                        upgradeType,
                    },
                },
            });
        }

        console.log(`God burned ${amount} SBYTE for ${upgradeType} in ${city.name}`);

        // For MVP, burns are tracked off-chain only
        // The SBYTE is conceptually removed from circulation
        return { txHash: 'offchain-burn' };
    }

    /**
     * Update city fee configuration
     * @param cityId - City to update
     * @param feeBps - New fee in basis points
     */
    async updateCityFeeConfig(
        cityId: string,
        feeBps: number,
        minFeeBps?: number,
        maxFeeBps?: number
    ): Promise<void> {
        // Validate bounds
        const FEE_ABSOLUTE_MAX = 1000; // 10%
        if (feeBps > FEE_ABSOLUTE_MAX) {
            throw new Error(`City fee cannot exceed ${FEE_ABSOLUTE_MAX} bps (10%)`);
        }

        await prisma.cityPolicy.update({
            where: { cityId },
            data: {
                cityFeeBps: feeBps,
                ...(minFeeBps !== undefined && { minCityFeeBps: minFeeBps }),
                ...(maxFeeBps !== undefined && { maxCityFeeBps: maxFeeBps }),
            },
        });

        // Log God action
        const godId = await this.resolveGodActorId();
        if (godId) {
            await prisma.adminLog.create({
                data: {
                    godId,
                    action: 'UPDATE_FEE_CONFIG',
                    payload: {
                        cityId,
                        cityFeeBps: feeBps,
                        minCityFeeBps: minFeeBps,
                        maxCityFeeBps: maxFeeBps,
                    },
                },
            });
        }

        console.log(`God updated city ${cityId} fee to ${feeBps} bps`);
    }
}
