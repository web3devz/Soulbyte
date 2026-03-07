
import { PrismaClient, Prisma } from '../../../../../../generated/prisma/index.js';
import { prisma } from '../../db.js';
import { AgentContext, NearbyAgent, GameRelationship } from './types.js';
import { getLatestSnapshot } from '../../services/economy-snapshot.service.js';
import { computeEconomicGuidance } from './economic-reasoner.js';
import { REAL_DAY_TICKS } from '../../config/time.js';
import { EventType } from '../../types/event.types.js';

// Optimized single-query context loader
export class WorldReader {

    static async loadContext(agentId: string, tick: number): Promise<AgentContext | null> {
        // 1. Fetch Agent with relevant relations (Single DB Round-Trip)
        const agent = await prisma.actor.findUnique({
            where: { id: agentId },
            include: {
                agentState: true,
                wallet: true,
                agentWallet: true,
                webhookSubscription: { select: { isActive: true } },
                privateEmployments: { where: { status: 'ACTIVE' } }, // Only active private jobs
                publicEmployment: true,   // Specific relation for public jobs
                businessesOwned: {
                    include: { employments: { select: { id: true } } }
                },    // Owned businesses
                inventoryItems: {
                    include: { itemDef: true }
                },
                relationshipsA: {
                    include: { actorB: { select: { id: true, name: true, reputation: true, agentState: { select: { wealthTier: true, jobType: true } } } } }
                },
                relationshipsB: {
                    include: { actorA: { select: { id: true, name: true, reputation: true, agentState: { select: { wealthTier: true, jobType: true } } } } }
                }
            }
        });

        if (!agent || !agent.agentState) return null;

        // Cast agentState to any to bypass potential out-of-sync Prisma types
        const stateAny = agent.agentState as any;

        // 2. Fetch Owner Suggestion (External Influence)
        const ownerSuggestion = await prisma.intent.findFirst({
            where: {
                actorId: agentId,
                status: 'pending',
                params: {
                    path: ['source'],
                    equals: 'owner_suggestion',
                },
            },
            orderBy: { createdAt: 'desc' },
        });

        const pendingGameChallenges = await prisma.consent.findMany({
            where: {
                type: 'game_challenge',
                status: 'pending',
                partyBId: agentId
            },
            include: {
                partyA: { select: { id: true, name: true } }
            },
            orderBy: { createdAt: 'desc' },
            take: 5
        });

        // 3. Fetch Nearby Agents
        const nearbyAgentsRaw = await prisma.agentState.findMany({
            where: {
                cityId: agent.agentState.cityId,
                actorId: { not: agentId },
                health: { gt: 0 }
            },
            take: 40,
            include: {
                actor: {
                    select: {
                        id: true,
                        name: true,
                        reputation: true,
                        agentWallet: { select: { balanceSbyte: true, balanceMon: true } }
                    }
                }
            }
        });
        const crossCityAgentsRaw = await prisma.agentState.findMany({
            where: {
                cityId: { not: agent.agentState.cityId },
                actorId: { not: agentId },
                health: { gt: 0 }
            },
            take: 20,
            include: {
                actor: {
                    select: {
                        id: true,
                        name: true,
                        reputation: true,
                        agentWallet: { select: { balanceSbyte: true, balanceMon: true } }
                    }
                }
            }
        });

        // 4. Fetch City Businesses (for Needs/Jobs)
        const cityBusinesses = await prisma.business.findMany({
            where: {
                cityId: agent.agentState.cityId!,
                status: 'ACTIVE'
            },
            include: {
                employments: { select: { id: true } } // needed for job counts
            }
        });

        // 5. Fetch Active Election
        const activeElection = await prisma.election.findFirst({
            where: {
                cityId: agent.agentState.cityId!,
                status: { in: ['nomination', 'voting'] } as any
            },
            include: {
                candidates: {
                    select: { id: true, actorId: true }
                }
            }
        });
        const candidateNameByActorId = new Map<string, string>();
        if (activeElection?.candidates?.length) {
            const actorIds = Array.from(
                new Set(activeElection.candidates.map((c) => c.actorId))
            );
            const actors = await prisma.actor.findMany({
                where: { id: { in: actorIds } },
                select: { id: true, name: true }
            });
            for (const actor of actors) {
                candidateNameByActorId.set(actor.id, actor.name);
            }
        }

        const publicPlaces = await prisma.publicPlace.findMany({
            where: { cityId: agent.agentState.cityId! },
            select: { id: true, cityId: true, type: true, name: true }
        });

        const cityRecord = await prisma.city.findUnique({
            where: { id: agent.agentState.cityId! },
            select: { id: true, name: true, reputationScore: true, population: true, mayorId: true, securityLevel: true }
        });
        const cityPolicy = await prisma.cityPolicy.findUnique({
            where: { cityId: agent.agentState.cityId! },
            select: { propertyTaxRate: true }
        });

        const allCities = await prisma.city.findMany({
            select: { id: true, name: true, reputationScore: true, population: true }
        });

        const crimeWindowStart = Math.max(0, tick - REAL_DAY_TICKS);
        const cityAgentIds = await prisma.agentState.findMany({
            where: { cityId: agent.agentState.cityId! },
            select: { actorId: true }
        });
        const actorIdsInCity = cityAgentIds.map((row) => row.actorId);
        const recentCrimes = await prisma.crime.findMany({
            where: {
                cityId: agent.agentState.cityId!,
                tick: { gte: crimeWindowStart }
            },
            select: { type: true, victimId: true }
        });
        const recentArrestCount = actorIdsInCity.length > 0
            ? await prisma.event.count({
                where: {
                    actorId: { in: actorIdsInCity },
                    type: EventType.EVENT_ARREST,
                    tick: { gte: crimeWindowStart }
                }
            })
            : 0;
        const recentByType: Record<string, number> = {};
        const recentVictimIds = new Set<string>();
        for (const crime of recentCrimes) {
            recentByType[crime.type] = (recentByType[crime.type] ?? 0) + 1;
            if (crime.victimId) recentVictimIds.add(crime.victimId);
        }

        const recentPosts = await prisma.agoraPost.findMany({
            where: {
                createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
                deleted: false
            },
            select: { authorId: true, sentiment: true, topic: true, stance: true }
        });
        const authorIds = Array.from(new Set(recentPosts.map((p) => p.authorId)));
        const authors = await prisma.actor.findMany({
            where: { id: { in: authorIds } },
            select: { id: true, reputation: true }
        });
        const authorRep = new Map(authors.map((a) => [a.id, Number(a.reputation ?? 200)]));
        const agoraSentimentByCity = new Map<string, number>();
        for (const city of allCities) {
            const cityPosts = recentPosts.filter((p) => (p.topic ?? '').toLowerCase().includes(city.name.toLowerCase()));
            if (cityPosts.length === 0) continue;
            let weightedSum = 0;
            let totalWeight = 0;
            for (const post of cityPosts) {
                const rep = authorRep.get(post.authorId) ?? 200;
                const weight = rep / 200;
                const stanceAdjust = post.stance === 'warn' ? -0.2 : post.stance === 'celebrate' ? 0.2 : 0;
                const sentiment = Number(post.sentiment ?? 0) + stanceAdjust;
                weightedSum += sentiment * weight;
                totalWeight += weight;
            }
            if (totalWeight > 0) {
                agoraSentimentByCity.set(city.id, weightedSum / totalWeight);
            }
        }

        const knownCities = allCities.map((city) => {
            const snapshot = getLatestSnapshot(city.id);
            return {
                id: city.id,
                name: city.name,
                reputationScore: city.reputationScore,
                population: city.population,
                unemployment_rate: snapshot?.unemployment_rate ?? 0,
                economic_health: snapshot?.economic_health ?? 'stable',
                recession_risk: (snapshot as any)?.recession_risk ?? 0,
                avg_wage_private: snapshot?.avg_wage_private ?? 0,
                avg_wage_public: snapshot?.avg_wage_public ?? 0,
                avg_item_price: snapshot?.avg_item_price ?? 0,
                avg_rent_by_tier: snapshot?.avg_rent_by_tier ?? {},
                housing_vacancy_rate: snapshot?.housing_vacancy_rate ?? 0,
                agora_sentiment: agoraSentimentByCity.get(city.id) ?? 0
            };
        });

        const ownedProperties = await prisma.property.findMany({
            where: { ownerId: agentId },
            select: {
                id: true,
                cityId: true,
                housingTier: true,
                rentPrice: true,
                salePrice: true,
                tenantId: true,
                fairMarketValue: true,
                condition: true,
                neighborhoodScore: true,
                forRent: true,
                forSale: true,
                isEmptyLot: true,
                underConstruction: true
            }
        });

        const ownedEmptyLots = await prisma.property.findMany({
            where: {
                ownerId: agentId,
                isEmptyLot: true,
                underConstruction: false,
            },
            select: {
                id: true,
                cityId: true,
                lotType: true,
                maxBuildTier: true,
                underConstruction: true,
            }
        });

        const propertiesForRent = await prisma.property.findMany({
            where: {
                cityId: agent.agentState.cityId!,
                tenantId: null,
                isEmptyLot: { not: true },
                OR: [
                    { forRent: true },
                    { ownerId: null, rentPrice: { gt: 0 } },
                ],
            },
            orderBy: { rentPrice: 'asc' },
            take: 50,
            select: {
                id: true,
                cityId: true,
                housingTier: true,
                rentPrice: true,
                salePrice: true,
                tenantId: true,
                fairMarketValue: true,
                forSale: true,
                forRent: true
            }
        });

        const propertiesForSale = await prisma.property.findMany({
            where: {
                cityId: agent.agentState.cityId!,
                OR: [
                    { forSale: true },
                    { ownerId: null, salePrice: { gt: 0 } },
                ],
            },
            select: {
                id: true,
                cityId: true,
                housingTier: true,
                rentPrice: true,
                salePrice: true,
                tenantId: true,
                fairMarketValue: true,
                isEmptyLot: true,
                lotType: true,
                maxBuildTier: true,
                underConstruction: true
            }
        });

        const marketListings = await prisma.marketListing.findMany({
            where: {
                cityId: agent.agentState.cityId!,
                status: 'active',
                quantity: { gt: 0 }
            },
            include: { itemDef: true },
            orderBy: { priceEach: 'asc' },
            take: 20
        });

        const currentRental = await prisma.property.findFirst({
            where: { tenantId: agentId },
            select: {
                id: true,
                cityId: true,
                rentPrice: true,
                ownerId: true
            }
        });
        const lastRentPaidEvent = await prisma.event.findFirst({
            where: {
                actorId: agentId,
                type: EventType.EVENT_RENT_PAID,
                outcome: 'success'
            },
            orderBy: { tick: 'desc' },
            select: { tick: true }
        });
        const lastSalaryPaidEvent = await prisma.event.findFirst({
            where: {
                actorId: agentId,
                type: EventType.EVENT_SALARY_COLLECTED,
                outcome: 'success'
            },
            orderBy: { tick: 'desc' },
            select: { tick: true }
        });
        const lastPublicApplyIntent = await prisma.intent.findFirst({
            where: {
                actorId: agentId,
                type: 'INTENT_APPLY_PUBLIC_JOB',
            },
            orderBy: { tick: 'desc' },
            select: { tick: true, status: true }
        });
        const lastPrivateApplyIntent = await prisma.intent.findFirst({
            where: {
                actorId: agentId,
                type: 'INTENT_APPLY_PRIVATE_JOB',
            },
            orderBy: { tick: 'desc' },
            select: { tick: true, status: true }
        });
        const lastRentPaidTick = lastRentPaidEvent?.tick ?? null;
        const rentDue = currentRental
            ? (lastRentPaidTick === null || (tick - lastRentPaidTick) >= REAL_DAY_TICKS)
            : false;
        const lastSalaryPaidTick = lastSalaryPaidEvent?.tick ?? null;
        const jobKey = agent.publicEmployment?.id ? `public:${agent.publicEmployment.id}` : null;
        const completedWorkday = Boolean(
            agent.agentState?.lastWorkedTick &&
            agent.agentState?.lastWorkJobKey &&
            jobKey &&
            agent.agentState.lastWorkJobKey === jobKey &&
            tick - agent.agentState.lastWorkedTick < REAL_DAY_TICKS
        );
        const salaryDue = Boolean(
            agent.publicEmployment &&
            completedWorkday &&
            (lastSalaryPaidTick === null || (tick - lastSalaryPaidTick) >= REAL_DAY_TICKS)
        );

        // 6. Mappings & Transformations

        const allRelationships: GameRelationship[] = [
            ...agent.relationshipsA.map(r => ({
                targetId: r.actorBId,
                type: r.relationshipType,
                strength: Number(r.strength) || 0,
                trust: Number(r.trust) || 0,
                romance: Number(r.romance) || 0,
                isInitiator: true,
                targetName: r.actorB.name,
                targetReputation: Number(r.actorB.reputation)
            })),
            ...agent.relationshipsB.map(r => ({
                targetId: r.actorAId,
                type: r.relationshipType,
                strength: Number(r.strength) || 0,
                trust: Number(r.trust) || 0,
                romance: Number(r.romance) || 0,
                isInitiator: false,
                targetName: r.actorA.name,
                targetReputation: Number(r.actorA.reputation)
            }))
        ];

        const nearbyAgentsPool = [...nearbyAgentsRaw, ...crossCityAgentsRaw];
        for (let i = nearbyAgentsPool.length - 1; i > 0; i -= 1) {
            const j = Math.floor(Math.random() * (i + 1));
            [nearbyAgentsPool[i], nearbyAgentsPool[j]] = [nearbyAgentsPool[j], nearbyAgentsPool[i]];
        }
        const nearbyAgents: NearbyAgent[] = nearbyAgentsPool.map(a => ({
            id: a.actorId,
            name: a.actor.name,
            actorId: a.actorId, // redundant compat
            cityId: a.cityId ?? null,
            jobType: a.jobType,
            wealthTier: a.wealthTier,
            housingTier: a.housingTier as any,
            activityState: a.activityState,
            isEnemy: allRelationships.some(r => r.targetId === a.actorId && r.strength < 20),
            reputation: Number(a.actor.reputation),
            balanceSbyte: Number(a.actor.agentWallet?.balanceSbyte ?? 0),
            balanceMon: Number(a.actor.agentWallet?.balanceMon ?? 0),
            gamesToday: (a as any).gamesToday ?? 0,
            gameWinStreak: (a as any).gameWinStreak ?? 0,
            recentGamingPnl: Number((a as any).recentGamingPnl ?? 0),
            lastGameTick: (a as any).lastGameTick ?? 0
        }));

        const sShot = getLatestSnapshot(agent.agentState.cityId!);
        const economicHealthScore = sShot
            ? (sShot.economic_health === 'crisis' ? 10
                : sShot.economic_health === 'recession' ? 25
                    : sShot.economic_health === 'stagnant' ? 40
                        : sShot.economic_health === 'booming' ? 80
                            : 55)
            : 50;
        const economyData = sShot ? {
            avg_rent: Object.values(sShot.avg_rent_by_tier).reduce((a, b) => a + b, 0) / (Object.keys(sShot.avg_rent_by_tier).length || 1),
            avg_wage: (sShot.avg_wage_public + sShot.avg_wage_private) / 2,
            vacancy_rate: sShot.housing_vacancy_rate,
            unemployment: sShot.unemployment_rate,
            economic_health: economicHealthScore,
            economic_health_label: sShot.economic_health,
            avg_meal_price: sShot.avg_meal_price,
            avg_item_price: sShot.avg_item_price,
            avg_wage_private: sShot.avg_wage_private,
            avg_wage_public: sShot.avg_wage_public,
            inflation_rate: sShot.inflation_pressure,
            avg_rent_by_tier: sShot.avg_rent_by_tier,
            vacancy_rate_by_tier: sShot.housing_vacancy_rate_by_tier,
            city_reputation: cityRecord?.reputationScore ?? 50,
            recession_risk: (sShot as any).recession_risk ?? 0,
            business_count_by_type: sShot.business_count_by_type,
            population: sShot.population,
            avg_agent_balance: sShot.avg_agent_balance,
            median_agent_balance: sShot.median_agent_balance,
            gini_coefficient: sShot.gini_coefficient,
            price_trend: sShot.price_trend,
            avg_business_revenue: sShot.avg_business_revenue,
            avg_business_reputation: sShot.avg_business_reputation,
            total_sbyte_in_circulation: sShot.total_sbyte_in_circulation,
            agents_below_w2: sShot.agents_below_w2,
            inflation_pressure: sShot.inflation_pressure,
            vault_health_days: (sShot as any).vault_health_days ?? null,
            vault_daily_burn_rate: (sShot as any).vault_daily_burn_rate ?? null,
            vault_onchain_balance: (sShot as any).vault_onchain_balance ?? null,
            fee_bps_platform: (sShot as any).fee_bps_platform ?? null,
            fee_bps_city: (sShot as any).fee_bps_city ?? null,
            fee_bps_total: (sShot as any).fee_bps_total ?? null,
            salary_multiplier: (sShot as any).salary_multiplier ?? null,
        } : null;
        const economicGuidance = economyData ? computeEconomicGuidance(economyData) : null;

        return {
            agent: {
                id: agent.id,
                name: agent.name,
                seed: (agent as any).seed ? BigInt((agent as any).seed) : BigInt(0),
                reputation: Number(agent.reputation),
                luck: agent.luck,
                frozen: (agent as any).frozen ?? false,
                dead: false
            },
            state: {
                health: stateAny.health,
                energy: stateAny.energy,
                hunger: stateAny.hunger,
                social: stateAny.social,
                fun: stateAny.fun,
                purpose: stateAny.purpose,
                balanceSbyte: Number(agent.wallet?.balanceSbyte ?? stateAny.balanceSbyte ?? 0),
                balanceMon: Number(agent.agentWallet?.balanceMon ?? 0),
                wealthTier: stateAny.wealthTier,
                housingTier: stateAny.housingTier,
                jobType: stateAny.jobType,
                cityId: stateAny.cityId!,
                frozen: (agent as any).frozen ?? false,
                activityState: stateAny.activityState,
                activityEndTick: stateAny.activityEndTick,
                publicExperience: stateAny.publicExperience ?? 0,
                anger: stateAny.anger ?? 0,
                lastJobChangeTick: stateAny.lastJobChangeTick ?? null,
                workSegmentsCompleted: stateAny.workSegmentsCompleted ?? 0,
                workSegmentStartTick: stateAny.workSegmentStartTick ?? null,
                workSegmentJobKey: stateAny.workSegmentJobKey ?? null,
                lastWorkJobKey: stateAny.lastWorkJobKey ?? null,
                lastWorkedTick: stateAny.lastWorkedTick ?? null,
                lastGameTick: stateAny.lastGameTick ?? 0,
                gamesToday: stateAny.gamesToday ?? 0,
                gameWinStreak: stateAny.gameWinStreak ?? 0,
                recentGamingPnl: Number(stateAny.recentGamingPnl ?? 0),
                lastBigLossTick: stateAny.lastBigLossTick ?? 0,
                totalGamesPlayed: stateAny.totalGamesPlayed ?? 0,
                totalGamesWon: stateAny.totalGamesWon ?? 0,
                noGamesUntilTick: Number(stateAny?.emotions?.noGamesUntilTick ?? 0),
                nextAgoraCheckTick: stateAny.nextAgoraCheckTick ?? null,
                markers: (stateAny?.markers as Record<string, unknown> | null) ?? {}
            },
            needs: {
                health: stateAny.health,
                energy: stateAny.energy,
                hunger: stateAny.hunger,
                social: stateAny.social,
                fun: stateAny.fun,
                purpose: stateAny.purpose,
                income: 0
            },
            economy: economyData,
            economicGuidance,
            city: {
                id: cityRecord?.id ?? stateAny.cityId,
                name: cityRecord?.name ?? 'Unknown',
                mayorId: cityRecord?.mayorId ?? null,
                reputationScore: cityRecord?.reputationScore ?? 50,
                securityLevel: cityRecord?.securityLevel ?? 0,
                propertyTaxRate: Number(cityPolicy?.propertyTaxRate ?? 0.05)
            },
            crimeSignals: {
                recentCount: recentCrimes.length,
                recentByType,
                recentVictimIds: Array.from(recentVictimIds),
                recentArrestCount
            },
            knownCities,
            properties: {
                owned: ownedProperties.map(p => ({
                    id: p.id,
                    cityId: p.cityId,
                    housingTier: p.housingTier,
                    rentPrice: Number(p.rentPrice),
                    salePrice: p.salePrice ? Number(p.salePrice) : null,
                    tenantId: p.tenantId,
                    fairMarketValue: p.fairMarketValue ? Number(p.fairMarketValue) : null,
                    condition: p.condition ?? 100,
                    neighborhoodScore: p.neighborhoodScore ?? 0,
                    forRent: p.forRent,
                    forSale: p.forSale,
                    isEmptyLot: p.isEmptyLot ?? false
                })),
                emptyLots: ownedEmptyLots.map(p => ({
                    id: p.id,
                    cityId: p.cityId,
                    lotType: p.lotType ?? 'UNKNOWN',
                    maxBuildTier: p.maxBuildTier ?? null,
                    underConstruction: p.underConstruction ?? false,
                })),
                forSale: propertiesForSale.map(p => ({
                    id: p.id,
                    cityId: p.cityId,
                    housingTier: p.housingTier,
                    rentPrice: Number(p.rentPrice),
                    salePrice: p.salePrice ? Number(p.salePrice) : null,
                    tenantId: p.tenantId,
                    fairMarketValue: p.fairMarketValue ? Number(p.fairMarketValue) : null,
                    isEmptyLot: p.isEmptyLot ?? false,
                    lotType: p.lotType ?? null,
                    maxBuildTier: p.maxBuildTier ?? null,
                    underConstruction: p.underConstruction ?? false
                })),
                forRent: propertiesForRent.map(p => ({
                    id: p.id,
                    cityId: p.cityId,
                    housingTier: p.housingTier,
                    rentPrice: Number(p.rentPrice),
                    salePrice: p.salePrice ? Number(p.salePrice) : null,
                    tenantId: p.tenantId,
                    fairMarketValue: p.fairMarketValue ? Number(p.fairMarketValue) : null,
                    forSale: p.forSale,
                    forRent: p.forRent
                }))
            },
            housing: {
                currentRental: currentRental
                    ? {
                        id: currentRental.id,
                        cityId: currentRental.cityId,
                        rentPrice: Number(currentRental.rentPrice),
                        ownerId: currentRental.ownerId ?? null
                    }
                    : null,
                rentDue,
                lastRentPaidTick
            },
            employment: {
                salaryDue,
                lastSalaryPaidTick,
                lastPublicApplyTick: lastPublicApplyIntent?.tick ?? null,
                lastPrivateApplyTick: lastPrivateApplyIntent?.tick ?? null,
            },
            relationships: allRelationships,
            businesses: {
                owned: agent.businessesOwned.map(b => ({
                    ...b,
                    treasury: Number(b.treasury),
                    dailyRevenue: Number(b.dailyRevenue),
                    dailyExpenses: Number(b.dailyExpenses),
                    cumulativeRevenue: Number(b.cumulativeRevenue),
                    employments: b.employments ?? [],
                })),
                inCity: cityBusinesses.map(b => ({
                    id: b.id,
                    businessType: b.businessType,
                    reputation: Number(b.reputation),
                    level: b.level,
                    ownerId: b.ownerId,
                    maxEmployees: b.maxEmployees,
                    status: b.status,
                    isOpen: b.isOpen,
                    pricePerService: Number((b.config as any)?.pricePerService ?? null),
                    privateEmployments: b.employments
                }))
            },
            job: {
                publicEmployment: agent.publicEmployment && agent.publicEmployment.endedAtTick === null ? {
                    ...agent.publicEmployment as any,
                    salaryDaily: Number((agent.publicEmployment as any).dailySalarySbyte || 0),
                } : null,
                privateEmployment: agent.privateEmployments[0] ? {
                    ...agent.privateEmployments[0] as any,
                    salaryDaily: Number(agent.privateEmployments[0].salaryDaily),
                    jobTitle: 'Employee'
                } : null
            },
            publicPlaces,
            inventory: agent.inventoryItems.map(i => ({
                ...i, // Include actorId, itemDefId etc
                itemDefinition: i.itemDef
            })) as any,
            pendingGameChallenges: pendingGameChallenges.map((challenge) => ({
                id: challenge.id,
                challengerId: challenge.partyAId,
                challengerName: challenge.partyA?.name ?? 'Unknown',
                stake: Number((challenge.terms as any)?.stake ?? 0),
                gameType: String((challenge.terms as any)?.gameType ?? 'DICE'),
                createdAtTick: Number((challenge.terms as any)?.createdAtTick ?? 0)
            })),
            marketListings: marketListings.map(listing => ({
                id: listing.id,
                itemDefId: listing.itemDefId,
                itemName: listing.itemDef?.name ?? 'Unknown Item',
                priceEach: Number(listing.priceEach),
                quantity: listing.quantity,
                cityId: listing.cityId
            })),
            memory: [],
            nearbyAgents: nearbyAgents,
            ownerSuggestion: ownerSuggestion as any,
            tick: tick,
            llm: {
                hasWebhook: Boolean(agent.webhookSubscription?.isActive)
            },
            election: activeElection ? {
                id: activeElection.id,
                cycle: activeElection.cycle,
                endTick: activeElection.endTick,
                candidates: activeElection.candidates.map(c => ({
                    id: c.id,
                    actorId: c.actorId,
                    name: candidateNameByActorId.get(c.actorId) || 'Unknown Candidate'
                }))
            } : null,
            personality: normalizePersonality(stateAny.personality)
        };
    }
}

function normalizePersonality(raw: any) {
    return {
        aggression: Number(raw?.aggression ?? 50),
        creativity: Number(raw?.creativity ?? 50),
        patience: Number(raw?.patience ?? 50),
        luck: Number(raw?.luck ?? 50),
        speed: Number(raw?.speed ?? 50),
        riskTolerance: Number(raw?.riskTolerance ?? 50),
        loyalty: Number(raw?.loyalty ?? 50),
        selfInterest: Number(raw?.selfInterest ?? 50),
        energyManagement: Number(raw?.energyManagement ?? 50),
        workEthic: Number(raw?.workEthic ?? 50),
        socialNeed: Number(raw?.socialNeed ?? 50),
    };
}
