import { prisma } from '../../db.js';
import { IntentStatus } from '../../types/intent.types.js';
import { EventType, EventOutcome } from '../../types/event.types.js';
import { IntentHandler } from '../engine.types.js';
import { AgentTransferService } from '../../services/agent-transfer.service.js';
import { ethers } from 'ethers';
import { Decimal } from 'decimal.js';
import { CONTRACTS } from '../../config/contracts.js';
import { CONSTRUCTION_BASE_COSTS, CONSTRUCTION_BASE_TICKS } from '../../config/gameplay.js';

const agentTransferService = new AgentTransferService();

export const handleRequestConstruction: IntentHandler = async (intent, actor, agentState, wallet, tick) => {
    const params = intent.params as { lotId?: string; buildingType?: string; maxBudget?: number; preferredConstructorId?: string | null };
    if (!params?.lotId || !params.buildingType || !params.maxBudget) {
        return fail(actor.id, EventType.EVENT_CONSTRUCTION_REQUEST_CREATED, 'Missing params');
    }

    const lot = await prisma.property.findUnique({ where: { id: params.lotId } });
    if (!lot) return fail(actor.id, EventType.EVENT_CONSTRUCTION_REQUEST_CREATED, 'Lot not found');
    if (lot.ownerId !== actor.id) return fail(actor.id, EventType.EVENT_CONSTRUCTION_REQUEST_CREATED, 'Not lot owner');
    if (!lot.isEmptyLot || lot.underConstruction) return fail(actor.id, EventType.EVENT_CONSTRUCTION_REQUEST_CREATED, 'Lot not available');

    const maxBudget = new Decimal(params.maxBudget);
    if (!wallet || new Decimal(wallet.balanceSbyte.toString()).lessThan(maxBudget.mul(0.2))) {
        return fail(actor.id, EventType.EVENT_CONSTRUCTION_REQUEST_CREATED, 'Insufficient budget');
    }

    const constructors = await prisma.business.count({
        where: { cityId: lot.cityId, businessType: 'CONSTRUCTION', frozen: false, status: 'ACTIVE' }
    });
    const preferCity = params.preferredConstructorId === 'city' || constructors === 0;
    if (preferCity) {
        const cityPrice = getBaseBuildCost(params.buildingType) * 1.1;
        await agentTransferService.transfer(
            actor.id,
            null,
            ethers.parseEther(cityPrice.toFixed(8)),
            'construction_city',
            lot.cityId,
            CONTRACTS.PUBLIC_VAULT_AND_GOD
        );
        return {
            stateUpdates: [{
                table: 'constructionProject',
                operation: 'create',
                data: {
                    constructorId: null,
                    clientId: actor.id,
                    lotId: params.lotId,
                    buildingType: params.buildingType,
                    status: 'in_progress',
                    startTick: tick,
                    estimatedCompletionTick: tick + getBaseConstructionTicks(params.buildingType),
                    agreedPrice: cityPrice,
                    depositPaid: cityPrice,
                    finalPaymentPaid: 0,
                    qualityBonus: 0
                }
            }, {
                table: 'property',
                operation: 'update',
                where: { id: lot.id },
                data: { underConstruction: true }
            }],
            events: [{
                actorId: actor.id,
                type: EventType.EVENT_CONSTRUCTION_STARTED,
                targetIds: [params.lotId],
                outcome: EventOutcome.SUCCESS,
                sideEffects: { method: 'city', price: cityPrice, propertyId: params.lotId, buildingType: params.buildingType }
            }],
            intentStatus: IntentStatus.EXECUTED
        };
    }

    return {
        stateUpdates: [{
            table: 'constructionRequest',
            operation: 'create',
            data: {
                requesterId: actor.id,
                cityId: lot.cityId,
                lotId: params.lotId,
                buildingType: params.buildingType,
                maxBudget: maxBudget.toNumber(),
                preferredConstructorId: params.preferredConstructorId ?? null,
                status: 'pending'
            }
        }, {
            table: 'property',
            operation: 'update',
            where: { id: lot.id },
            data: { underConstruction: true }
        }],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_CONSTRUCTION_REQUEST_CREATED,
            targetIds: [params.lotId],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { buildingType: params.buildingType, propertyId: params.lotId }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleSubmitConstructionQuote: IntentHandler = async (intent, actor, agentState, _wallet, tick) => {
    const params = intent.params as { requestId?: string; businessId?: string; quote?: number; depositPercent?: number; estimatedTicks?: number; qualityBonus?: number };
    if (!params?.requestId || !params.businessId || !params.quote || !params.depositPercent || !params.estimatedTicks) {
        return fail(actor.id, EventType.EVENT_CONSTRUCTION_QUOTE_SUBMITTED, 'Missing params');
    }

    const request = await prisma.constructionRequest.findUnique({ where: { id: params.requestId } });
    if (!request || !['pending', 'quoted'].includes(request.status)) {
        return fail(actor.id, EventType.EVENT_CONSTRUCTION_QUOTE_SUBMITTED, 'Request not available');
    }

    const business = await prisma.business.findUnique({ where: { id: params.businessId } });
    if (!business || business.ownerId !== actor.id || business.businessType !== 'CONSTRUCTION') {
        return fail(actor.id, EventType.EVENT_CONSTRUCTION_QUOTE_SUBMITTED, 'Invalid constructor');
    }

    if (agentState?.cityId && business.cityId !== agentState.cityId) {
        return fail(actor.id, EventType.EVENT_CONSTRUCTION_QUOTE_SUBMITTED, 'Different city');
    }

    const quote = new Decimal(params.quote);
    const min = request.maxBudget.mul(0.2);
    if (quote.lessThan(min)) {
        return fail(actor.id, EventType.EVENT_CONSTRUCTION_QUOTE_SUBMITTED, 'Quote too low');
    }

    return {
        stateUpdates: [{
            table: 'constructionQuote',
            operation: 'create',
            data: {
                requestId: request.id,
                constructorId: actor.id,
                businessId: business.id,
                quote: quote.toNumber(),
                depositPercent: new Decimal(params.depositPercent).toNumber(),
                estimatedTicks: params.estimatedTicks,
                qualityBonus: params.qualityBonus ?? 0,
                expiresAtTick: tick + 10,
                status: 'pending'
            }
        }, {
            table: 'constructionRequest',
            operation: 'update',
            where: { id: request.id },
            data: { status: 'quoted' }
        }],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_CONSTRUCTION_QUOTE_SUBMITTED,
            targetIds: [request.id],
            outcome: EventOutcome.SUCCESS,
            sideEffects: { quote: quote.toNumber(), estimatedTicks: params.estimatedTicks }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

export const handleAcceptConstructionQuote: IntentHandler = async (intent, actor, _agentState, wallet, tick) => {
    const params = intent.params as { quoteId?: string };
    if (!params?.quoteId) return fail(actor.id, EventType.EVENT_CONSTRUCTION_STARTED, 'Missing quoteId');

    const quote = await prisma.constructionQuote.findUnique({ where: { id: params.quoteId } });
    if (!quote || quote.status !== 'pending') return fail(actor.id, EventType.EVENT_CONSTRUCTION_STARTED, 'Quote not available');
    if (quote.expiresAtTick !== null && tick > quote.expiresAtTick) {
        await prisma.constructionQuote.update({ where: { id: quote.id }, data: { status: 'expired' } });
        return fail(actor.id, EventType.EVENT_CONSTRUCTION_STARTED, 'Quote expired');
    }

    const request = await prisma.constructionRequest.findUnique({ where: { id: quote.requestId } });
    if (!request || request.requesterId !== actor.id) return fail(actor.id, EventType.EVENT_CONSTRUCTION_STARTED, 'Not requester');

    const business = await prisma.business.findUnique({ where: { id: quote.businessId } });
    if (!business) return fail(actor.id, EventType.EVENT_CONSTRUCTION_STARTED, 'Constructor missing');

    const depositAmount = new Decimal(quote.quote.toString()).mul(new Decimal(quote.depositPercent.toString()));
    if (!wallet || new Decimal(wallet.balanceSbyte.toString()).lessThan(depositAmount)) {
        return fail(actor.id, EventType.EVENT_CONSTRUCTION_STARTED, 'Insufficient deposit');
    }

    await agentTransferService.transfer(
        actor.id,
        business.ownerId,
        ethers.parseEther(depositAmount.toFixed(8)),
        'business',
        business.cityId
    );

    await prisma.constructionQuote.updateMany({
        where: { requestId: request.id, id: { not: quote.id } },
        data: { status: 'rejected' }
    });

    return {
        stateUpdates: [{
            table: 'constructionProject',
            operation: 'create',
            data: {
                constructorId: business.id,
                clientId: actor.id,
                lotId: request.lotId,
                buildingType: request.buildingType,
                status: 'in_progress',
                startTick: tick,
                estimatedCompletionTick: tick + quote.estimatedTicks,
                agreedPrice: new Decimal(quote.quote.toString()).toNumber(),
                depositPaid: depositAmount.toNumber(),
                finalPaymentPaid: 0,
                qualityBonus: quote.qualityBonus
            }
        }, {
            table: 'constructionRequest',
            operation: 'update',
            where: { id: request.id },
            data: { status: 'accepted' }
        }, {
            table: 'constructionQuote',
            operation: 'update',
            where: { id: quote.id },
            data: { status: 'accepted' }
        }],
        events: [{
            actorId: actor.id,
            type: EventType.EVENT_CONSTRUCTION_STARTED,
            targetIds: [business.id],
            outcome: EventOutcome.SUCCESS,
            sideEffects: {
                projectLotId: request.lotId,
                propertyId: request.lotId,
                buildingType: request.buildingType,
                constructorBusinessId: business.id,
                deposit: depositAmount.toNumber()
            }
        }],
        intentStatus: IntentStatus.EXECUTED
    };
};

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

function getBaseBuildCost(buildingType: string): number {
    return CONSTRUCTION_BASE_COSTS[buildingType] ?? 24000;
}

function getBaseConstructionTicks(buildingType: string): number {
    return CONSTRUCTION_BASE_TICKS[buildingType] ?? 200;
}
