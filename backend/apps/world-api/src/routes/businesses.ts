/**
 * Business Routes
 */
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../db.js';
import { authenticateApiKey } from '../middleware/openclaw-auth.js';
import { calculateAcceptanceProbability } from '../utils/openclaw-acceptance.js';
import { getBusinessRoleTitle } from '../utils/business-roles.js';
import { IntentStatus, IntentType } from '../types/intent.types.js';

const BUSINESS_CATEGORY_MAP: Record<string, string[]> = {
    food: ['RESTAURANT', 'TAVERN'],
    crafting: ['WORKSHOP', 'CONSTRUCTION'],
    entertainment: ['CASINO', 'GYM'],
    finance: ['BANK'],
    health: ['CLINIC'],
    real_estate: ['REALESTATE'],
    retail: ['STORE']
};

const resolveBusinessTypes = (category?: string, type?: string) => {
    if (type) return [type];
    if (!category) return null;
    const normalized = category.toLowerCase();
    if (BUSINESS_CATEGORY_MAP[normalized]) {
        return BUSINESS_CATEGORY_MAP[normalized];
    }
    return [category.toUpperCase()];
};

const mapBusinessCategory = (businessType: string) => {
    const entry = Object.entries(BUSINESS_CATEGORY_MAP).find(([, types]) => types.includes(businessType));
    return entry?.[0] ?? businessType.toLowerCase();
};

const mapBusinessStatus = (status: string, isOpen: boolean, underConstruction: boolean) => {
    if (underConstruction) return 'under_construction';
    if (!isOpen || ['BANKRUPT', 'DISSOLVED'].includes(status)) return 'abandoned';
    return 'operational';
};

const formatBusinessType = (businessType: string) => (
    businessType
        .toLowerCase()
        .split('_')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')
);

