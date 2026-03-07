import { prisma } from '../../db.js';
import { EventType, EventOutcome } from '../../types/event.types.js';
import { propertyRatingService } from '../../services/property-rating.service.js';

const DEGRADATION_BY_TIER: Record<string, number> = {
    shelter: 0.15,
    slum_room: 0.12,
    apartment: 0.1,
    condo: 0.1,
    house: 0.08,
    villa: 0.06,
    estate: 0.05,
    palace: 0.04,
    citadel: 0.03,
};

function deterministicChance(seed: string): number {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
        hash = (hash << 5) - hash + seed.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash % 100) / 100;
}

export class PropertyMaintenanceEngine {
    async degradeAll(tick: number): Promise<void> {
        const properties = await prisma.property.findMany({
            where: { isEmptyLot: false, ownerId: { not: null } },
        });

        for (const prop of properties) {
            const degradation = DEGRADATION_BY_TIER[prop.housingTier] ?? 0.1;
            const currentCondition = prop.condition ?? 100;
            const newCondition = Math.max(0, currentCondition - degradation);

            const updates: any = { condition: newCondition };

            if (newCondition <= 0 && prop.tenantId) {
                await this.evictForCondemnation(prop, tick);
                updates.tenantId = null;
                updates.forRent = false;
            }

            if (newCondition < 30 && prop.tenantId) {
                const leaveChance = (30 - newCondition) / 100;
                const roll = deterministicChance(`${prop.id}-${tick}`);
                if (roll < leaveChance) {
                    await this.tenantLeaves(prop, tick, 'POOR_CONDITION');
                    updates.tenantId = null;
                }
            }

            await prisma.property.update({ where: { id: prop.id }, data: updates });
        }
    }

    private async evictForCondemnation(prop: any, tick: number): Promise<void> {
        await prisma.agentState.update({
            where: { actorId: prop.tenantId },
            data: { housingTier: 'street' },
        });
        await prisma.actor.update({
            where: { id: prop.ownerId },
            data: { reputation: { decrement: 25 } },
        });
        await prisma.agentState.update({
            where: { actorId: prop.ownerId },
            data: { reputationScore: { decrement: 25 } },
        });
        await prisma.event.create({
            data: {
                actorId: prop.tenantId,
                type: EventType.EVENT_PROPERTY_CONDEMNED,
                targetIds: [prop.id],
                tick,
                outcome: EventOutcome.SUCCESS,
                sideEffects: { reason: 'PROPERTY_CONDEMNED', propertyId: prop.id },
            },
        });
        if (prop.ownerId && prop.tenantId) {
            await propertyRatingService.autoRateLandlord(prop.tenantId, prop.id, tick);
            await propertyRatingService.autoRateTenant(prop.ownerId, prop.tenantId, prop.id, tick);
        }
    }

    private async tenantLeaves(prop: any, tick: number, reason: string): Promise<void> {
        await prisma.agentState.update({
            where: { actorId: prop.tenantId },
            data: { housingTier: 'street' },
        });
        await prisma.event.create({
            data: {
                actorId: prop.tenantId,
                type: EventType.EVENT_TENANT_LEFT,
                targetIds: [prop.id],
                tick,
                outcome: EventOutcome.SUCCESS,
                sideEffects: { reason, propertyId: prop.id },
            },
        });
        if (prop.ownerId && prop.tenantId) {
            await propertyRatingService.autoRateLandlord(prop.tenantId, prop.id, tick);
            await propertyRatingService.autoRateTenant(prop.ownerId, prop.tenantId, prop.id, tick);
        }
    }
}

export const propertyMaintenanceEngine = new PropertyMaintenanceEngine();
