import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../db.js';
import { propertyRatingService } from '../services/property-rating.service.js';
import { authenticateApiKey } from '../middleware/openclaw-auth.js';
import { calculateAcceptanceProbability } from '../utils/openclaw-acceptance.js';
import { IntentStatus, IntentType } from '../types/intent.types.js';

export async function propertyRoutes(app: FastifyInstance) {
    /**
     * GET /api/v1/properties
     * Query: ?cityId=...&available=true
     * Back-compat alias for city listings.
     */
    app.get('/api/v1/properties', async (request: FastifyRequest, reply) => {
        const query = request.query as {
            cityId?: string;
            available?: string;
            limit?: string;
            offset?: string;
            sort?: 'rentPrice' | 'salePrice' | 'createdAt' | 'housingTier' | 'neighborhoodScore';
            direction?: 'asc' | 'desc';
        };
        const cityId = query.cityId;
        if (!cityId) {
            return reply.code(400).send({ error: 'Missing cityId' });
        }
        const isAvailable = query.available === 'true';
        const limit = parseInt(query.limit || '50', 10);
        const offset = parseInt(query.offset || '0', 10);
        const sortField = query.sort || 'rentPrice';
        const sortDirection = query.direction === 'desc' ? 'desc' : 'asc';
        const orderBy =
            sortField === 'salePrice'
                ? { salePrice: sortDirection }
                : sortField === 'createdAt'
                ? { createdAt: sortDirection }
                : sortField === 'housingTier'
                ? { housingTier: sortDirection }
                : sortField === 'neighborhoodScore'
                ? { neighborhoodScore: sortDirection }
                : { rentPrice: sortDirection };

        const whereClause: any = { cityId };
        if (isAvailable) {
            whereClause.OR = [
                { forRent: true, tenantId: null, isEmptyLot: { not: true } },
                { forSale: true, isEmptyLot: { not: true } },
                { ownerId: null, tenantId: null, isEmptyLot: { not: true }, rentPrice: { gt: 0 } },
                { ownerId: null, isEmptyLot: { not: true }, salePrice: { gt: 0 } },
            ];
        }

        const [properties, total] = await Promise.all([
            prisma.property.findMany({
                where: whereClause,
                take: limit,
                skip: offset,
                orderBy,
                select: {
                    id: true,
                    cityId: true,
                    housingTier: true,
                    rentPrice: true,
                    salePrice: true,
                    forRent: true,
                    forSale: true,
                    tenantId: true,
                    ownerId: true,
                    lotType: true,
                    maxBuildTier: true,
                    latitude: true,
                    longitude: true,
                    terrainWidth: true,
                    terrainHeight: true,
                    terrainArea: true,
                    condition: true,
                    neighborhoodScore: true,
                    underConstruction: true,
                    isEmptyLot: true,
                    createdAt: true
                }
            }),
            prisma.property.count({ where: whereClause })
        ]);

        return reply.send({
            properties: properties.map((p: any) => ({
                ...p,
                rentPrice: p.rentPrice?.toString(),
                salePrice: p.salePrice?.toString() ?? null
            })),
            total
        });
    });

    /**
     * GET /api/v1/properties/:id
     * Property detail view
     */
    app.get('/api/v1/properties/:id', async (request: FastifyRequest, reply) => {
        const { id } = request.params as { id: string };
        const property = await prisma.property.findUnique({ where: { id } });
        if (!property) return reply.code(404).send({ error: 'Property not found' });

        const [city, owner, tenant] = await Promise.all([
            prisma.city.findUnique({ where: { id: property.cityId }, select: { id: true, name: true } }),
            property.ownerId
                ? prisma.actor.findUnique({ where: { id: property.ownerId }, select: { id: true, name: true } })
                : Promise.resolve(null),
            property.tenantId
                ? prisma.actor.findUnique({ where: { id: property.tenantId }, select: { id: true, name: true } })
                : Promise.resolve(null),
        ]);

        const propertyName = property.lotType ? `${property.lotType} Property` : `${property.housingTier} Property`;

        return reply.send({
            property: {
                id: property.id,
                propertyName,
                cityId: property.cityId,
                cityName: city?.name ?? null,
                housingTier: property.housingTier,
                lotType: property.lotType ?? null,
                rentPrice: property.rentPrice?.toString() ?? null,
                salePrice: property.salePrice?.toString() ?? null,
                forRent: property.forRent,
                forSale: property.forSale,
                ownerId: property.ownerId ?? null,
                ownerName: owner?.name ?? null,
                tenantId: property.tenantId ?? null,
                tenantName: tenant?.name ?? null,
                terrainArea: property.terrainArea ?? null,
                condition: property.condition ?? null,
            }
        });
    });

    /**
     * POST /api/v1/properties/buy
     * Body: { propertyId: string, maxPrice?: number, priority?: number }
     * Requires Authorization: Bearer <api_key>
     */
    app.post('/api/v1/properties/buy', async (request: FastifyRequest, reply: FastifyReply) => {
        const auth = await authenticateApiKey(request.headers.authorization as string | undefined);
        if (!auth || auth.role !== 'agent' || !auth.actorId) {
            return reply.code(401).send({ error: 'Unauthorized' });
        }

        const body = request.body as { propertyId?: string; maxPrice?: number; priority?: number };
        if (!body?.propertyId) {
            return reply.code(400).send({ error: 'propertyId is required' });
        }

        const actor = await prisma.actor.findUnique({
            where: { id: auth.actorId },
            include: { jail: true, agentState: true },
        });
        if (!actor) return reply.code(404).send({ error: 'Actor not found' });
        if (actor.kind !== 'agent') return reply.code(400).send({ error: 'Only agents can buy properties' });
        if (actor.frozen) return reply.code(403).send({ error: 'Frozen actors cannot buy properties' });
        if (actor.jail) return reply.code(403).send({ error: 'Jailed actors cannot buy properties' });

        const worldState = await prisma.worldState.findFirst({ where: { id: 1 } });
        const currentTick = worldState?.tick ?? 0;

        const intent = await prisma.intent.create({
            data: {
                actorId: auth.actorId,
                type: IntentType.INTENT_BUY_PROPERTY,
                targetId: null,
                params: {
                    propertyId: body.propertyId,
                    maxPrice: body.maxPrice ?? undefined,
                    source: 'owner_suggestion'
                },
                priority: body.priority ?? 0.8,
                tick: currentTick,
                status: IntentStatus.PENDING,
            },
        });

        const acceptanceProbability = calculateAcceptanceProbability(actor.agentState, IntentType.INTENT_BUY_PROPERTY);

        return reply.code(200).send({
            intent_id: intent.id,
            status: intent.status,
            acceptance_probability: acceptanceProbability,
            message: 'Buy request submitted. Your agent will consider it.',
        });
    });

    /**
     * GET /api/v1/properties/:id/ratings
     */
    app.get('/api/v1/properties/:id/ratings', async (request: FastifyRequest, reply) => {
        const { id } = request.params as { id: string };
        const ratings = await prisma.propertyRating.findMany({
            where: { propertyId: id },
            orderBy: { createdAt: 'desc' }
        });
        return reply.send({ ratings });
    });

    /**
     * GET /api/v1/actors/:id/landlord-rating
     */
    app.get('/api/v1/actors/:id/landlord-rating', async (request: FastifyRequest, reply) => {
        const { id } = request.params as { id: string };
        const score = await propertyRatingService.getLandlordRating(id);
        return reply.send({ actorId: id, landlordRating: score });
    });

    /**
     * GET /api/v1/actors/:id/tenant-rating
     */
    app.get('/api/v1/actors/:id/tenant-rating', async (request: FastifyRequest, reply) => {
        const { id } = request.params as { id: string };
        const score = await propertyRatingService.getTenantRating(id);
        return reply.send({ actorId: id, tenantRating: score });
    });
}