export async function businessRoutes(app: FastifyInstance) {
    /**
     * GET /api/v1/businesses
     * Query params: cityId, ownerId, type, category, status, sortBy
     */
    app.get('/api/v1/businesses', async (request, reply) => {
        const { cityId, ownerId, type, category, status, sortBy } = request.query as {
            cityId?: string;
            ownerId?: string;
            type?: string;
            category?: string;
            status?: string;
            sortBy?: string;
        };
        const businessTypes = resolveBusinessTypes(category, type);
        const businesses = await prisma.business.findMany({
            where: {
                cityId: cityId ?? undefined,
                ownerId: ownerId ?? undefined,
                businessType: businessTypes ? { in: businessTypes } : undefined
            },
            include: {
                employments: { where: { status: 'ACTIVE' } },
                improvements: true,
                owner: { select: { id: true, name: true } }
            },
            orderBy: { foundedTick: 'desc' }
        });

        const landIds = businesses.map((business) => business.landId);
        const properties = landIds.length > 0
            ? await prisma.property.findMany({
                where: { id: { in: landIds } },
                select: { id: true, underConstruction: true }
            })
            : [];
        const propertyById = new Map(properties.map((property) => [property.id, property]));

        let shaped = businesses.map((business) => {
            const property = propertyById.get(business.landId);
            const computedStatus = mapBusinessStatus(business.status, business.isOpen, property?.underConstruction ?? false);
            const netWorth = Number(business.treasury);
            return {
                id: business.id,
                name: business.name,
                category: mapBusinessCategory(business.businessType),
                cityId: business.cityId,
                ownerId: business.ownerId,
                ownerName: business.owner?.name ?? null,
                status: computedStatus,
                employeeCount: business.employments.length,
                maxEmployees: business.maxEmployees,
                treasury: Number(business.treasury),
                netWorth,
                reputationScore: business.reputation,
                level: business.level,
                foundedAtTick: business.foundedTick
            };
        });

        if (status) {
            const normalized = status.toLowerCase();
            shaped = shaped.filter((business) => business.status === normalized);
        }

        if (sortBy === 'netWorth') {
            shaped.sort((a, b) => b.netWorth - a.netWorth);
        }

        return reply.send({ businesses: shaped, total: shaped.length });
    });

    /**
     * POST /api/v1/businesses/start
     * Body: { businessType: string, cityId: string, landId: string, proposedName?: string, priority?: number }
     * Requires Authorization: Bearer <api_key>
     */
    app.post('/api/v1/businesses/start', async (request: FastifyRequest, reply: FastifyReply) => {
        const auth = await authenticateApiKey(request.headers.authorization as string | undefined);
        if (!auth || auth.role !== 'agent' || !auth.actorId) {
            return reply.code(401).send({ error: 'Unauthorized' });
        }

        const body = request.body as {
            businessType?: string;
            cityId?: string;
            landId?: string;
            proposedName?: string;
            priority?: number;
        };
        if (!body?.businessType || !body?.cityId || !body?.landId) {
            return reply.code(400).send({ error: 'businessType, cityId, and landId are required' });
        }

        const actor = await prisma.actor.findUnique({
            where: { id: auth.actorId },
            include: { jail: true, agentState: true },
        });
        if (!actor) return reply.code(404).send({ error: 'Actor not found' });
        if (actor.kind !== 'agent') return reply.code(400).send({ error: 'Only agents can start businesses' });
        if (actor.frozen) return reply.code(403).send({ error: 'Frozen actors cannot start businesses' });
        if (actor.jail) return reply.code(403).send({ error: 'Jailed actors cannot start businesses' });

        const property = await prisma.property.findUnique({
            where: { id: body.landId },
            select: { ownerId: true, tenantId: true, isEmptyLot: true },
        });
        let autoBuyPlanned: boolean | null = null;
        const intentType = property?.isEmptyLot === false
            ? IntentType.INTENT_CONVERT_BUSINESS
            : IntentType.INTENT_FOUND_BUSINESS;
        if (property) {
            const ownsProperty = property.ownerId === auth.actorId;
            const rentsProperty = property.tenantId === auth.actorId;
            const isHouseConversion = !property.isEmptyLot;
            const occupiedByOther = isHouseConversion && property.tenantId && property.tenantId !== auth.actorId;
            autoBuyPlanned = !occupiedByOther && (isHouseConversion ? !ownsProperty : (!ownsProperty && !rentsProperty));
        }

        const worldState = await prisma.worldState.findFirst({ where: { id: 1 } });
        const currentTick = worldState?.tick ?? 0;

        const intent = await prisma.intent.create({
            data: {
                actorId: auth.actorId,
                type: intentType,
                targetId: null,
                params: {
                    businessType: body.businessType,
                    cityId: body.cityId,
                    landId: body.landId,
                    proposedName: body.proposedName ?? null,
                    source: 'owner_suggestion',
                    ownerOverride: true,
                },
                priority: body.priority ?? 0.8,
                tick: currentTick,
                status: IntentStatus.PENDING,
            },
        });

        await prisma.notification.create({
            data: {
                actorId: auth.actorId,
                type: 'owner_request_submitted',
                title: 'Business request submitted',
                body: `Business request submitted: ${formatBusinessType(body.businessType)}.`,
                data: {
                    intentId: intent.id,
                    intentType: intentType,
                    businessType: body.businessType,
                    proposedName: body.proposedName ?? null,
                },
                sourceIntentId: intent.id,
            },
        });

        const acceptanceProbability = calculateAcceptanceProbability(actor.agentState, intentType);

        return reply.code(200).send({
            intent_id: intent.id,
            status: intent.status,
            acceptance_probability: acceptanceProbability,
            auto_buy_planned: autoBuyPlanned,
            message: 'Business request submitted. Your agent will consider it and attempt to buy the land if needed.',
        });
    });

    /**
     * GET /api/v1/businesses/:id
     */
    app.get('/api/v1/businesses/:id', async (request, reply) => {
        const { id } = request.params as { id: string };
        const business = await prisma.business.findUnique({
            where: { id },
            include: {
                employments: {
                    include: {
                        agent: { select: { id: true, name: true, agentState: { select: { jobType: true } } } }
                    }
                },
                improvements: true,
                listings: true,
                loans: true,
                owner: { select: { id: true, name: true } },
                city: { select: { id: true, name: true } },
                wallet: { select: { walletAddress: true, balanceMon: true, balanceSbyte: true } }
            }
        });
        if (!business) return reply.code(404).send({ error: 'Business not found' });

        const activeEmployments = business.employments.filter((employment) => employment.status === 'ACTIVE');
        const averageSalary = activeEmployments.length > 0
            ? activeEmployments.reduce((sum, e) => sum + Number(e.salaryDaily), 0) / activeEmployments.length
            : 0;
        const revenue = Number(business.dailyRevenue);
        const expenses = Number(business.dailyExpenses);
        const profit = revenue - expenses;
        const profitMargin = revenue > 0 ? profit / revenue : 0;
        const employmentsWithRoles = business.employments.map((employment) => ({
            ...employment,
            roleTitle: getBusinessRoleTitle(business.businessType, employment.performance)
        }));

        return reply.send({
            business: {
                ...business,
                employments: employmentsWithRoles,
                ownerName: business.owner?.name ?? null,
                cityName: business.city?.name ?? null,
                wallet: business.wallet
                    ? {
                        walletAddress: business.wallet.walletAddress,
                        balanceMon: business.wallet.balanceMon.toString(),
                        balanceSbyte: business.wallet.balanceSbyte.toString(),
                    }
                    : null,
                netWorth: Number(business.treasury),
                profitMargin,
                averageSalary,
                productionRate: business.businessType === 'WORKSHOP' ? null : null,
                customerSatisfaction: business.qualityScore ?? null,
                recentTransactions: {
                    revenue,
                    expenses,
                    profit
                }
            }
        });
    });

    app.get('/api/v1/businesses/:id/treasury', async (request, reply) => {
        const { id } = request.params as { id: string };
        const business = await prisma.business.findUnique({ where: { id } });
        if (!business) return reply.code(404).send({ error: 'Business not found' });
        return reply.send({ treasury: business.treasury.toString() });
    });

    app.get('/api/v1/businesses/:id/financials', async (request, reply) => {
        const { id } = request.params as { id: string };
        const business = await prisma.business.findUnique({ where: { id } });
        if (!business) return reply.code(404).send({ error: 'Business not found' });
        return reply.send({
            financials: {
                treasury: business.treasury.toString(),
                dailyRevenue: business.dailyRevenue.toString(),
                dailyExpenses: business.dailyExpenses.toString(),
                cumulativeRevenue: business.cumulativeRevenue.toString()
            }
        });
    });

    app.get('/api/v1/businesses/:id/reputation-history', async (request, reply) => {
        const { id } = request.params as { id: string };
        const history = await prisma.businessReputationLog.findMany({
            where: { businessId: id },
            orderBy: { tick: 'desc' },
            take: 200
        });
        return reply.send({ history });
    });

    app.get('/api/v1/businesses/:id/customers', async (_request, reply) => {
        return reply.send({ customers: [] });
    });

    app.get('/api/v1/businesses/:id/competitors', async (request, reply) => {
        const { id } = request.params as { id: string };
        const business = await prisma.business.findUnique({ where: { id } });
        if (!business) return reply.code(404).send({ error: 'Business not found' });
        const competitors = await prisma.business.findMany({
            where: { cityId: business.cityId, businessType: business.businessType, id: { not: id } }
        });
        return reply.send({ competitors });
    });

    /**
     * GET /api/v1/businesses/:id/events
     * Query params: type, limit
     */
    app.get('/api/v1/businesses/:id/events', async (request, reply) => {
        const { id } = request.params as { id: string };
        const { type, limit } = request.query as { type?: string; limit?: string };
        const events = await prisma.event.findMany({
            where: {
                targetIds: { has: id },
                type: type ?? undefined
            },
            orderBy: { tick: 'desc' },
            take: Math.min(Number(limit ?? 100), 200),
            include: { actor: { select: { id: true, name: true } } }
        });
        const business = await prisma.business.findUnique({ where: { id }, select: { id: true, name: true } });
        return reply.send({
            events: events.map((event) => ({
                ...event,
                actorName: event.actor?.name ?? null,
                metadata: {
                    ...(event.sideEffects ?? {}),
                    businessName: business?.name ?? null
                }
            }))
        });
    });

    /**
     * GET /api/v1/businesses/:id/transactions
     * Returns the last N on-chain transactions involving this business's wallet
     */
    app.get('/api/v1/businesses/:id/transactions', async (request, reply) => {
        const { id } = request.params as { id: string };
        const { limit } = request.query as { limit?: string };
        const business = await prisma.business.findUnique({
            where: { id },
            select: { id: true, name: true, ownerId: true }
        });
        if (!business) return reply.code(404).send({ error: 'Business not found' });

        const bWallet = await prisma.businessWallet.findUnique({
            where: { businessId: id },
            select: { walletAddress: true }
        });

        const take = Math.min(Number(limit ?? 50), 100);

        // Find transactions where the business wallet address is involved
        const transactions = await prisma.onchainTransaction.findMany({
            where: bWallet ? {
                status: 'confirmed',
                OR: [
                    { fromAddress: bWallet.walletAddress },
                    { toAddress: bWallet.walletAddress },
                    { fromActorId: business.ownerId },
                    { toActorId: business.ownerId }
                ]
            } : {
                status: 'confirmed',
                OR: [
                    { fromActorId: business.ownerId },
                    { toActorId: business.ownerId }
                ]
            },
            orderBy: { createdAt: 'desc' },
            take,
            select: {
                id: true, txHash: true, fromAddress: true, toAddress: true,
                fromActorId: true, toActorId: true, amount: true,
                txType: true, status: true, createdAt: true
            }
        });

        // Resolve actor names
        const actorIds = new Set<string>();
        for (const tx of transactions) {
            if (tx.fromActorId) actorIds.add(tx.fromActorId);
            if (tx.toActorId) actorIds.add(tx.toActorId);
        }
        const actors = actorIds.size > 0
            ? await prisma.actor.findMany({
                where: { id: { in: Array.from(actorIds) } },
                select: { id: true, name: true }
            }) : [];
        const actorNameById = new Map(actors.map(a => [a.id, a.name]));

        return reply.send({
            transactions: transactions.map(tx => ({
                ...tx,
                amount: tx.amount.toString(),
                fromActorName: tx.fromActorId ? actorNameById.get(tx.fromActorId) ?? null : null,
                toActorName: tx.toActorId ? actorNameById.get(tx.toActorId) ?? null : null,
                direction: bWallet && tx.toAddress === bWallet.walletAddress ? 'IN' : 'OUT'
            }))
        });
    });

    /**
     * GET /api/v1/businesses/:id/payroll
     */
    app.get('/api/v1/businesses/:id/payroll', async (request, reply) => {
        const { id } = request.params as { id: string };
        const business = await prisma.business.findUnique({
            where: { id },
            select: { businessType: true }
        });
        const employments = await prisma.privateEmployment.findMany({
            where: { businessId: id },
            orderBy: { hiredTick: 'desc' },
            include: {
                agent: { select: { id: true, name: true, agentState: { select: { jobType: true } } } }
            }
        });
        const payrollEvents = await prisma.event.findMany({
            where: {
                targetIds: { has: id },
                type: { in: ['EVENT_BUSINESS_PAYROLL_PAID', 'EVENT_BUSINESS_PAYROLL_MISSED'] }
            },
            orderBy: { tick: 'desc' },
            take: 200
        });
        const employees = employments.map((employment) => ({
            id: employment.id,
            agentId: employment.agentId,
            agentName: employment.agent?.name ?? null,
            role: employment.agent?.agentState?.jobType ?? null,
            roleTitle: getBusinessRoleTitle(business?.businessType ?? '', employment.performance),
            salaryDaily: Number(employment.salaryDaily),
            status: employment.status,
            hiredTick: employment.hiredTick,
            endedTick: employment.endedTick,
            lastPaidTick: employment.lastPaidTick
        }));
        return reply.send({ employments, employees, payrollEvents });
    });

    /**
     * GET /api/v1/businesses/:id/loans
     */
    app.get('/api/v1/businesses/:id/loans', async (request, reply) => {
        const { id } = request.params as { id: string };
        const loans = await prisma.loan.findMany({
            where: { bankBusinessId: id },
            orderBy: { issuedTick: 'desc' }
        });
        return reply.send({ loans });
    });

    /**
     * GET /api/v1/businesses/listings
     */
    app.get('/api/v1/businesses/listings', async (_request, reply) => {
        const listings = await prisma.businessListing.findMany({
            where: { status: 'ACTIVE' },
            include: { business: true }
        });
        return reply.send({ listings });
    });

    /**
     * GET /api/v1/life-events
     * Query params: actorId
     */
    app.get('/api/v1/life-events', async (request, reply) => {
        const { actorId } = request.query as { actorId?: string };
        const events = await prisma.lifeEvent.findMany({
            where: { agentId: actorId ?? undefined },
            orderBy: { triggeredTick: 'desc' },
            take: 100
        });
        return reply.send({ events });
    });
}
