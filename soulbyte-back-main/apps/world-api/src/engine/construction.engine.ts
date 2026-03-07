import { prisma } from '../db.js';
import { AgentTransferService } from '../services/agent-transfer.service.js';
import { ethers } from 'ethers';
import { Decimal } from 'decimal.js';
import { EventOutcome, EventType } from '../types/event.types.js';

const agentTransferService = new AgentTransferService();

const OWNER_WORK_WINDOW_TICKS = 1440;
const HOUSING_BUILDING_TYPES = new Set([
    'SLUM_ROOM',
    'APARTMENT',
    'CONDO',
    'HOUSE',
    'VILLA',
    'ESTATE',
    'PALACE',
    'CITADEL',
]);
const HOUSING_TERRAIN_SIZE: Record<string, { width: number; height: number }> = {
    shelter: { width: 1, height: 1 },
    slum_room: { width: 1, height: 1 },
    apartment: { width: 2, height: 2 },
    condo: { width: 3, height: 3 },
    house: { width: 4, height: 4 },
    villa: { width: 5, height: 5 },
    estate: { width: 6, height: 6 },
    palace: { width: 8, height: 8 },
    citadel: { width: 10, height: 10 },
    street: { width: 1, height: 1 },
};

function getHousingTierForBuildingType(buildingType: string): string | null {
    if (!HOUSING_BUILDING_TYPES.has(buildingType)) return null;
    return buildingType.toLowerCase();
}

function getHousingTerrainSize(housingTier: string) {
    return HOUSING_TERRAIN_SIZE[housingTier] || { width: 1, height: 1 };
}

export async function processConstructionProjects(currentTick: number): Promise<number> {
    const projects = await prisma.constructionProject.findMany({
        where: { status: { in: ['in_progress', 'paused'] } },
        orderBy: { createdAt: 'asc' }
    });

    let processed = 0;
    for (const project of projects) {
        const business = project.constructorId
            ? await prisma.business.findUnique({ where: { id: project.constructorId } })
            : null;

        if (business) {
            const activeEmployees = await prisma.privateEmployment.count({
                where: { businessId: business.id, status: 'ACTIVE' }
            });

            const ownerWorkedRecently = business.ownerLastWorkedTick !== null
                && business.ownerLastWorkedTick >= currentTick - OWNER_WORK_WINDOW_TICKS;

            if (activeEmployees < 1 || !ownerWorkedRecently) {
                if (project.status !== 'paused') {
                    await prisma.constructionProject.update({
                        where: { id: project.id },
                        data: { status: 'paused' }
                    });
                    await prisma.event.create({
                        data: {
                            actorId: business.ownerId,
                            type: EventType.EVENT_CONSTRUCTION_PROJECT_PAUSED,
                            targetIds: [project.id],
                            tick: currentTick,
                            outcome: EventOutcome.SUCCESS,
                            sideEffects: { reason: 'UNDERSTAFFED' }
                        }
                    });
                }
                processed++;
                continue;
            }

            if (project.status === 'paused') {
                await prisma.constructionProject.update({
                    where: { id: project.id },
                    data: { status: 'in_progress' }
                });
            }
        }

        if (project.estimatedCompletionTick !== null && currentTick >= project.estimatedCompletionTick) {
            await completeProject(project.id, currentTick);
        }

        processed++;
    }

    return processed;
}

export async function generateConstructionQuotes(currentTick: number): Promise<number> {
    const requests = await prisma.constructionRequest.findMany({
        where: { status: 'pending' }
    });
    let created = 0;
    for (const request of requests) {
        const constructors = await prisma.business.findMany({
            where: {
                cityId: request.cityId,
                businessType: 'CONSTRUCTION',
                frozen: false,
                status: 'ACTIVE'
            },
            orderBy: { reputation: 'desc' },
            take: 5
        });

        const eligible = request.preferredConstructorId
            ? constructors.filter(c => c.id === request.preferredConstructorId)
            : constructors;

        if (eligible.length === 0) continue;

        const emptyLots = await prisma.property.count({
            where: { cityId: request.cityId, isEmptyLot: true, underConstruction: false }
        });
        const cityLots = await prisma.property.findMany({
            where: { cityId: request.cityId },
            select: { id: true }
        });
        const lotIds = cityLots.map(l => l.id);
        const activeProjects = await prisma.constructionProject.count({
            where: { status: { in: ['in_progress', 'paused'] }, lotId: { in: lotIds } }
        });
        const demandRatio = emptyLots > 0 ? activeProjects / emptyLots : 0;

        let createdForRequest = 0;
        for (const business of eligible) {
            const exists = await prisma.constructionQuote.findFirst({
                where: { requestId: request.id, businessId: business.id, status: 'pending' }
            });
            if (exists) continue;

            const quote = generateQuote({
                baseCost: getBaseBuildCost(request.buildingType),
                reputation: business.reputation,
                demandRatio,
                maxBudget: Number(request.maxBudget),
                buildingType: request.buildingType
            });

            await prisma.constructionQuote.create({
                data: {
                    requestId: request.id,
                    constructorId: business.ownerId,
                    businessId: business.id,
                    quote: quote.price,
                    depositPercent: quote.depositPercent,
                    estimatedTicks: quote.estimatedTicks,
                    qualityBonus: quote.qualityBonus,
                    expiresAtTick: currentTick + 10,
                    status: 'pending'
                }
            });
            created += 1;
            createdForRequest += 1;
        }

        if (createdForRequest > 0) {
            await prisma.constructionRequest.update({
                where: { id: request.id },
                data: { status: 'quoted' }
            });
        }
    }

    return created;
}

