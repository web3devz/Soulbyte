import { prisma } from '../../db.js';
import { EventType, EventOutcome } from '../../types/event.types.js';
import { getLatestSnapshot } from '../../services/economy-snapshot.service.js';

export class PropertyTaxEngine {
    async collectTaxes(tick: number, cityId: string): Promise<void> {
        const policy = await prisma.cityPolicy.findUnique({ where: { cityId } });
        const annualRate = policy?.propertyTaxRate ?? 0.02;
        const dailyRate = annualRate / 365;

        const properties = await prisma.property.findMany({
            where: { cityId, ownerId: { not: null } },
            include: { owner: { include: { wallet: true, agentState: true } } }
        });

        const snapshot = getLatestSnapshot(cityId);

        for (const prop of properties) {
            const fmv = Number(prop.fairMarketValue ?? 0);
            if (fmv <= 0 || !prop.ownerId) continue;

            const rate = prop.isEmptyLot ? dailyRate * 0.5 : dailyRate;
            let taxDue = fmv * rate;
            const rentCap = prop.tenantId
                ? Number(prop.rentPrice ?? 0)
                : (snapshot?.avg_rent_by_tier?.[prop.housingTier] ?? 0);
            if (rentCap > 0) {
                taxDue = Math.min(taxDue, rentCap);
            } else if (rentCap <= 0) {
                taxDue = 0;
            }
            const ownerBalance = Number(prop.owner?.wallet?.balanceSbyte ?? 0);

            if (taxDue <= 0) {
                await prisma.property.update({
                    where: { id: prop.id },
                    data: { lastTaxTick: tick }
                });
                continue;
            }

            if (ownerBalance >= taxDue) {
                await this.deductAndTransfer(prop.ownerId, taxDue, cityId, tick);
                await prisma.property.update({
                    where: { id: prop.id },
                    data: { missedTaxDays: 0, lastTaxTick: tick }
                });
                await prisma.event.create({
                    data: {
                        actorId: prop.ownerId,
                        type: EventType.EVENT_PROPERTY_TAX_PAID,
                        targetIds: [prop.id],
                        tick,
                        outcome: EventOutcome.SUCCESS,
                        sideEffects: { propertyId: prop.id, amount: taxDue, cityId }
                    }
                });
            } else {
                const newMissed = (prop.missedTaxDays ?? 0) + 1;
                await prisma.property.update({
                    where: { id: prop.id },
                    data: { missedTaxDays: newMissed, lastTaxTick: tick }
                });
                await prisma.event.create({
                    data: {
                        actorId: prop.ownerId,
                        type: EventType.EVENT_PROPERTY_TAX_MISSED,
                        targetIds: [prop.id],
                        tick,
                        outcome: EventOutcome.BLOCKED,
                        sideEffects: { propertyId: prop.id, missedTaxDays: newMissed }
                    }
                });

                if (newMissed >= 7) {
                    await this.seizeProperty(prop.id, cityId, tick);
                }
            }
        }
    }

    private async deductAndTransfer(ownerId: string, amount: number, cityId: string, tick: number): Promise<void> {
        await prisma.wallet.update({
            where: { actorId: ownerId },
            data: { balanceSbyte: { decrement: amount } }
        });
        await prisma.agentWallet.update({
            where: { actorId: ownerId },
            data: { balanceSbyte: { decrement: amount } }
        });
        await prisma.cityVault.update({
            where: { cityId },
            data: { balanceSbyte: { increment: amount } }
        });
        await prisma.transaction.create({
            data: {
                fromActorId: ownerId,
                toActorId: null,
                amount,
                cityId,
                tick,
                reason: 'PROPERTY_TAX',
                onchainTxHash: null,
                feePlatform: 0,
                feeCity: amount,
                metadata: { cityId }
            }
        });
    }

    private async seizeProperty(propertyId: string, cityId: string, tick: number): Promise<void> {
        const prop = await prisma.property.findUnique({ where: { id: propertyId } });
        if (!prop || !prop.ownerId) return;

        if (prop.tenantId) {
            await prisma.agentState.update({
                where: { actorId: prop.tenantId },
                data: { housingTier: 'street' }
            });
            await prisma.event.create({
                data: {
                    actorId: prop.tenantId,
                    type: EventType.EVENT_EVICTION,
                    targetIds: [prop.id],
                    tick,
                    outcome: EventOutcome.SUCCESS,
                    sideEffects: { reason: 'PROPERTY_SEIZED_TAX_DEFAULT', propertyId: prop.id }
                }
            });
        }

        await prisma.actor.update({
            where: { id: prop.ownerId },
            data: { reputation: { decrement: 50 } }
        });
        await prisma.agentState.update({
            where: { actorId: prop.ownerId },
            data: { reputationScore: { decrement: 50 } }
        });

        await prisma.property.update({
            where: { id: propertyId },
            data: {
                ownerId: null,
                tenantId: null,
                forSale: true,
                forRent: false,
                missedTaxDays: 0,
                salePrice: prop.fairMarketValue ?? prop.salePrice
            }
        });

        await prisma.event.create({
            data: {
                actorId: prop.ownerId,
                type: EventType.EVENT_PROPERTY_SEIZED,
                targetIds: [prop.id],
                tick,
                outcome: EventOutcome.SUCCESS,
                sideEffects: { propertyId, reason: 'TAX_DEFAULT_7_DAYS' }
            }
        });
    }
}

export const propertyTaxEngine = new PropertyTaxEngine();
