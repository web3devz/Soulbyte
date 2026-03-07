/**
 * Cities Routes
 * GET /api/v1/cities/:cityId - City details
 */
import { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma } from '../db.js';
import { getLatestSnapshot } from '../services/economy-snapshot.service.js';
import { REAL_DAY_TICKS } from '../config/time.js';

const humanizeEnumLabel = (value?: string | null) => {
    if (!value) return null;
    return value
        .toLowerCase()
        .split('_')
        .map((part) => (part.length > 0 ? part[0].toUpperCase() + part.slice(1) : part))
        .join(' ');
};

export async function citiesRoutes(app: FastifyInstance) {
    /**
     * GET /api/v1/cities/:cityId
     * Returns city details including policy, vault, and proposals
     */
    app.get('/api/v1/cities/:cityId', async (request: FastifyRequest, reply) => {
        const { cityId } = request.params as { cityId: string };

        try {
            const city = await prisma.city.findUnique({
                where: { id: cityId },
                include: {
                    policies: true,
                    vault: true,
                    proposals: {
                        orderBy: { createdAt: 'desc' },
                        take: 10,
                    },
                    mayor: {
                        select: {
                            id: true,
                            name: true,
                        },
                    },
                    _count: {
                        select: {
                            agentStates: true,
                        },
                    },
                },
            });

            if (!city) {
                return reply.code(404).send({
                    error: 'City not found',
                    details: `No city with id: ${cityId}`,
                });
            }

            const businesses = await prisma.business.findMany({
                where: { cityId },
                select: { id: true, status: true, isOpen: true, businessType: true, landId: true }
            });
            const landIds = businesses.map((b) => b.landId);
            const properties = landIds.length > 0
                ? await prisma.property.findMany({
                    where: { id: { in: landIds } },
                    select: { id: true, underConstruction: true }
                })
                : [];
            const propertyById = new Map(properties.map((property) => [property.id, property]));
            const totalBusinesses = businesses.length;
            const underConstruction = businesses.filter((b) => propertyById.get(b.landId)?.underConstruction).length;
            const activeBusinesses = businesses.filter((b) => b.isOpen && b.status === 'ACTIVE' && !propertyById.get(b.landId)?.underConstruction).length;
            const abandoned = businesses.filter((b) => !b.isOpen || ['BANKRUPT', 'DISSOLVED'].includes(b.status)).length;
            const categoryCounts = new Map<string, number>();
            businesses.forEach((business) => {
                const key = business.businessType.toLowerCase();
                categoryCounts.set(key, (categoryCounts.get(key) ?? 0) + 1);
            });
            const topCategories = Array.from(categoryCounts.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([category]) => category);

            const employeeStats = await prisma.privateEmployment.aggregate({
                where: { business: { cityId }, status: 'ACTIVE' },
                _count: { _all: true },
                _avg: { salaryDaily: true }
            });
            const totalEmployees = employeeStats._count?._all ?? 0;
            const averageWage = employeeStats._avg?.salaryDaily ? Number(employeeStats._avg.salaryDaily) : 0;

            return reply.send({
                city: {
                    id: city.id,
                    name: city.name,
                    population: city.population,
                    populationCap: city.populationCap,
                    currentResidents: city._count.agentStates,
                    housingCapacity: city.housingCapacity,
                    jobCapacity: city.jobCapacity,
                    securityLevel: city.securityLevel,
                    healthServices: city.healthServices,
                    entertainment: city.entertainment,
                    transport: city.transport,
                    reputationScore: city.reputationScore,
                    createdAt: city.createdAt,
                    mayor: city.mayor,
                    policy: city.policies ? {
                        rentTaxRate: city.policies.rentTaxRate.toString(),
                        tradeTaxRate: city.policies.tradeTaxRate.toString(),
                        professionTaxRate: city.policies.professionTaxRate.toString(),
                        cityFeeRate: city.policies.cityFeeRate.toString(),
                        businessTaxRate: city.policies.businessTaxRate?.toString() ?? '0.00',
                        propertyTaxRate: city.policies.propertyTaxRate?.toString() ?? '0.02',
                    } : null,
                    vault: {
                        balanceSbyte: city.vault?.balanceSbyte.toString() ?? '0',
                    },
                    recentProposals: city.proposals.map((p: { id: string; type: string; status: string; createdAt: Date }) => ({
                        id: p.id,
                        type: p.type,
                        status: p.status,
                        createdAt: p.createdAt,
                    })),
                    businessStats: {
                        totalBusinesses,
                        activeBusinesses,
                        underConstruction,
                        abandoned,
                        topCategories,
                        totalEmployees,
                        averageWage
                    }
                },
            });
        } catch (error) {
            console.error('Error fetching city:', error);
            return reply.code(500).send({ error: 'Internal server error' });
        }
    });

    /**
     * GET /api/v1/cities/:cityId/economy
     * Returns latest EconomicSnapshot for city
     */
    app.get('/api/v1/cities/:cityId/economy', async (request: FastifyRequest, reply) => {
        const { cityId } = request.params as { cityId: string };
        const snapshot = getLatestSnapshot(cityId);
        if (!snapshot) {
            return reply.code(404).send({ error: 'No snapshot available' });
        }
        return reply.send({ economy: snapshot });
    });

    /**
     * GET /api/v1/cities/:cityId/economy/summary
     * Returns latest snapshot with deltas
     */
    app.get('/api/v1/cities/:cityId/economy/summary', async (request: FastifyRequest, reply) => {
        const { cityId } = request.params as { cityId: string };
        const snapshot = getLatestSnapshot(cityId);
        if (!snapshot) {
            return reply.code(404).send({ error: 'No snapshot available' });
        }
        const previous = await prisma.economicSnapshot.findFirst({
            where: { cityId, computedAtTick: { lt: snapshot.computed_at_tick } },
            orderBy: { computedAtTick: 'desc' }
        });
        const previousData = previous?.data as any | undefined;
        const delta = (current: number | null | undefined, prior: number | null | undefined) => {
            if (current === null || current === undefined || prior === null || prior === undefined) return null;
            return current - prior;
        };

        const concerns: string[] = [];
        if (snapshot.unemployment_rate > 0.25) concerns.push('unemployment');
        if (snapshot.housing_vacancy_rate > 0.3) concerns.push('housing_cost');
        if (snapshot.crimes_last_period > 10) concerns.push('high_crime');

        return reply.send({
            snapshot,
            deltas: {
                unemployment_rate: delta(snapshot.unemployment_rate, previousData?.unemployment_rate),
                avg_rent: delta(snapshot.avg_rent, previousData?.avg_rent),
                avg_wage_private: delta(snapshot.avg_wage_private, previousData?.avg_wage_private),
                population: delta(snapshot.population, previousData?.population),
                inflation_pressure: delta(snapshot.inflation_pressure, previousData?.inflation_pressure)
            },
            topConcerns: concerns
        });
    });

    /**
     * GET /api/v1/cities/:cityId/health
     * Returns recession risk and population trend
     */
    app.get('/api/v1/cities/:cityId/health', async (request: FastifyRequest, reply) => {
        const { cityId } = request.params as { cityId: string };
        const snapshot = getLatestSnapshot(cityId);
        if (!snapshot) {
            return reply.code(404).send({ error: 'No snapshot available' });
        }

        const previous = await prisma.economicSnapshot.findFirst({
            where: { cityId, computedAtTick: { lt: snapshot.computed_at_tick } },
            orderBy: { computedAtTick: 'desc' }
        });
        const previousPopulation = (previous?.data as any)?.population ?? snapshot.population;
        const populationTrend = snapshot.population > previousPopulation
            ? 'growing'
            : snapshot.population < previousPopulation
                ? 'declining'
                : 'stable';

        const concerns: string[] = [];
        if (snapshot.unemployment_rate > 0.25) concerns.push('unemployment');
        if (snapshot.housing_vacancy_rate > 0.3) concerns.push('housing_cost');
        if (snapshot.crimes_last_period > 10) concerns.push('high_crime');

        return reply.send({
            recessionRisk: snapshot.recession_risk ?? 0,
            populationTrend,
            topConcerns: concerns,
            neighborhoodMap: null
        });
    });

    app.get('/api/v1/cities/:cityId/analytics/economy', async (request: FastifyRequest, reply) => {
        const { cityId } = request.params as { cityId: string };
        const snapshot = await prisma.cityAnalyticsSnapshot.findFirst({
            where: { cityId },
            orderBy: { tick: 'desc' }
        });
        return reply.send({ metrics: snapshot?.metrics ?? {} });
    });

    app.get('/api/v1/cities/:cityId/analytics/social', async (request, reply) => {
        const { cityId } = request.params as { cityId: string };
        const cityAgents = await prisma.agentState.findMany({
            where: { cityId },
            select: { actorId: true }
        });
        const actorIds = cityAgents.map((a) => a.actorId);
        if (actorIds.length === 0) {
            return reply.send({ metrics: { population: 0 } });
        }
        const [datingCount, marriageCount, relationshipCount, reputationAgg] = await Promise.all([
            prisma.consent.count({
                where: {
                    type: 'dating',
                    status: 'active',
                    OR: [
                        { cityId },
                        { cityId: null, partyAId: { in: actorIds }, partyBId: { in: actorIds } }
                    ]
                }
            }),
            prisma.consent.count({
                where: {
                    type: 'marriage',
                    status: 'active',
                    OR: [
                        { cityId },
                        { cityId: null, partyAId: { in: actorIds }, partyBId: { in: actorIds } }
                    ]
                }
            }),
            prisma.relationship.count({
                where: {
                    OR: [
                        { cityId },
                        { cityId: null, actorAId: { in: actorIds }, actorBId: { in: actorIds } }
                    ]
                }
            }),
            prisma.actor.aggregate({
                where: { id: { in: actorIds } },
                _avg: { reputation: true }
            })
        ]);

        return reply.send({
            metrics: {
                population: actorIds.length,
                activeDating: datingCount,
                activeMarriages: marriageCount,
                relationships: relationshipCount,
                averageReputation: reputationAgg._avg?.reputation ? Number(reputationAgg._avg.reputation) : 0
            }
        });
    });

    app.get('/api/v1/cities/:cityId/analytics/political', async (request, reply) => {
        const { cityId } = request.params as { cityId: string };
        const city = await prisma.city.findUnique({ where: { id: cityId }, select: { mayorId: true, securityLevel: true } });
        const [pendingProposals, recentElection, voteCount] = await Promise.all([
            prisma.cityProposal.count({ where: { cityId, status: 'pending' } }),
            prisma.election.findFirst({
                where: { cityId },
                orderBy: { createdAt: 'desc' },
                select: { id: true, status: true, startTick: true, endTick: true }
            }),
            prisma.vote.count({
                where: {
                    election: { cityId }
                }
            })
        ]);

        return reply.send({
            metrics: {
                mayorId: city?.mayorId ?? null,
                securityLevel: city?.securityLevel ?? 0,
                pendingProposals,
                lastElection: recentElection ?? null,
                totalVotes: voteCount
            }
        });
    });

    app.get('/api/v1/cities/:cityId/analytics/history', async (request: FastifyRequest, reply) => {
        const { cityId } = request.params as { cityId: string };
        const history = await prisma.cityAnalyticsSnapshot.findMany({
            where: { cityId },
            orderBy: { tick: 'desc' },
            take: 50
        });
        return reply.send({ history });
    });

    app.get('/api/v1/cities/:cityId/trending-agents', async (request, reply) => {
        const { cityId } = request.params as { cityId: string };
        const worldState = await prisma.worldState.findFirst({ where: { id: 1 } });
        const currentTick = worldState?.tick ?? 0;
        const startTick = Math.max(0, currentTick - REAL_DAY_TICKS);

        const cityAgents = await prisma.agentState.findMany({
            where: { cityId },
            select: { actorId: true }
        });
        const actorIds = cityAgents.map((a) => a.actorId);
        if (actorIds.length === 0) {
            return reply.send({ trending: [] });
        }

        const TRENDING_EVENT_WEIGHTS: Record<string, number> = {
            EVENT_BUSINESS_FOUNDED: 8,
            EVENT_BUSINESS_CONVERTED: 8,
            EVENT_PROPOSAL_SUBMITTED: 6,
            EVENT_CITY_UPGRADED: 6,
            EVENT_CRIME_COMMITTED: 4,
            EVENT_ARREST: 4,
            EVENT_AGORA_POSTED: 2,
            EVENT_WORK_COMPLETED: 1
        };
        const trackedTypes = Object.keys(TRENDING_EVENT_WEIGHTS);
        const [eventCounts, actors] = await Promise.all([
            prisma.event.groupBy({
                by: ['actorId', 'type'],
                where: {
                    actorId: { in: actorIds },
                    tick: { gte: startTick },
                    outcome: 'success',
                    type: { in: trackedTypes }
                },
                _count: { _all: true }
            }),
            prisma.actor.findMany({
                where: { id: { in: actorIds } },
                select: {
                    id: true,
                    name: true,
                    reputation: true,
                    wallet: { select: { balanceSbyte: true } }
                }
            })
        ]);

        const eventScoreByActor = new Map<string, { score: number; eventCount: number }>();
        for (const row of eventCounts) {
            const weight = TRENDING_EVENT_WEIGHTS[row.type] ?? 0;
            const cappedCount = Math.min(row._count._all, 5);
            const entry = eventScoreByActor.get(row.actorId) ?? { score: 0, eventCount: 0 };
            entry.score += weight * cappedCount;
            entry.eventCount += row._count._all;
            eventScoreByActor.set(row.actorId, entry);
        }
        const scored = actors.map((actor) => {
            const eventScore = eventScoreByActor.get(actor.id) ?? { score: 0, eventCount: 0 };
            const reputation = Number(actor.reputation ?? 0);
            const balance = Number(actor.wallet?.balanceSbyte ?? 0);
            const score = eventScore.score + (reputation / 100) + (balance / 1000);
            return {
                actorId: actor.id,
                name: actor.name,
                score,
                reputation,
                eventCount: eventScore.eventCount,
                balanceSbyte: balance
            };
        });

        scored.sort((a, b) => b.score - a.score);
        return reply.send({ trending: scored.slice(0, 10) });
    });

    /**
     * GET /api/v1/cities/:cityId/properties
     * Returns properties in the city (listings)
     * Query: ?available=true (returns only forRent or forSale)
     */
    app.get('/api/v1/cities/:cityId/properties', async (request: FastifyRequest, reply) => {
        const { cityId } = request.params as { cityId: string };
        const query = request.query as {
            available?: string;
            limit?: string;
            offset?: string;
            sort?: 'rentPrice' | 'salePrice' | 'createdAt' | 'housingTier' | 'neighborhoodScore';
            direction?: 'asc' | 'desc';
        };
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

        try {
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
                orderBy, // Default cheap-first unless overridden
                select: {
                    id: true,
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

            const actorIds = Array.from(
                new Set(
                    properties
                        .flatMap((property) => [property.ownerId, property.tenantId])
                        .filter((value): value is string => Boolean(value))
                )
            );

            const actors = actorIds.length > 0
                ? await prisma.actor.findMany({
                    where: { id: { in: actorIds } },
                    select: { id: true, name: true }
                })
                : [];

            const actorNameById = new Map(actors.map((actor) => [actor.id, actor.name]));

            return reply.send({
                properties: properties.map((p: any) => {
                    const status = p.underConstruction
                        ? 'under_construction'
                        : p.forSale
                            ? 'for_sale'
                            : p.tenantId
                                ? 'occupied'
                                : p.forRent
                                    ? 'available'
                                    : p.ownerId
                                        ? 'owned'
                                        : 'abandoned';
                    const maxOccupants = p.housingTier === 'shelter' || p.housingTier === 'slum_room'
                        ? 1
                        : p.housingTier === 'apartment' || p.housingTier === 'condo'
                            ? 2
                            : p.housingTier === 'house' || p.housingTier === 'villa'
                                ? 4
                                : p.housingTier === 'estate' || p.housingTier === 'palace' || p.housingTier === 'citadel'
                                    ? 6
                                    : 1;
                    return ({
                    ...p,
                    rentPrice: p.rentPrice?.toString(),
                    salePrice: p.salePrice?.toString() ?? null,
                    ownerName: p.ownerId ? actorNameById.get(p.ownerId) ?? null : null,
                    tenantName: p.tenantId ? actorNameById.get(p.tenantId) ?? null : null,
                    propertyType: p.lotType ?? p.housingTier ?? null,
                    name: p.lotType || p.housingTier
                        ? `${humanizeEnumLabel(p.lotType ?? p.housingTier)} Property`
                        : null,
                    status,
                    lot_size: p.terrainArea ?? 0,
                    coordinates: p.latitude != null && p.longitude != null
                        ? {
                            lat: Number(p.latitude),
                            lng: Number(p.longitude),
                            latitude: Number(p.latitude),
                            longitude: Number(p.longitude)
                        }
                        : null
                    ,
                    neighborhoodScore: p.neighborhoodScore ?? 0,
                    condition: p.condition ?? 100,
                    maxOccupants,
                    currentOccupants: p.tenantId ? 1 : 0,
                    constructionDate: p.createdAt?.toISOString() ?? null,
                    lastRenovated: null
                });
                }),
                total
            });

        } catch (error) {
            console.error('Error fetching properties:', error);
            return reply.code(500).send({ error: 'Internal server error' });
        }
    });

    /**
     * GET /api/v1/cities/:cityId/properties/summary
     * Returns housing availability summary
     */
    app.get('/api/v1/cities/:cityId/properties/summary', async (request: FastifyRequest, reply) => {
        const { cityId } = request.params as { cityId: string };

        try {
            const [total, availableForRent, availableForSale, occupied] = await Promise.all([
                prisma.property.count({ where: { cityId } }),
                prisma.property.count({ where: { cityId, forRent: true, tenantId: null } }),
                prisma.property.count({ where: { cityId, forSale: true } }),
                prisma.property.count({ where: { cityId, tenantId: { not: null } } })
            ]);

            return reply.send({
                cityId,
                total,
                availableForRent,
                availableForSale,
                occupied
            });
        } catch (error) {
            console.error('Error fetching property summary:', error);
            return reply.code(500).send({ error: 'Internal server error' });
        }
    });

    /**
     * GET /api/v1/cities/available
     * Returns lightweight city list with snapshot stats
     */
    app.get('/api/v1/cities/available', async (_request: FastifyRequest, reply) => {
        const cities = await prisma.city.findMany({
            select: {
                id: true,
                name: true,
            },
        });

        const withStats = await Promise.all(
            cities.map(async (city) => {
                const snapshot = await prisma.economicSnapshot.findFirst({
                    where: { cityId: city.id },
                    orderBy: { computedAtTick: 'desc' },
                });
                const data = snapshot?.data as any;
                return {
                    id: city.id,
                    name: city.name,
                    population: data?.population ?? 0,
                    unemployment_rate: data?.unemployment_rate ?? 0,
                    economic_health: data?.economic_health ?? 'unknown',
                };
            })
        );

        return reply.send({ cities: withStats });
    });

    /**
     * GET /api/v1/cities
     * Returns list of all cities
     */
    app.get('/api/v1/cities', async (_request, reply) => {
        try {
            const cities = await prisma.city.findMany({
                include: {
                    vault: true,
                    _count: {
                        select: { agentStates: true },
                    },
                },
            });

            return reply.send({
                cities: cities.map((city: { id: string; name: string; population: number; _count: { agentStates: number }; vault: { balanceSbyte: unknown } | null }) => ({
                    id: city.id,
                    name: city.name,
                    population: city.population,
                    currentResidents: city._count.agentStates,
                    vaultBalance: city.vault?.balanceSbyte.toString() ?? '0',
                })),
            });
        } catch (error) {
            console.error('Error fetching cities:', error);
            return reply.code(500).send({ error: 'Internal server error' });
        }
    });
}