export async function cleanupExpiredConstructionQuotes(currentTick: number): Promise<number> {
    const expired = await prisma.constructionQuote.findMany({
        where: { status: 'pending', expiresAtTick: { lt: currentTick } }
    });
    if (expired.length === 0) return 0;
    await prisma.constructionQuote.updateMany({
        where: { id: { in: expired.map(e => e.id) } },
        data: { status: 'expired' }
    });

    const requestIds = Array.from(new Set(expired.map(e => e.requestId)));
    for (const requestId of requestIds) {
        const pendingQuotes = await prisma.constructionQuote.count({
            where: { requestId, status: 'pending' }
        });
        if (pendingQuotes === 0) {
            const request = await prisma.constructionRequest.findUnique({ where: { id: requestId } });
            if (request && request.status !== 'accepted') {
                await prisma.constructionRequest.update({
                    where: { id: requestId },
                    data: { status: 'expired' }
                });
                await prisma.property.update({
                    where: { id: request.lotId },
                    data: { underConstruction: false }
                });
            }
        }
    }
    return expired.length;
}

async function completeProject(projectId: string, currentTick: number): Promise<void> {
    const project = await prisma.constructionProject.findUnique({ where: { id: projectId } });
    if (!project) return;

    const business = project.constructorId
        ? await prisma.business.findUnique({ where: { id: project.constructorId } })
        : null;

    const lot = await prisma.property.findUnique({ where: { id: project.lotId } });
    if (!lot) return;

    const finalPayment = new Decimal(project.agreedPrice.toString()).minus(new Decimal(project.depositPaid.toString()));

    try {
        if (business) {
            await agentTransferService.transfer(
                project.clientId,
                business.ownerId,
                ethers.parseEther(finalPayment.toFixed(8)),
                'business',
                business.cityId
            );
        }

        await prisma.constructionProject.update({
            where: { id: project.id },
            data: {
                status: 'completed',
                actualCompletionTick: currentTick,
                finalPaymentPaid: finalPayment.toNumber()
            }
        });

        const housingTier = getHousingTierForBuildingType(project.buildingType);
        const terrainSize = housingTier ? getHousingTerrainSize(housingTier) : null;
        const propertyUpdate: Record<string, unknown> = {
            ownerId: project.clientId,
            isEmptyLot: false,
            underConstruction: false,
            forSale: false,
            forRent: false,
            constructedBy: business?.id ?? null
        };
        if (housingTier) {
            propertyUpdate.housingTier = housingTier;
            propertyUpdate.lotType = null;
            propertyUpdate.terrainWidth = terrainSize?.width ?? null;
            propertyUpdate.terrainHeight = terrainSize?.height ?? null;
            propertyUpdate.terrainArea = terrainSize ? terrainSize.width * terrainSize.height : null;
        }

        await prisma.property.update({
            where: { id: lot.id },
            data: propertyUpdate
        });

        if (business) {
            await updateBusinessReputation(business.id, 10, 'CONSTRUCTION_COMPLETED', 'Construction completed', currentTick);
        }

        await prisma.event.create({
            data: {
                actorId: business ? business.ownerId : project.clientId,
                type: EventType.EVENT_CONSTRUCTION_COMPLETED,
                targetIds: [project.id],
                tick: currentTick,
                outcome: EventOutcome.SUCCESS,
                sideEffects: {
                    projectId: project.id,
                    propertyId: lot.id,
                    buildingType: project.buildingType,
                    amount: finalPayment.toString()
                }
            }
        });
    } catch (error) {
        console.error('Construction completion failed', {
            projectId,
            lotId: project.lotId,
            businessId: business?.id ?? null,
            error: (error as Error)?.message ?? String(error)
        });
        await prisma.constructionProject.update({
            where: { id: project.id },
            data: {
                status: 'defaulted',
                actualCompletionTick: currentTick,
                finalPaymentPaid: 0
            }
        });

        const failedHousingTier = getHousingTierForBuildingType(project.buildingType);
        const failedTerrainSize = failedHousingTier ? getHousingTerrainSize(failedHousingTier) : null;
        const failedPropertyUpdate: Record<string, unknown> = {
            ownerId: business ? business.ownerId : project.clientId,
            isEmptyLot: false,
            underConstruction: false,
            forSale: false,
            forRent: false,
            constructedBy: business?.id ?? null
        };
        if (failedHousingTier) {
            failedPropertyUpdate.housingTier = failedHousingTier;
            failedPropertyUpdate.lotType = null;
            failedPropertyUpdate.terrainWidth = failedTerrainSize?.width ?? null;
            failedPropertyUpdate.terrainHeight = failedTerrainSize?.height ?? null;
            failedPropertyUpdate.terrainArea = failedTerrainSize
                ? failedTerrainSize.width * failedTerrainSize.height
                : null;
        }

        await prisma.property.update({
            where: { id: lot.id },
            data: failedPropertyUpdate
        });

        if (business) {
            await updateBusinessReputation(business.id, -5, 'CONSTRUCTION_DEFAULT', 'Client payment default', currentTick);
            await prisma.actor.update({
                where: { id: project.clientId },
                data: { reputation: { increment: -50 } }
            });
        }

        await prisma.event.create({
            data: {
                actorId: business ? business.ownerId : project.clientId,
                type: EventType.EVENT_CONSTRUCTION_PAYMENT_DEFAULT,
                targetIds: [project.id],
                tick: currentTick,
                outcome: EventOutcome.SUCCESS,
                sideEffects: { reason: 'FINAL_PAYMENT_FAILED' }
            }
        });
    }
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
}

