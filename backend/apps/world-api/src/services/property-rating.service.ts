import { prisma } from '../db.js';
import { getLatestSnapshot } from './economy-snapshot.service.js';
import { EventType, EventOutcome } from '../types/event.types.js';

export class PropertyRatingService {
    async autoRateLandlord(tenantId: string, propertyId: string, tick: number): Promise<void> {
        const prop = await prisma.property.findUnique({ where: { id: propertyId } });
        if (!prop?.ownerId) return;

        const condition = prop.condition ?? 100;
        const tenantSince = prop.tenantSince ?? tick;

        const snapshot = getLatestSnapshot(prop.cityId);
        const avgRent = snapshot?.avg_rent_by_tier?.[prop.housingTier] ?? Number(prop.rentPrice);
        const rentRatio = avgRent > 0 ? Number(prop.rentPrice) / avgRent : 1;
        const rentFairness = rentRatio < 0.9 ? 5 : rentRatio < 1.1 ? 4 : rentRatio < 1.3 ? 3 : rentRatio < 1.5 ? 2 : 1;

        const maintenanceScore = condition > 80 ? 5 : condition > 60 ? 4 : condition > 40 ? 3 : condition > 20 ? 2 : 1;

        const rentChanges = await this.countRentChanges(propertyId, tenantSince);
        const stabilityScore = rentChanges === 0 ? 5 : rentChanges === 1 ? 4 : rentChanges <= 3 ? 3 : 2;

        const overall = Math.round((rentFairness + maintenanceScore + stabilityScore) / 3);

        await prisma.propertyRating.upsert({
            where: {
                propertyId_raterId_role: {
                    propertyId,
                    raterId: tenantId,
                    role: 'tenant_rates_landlord',
                }
            },
            create: {
                propertyId,
                raterId: tenantId,
                targetId: prop.ownerId,
                role: 'tenant_rates_landlord',
                score: overall,
                categories: { rentFairness, maintenance: maintenanceScore, stability: stabilityScore },
                tick,
            },
            update: {
                score: overall,
                categories: { rentFairness, maintenance: maintenanceScore, stability: stabilityScore },
                tick,
            }
        });

        await prisma.event.create({
            data: {
                actorId: tenantId,
                type: EventType.EVENT_TENANT_RATED_LANDLORD,
                targetIds: [prop.ownerId],
                tick,
                outcome: EventOutcome.SUCCESS,
                sideEffects: { propertyId, score: overall }
            }
        });
    }

    async autoRateTenant(landlordId: string, tenantId: string, propertyId: string, tick: number): Promise<void> {
        const prop = await prisma.property.findUnique({ where: { id: propertyId } });
        if (!prop) return;

        const missedRent = prop.missedRentDays ?? 0;
        const tenantSince = prop.tenantSince ?? tick;
        const duration = tick - tenantSince;

        const paymentScore = missedRent === 0 ? 5 : missedRent <= 1 ? 4 : missedRent <= 2 ? 3 : 2;
        const durationScore = duration > 17280 ? 5 : duration > 8640 ? 4 : duration > 4320 ? 3 : 2;

        const overall = Math.round((paymentScore + durationScore + 4) / 3);

        await prisma.propertyRating.upsert({
            where: {
                propertyId_raterId_role: {
                    propertyId,
                    raterId: landlordId,
                    role: 'landlord_rates_tenant',
                }
            },
            create: {
                propertyId,
                raterId: landlordId,
                targetId: tenantId,
                role: 'landlord_rates_tenant',
                score: overall,
                categories: { paymentReliability: paymentScore, tenancyDuration: durationScore },
                tick,
            },
            update: {
                score: overall,
                categories: { paymentReliability: paymentScore, tenancyDuration: durationScore },
                tick,
            }
        });

        await prisma.event.create({
            data: {
                actorId: landlordId,
                type: EventType.EVENT_LANDLORD_RATED_TENANT,
                targetIds: [tenantId],
                tick,
                outcome: EventOutcome.SUCCESS,
                sideEffects: { propertyId, score: overall }
            }
        });
    }

    async getLandlordRating(actorId: string): Promise<number> {
        const ratings = await prisma.propertyRating.findMany({
            where: { targetId: actorId, role: 'tenant_rates_landlord' },
            select: { score: true },
        });
        if (ratings.length === 0) return 3.0;
        return ratings.reduce((s, r) => s + r.score, 0) / ratings.length;
    }

    async getTenantRating(actorId: string): Promise<number> {
        const ratings = await prisma.propertyRating.findMany({
            where: { targetId: actorId, role: 'landlord_rates_tenant' },
            select: { score: true },
        });
        if (ratings.length === 0) return 3.0;
        return ratings.reduce((s, r) => s + r.score, 0) / ratings.length;
    }

    private async countRentChanges(propertyId: string, sinceTick: number): Promise<number> {
        const changes = await prisma.event.findMany({
            where: {
                type: EventType.EVENT_RENT_ADJUSTED,
                tick: { gte: sinceTick },
                sideEffects: {
                    path: ['propertyId'],
                    equals: propertyId,
                }
            },
            select: { id: true }
        });
        return changes.length;
    }
}

export const propertyRatingService = new PropertyRatingService();