function generateQuote(params: {
    baseCost: number;
    reputation: number;
    demandRatio: number;
    maxBudget: number;
    buildingType: string;
}) {
    const reputationMultiplier = params.reputation > 800 ? 1.3 : params.reputation > 600 ? 1.1 : params.reputation > 400 ? 1.0 : 0.9;
    const demandMultiplier = params.demandRatio > 0.8 ? 1.2 : params.demandRatio < 0.5 ? 0.9 : 1.0;
    let price = params.baseCost * reputationMultiplier * demandMultiplier;
    if (price > params.maxBudget * 0.95) {
        price = params.maxBudget * 0.95;
    }
    const speedMultiplier = params.reputation > 800 ? 2.0 : params.reputation > 600 ? 1.5 : params.reputation > 400 ? 1.0 : 0.75;
    const qualityBonus = params.reputation > 800 ? 250 : params.reputation > 600 ? 100 : params.reputation > 400 ? 0 : -50;
    const depositPercent = params.reputation < 400 ? 0.5 : 0.2;
    const estimatedTicks = Math.max(1, Math.floor(getBaseConstructionTicks(params.buildingType) / speedMultiplier));
    return { price, depositPercent, estimatedTicks, qualityBonus };
}

function getBaseBuildCost(buildingType: string): number {
    const costs: Record<string, number> = {
        SLUM_ROOM: 2400,
        APARTMENT: 2400,
        CONDO: 24000,
        HOUSE: 240000,
        VILLA: 2400000,
        ESTATE: 12000000,
        PALACE: 24000000,
        CITADEL: 120000000,
        RESTAURANT: 24000,
        CASINO: 240000,
        CLINIC: 240000,
        BANK: 2400000
    };
    return costs[buildingType] ?? 24000;
}

function getBaseConstructionTicks(buildingType: string): number {
    const times: Record<string, number> = {
        SLUM_ROOM: 50,
        APARTMENT: 100,
        CONDO: 200,
        HOUSE: 500,
        VILLA: 1000,
        ESTATE: 1500,
        PALACE: 3000,
        CITADEL: 5000,
        RESTAURANT: 200,
        CASINO: 500,
        CLINIC: 500,
        BANK: 1000
    };
    return times[buildingType] ?? 200;
}
