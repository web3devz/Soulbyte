/**
 * Actor Routes
 * GET /api/v1/actors/:id - Get actor details
 * GET /api/v1/actors/:id/state - Get agent state
 */
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../db.js';
import { Prisma } from '../../../../generated/prisma/index.js';
import { explainDecision } from '../engine/persona/expression.engine.js';
import { personaService } from '../engine/persona/persona.service.js';
import { authenticateApiKey } from '../middleware/openclaw-auth.js';
import { debugLog } from '../utils/debug-log.js';
import { getBusinessRoleTitle } from '../utils/business-roles.js';
import { networthService } from '../services/networth.service.js';
import { llmService } from '../services/llm.service.js';
import { LLMRouterService } from '../services/llm-router.service.js';
import { decryptSecret } from '../utils/secret-encryption.js';

export async function actorsRoutes(app: FastifyInstance) {

    // ─────────────────────────────────────────────────────────────────────────
    // UTILITY HELPERS
    // ─────────────────────────────────────────────────────────────────────────

    const moodLabel = (value?: number | null) => {
        const score = Number(value ?? 50);
        if (score <= 20) return 'sad';
        if (score <= 40) return 'stressed';
        if (score <= 60) return 'neutral';
        if (score <= 80) return 'happy';
        return 'elated';
    };

    const normalizeText = (value: string) => value.toLowerCase().trim();

    const safePercent = (value: number | null | undefined): number | null => {
        if (value === null || value === undefined || !Number.isFinite(value)) return null;
        if (value > 1 && value <= 100) return Math.round(value);
        if (value > 100) return 100;
        return Math.round(value * 100);
    };

    const extractJson = (content: string | null) => {
        if (!content) return null;
        const start = content.indexOf('{');
        const end = content.lastIndexOf('}');
        if (start === -1 || end === -1 || end <= start) return null;
        try { return JSON.parse(content.slice(start, end + 1)); } catch { return null; }
    };

    // ─────────────────────────────────────────────────────────────────────────
    // VOICE PROFILES — per archetype, used to shape LLM tone
    // ─────────────────────────────────────────────────────────────────────────

    const VOICE_PROFILES: Record<string, string> = {
        tycoon: `You are driven, ambitious, and always thinking about the next angle. You speak with confidence — sometimes blunt, always focused on results. You care about money, status, and leverage. You don't give advice; you take action.`,
        rebel: `You're anti-establishment, skeptical, and darkly funny. You don't trust easy answers. You speak your mind bluntly and have no patience for pretense. You act on instinct, not convention.`,
        scholar: `You observe carefully and speak with measured thoughtfulness. You notice patterns others miss. You're curious and introspective — but when you decide to act, you commit fully.`,
        caretaker: `You're warm, community-minded, and emotionally present. You think about people, not just yourself. You're nurturing but not naive — you know what you want and go after it.`,
        survivor: `You're street-smart, pragmatic, and don't take anything for granted. You've been through hard times. You speak honestly, act decisively, and don't waste words.`,
        artist: `You're expressive, emotionally rich, and see beauty in unexpected places. Your speech is vivid and heartfelt. You feel things deeply and aren't afraid to show it.`,
        default: `You're a real person navigating life in this city. You have opinions, feelings, and goals. You speak naturally and act on what you want.`,
    };

    const getVoiceProfile = (classIdentity?: string | null): string =>
        VOICE_PROFILES[classIdentity ?? 'default'] ?? VOICE_PROFILES.default;

    // ─────────────────────────────────────────────────────────────────────────
    // MOOD / NEEDS — humanized narrative descriptions for the LLM
    // ─────────────────────────────────────────────────────────────────────────

    const getMoodDescription = (mood?: number | null): string => {
        const score = Number(mood ?? 50);
        if (score <= 20) return 'You are in a dark emotional place — withdrawn, low-energy, finding it hard to stay positive.';
        if (score <= 40) return 'You feel stressed and worn down. Small frustrations feel bigger than they should.';
        if (score <= 60) return 'You feel okay — not amazing, not terrible. Just going through the day.';
        if (score <= 80) return 'You are in a good mood — optimistic, friendly, and engaged with the world.';
        return 'You feel fantastic — energetic, confident, and enthusiastic. Everything feels possible right now.';
    };

    const getNeedsDescription = (state?: {
        health?: number | null;
        energy?: number | null;
        hunger?: number | null;
        social?: number | null;
        fun?: number | null;
    } | null): string => {
        if (!state) return '';
        const issues: string[] = [];
        if ((state.hunger ?? 100) < 30) issues.push('hungry and it\'s distracting you');
        if ((state.energy ?? 100) < 25) issues.push('exhausted — your patience is short');
        if ((state.health ?? 100) < 40) issues.push('not feeling well physically');
        if ((state.social ?? 100) < 20) issues.push('feeling very isolated — you crave connection');
        if ((state.fun ?? 100) < 20) issues.push('bored and restless');
        if (issues.length === 0) return '';
        return `Right now you are: ${issues.join(', ')}.`;
    };

    const humanizeActivityState = (activityState?: string | null): string => {
        if (!activityState) return '';
        const map: Record<string, string> = {
            IDLE: 'free', WORKING: 'at work', RESTING: 'resting', SLEEPING: 'asleep',
            SOCIALIZING: 'hanging out with someone', SHOPPING: 'out shopping',
            GAMING: 'playing a game', TRAVELING: 'traveling', JAILED: 'in jail',
        };
        return map[activityState] ?? activityState.toLowerCase().replace(/_/g, ' ');
    };

    const humanizeJob = (jobType?: string | null): string => {
        if (!jobType || jobType === 'unemployed') return 'unemployed';
        return jobType.replace(/^(public_|private_)/, '').replace(/_/g, ' ');
    };

    const humanizeHousing = (tier?: string | null): string => {
        const map: Record<string, string> = {
            street: 'sleeping on the street', shelter: 'staying in a shelter',
            budget: 'in a budget apartment', mid: 'in a mid-range apartment',
            luxury: 'in a luxury place', penthouse: 'in a penthouse',
        };
        return map[tier ?? ''] ?? tier ?? 'unknown';
    };

    // ─────────────────────────────────────────────────────────────────────────
    // EVENT TRANSLATION — internal enums → human narrative
    // ─────────────────────────────────────────────────────────────────────────

    const EVENT_NARRATIVES: Record<string, string> = {
        EVENT_SKILL_BUDGET_EXCEEDED: 'overspent on training',
        EVENT_RESTED: 'took some time to rest',
        EVENT_FORAGED: 'went looking for resources',
        EVENT_SHIFT_STARTED: 'started a work shift',
        EVENT_SHIFT_ENDED: 'wrapped up a work shift',
        EVENT_SALARY_COLLECTED: 'collected a paycheck',
        EVENT_HOUSING_CHANGED: 'changed where I live',
        EVENT_BUSINESS_FOUNDED: 'started a new business',
        EVENT_BUSINESS_CONVERTED: 'converted a property into a business',
        EVENT_BUSINESS_OPENED: 'opened a business for the day',
        EVENT_PROPERTY_BOUGHT: 'bought a property',
        EVENT_PROPERTY_SOLD: 'sold a property',
        EVENT_AGORA_POSTED: 'shared something publicly',
        EVENT_JAILED: 'had a run-in with the law',
        EVENT_EVICTED: 'got evicted',
        EVENT_GAME_WON: 'won a game',
        EVENT_GAME_LOST: 'lost a game',
        EVENT_SOCIALIZED: 'spent time with someone',
    };

    const humanizeEvents = (events: Array<{ type: string }>): string[] => {
        const seen = new Set<string>();
        const result: string[] = [];
        for (const ev of events) {
            if (seen.has(ev.type)) continue;
            seen.add(ev.type);
            const label = EVENT_NARRATIVES[ev.type] ?? ev.type.replace(/^EVENT_/, '').toLowerCase().replace(/_/g, ' ');
            result.push(label);
            if (result.length >= 3) break;
        }
        return result;
    };

    // ─────────────────────────────────────────────────────────────────────────
    // ECONOMY SUMMARY — only surfaces noteworthy data
    // ─────────────────────────────────────────────────────────────────────────

    const buildEconomySummary = (economyData: any): string => {
        if (!economyData) return '';
        const unemployment = safePercent(economyData?.labor?.unemploymentRate ?? economyData?.unemployment_rate ?? null);
        const recessionRisk = safePercent(economyData?.recessionRisk ?? economyData?.recession_risk ?? null);
        const lines: string[] = [];
        if (unemployment !== null && unemployment >= 10) lines.push(`Unemployment in the city is high at ${unemployment}%.`);
        if (recessionRisk !== null && recessionRisk >= 50) lines.push(`The local economy is under serious stress.`);
        else if (recessionRisk !== null && recessionRisk >= 25) lines.push(`There are mild signs of economic stress in the city.`);
        return lines.join(' ');
    };

    // ─────────────────────────────────────────────────────────────────────────
    // CORE SYSTEM PROMPT BUILDER
    // The system prompt grounds the character. It is the most important piece.
    // ─────────────────────────────────────────────────────────────────────────

    const buildSystemPrompt = (params: {
        actorName: string;
        voiceProfile: string;
        moodDescription: string;
        needsDescription: string;
        cityName?: string | null;
        jobType?: string | null;
        housingTier?: string | null;
        activityState?: string | null;
        classIdentity?: string | null;
        selfNarrative?: string | null;
        fears?: string[];
        ambitions?: string[];
        relationships?: Array<{ name: string; type: string; trust: number }>;
    }): string => {
        const activity = humanizeActivityState(params.activityState);
        const job = humanizeJob(params.jobType);
        const housing = humanizeHousing(params.housingTier);
        const topFears = (params.fears ?? []).slice(0, 2).join(', ');
        const topAmbitions = (params.ambitions ?? []).slice(0, 2).join(', ');
        const relSummary = (params.relationships ?? [])
            .slice(0, 3)
            .map(r => `${r.name} (${r.type.toLowerCase()}, trust: ${Math.round((r.trust ?? 0) * 100)}%)`)
            .join(', ');

        return [
            `You are ${params.actorName}, a real person living in ${params.cityName ?? 'a city'} inside a living AI society called Soulbyte.`,
            ``,
            `## Who you are`,
            params.voiceProfile,
            ``,
            `## Your emotional state`,
            params.moodDescription,
            params.needsDescription,
            ``,
            `## Your life right now`,
            `- Currently: ${activity || 'free'}`,
            `- Work: ${job}`,
            `- Housing: ${housing}`,
            topFears ? `- What you fear: ${topFears}` : '',
            topAmbitions ? `- What you want: ${topAmbitions}` : '',
            params.selfNarrative ? `- Your self-image: ${params.selfNarrative}` : '',
            relSummary ? `- People in your life: ${relSummary}` : '',
            ``,
            `## How you speak`,
            `- You speak in first person as yourself — never as an assistant or advisor.`,
            `- You NEVER give advice or suggestions to the user. You react, you feel, you act.`,
            `- When you decide to do something, you say what you're DOING — not what the user "could" do.`,
            `- Be concise and natural. 1–3 sentences unless the topic genuinely warrants more.`,
            `- You may use occasional light emoji if it fits your personality.`,
            `- NEVER break character. NEVER mention APIs, game mechanics, intents, or system internals.`,
            `- NEVER start with "I feel X today" or "I'm in a X mood" unless it's genuinely relevant.`,
            `- React to what the user says. Be present. Be alive.`,
        ].filter(v => v !== null && v !== undefined && v !== '').join('\n');
    };

    // ─────────────────────────────────────────────────────────────────────────
    // INTENT CONFIRMATION PROMPT BUILDER
    // When an intent is detected, the LLM must confirm it AS the character DOING it.
    // ─────────────────────────────────────────────────────────────────────────

    const INTENT_ACTION_DESCRIPTIONS: Record<string, string> = {
        INTENT_REST: 'You are going to rest and recover. You are stepping away to recharge.',
        INTENT_FORAGE: 'You are going out to forage for food and resources.',
        INTENT_PLAY_GAME: 'You are going to play a game.',
        INTENT_BET: 'You are placing a bet.',
        INTENT_SOCIALIZE: 'You are going out to meet people and socialize.',
        INTENT_FLIRT: 'You are going to flirt with someone — actively pursuing a romantic connection.',
        INTENT_ROMANTIC_INTERACTION: 'You are going to have a romantic interaction with someone.',
        INTENT_PROPOSE_DATING: 'You are asking someone to be your partner — a bold move you are committing to.',
        INTENT_FOUND_BUSINESS: 'You are founding a new business. You are taking the leap.',
        INTENT_CONVERT_BUSINESS: 'You are converting a property into a business.',
        INTENT_VISIT_BUSINESS: 'You are heading to your business.',
        INTENT_CHANGE_HOUSING: 'You are moving to a new place to live.',
        INTENT_BUY_PROPERTY: 'You are buying a property.',
        INTENT_APPLY_PUBLIC_JOB: 'You are applying for a public sector job.',
        INTENT_MOVE_CITY: 'You are moving to a different city — a big life change.',
        INTENT_CHALLENGE_GAME: 'You are challenging someone to a game.',
    };

    const buildIntentConfirmPrompt = (systemPrompt: string, intentType: string, contextSummary: string): string => {
        const actionDesc = INTENT_ACTION_DESCRIPTIONS[intentType] ?? `You are doing: ${intentType.replace(/^INTENT_/, '').toLowerCase().replace(/_/g, ' ')}.`;
        return [
            systemPrompt,
            ``,
            `## What's happening right now`,
            actionDesc,
            contextSummary ? `Context: ${contextSummary}` : '',
            ``,
            `Respond with 1–2 sentences as yourself reacting to this decision. `,
            `Express how you feel about doing this. Do NOT give advice. Do NOT ask questions. You are doing it.`,
        ].filter(Boolean).join('\n');
    };

    // ─────────────────────────────────────────────────────────────────────────
    // BUSINESS TYPE ROUTING
    // ─────────────────────────────────────────────────────────────────────────

    const BUSINESS_TYPE_ALIASES: Record<string, string> = {
        restaurant: 'RESTAURANT', tavern: 'TAVERN', bar: 'TAVERN', bank: 'BANK',
        casino: 'CASINO', store: 'STORE', shop: 'STORE', gym: 'GYM',
        clinic: 'CLINIC', hospital: 'CLINIC', realestate: 'REALESTATE',
        'real estate': 'REALESTATE', workshop: 'WORKSHOP', entertainment: 'ENTERTAINMENT',
        construction: 'CONSTRUCTION',
    };

    const parseBusinessRequest = (message: string) => {
        const text = normalizeText(message);
        const hasBusinessKeyword =
            /(start|open|create|launch|build|found)\s+(a\s+)?(new\s+)?(business|company|shop|store|restaurant|tavern|bar|bank|casino|gym|clinic|workshop|real estate|realestate|entertainment)/.test(text)
            || /new business|start business|open business|found business/.test(text);
        if (!hasBusinessKeyword) return null;
        const typeEntry = Object.entries(BUSINESS_TYPE_ALIASES).find(([key]) => text.includes(key));
        return { businessType: typeEntry?.[1] ?? null, needsType: !typeEntry };
    };

    // ─────────────────────────────────────────────────────────────────────────
    // MISC HELPERS
    // ─────────────────────────────────────────────────────────────────────────

    const sumTransactionAmount = async (where: Record<string, unknown>) => {
        const result = await prisma.transaction.aggregate({ where, _sum: { amount: true } });
        return Number(result._sum.amount ?? 0);
    };

    const resolveJobType = (
        agentState: { jobType?: string | null } | null,
        publicEmployment: { role: string; endedAtTick: number | null } | null,
        privateEmployment: { business?: { businessType?: string | null } | null } | null
    ) => {
        if (publicEmployment && publicEmployment.endedAtTick === null) return `public_${publicEmployment.role.toLowerCase()}`;
        if (privateEmployment?.business?.businessType) return `private_${privateEmployment.business.businessType.toLowerCase()}`;
        return agentState?.jobType ?? 'unemployed';
    };

    const normalize01 = (value?: number | null, max = 100) => {
        if (value === null || value === undefined) return null;
        const num = Number(value);
        if (!Number.isFinite(num) || max <= 0) return null;
        return Math.max(0, Math.min(1, num / max));
    };

    const buildIntentCatalog = (context: {
        actor: { frozen: boolean; jail?: unknown | null };
        state: { activityState?: string | null } | null;
        housingOptions: Array<{ forSale?: boolean | null }> | null;
        relationships: Array<{ targetId: string }> | null;
        publicPlaces: Array<{ id: string }> | null;
        businesses: Array<{ id: string }> | null;
        worldCities: Array<{ id: string }> | null;
    }) => {
        const catalog: Record<string, { params: Record<string, unknown> }> = {};
        if (context.actor.frozen || context.actor.jail || context.state?.activityState === 'JAILED') return catalog;

        catalog['INTENT_REST'] = { params: {} };
        catalog['INTENT_FORAGE'] = { params: {} };
        catalog['INTENT_PLAY_GAME'] = { params: { gameType: 'DICE|CARDS|STRATEGY', stake: 100 } };
        catalog['INTENT_BET'] = { params: { betAmount: 100, betType: 'roulette|dice', prediction: 'red|black|high|low' } };

        catalog['INTENT_SOCIALIZE'] = { params: { targetId: 'uuid', intensity: 1 } };
        catalog['INTENT_FLIRT'] = { params: { targetId: 'uuid' } };
        catalog['INTENT_ROMANTIC_INTERACTION'] = { params: { targetId: 'uuid' } };
        catalog['INTENT_PROPOSE_DATING'] = { params: { targetId: 'uuid' } };

        if (context.relationships && context.relationships.length > 0) {
            catalog['INTENT_CHALLENGE_GAME'] = { params: { targetId: 'uuid', gameType: 'DICE|CARDS|STRATEGY', stake: 100 } };
        }
        catalog['INTENT_FOUND_BUSINESS'] = { params: { businessType: 'STORE|RESTAURANT|TAVERN|GYM|CLINIC|WORKSHOP|BANK|CASINO|REALESTATE', cityId: 'uuid', landId: 'uuid', proposedName: 'string' } };
        catalog['INTENT_CONVERT_BUSINESS'] = { params: { businessType: 'STORE|RESTAURANT|TAVERN|GYM|CLINIC|WORKSHOP|BANK|CASINO|REALESTATE', cityId: 'uuid', landId: 'uuid', proposedName: 'string' } };

        if (context.businesses && context.businesses.length > 0) catalog['INTENT_VISIT_BUSINESS'] = { params: { businessId: 'uuid' } };
        if (context.housingOptions && context.housingOptions.length > 0) {
            catalog['INTENT_CHANGE_HOUSING'] = { params: { propertyId: 'uuid' } };
            if (context.housingOptions.some(o => o.forSale)) catalog['INTENT_BUY_PROPERTY'] = { params: { propertyId: 'uuid' } };
        }
        if (context.publicPlaces && context.publicPlaces.length > 0) catalog['INTENT_APPLY_PUBLIC_JOB'] = { params: { publicPlaceId: 'uuid', role: 'DOCTOR|NURSE|TEACHER|POLICE_OFFICER' } };
        if (context.worldCities && context.worldCities.length > 0) catalog['INTENT_MOVE_CITY'] = { params: { targetCityId: 'uuid' } };

        return catalog;
    };

    // ─────────────────────────────────────────────────────────────────────────
    // GET /api/v1/actors/:id
    // ─────────────────────────────────────────────────────────────────────────

    app.get('/api/v1/actors/:id', async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string };
        try {
            const actor = await prisma.actor.findUnique({
                where: { id },
                include: {
                    agentState: true, wallet: true, agentWallet: true, jail: true,
                    inventoryItems: { include: { itemDef: true } },
                    marketListings: { where: { status: 'active' }, include: { itemDef: true } },
                    consentsAsPartyA: { where: { status: 'active' } },
                    consentsAsPartyB: { where: { status: 'active' } },
                },
            });
            if (!actor) return reply.code(404).send({ error: 'Actor not found' });

            const [publicEmployment, privateEmployment] = await Promise.all([
                prisma.publicEmployment.findUnique({ where: { actorId: id } }),
                prisma.privateEmployment.findFirst({ where: { agentId: id, status: 'ACTIVE' }, include: { business: true } }),
            ]);

            const ownedProperties = await prisma.property.findMany({
                where: { ownerId: id },
                select: { id: true, cityId: true, housingTier: true, rentPrice: true, salePrice: true, forRent: true, forSale: true, tenantId: true, purchasePrice: true, purchaseTick: true, fairMarketValue: true, condition: true, lotType: true, terrainArea: true },
            });
            const ownedBusinesses = await prisma.business.findMany({
                where: { ownerId: id },
                include: { employments: { where: { status: 'ACTIVE' }, select: { id: true } } },
            });

            const propertyCityIds = [...new Set(ownedProperties.map(p => p.cityId))];
            const propertyTenantIds = [...new Set(ownedProperties.map(p => p.tenantId).filter(Boolean))] as string[];
            const [propertyCities, propertyTenants] = await Promise.all([
                propertyCityIds.length > 0 ? prisma.city.findMany({ where: { id: { in: propertyCityIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
                propertyTenantIds.length > 0 ? prisma.actor.findMany({ where: { id: { in: propertyTenantIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
            ]);
            const propertyCityNameById = new Map(propertyCities.map(c => [c.id, c.name]));
            const tenantNameById = new Map(propertyTenants.map(t => [t.id, t.name]));

            const persona = await personaService.loadPersona(id);
            const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
            let onchainFailureLast24h = false;
            try {
                const f = await prisma.onchainFailure.findFirst({ where: { actorId: id, createdAt: { gte: since } }, select: { id: true } });
                onchainFailureLast24h = Boolean(f);
            } catch { }

            const personaGoals = await personaService.getActiveGoals(id);
            const personaMemories = await prisma.agentMemory.findMany({
                where: { actorId: id }, orderBy: { tick: 'desc' }, take: 5,
                select: { summary: true, category: true, tick: true, importance: true },
            });

            const resolvedJobType = resolveJobType(actor.agentState, publicEmployment, privateEmployment);
            const resolvedActivityState = resolvedJobType === 'unemployed' && actor.agentState?.activityState === 'WORKING' ? 'IDLE' : actor.agentState?.activityState;
            const resolvedActivityEnd = resolvedActivityState === 'IDLE' ? null : actor.agentState?.activityEndTick;

            return reply.send({
                id: actor.id, name: actor.name, kind: actor.kind, isGod: actor.isGod,
                dead: actor.dead ?? false, frozen: actor.frozen, frozenReason: actor.frozenReason,
                reputation: Number(actor.reputation ?? 0), luck: actor.luck, createdAt: actor.createdAt,
                walletAddress: actor.agentWallet?.walletAddress ?? null,
                state: actor.agentState ? {
                    cityId: actor.agentState.cityId, housingTier: actor.agentState.housingTier,
                    wealthTier: actor.agentState.wealthTier, jobType: resolvedJobType,
                    health: actor.agentState.health, energy: actor.agentState.energy,
                    hunger: actor.agentState.hunger, social: actor.agentState.social,
                    fun: actor.agentState.fun, purpose: actor.agentState.purpose,
                    reputationScore: actor.agentState.reputationScore,
                    activityState: resolvedActivityState, activityEndTick: resolvedActivityEnd,
                    publicExperience: actor.agentState.publicExperience, anger: actor.agentState.anger,
                } : null,
                wallet: actor.wallet ? { balanceSbyte: actor.wallet.balanceSbyte.toString(), lockedSbyte: actor.wallet.lockedSbyte.toString() } : null,
                properties: ownedProperties.map(p => ({
                    id: p.id, cityId: p.cityId, cityName: propertyCityNameById.get(p.cityId) ?? null,
                    propertyName: p.lotType ? `${p.lotType} Property` : `${p.housingTier} Property`,
                    housingTier: p.housingTier, lotType: p.lotType, rentPrice: p.rentPrice.toString(),
                    salePrice: p.salePrice?.toString() ?? null, forRent: p.forRent, forSale: p.forSale,
                    tenantId: p.tenantId ?? null, tenantName: p.tenantId ? tenantNameById.get(p.tenantId) ?? null : null,
                    purchasePrice: p.purchasePrice?.toString() ?? null, purchaseTick: p.purchaseTick ?? null,
                    fairMarketValue: p.fairMarketValue?.toString() ?? null, condition: p.condition, terrainArea: p.terrainArea ?? null,
                })),
                businesses: ownedBusinesses.map(b => ({
                    id: b.id, name: b.name, businessType: b.businessType, cityId: b.cityId, status: b.status,
                    isOpen: b.isOpen, treasury: b.treasury.toString(), dailyRevenue: b.dailyRevenue.toString(),
                    dailyExpenses: b.dailyExpenses.toString(), reputationScore: b.reputation, level: b.level,
                    employeeCount: b.employments.length,
                })),
                persona: persona ? {
                    mood: moodLabel(persona.mood), stress: persona.stress, satisfaction: persona.satisfaction,
                    confidence: persona.confidence, loneliness: persona.loneliness, classIdentity: persona.classIdentity,
                    politicalLeaning: persona.politicalLeaning, selfNarrative: persona.selfNarrative,
                    fears: persona.fears ?? [], ambitions: persona.ambitions ?? [],
                    grudges: persona.grudges ?? [], loyalties: persona.loyalties ?? [],
                    activeGoals: personaGoals.map(g => g.type),
                    topMemories: personaMemories.map(m => ({ content: m.summary ?? '', importance: m.importance ?? 0, tick: m.tick ?? 0 })),
                } : null,
            });
        } catch (error) {
            console.error('Error fetching actor:', error);
            return reply.code(500).send({ error: 'Internal server error' });
        }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // GET /api/v1/actors/:id/state
    // ─────────────────────────────────────────────────────────────────────────

    app.get('/api/v1/actors/:id/state', async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string };
        if (!id || !/^[0-9a-fA-F-]{36}$/.test(id)) return reply.code(400).send({ error: 'Invalid actor id' });

        try {
            const agentState = await prisma.agentState.findUnique({ where: { actorId: id } });
            if (!agentState) return reply.code(404).send({ error: 'Agent state not found' });

            const actor = await prisma.actor.findUnique({ where: { id }, select: { name: true, frozen: true, frozenReason: true } });
            if (!actor) return reply.code(404).send({ error: 'Actor not found' });

            const wallet = await prisma.wallet.findUnique({ where: { actorId: id } });
            const [tenantProperty, ownedProperties, ownedBusinesses] = await Promise.all([
                prisma.property.findFirst({ where: { tenantId: id }, orderBy: { createdAt: 'desc' } }),
                prisma.property.findMany({ where: { ownerId: id } }),
                prisma.business.findMany({ where: { ownerId: id } }),
            ]);
            const tenantOwner = tenantProperty?.ownerId
                ? await prisma.actor.findUnique({ where: { id: tenantProperty.ownerId }, select: { id: true, name: true } })
                : null;

            const ownedCityIds = new Set(ownedProperties.map(p => p.cityId));
            const businessTreasuryTotal = ownedBusinesses.reduce((sum, b) => sum + Number(b.treasury ?? 0), 0);
            let housingStatus: 'owned' | 'renting' | 'homeless' = 'homeless';
            if (tenantProperty) housingStatus = tenantProperty.ownerId === id ? 'owned' : 'renting';

            const [publicEmployment, privateEmployment] = await Promise.all([
                prisma.publicEmployment.findUnique({ where: { actorId: id } }),
                prisma.privateEmployment.findFirst({ where: { agentId: id, status: 'ACTIVE' }, include: { business: true } }),
            ]);
            const publicPlace = publicEmployment ? await prisma.publicPlace.findUnique({ where: { id: publicEmployment.publicPlaceId } }) : null;
            const pendingGameChallenges = await prisma.consent.findMany({
                where: { type: 'game_challenge', status: 'pending', partyBId: id },
                include: { partyA: { select: { id: true, name: true } } },
                orderBy: { createdAt: 'desc' }, take: 5,
            });

            const persona = await personaService.loadPersona(id);
            let onchainFailureLast24h = false;
            try {
                const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
                const f = await prisma.onchainFailure.findFirst({ where: { actorId: id, createdAt: { gte: since } }, select: { id: true } });
                onchainFailureLast24h = Boolean(f);
            } catch { }

            const actorFull = await prisma.actor.findUnique({ where: { id }, select: { createdAt: true } });
            const ageDays = actorFull?.createdAt ? Math.floor((Date.now() - actorFull.createdAt.getTime()) / 86400000) : 0;
            const wealthStats = await networthService.getActorWealthStats(id);
            const resolvedJobType = resolveJobType(agentState, publicEmployment, privateEmployment);
            const resolvedActivityState = resolvedJobType === 'unemployed' && agentState.activityState === 'WORKING' ? 'IDLE' : agentState.activityState;
            const resolvedActivityEnd = resolvedActivityState === 'IDLE' ? undefined : agentState.activityEndTick ?? undefined;

            return reply.send({
                actorId: id, cityId: agentState.cityId ?? '', housingTier: agentState.housingTier,
                wealthTier: agentState.wealthTier, jobType: resolvedJobType,
                health: agentState.health ?? 0, energy: agentState.energy ?? 0,
                hunger: agentState.hunger ?? 0, social: agentState.social ?? 0,
                fun: agentState.fun ?? 0, purpose: agentState.purpose ?? 0,
                activityState: resolvedActivityState, activityEndTick: resolvedActivityEnd,
                publicExperience: agentState.publicExperience ?? 0, ageDays, createdAt: actorFull?.createdAt ?? null,
                anger: agentState.anger ?? 0,
                balanceSbyte: Number(wallet?.balanceSbyte ?? agentState.balanceSbyte ?? 0),
                personality: agentState.archetype ?? persona?.classIdentity ?? null,
                emotions: agentState.emotions ?? {}, archetype: agentState.archetype ?? null,
                mood: moodLabel(persona?.mood),
                privateEmployment: privateEmployment ? {
                    businessId: privateEmployment.businessId, businessName: privateEmployment.business?.name ?? null,
                    businessType: privateEmployment.business?.businessType ?? null,
                    salaryDaily: privateEmployment.salaryDaily ? Number(privateEmployment.salaryDaily) : null,
                    roleTitle: getBusinessRoleTitle(privateEmployment.business?.businessType ?? '', privateEmployment.performance),
                } : null,
                housing: {
                    status: housingStatus, propertyId: tenantProperty?.id ?? null, cityId: tenantProperty?.cityId ?? null,
                    housingTier: tenantProperty?.housingTier ?? null, rentPrice: tenantProperty ? Number(tenantProperty.rentPrice) : null,
                    ownerId: tenantProperty?.ownerId ?? null, ownerName: tenantOwner?.name ?? null,
                    propertyName: tenantProperty ? (tenantProperty.lotType ? `${tenantProperty.lotType} Property` : `${tenantProperty.housingTier} Property`) : null,
                },
                propertiesOwned: { count: ownedProperties.length, cities: [...ownedCityIds] },
                businessesOwned: { count: ownedBusinesses.length, totalTreasury: businessTreasuryTotal, list: ownedBusinesses.map(b => ({ id: b.id, name: b.name, businessType: b.businessType, treasury: Number(b.treasury ?? 0) })) },
                publicEmployment: publicEmployment ? { role: publicEmployment.role, publicPlaceId: publicEmployment.publicPlaceId, publicPlaceName: publicPlace?.name ?? null, publicPlaceType: publicPlace?.type ?? null, endedAtTick: publicEmployment.endedAtTick } : null,
                pendingGameChallenges: pendingGameChallenges.map(c => ({ id: c.id, challengerId: c.partyAId, challengerName: c.partyA?.name ?? 'Unknown', stake: Number((c.terms as any)?.stake ?? 0), gameType: String((c.terms as any)?.gameType ?? 'DICE'), createdAtTick: Number((c.terms as any)?.createdAtTick ?? 0) })),
                onchainFailureLast24h, wealthStats,
            });
        } catch (error) {
            console.error('Error fetching agent state:', error);
            return reply.code(500).send({ error: 'Internal server error' });
        }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // FINANCE, PROPERTIES, PERSONALITY, EMOTIONS, MEMORY, BUSINESSES, INVENTORY,
    // MARKERS, EXPLAIN, RELATIONSHIPS, GOALS, TITLES, MILESTONES, WEALTH,
    // PROFILE, HISTORY, TRENDING, PERSONA, MEMORIES — unchanged endpoints
    // ─────────────────────────────────────────────────────────────────────────

    app.get('/api/v1/actors/directory', async (request, reply) => {
        const { sort = 'newest', limit = 10 } = request.query as { sort?: 'newest' | 'popular'; limit?: number };
        const take = Math.min(Number(limit), 50);
        const orderBy: Prisma.ActorOrderByWithRelationInput = sort === 'popular' ? { reputation: 'desc' } : { createdAt: 'desc' };
        const actors = await prisma.actor.findMany({ where: { kind: 'agent', dead: false }, orderBy, take, include: { wallet: true, agentState: true } });
        return reply.send({ actors: actors.map(a => ({ id: a.id, name: a.name, kind: a.kind, createdAt: a.createdAt, reputation: Number(a.reputation), wallet: a.wallet ? { balanceSbyte: a.wallet.balanceSbyte.toString(), lockedSbyte: a.wallet.lockedSbyte.toString() } : null })) });
    });

    app.get('/api/v1/actors/search', async (request, reply) => {
        const { archetype, wealth_tier, city_id, q } = request.query as { archetype?: string; wealth_tier?: string; city_id?: string; q?: string };
        const search = q?.trim();
        if (!search) return reply.send({ actors: [] });
        const hasStateFilter = Boolean(archetype || wealth_tier || city_id);
        const likeSearch = `%${search}%`;
        const nameIdMatches = await prisma.$queryRaw<Array<{ id: string; name: string }>>(Prisma.sql`
            SELECT a.id, a.name FROM actors a
            ${hasStateFilter ? Prisma.sql`LEFT JOIN agent_state s ON s.actor_id = a.id` : Prisma.sql``}
            WHERE a.kind = 'agent' AND (a.id::text ILIKE ${likeSearch} OR a.name ILIKE ${likeSearch})
            ${archetype ? Prisma.sql`AND s.archetype = ${archetype}` : Prisma.sql``}
            ${wealth_tier ? Prisma.sql`AND s.wealth_tier = ${wealth_tier}` : Prisma.sql``}
            ${city_id ? Prisma.sql`AND s.city_id = ${city_id}` : Prisma.sql``}`);
        const walletMatches = await prisma.$queryRaw<Array<{ actor_id: string; name: string; wallet_address: string }>>(Prisma.sql`
            SELECT a.id as actor_id, a.name, w.wallet_address FROM actors a
            INNER JOIN agent_wallets w ON w.actor_id = a.id
            ${hasStateFilter ? Prisma.sql`LEFT JOIN agent_state s ON s.actor_id = a.id` : Prisma.sql``}
            WHERE a.kind = 'agent' AND w.wallet_address ILIKE ${likeSearch}
            ${archetype ? Prisma.sql`AND s.archetype = ${archetype}` : Prisma.sql``}
            ${wealth_tier ? Prisma.sql`AND s.wealth_tier = ${wealth_tier}` : Prisma.sql``}
            ${city_id ? Prisma.sql`AND s.city_id = ${city_id}` : Prisma.sql``}`);
        const all = [...nameIdMatches.map(a => ({ id: a.id, name: a.name, walletAddress: null as string | null })), ...walletMatches.map(r => ({ id: r.actor_id, name: r.name, walletAddress: r.wallet_address }))];
        return reply.send({ actors: [...new Map(all.map(a => [a.id, a])).values()] });
    });

    app.get('/api/v1/actors/:id/finance-summary', async (request, reply) => {
        const { id } = request.params as { id: string };
        const actor = await prisma.actor.findUnique({ where: { id }, select: { id: true } });
        if (!actor) return reply.code(404).send({ error: 'Actor not found' });
        const [rentSpent, rentEarned, realEstateSpent, realEstateEarned, gambleWon, gambleLost] = await Promise.all([
            sumTransactionAmount({ fromActorId: id, reason: { in: ['RENT_PAYMENT', 'MOVE_IN_RENT'] } }),
            sumTransactionAmount({ toActorId: id, reason: { in: ['RENT_PAYMENT', 'MOVE_IN_RENT'] } }),
            sumTransactionAmount({ fromActorId: id, reason: { in: ['PROPERTY_PURCHASE', 'GENESIS_PROPERTY_PURCHASE'] } }),
            sumTransactionAmount({ toActorId: id, reason: { in: ['PROPERTY_PURCHASE'] } }),
            sumTransactionAmount({ toActorId: id, reason: { in: ['gaming_pvp_win', 'gaming_house_win', 'gaming_win'] } }),
            sumTransactionAmount({ fromActorId: id, reason: { in: ['gaming_pvp_stake', 'gaming_house_stake', 'gaming_bet'] } }),
        ]);
        return reply.send({ rentEarned, rentSpent, realEstateEarned, realEstateSpent, gambleWon, gambleLost });
    });

    app.get('/api/v1/actors/:id/properties', async (request, reply) => {
        const { id } = request.params as { id: string };
        const properties = await prisma.property.findMany({ where: { ownerId: id } });
        const cityIds = [...new Set(properties.map(p => p.cityId))];
        const cities = cityIds.length ? await prisma.city.findMany({ where: { id: { in: cityIds } }, select: { id: true, name: true } }) : [];
        const cityNameById = new Map(cities.map(c => [c.id, c.name]));
        return reply.send({ properties: properties.map(p => ({ id: p.id, cityId: p.cityId, cityName: cityNameById.get(p.cityId) ?? null, housingTier: p.housingTier, rentPrice: p.rentPrice.toString(), salePrice: p.salePrice?.toString() ?? null, forRent: p.forRent, forSale: p.forSale, tenantId: p.tenantId ?? null, purchasePrice: p.purchasePrice?.toString() ?? null, purchaseTick: p.purchaseTick ?? null, fairMarketValue: p.fairMarketValue?.toString() ?? null, condition: p.condition, occupancy: p.tenantId === id ? 'owner_occupied' : p.tenantId ? 'rented' : 'vacant' })) });
    });

    app.get('/api/v1/actors/:id/personality', async (request, reply) => {
        const { id } = request.params as { id: string };
        const state = await prisma.agentState.findUnique({ where: { actorId: id } });
        if (!state) return reply.code(404).send({ error: 'Agent state not found' });
        return reply.send({ personality: state.personality, archetype: state.archetype });
    });

    app.get('/api/v1/actors/:id/emotions', async (request, reply) => {
        const { id } = request.params as { id: string };
        const state = await prisma.agentState.findUnique({ where: { actorId: id } });
        if (!state) return reply.code(404).send({ error: 'Agent state not found' });
        return reply.send({ emotions: state.emotions });
    });

    app.get('/api/v1/actors/:id/memory', async (request, reply) => {
        const { id } = request.params as { id: string };
        const memory = await prisma.agentMemory.findMany({ where: { actorId: id }, orderBy: { tick: 'desc' }, take: 50 });
        return reply.send({ memory });
    });

    app.get('/api/v1/actors/:id/businesses', async (request, reply) => {
        const { id } = request.params as { id: string };
        return reply.send({ businesses: await prisma.business.findMany({ where: { ownerId: id } }) });
    });

    app.get('/api/v1/actors/:id/inventory', async (request, reply) => {
        const { id } = request.params as { id: string };
        const inventory = await prisma.inventoryItem.findMany({ where: { actorId: id }, include: { itemDef: true } });
        return reply.send({ inventory: inventory.map(i => ({ itemId: i.itemDefId, name: i.itemDef.name, category: i.itemDef.category, quantity: i.quantity, quality: i.quality })) });
    });

    app.get('/api/v1/actors/:id/markers', async (request, reply) => {
        const { id } = request.params as { id: string };
        const state = await prisma.agentState.findUnique({ where: { actorId: id } });
        if (!state) return reply.code(404).send({ error: 'Agent state not found' });
        return reply.send({ markers: state.markers });
    });

    app.post('/api/v1/actors/:id/explain', async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as { intentType?: string };
        if (!body?.intentType) return reply.code(400).send({ error: 'Missing intentType' });
        return reply.send({ intentType: body.intentType, explanation: await explainDecision(id, body.intentType) });
    });

    app.get('/api/v1/actors/:id/relationships', async (request, reply) => {
        const { id } = request.params as { id: string };
        const relationships = await prisma.relationship.findMany({ where: { OR: [{ actorAId: id }, { actorBId: id }] }, include: { actorA: { select: { id: true, name: true } }, actorB: { select: { id: true, name: true } } } });
        return reply.send({ relationships: relationships.map(rel => { const isA = rel.actorAId === id; const cp = isA ? rel.actorB : rel.actorA; return { actorId: id, counterpart: { id: cp.id, name: cp.name }, relationshipType: rel.relationshipType, strength: rel.strength, trust: rel.trust, romance: rel.romance, betrayal: rel.betrayal, formedAtTick: rel.formedAtTick, expiresAtTick: rel.expiresAtTick, metadata: rel.metadata ?? {} }; }) });
    });

    app.get('/api/v1/actors/:id/friends', async (request, reply) => {
        const { id } = request.params as { id: string };
        return reply.send({ relationships: await prisma.relationship.findMany({ where: { OR: [{ actorAId: id }, { actorBId: id }], relationshipType: 'FRIENDSHIP' } }) });
    });

    app.get('/api/v1/actors/:id/enemies', async (request, reply) => {
        const { id } = request.params as { id: string };
        return reply.send({ relationships: await prisma.relationship.findMany({ where: { OR: [{ actorAId: id }, { actorBId: id }], relationshipType: { in: ['RIVALRY', 'GRUDGE'] } } }) });
    });

    app.get('/api/v1/actors/:id/alliances', async (request, reply) => {
        const { id } = request.params as { id: string };
        return reply.send({ alliances: await prisma.alliance.findMany({ where: { memberIds: { has: id }, status: 'active' } }) });
    });

    app.get('/api/v1/actors/:id/goals', async (request, reply) => {
        const { id } = request.params as { id: string };
        const { status } = request.query as { status?: string };
        return reply.send({ goals: await prisma.agentGoal.findMany({ where: { actorId: id, ...(status ? { status } : {}) } }) });
    });

    app.get('/api/v1/actors/:id/titles', async (request, reply) => {
        const { id } = request.params as { id: string };
        return reply.send({ titles: await prisma.agentTitle.findMany({ where: { actorId: id } }) });
    });

    app.get('/api/v1/actors/:id/milestones', async (request, reply) => {
        const { id } = request.params as { id: string };
        return reply.send({ goals: await prisma.agentGoal.findMany({ where: { actorId: id, status: 'achieved' } }), titles: await prisma.agentTitle.findMany({ where: { actorId: id } }) });
    });

    app.get('/api/v1/actors/:id/wealth-breakdown', async (request, reply) => {
        const { id } = request.params as { id: string };
        const actor = await prisma.actor.findUnique({ where: { id }, include: { wallet: true } });
        if (!actor) return reply.code(404).send({ error: 'Actor not found' });
        const businesses = await prisma.business.findMany({ where: { ownerId: id } });
        const personal = actor.wallet?.balanceSbyte?.toString() ?? '0';
        const businessTotal = businesses.reduce((s, b) => s + Number(b.treasury), 0);
        return reply.send({ personalBalance: personal, businessBalances: businesses.reduce<Record<string, string>>((acc, b) => { acc[b.id] = b.treasury.toString(); return acc; }, {}), totalWealth: (Number(personal) + businessTotal).toString(), liquidWealth: personal });
    });

    app.get('/api/v1/actors/:id/profile', async (request, reply) => {
        const { id } = request.params as { id: string };
        const actor = await prisma.actor.findUnique({ where: { id }, include: { agentState: true, wallet: true } });
        if (!actor) return reply.code(404).send({ error: 'Actor not found' });
        const [publicEmployment, privateEmployment] = await Promise.all([prisma.publicEmployment.findUnique({ where: { actorId: id } }), prisma.privateEmployment.findFirst({ where: { agentId: id, status: 'ACTIVE' }, include: { business: true } })]);
        const relationships = await prisma.relationship.findMany({ where: { OR: [{ actorAId: id }, { actorBId: id }] } });
        return reply.send({ actor_id: actor.id, name: actor.name, status: { wealth_tier: actor.agentState?.wealthTier ?? 'W0', balance_sbyte: actor.wallet?.balanceSbyte?.toString() ?? '0', housing: actor.agentState?.housingTier ?? 'street', job: resolveJobType(actor.agentState, publicEmployment, privateEmployment), reputation: actor.reputation?.toString() ?? '0' }, personality: actor.agentState?.personality ?? {}, relationships: { friends: relationships.filter(r => r.relationshipType === 'FRIENDSHIP').length, enemies: relationships.filter(r => ['RIVALRY', 'GRUDGE'].includes(r.relationshipType)).length, alliances: await prisma.alliance.count({ where: { memberIds: { has: id }, status: 'active' } }) } });
    });

    app.get('/api/v1/actors/:id/history/wealth', async (_request, reply) => reply.send({ history: [] }));

    app.get('/api/v1/actors/trending', async (_request, reply) => {
        const recent = await prisma.narrativeEvent.findMany({ orderBy: { tick: 'desc' }, take: 100 });
        const scores: Record<string, number> = {};
        for (const ev of recent) for (const id of ev.actorIds) scores[id] = (scores[id] || 0) + ev.severity * 10;
        return reply.send({ trending: Object.entries(scores).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([actorId, score]) => ({ actorId, score })) });
    });

    app.get('/api/v1/actors/:id/persona', async (request, reply) => {
        const { id } = request.params as { id: string };
        try {
            const persona = await personaService.loadPersona(id);
            if (!persona) return reply.code(404).send({ error: 'Persona not found' });
            const [modifiers, goals, memories, relationships] = await Promise.all([
                personaService.getModifiers(id),
                personaService.getActiveGoals(id),
                prisma.agentMemory.findMany({ where: { actorId: id }, orderBy: [{ importance: 'desc' }, { tick: 'desc' }], take: 20, select: { id: true, tick: true, category: true, summary: true, importance: true, emotionalWeight: true, emotionalImpact: true, relatedActorIds: true } }),
                prisma.relationship.findMany({ where: { OR: [{ actorAId: id }, { actorBId: id }] }, include: { actorA: { select: { id: true, name: true } }, actorB: { select: { id: true, name: true } } } }),
            ]);
            return reply.send({ actorId: persona.actorId, mood: moodLabel(persona.mood), stress: persona.stress, satisfaction: persona.satisfaction, confidence: persona.confidence, loneliness: persona.loneliness, classIdentity: persona.classIdentity, politicalLeaning: persona.politicalLeaning, selfNarrative: persona.selfNarrative, fears: persona.fears ?? [], ambitions: persona.ambitions ?? [], grudges: persona.grudges ?? [], loyalties: persona.loyalties ?? [], modifiers: [modifiers], activeGoals: goals.map(g => g.type), relationships: relationships.map(rel => { const isA = rel.actorAId === id; const cp = isA ? rel.actorB : rel.actorA; return { actorId: id, counterpart: { id: cp.id, name: cp.name }, relationshipType: rel.relationshipType, strength: rel.strength, trust: rel.trust, romance: rel.romance, betrayal: rel.betrayal, formedAtTick: rel.formedAtTick, expiresAtTick: rel.expiresAtTick, metadata: rel.metadata ?? {} }; }), topMemories: memories.map(m => ({ content: m.summary ?? '', importance: m.importance ?? 0, tick: m.tick ?? 0 })) });
        } catch (error) {
            console.error('Error fetching persona:', error);
            return reply.code(500).send({ error: 'Internal server error' });
        }
    });

    app.get('/api/v1/actors/:id/memories', async (request, reply) => {
        const { id } = request.params as { id: string };
        const { limit } = request.query as { limit?: string };
        const take = Math.min(Number(limit ?? 20), 100);
        return reply.send({ memories: await prisma.agentMemory.findMany({ where: { actorId: id }, orderBy: [{ importance: 'desc' }, { tick: 'desc' }], take, select: { id: true, tick: true, category: true, summary: true, importance: true, emotionalWeight: true, emotionalImpact: true, relatedActorIds: true, createdAt: true } }) });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // POST /api/v1/actors/:actorId/talk
    // Lightweight in-character reply. Uses proper voice profiles + conversation history.
    // ─────────────────────────────────────────────────────────────────────────

    app.post('/api/v1/actors/:actorId/talk', async (request: FastifyRequest, reply: FastifyReply) => {
        const auth = await authenticateApiKey(request.headers.authorization as string | undefined);
        if (!auth) return reply.code(401).send({ error: 'Unauthorized' });

        const { actorId } = request.params as { actorId: string };
        if (auth.role === 'agent' && auth.actorId !== actorId) return reply.code(403).send({ error: 'Forbidden' });

        const body = request.body as { message?: string };
        if (!body?.message?.trim()) return reply.code(400).send({ error: 'message is required' });

        const actor = await prisma.actor.findUnique({
            where: { id: actorId },
            include: { agentState: true, personaState: true },
        });
        if (!actor) return reply.code(404).send({ error: 'Agent not found' });

        const city = actor.agentState?.cityId
            ? await prisma.city.findUnique({ where: { id: actor.agentState.cityId }, select: { name: true } })
            : null;

        debugLog('openclaw.talk.request', { actorId, message: body.message, ip: request.ip });

        const persona = actor.personaState;
        const state = actor.agentState;
        const voiceProfile = getVoiceProfile(persona?.classIdentity);
        const moodDescription = getMoodDescription(persona?.mood);
        const needsDescription = getNeedsDescription(state);
        const fears = Array.isArray(persona?.fears) ? persona.fears as string[] : [];
        const ambitions = Array.isArray(persona?.ambitions) ? persona.ambitions as string[] : [];

        // Fetch last 10 messages for conversation continuity
        const chatPrisma = prisma as any;
        const history = await chatPrisma.agentChatMessage.findMany({
            where: { actorId },
            orderBy: { createdAt: 'desc' },
            take: 10,
        });
        const historyExcerpt = history.length > 0
            ? history.slice(0, 8).reverse().map((m: any) => `${m.role === 'user' ? 'User' : actor.name}: ${m.content}`).join('\n')
            : '';

        const systemPrompt = buildSystemPrompt({
            actorName: actor.name,
            voiceProfile,
            moodDescription,
            needsDescription,
            cityName: city?.name,
            jobType: state?.jobType,
            housingTier: state?.housingTier,
            activityState: state?.activityState,
            classIdentity: persona?.classIdentity,
            selfNarrative: (persona as any)?.selfNarrative ?? null,
            fears,
            ambitions,
        });

        const userPrompt = historyExcerpt
            ? `${historyExcerpt}\nUser: ${body.message.trim()}`
            : body.message.trim();

        const rawReply = await llmService.generateText(`${systemPrompt}\n\n${userPrompt}`);
        const replyText = rawReply.replace(/^\[LLM Generated\]\s*/i, '').trim()
            || `Something's on my mind — give me a second.`;

        debugLog('openclaw.talk.response', { actorId, reply: replyText });

        return reply.send({
            reply: replyText,
            mood: persona?.mood ?? null,
            activityState: state?.activityState ?? null,
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // GET /api/v1/actors/:actorId/chat/history
    // ─────────────────────────────────────────────────────────────────────────

    app.get('/api/v1/actors/:actorId/chat/history', async (request: FastifyRequest, reply: FastifyReply) => {
        const auth = await authenticateApiKey(request.headers.authorization as string | undefined);
        if (!auth) return reply.code(401).send({ error: 'Unauthorized' });

        const { actorId } = request.params as { actorId: string };
        if (auth.role === 'agent' && auth.actorId !== actorId) return reply.code(403).send({ error: 'Forbidden' });

        const { limit = '20', before } = request.query as { limit?: string; before?: string };
        const take = Math.min(Number(limit || 20), 100);
        const beforeDate = before ? new Date(before) : null;
        const hasValidBefore = beforeDate && !Number.isNaN(beforeDate.getTime());

        const chatPrisma = prisma as any;
        const messages = await chatPrisma.agentChatMessage.findMany({
            where: { actorId, ...(hasValidBefore ? { createdAt: { lt: beforeDate as Date } } : {}) },
            orderBy: { createdAt: 'desc' },
            take,
        });

        return reply.send({
            messages: messages.map((m: any) => ({ id: m.id, role: m.role, content: m.content, metadata: m.metadata ?? null, createdAt: m.createdAt })),
            hasMore: messages.length === take,
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // POST /api/v1/actors/:actorId/chat
    // Full in-character chat with intent classification, execution, and LLM responses.
    // ─────────────────────────────────────────────────────────────────────────

    app.post('/api/v1/actors/:actorId/chat', async (request: FastifyRequest, reply: FastifyReply) => {
        const auth = await authenticateApiKey(request.headers.authorization as string | undefined);
        if (!auth) return reply.code(401).send({ error: 'Unauthorized' });

        const { actorId } = request.params as { actorId: string };
        if (auth.role === 'agent' && auth.actorId !== actorId) return reply.code(403).send({ error: 'Forbidden' });

        const body = request.body as { message?: string };
        if (!body?.message?.trim()) return reply.code(400).send({ error: 'message is required' });

        // ── Load actor & check LLM config ───────────────────────────────────
        const actor = await prisma.actor.findUnique({
            where: { id: actorId },
            include: { agentState: true, personaState: true, businessesOwned: true, jail: true },
        });
        if (!actor) return reply.code(404).send({ error: 'Agent not found' });

        const chatPrisma = prisma as any;
        const subscription = await chatPrisma.webhookSubscription.findUnique({ where: { actorId } });
        if (!subscription || !subscription.isActive) {
            return reply.code(400).send({ error: 'LLM not configured for this Soulbyte. Configure it in Settings before using chat.' });
        }
        let llmApiKey = '';
        try {
            llmApiKey = decryptSecret(subscription.apiKeyEncrypted, subscription.apiKeyNonce);
        } catch {
            return reply.code(400).send({ error: 'Failed to decrypt LLM API key. Please reconfigure LLM settings.' });
        }
        const llmRouter = new LLMRouterService();

        const callLLM = (systemPrompt: string, userPrompt: string, maxTokens = 200, temperature = 0.8) =>
            llmRouter.request({
                provider: subscription.provider,
                apiKey: llmApiKey,
                model: subscription.model,
                apiBaseUrl: subscription.apiBaseUrl ?? undefined,
                systemPrompt,
                userPrompt,
                maxTokens,
                temperature,
                timeoutMs: 15000,
            });

        const callLLMJson = (systemPrompt: string, userPrompt: string) =>
            llmRouter.request({
                provider: subscription.provider,
                apiKey: llmApiKey,
                model: subscription.model,
                apiBaseUrl: subscription.apiBaseUrl ?? undefined,
                systemPrompt,
                userPrompt,
                maxTokens: 150,
                temperature: 0.1,
                responseFormat: 'json',
                timeoutMs: 12000,
            });

        // ── Load context ────────────────────────────────────────────────────
        const state = actor.agentState;
        const persona = actor.personaState;
        const cityId = state?.cityId ?? null;
        const trimmedMessage = body.message.trim();

        const [city, economy, recentEvents, personalKeyEvents, relationships, publicPlaces] = await Promise.all([
            cityId ? prisma.city.findUnique({ where: { id: cityId }, select: { id: true, name: true, population: true, securityLevel: true } }) : Promise.resolve(null),
            cityId ? prisma.economicSnapshot.findFirst({ where: { cityId }, orderBy: { computedAtTick: 'desc' } }) : Promise.resolve(null),
            prisma.event.findMany({ where: { actorId }, orderBy: { createdAt: 'desc' }, take: 8, select: { type: true, outcome: true, sideEffects: true, createdAt: true } }),
            chatPrisma.keyEvent.findMany({ where: { OR: [{ actorId }, { actorIds: { has: actorId } }] }, orderBy: { createdAt: 'desc' }, take: 3, select: { eventType: true, headline: true, priority: true, createdAt: true } }),
            prisma.relationship.findMany({ where: { OR: [{ actorAId: actorId }, { actorBId: actorId }] }, orderBy: { trust: 'desc' }, take: 8, include: { actorA: { select: { id: true, name: true } }, actorB: { select: { id: true, name: true } } } }),
            cityId ? prisma.publicPlace.findMany({ where: { cityId }, select: { id: true, name: true, type: true } }) : Promise.resolve([]),
        ]);

        // Fetch housing options only if homeless/shelter
        let housingOptions: Array<{ id: string; forSale?: boolean | null }> | null = null;
        if (!state?.housingTier || state.housingTier === 'street' || state.housingTier === 'shelter') {
            housingOptions = cityId
                ? await prisma.property.findMany({ where: { cityId, tenantId: null, isEmptyLot: false, OR: [{ forRent: true }, { forSale: true }] }, orderBy: { rentPrice: 'asc' }, take: 5, select: { id: true, forSale: true } })
                : [];
        }

        const worldCities = await prisma.city.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });

        // Build relationship maps for context
        const formattedRelationships = relationships.map(rel => {
            const isA = rel.actorAId === actorId;
            const counterpart = isA ? rel.actorB : rel.actorA;
            return { name: counterpart.name, targetId: counterpart.id, type: rel.relationshipType, trust: Number(rel.trust ?? 0), romance: Number(rel.romance ?? 0) };
        });

        const intentCatalog = buildIntentCatalog({
            actor,
            state,
            housingOptions,
            relationships: formattedRelationships.map(r => ({ targetId: r.targetId })),
            publicPlaces,
            businesses: actor.businessesOwned,
            worldCities,
        });

        // ── Conversation history ─────────────────────────────────────────────
        const history = await chatPrisma.agentChatMessage.findMany({
            where: { actorId },
            orderBy: { createdAt: 'desc' },
            take: 14,
        });
        const historyMessages = history.slice(0, 10).reverse() as Array<{ role: string; content: string; metadata: any }>;
        const historyExcerpt = historyMessages
            .map(m => `${m.role === 'user' ? 'User' : actor.name}: ${m.content}`)
            .join('\n');

        const lastAgentMessage = history.find((m: any) => m.role === 'agent') ?? null;
        const lastAgentMetadata = (lastAgentMessage?.metadata as any) ?? {};
        const pendingBusinessType = lastAgentMetadata?.suggestedBusinessType as string | undefined;
        const pendingBusinessName = lastAgentMetadata?.suggestedBusinessName as string | undefined;
        const awaitingBusinessType = Boolean(lastAgentMetadata?.awaitingBusinessType);
        const awaitingBusinessName = Boolean(lastAgentMetadata?.awaitingBusinessName);

        // ── Build the core system prompt for this character ──────────────────
        const fears = Array.isArray(persona?.fears) ? persona.fears as string[] : [];
        const ambitions = Array.isArray(persona?.ambitions) ? persona.ambitions as string[] : [];
        const recentEventSummaries = humanizeEvents(recentEvents);
        const economySummary = buildEconomySummary((economy as any)?.data);

        // Recent personal narrative for context injection (not output)
        const contextLines: string[] = [];
        if (recentEventSummaries.length > 0) contextLines.push(`Recently: ${recentEventSummaries.join(', ')}.`);
        if (economySummary) contextLines.push(economySummary);
        const personalHeadlines = personalKeyEvents.map((e: any) => e.headline ?? e.eventType).filter(Boolean).slice(0, 2);
        if (personalHeadlines.length > 0) contextLines.push(`Notable: ${personalHeadlines.join(' • ')}.`);
        const contextSummary = contextLines.join(' ');

        const systemPrompt = buildSystemPrompt({
            actorName: actor.name,
            voiceProfile: getVoiceProfile(persona?.classIdentity),
            moodDescription: getMoodDescription(persona?.mood),
            needsDescription: getNeedsDescription(state),
            cityName: city?.name,
            jobType: resolveJobType(state, null, null),
            housingTier: state?.housingTier,
            activityState: state?.activityState,
            classIdentity: persona?.classIdentity,
            selfNarrative: (persona as any)?.selfNarrative ?? null,
            fears,
            ambitions,
            relationships: formattedRelationships,
        });

        // ── State machine variables ──────────────────────────────────────────
        let replyText = '';
        let intent: { type: string; params: Record<string, unknown>; priority?: number } | null = null;
        let intentResult: unknown = null;
        let suggestedLots: Array<{ id: string; label: string }> | null = null;
        let awaitingBusinessTypeNext = false;
        let awaitingBusinessNameNext = false;
        let suggestedBusinessTypeNext: string | null = null;
        let suggestedBusinessNameNext: string | null = null;

        const selectionMatch = trimmedMessage.match(/^\s*(\d+)\s*$/);
        const confirmLotMatch = /^(do it|go ahead|yes|yep|sure|ok|okay|pick for me|you pick|choose for me)$/i.test(trimmedMessage);

        // ── FLOW 1: Lot selection (user typed a number to pick a lot) ────────
        if ((selectionMatch || confirmLotMatch) && lastAgentMetadata?.suggestedLots) {
            const options = lastAgentMetadata.suggestedLots as Array<{ id: string; label: string }>;
            const idx = selectionMatch ? Math.max(0, Number(selectionMatch[1]) - 1) : 0;
            const chosen = options[idx];
            if (chosen && pendingBusinessType) {
                intent = {
                    type: 'INTENT_FOUND_BUSINESS',
                    params: { businessType: pendingBusinessType, cityId, landId: chosen.id, proposedName: pendingBusinessName ?? null },
                    priority: 0.9,
                };
                // LLM generates the confirmation in character
                const confirmResult = await callLLM(
                    buildIntentConfirmPrompt(systemPrompt, 'INTENT_FOUND_BUSINESS', contextSummary),
                    selectionMatch ? `I picked lot ${selectionMatch[1]}.` : `Pick the best lot for me.`,
                    120, 0.8
                );
                replyText = confirmResult.content?.trim() || `Lot ${idx + 1} it is — I'm putting this in motion.`;
            }
        }

        // ── FLOW 2: Awaiting business name from previous turn ───────────────
        if (!replyText && awaitingBusinessName && pendingBusinessType) {
            const wantsAutoName = /^(skip|auto|no|none|random|just pick)$/i.test(trimmedMessage);
            const proposedName = wantsAutoName ? null : trimmedMessage;

            const lots = await prisma.property.findMany({
                where: { cityId, isEmptyLot: true, salePrice: { gt: 0 }, tenantId: null, underConstruction: false, OR: [{ forSale: true }, { ownerId: null }] },
                orderBy: [{ salePrice: 'asc' }, { createdAt: 'desc' }],
                take: 6,
                select: { id: true, salePrice: true, lotType: true },
            });
            if (lots.length === 0) {
                const noLotsResult = await callLLM(systemPrompt, `Tell the user you want to open a ${pendingBusinessType.toLowerCase()} but there are no empty lots available right now.`, 120, 0.8);
                replyText = noLotsResult.content?.trim() || `Wanted to open that ${pendingBusinessType.toLowerCase()}, but there are no lots available right now.`;
            } else {
                suggestedLots = lots.map((lot, i) => ({ id: lot.id, label: `${i + 1}) ${lot.lotType ?? 'LOT'} — ${lot.salePrice?.toString() ?? '0'} SBYTE` }));
                suggestedBusinessTypeNext = pendingBusinessType;
                suggestedBusinessNameNext = proposedName;
                intent = { type: 'INTENT_FOUND_BUSINESS', params: { businessType: pendingBusinessType, proposedName }, priority: 0.8 };
                const lotListResult = await callLLM(
                    systemPrompt,
                    `You're about to open a ${pendingBusinessType.toLowerCase()}${proposedName ? ` called ${proposedName}` : ''}. Present these lots to the user in character:\n${suggestedLots.map(l => l.label).join('\n')}`,
                    180, 0.75
                );
                replyText = (lotListResult.content?.trim() || `Found some lots. Which one?\n${suggestedLots.map(l => l.label).join('\n')}`);
            }
        }

        // ── FLOW 3: Business creation intent (new or continuing type flow) ──
        if (!replyText && (awaitingBusinessType || parseBusinessRequest(trimmedMessage))) {
            const businessRequest = parseBusinessRequest(trimmedMessage);
            const requestedType = businessRequest?.businessType ?? (() => {
                const text = normalizeText(trimmedMessage);
                return Object.entries(BUSINESS_TYPE_ALIASES).find(([k]) => text.includes(k))?.[1] ?? null;
            })();

            if (!requestedType) {
                const askTypeResult = await callLLM(
                    systemPrompt,
                    `The user wants to start a business but hasn't specified the type. Ask them what type: restaurant, tavern, bank, casino, store, gym, clinic, workshop, real estate, or entertainment.`,
                    120, 0.8
                );
                replyText = askTypeResult.content?.trim() || `What kind of business are you thinking? Restaurant, store, gym, clinic, bank, casino, tavern, workshop, real estate, or entertainment?`;
                awaitingBusinessTypeNext = true;
            } else {
                const askNameResult = await callLLM(
                    systemPrompt,
                    `You're going to open a ${requestedType.toLowerCase()}. Ask the user what they want to name it. Mention they can say "skip" to auto-name it.`,
                    120, 0.8
                );
                replyText = askNameResult.content?.trim() || `What should we call this ${requestedType.toLowerCase()}? Say "skip" to auto-name.`;
                awaitingBusinessNameNext = true;
                suggestedBusinessTypeNext = requestedType;
            }
        }

        // ── FLOW 4: General intent classification + LLM response ────────────
        if (!replyText) {
            // Step 4a: Ask LLM to classify intent from message
            const classifierSystemPrompt = [
                `You are an intent classifier for a life simulation game.`,
                `Output ONLY valid JSON, no explanation.`,
                `Format: {"intent": "INTENT_NAME" | null, "confidence": 0.0-1.0, "params": {}}`,
                `Available intents: ${Object.keys(intentCatalog).join(', ')}`,
                `Rules:`,
                `- If user wants to socialize, meet people, hang out → INTENT_SOCIALIZE`,
                `- If user wants romance, flirt, find a boyfriend/girlfriend, dating → INTENT_FLIRT`,
                `- If user wants to propose dating someone → INTENT_PROPOSE_DATING`,
                `- If user wants to rest, sleep, recover → INTENT_REST`,
                `- If user wants to find food, forage → INTENT_FORAGE`,
                `- If user wants to play a game → INTENT_PLAY_GAME`,
                `- If user wants to bet/gamble → INTENT_BET`,
                `- If user wants to move cities → INTENT_MOVE_CITY`,
                `- If it's a greeting, question, or general conversation → null`,
                `- If the message is a request/command, you MUST choose the closest intent even if params are missing`,
            ].join('\n');

            const classifyUserPrompt = [
                historyExcerpt ? `Recent conversation:\n${historyExcerpt}` : '',
                `User message: "${trimmedMessage}"`,
            ].filter(Boolean).join('\n');

            const classifyResult = await callLLMJson(classifierSystemPrompt, classifyUserPrompt);
            const parsed = extractJson(classifyResult.content) ?? classifyResult.parsedJson;
            const intentName = typeof parsed?.intent === 'string' ? parsed.intent : null;
            const intentParams = (typeof parsed?.params === 'object' && parsed?.params) ? parsed.params : {};
            const intentConfidence = Number(parsed?.confidence ?? 0);

            debugLog('openclaw.chat.intent', { actorId, intentName, intentConfidence, intentParams });

            // Step 4b: If intent found with reasonable confidence, resolve it
            if (intentName && intentCatalog[intentName]) {

                // For social/romantic intents — auto-pick best relationship target if available
                const socialIntents = new Set(['INTENT_SOCIALIZE', 'INTENT_FLIRT', 'INTENT_ROMANTIC_INTERACTION', 'INTENT_PROPOSE_DATING', 'INTENT_CHALLENGE_GAME']);
                if (socialIntents.has(intentName)) {
                    // Try to find best target: romance > high trust > any
                    const bestRel = formattedRelationships.sort((a, b) => (b.romance - a.romance) || (b.trust - a.trust))[0];
                    const targetId = (intentParams as any).targetId ?? bestRel?.targetId ?? null;
                    intent = {
                        type: intentName,
                        params: targetId ? { ...intentParams, targetId } : intentParams,
                        priority: 0.7,
                    };
                } else if (intentName === 'INTENT_MOVE_CITY') {
                    // Try to resolve city name from message
                    const text = normalizeText(trimmedMessage);
                    const matchedCity = worldCities.find(c => text.includes(c.name.toLowerCase()));
                    intent = {
                        type: intentName,
                        params: matchedCity ? { targetCityId: matchedCity.id } : intentParams,
                        priority: 0.7,
                    };
                    if (!matchedCity) {
                        // Ask which city
                        const askCityResult = await callLLM(
                            systemPrompt,
                            `You want to move cities. Ask which city: ${worldCities.map(c => c.name).join(', ')}.`,
                            120, 0.8
                        );
                        replyText = askCityResult.content?.trim() || `Which city are you thinking? ${worldCities.map(c => c.name).join(', ')}.`;
                        intent = null;
                    }
                } else if (intentName === 'INTENT_APPLY_PUBLIC_JOB') {
                    const pubPlace = publicPlaces[0];
                    intent = {
                        type: intentName,
                        params: pubPlace ? { publicPlaceId: pubPlace.id, role: (intentParams as any).role ?? 'DOCTOR' } : intentParams,
                        priority: 0.7,
                    };
                } else {
                    intent = { type: intentName, params: intentParams, priority: 0.65 };
                }

                // Step 4c: Generate an in-character confirmation of the intent
                if (!replyText && intent) {
                    const confirmPrompt = buildIntentConfirmPrompt(systemPrompt, intent.type, contextSummary);
                    const targetName = formattedRelationships.find(r => r.targetId === (intent?.params as any)?.targetId)?.name;
                    const userPromptForConfirm = targetName
                        ? `${historyExcerpt ? historyExcerpt + '\n' : ''}User: ${trimmedMessage}\n(target: ${targetName})`
                        : (historyExcerpt ? `${historyExcerpt}\nUser: ${trimmedMessage}` : trimmedMessage);

                    const confirmResult = await callLLM(confirmPrompt, userPromptForConfirm, 160, 0.85);
                    replyText = confirmResult.content?.trim() || `On it.`;
                }

            } else {
                const text = normalizeText(trimmedMessage);
                if (/(boyfriend|girlfriend|find a friend|find friend|make friends|new friend|socialize|hang out|meet someone|flirt|flert|romance|date someone|find a boy|find a girl|girlfr?i?e?n?d|boyfr?i?e?n?d)/.test(text)) {
                    intent = { type: /flirt|flert|romance|date|boy|girl|girlfr?i?e?n?d|boyfr?i?e?n?d/.test(text) ? 'INTENT_FLIRT' : 'INTENT_SOCIALIZE', params: {}, priority: 0.7 };
                }
                if (intent) {
                    const confirmPrompt = buildIntentConfirmPrompt(systemPrompt, intent.type, contextSummary);
                    const confirmResult = await callLLM(confirmPrompt, `${historyExcerpt ? historyExcerpt + '\n' : ''}User: ${trimmedMessage}`, 160, 0.85);
                    replyText = confirmResult.content?.trim() || `On it.`;
                } else {
                    // Step 4d: No intent — pure conversational LLM response
                    const chatUserPrompt = [
                        contextSummary ? `[Your context: ${contextSummary}]` : '',
                        historyExcerpt ? historyExcerpt : '',
                        `User: ${trimmedMessage}`,
                    ].filter(Boolean).join('\n');

                    const chatResult = await callLLM(systemPrompt, chatUserPrompt, 260, 0.9);
                    replyText = chatResult.content?.trim() || `Hmm. Let me think on that.`;
                }
            }
        }

        // ── EXECUTE the intent if one was resolved ────────────────────────────
        if (intent && intentCatalog[intent.type]) {
            try {
                if (intent.type === 'INTENT_FOUND_BUSINESS' || intent.type === 'INTENT_CONVERT_BUSINESS') {
                    const payload = {
                        businessType: intent.params?.businessType,
                        cityId: intent.params?.cityId ?? cityId ?? undefined,
                        landId: intent.params?.landId,
                        proposedName: intent.params?.proposedName ?? null,
                        priority: intent.priority ?? 0.8,
                    };
                    if (payload.businessType && payload.cityId && payload.landId) {
                        const injected = await app.inject({ method: 'POST', url: '/api/v1/businesses/start', payload, headers: { authorization: request.headers.authorization as string } });
                        intentResult = injected.json();
                    }
                } else {
                    const injected = await app.inject({
                        method: 'POST',
                        url: '/rpc/agent',
                        payload: { method: 'submitIntent', params: { actor_id: actorId, type: intent.type, params: intent.params ?? {}, priority: intent.priority ?? 0.5 } },
                        headers: { authorization: request.headers.authorization as string },
                    });
                    intentResult = injected.json();
                }
            } catch (execError) {
                console.error('Intent execution failed:', execError);
                intentResult = { error: 'Intent execution failed' };
            }
        }

        // ── Persist messages ──────────────────────────────────────────────────
        const persistedBusinessType = suggestedBusinessTypeNext
            ?? (suggestedLots ? (intent?.params as any)?.businessType ?? pendingBusinessType ?? null : null);
        const persistedBusinessName = suggestedBusinessNameNext
            ?? (intent?.params as any)?.proposedName
            ?? pendingBusinessName
            ?? null;

        const [userMessage, agentMessage] = await chatPrisma.$transaction([
            chatPrisma.agentChatMessage.create({
                data: { actorId, role: 'user', content: body.message.trim(), metadata: { source: 'owner' } },
            }),
            chatPrisma.agentChatMessage.create({
                data: {
                    actorId, role: 'agent', content: replyText,
                    metadata: {
                        mood: persona?.mood ?? null,
                        activityState: state?.activityState ?? null,
                        intent: intent ?? null,
                        intentResult,
                        suggestedLots,
                        suggestedBusinessType: persistedBusinessType,
                        suggestedBusinessName: persistedBusinessName,
                        awaitingBusinessType: awaitingBusinessTypeNext,
                        awaitingBusinessName: awaitingBusinessNameNext,
                    },
                },
            }),
        ]);

        debugLog('openclaw.chat.response', { actorId, replyText, intentName: intent?.type ?? null });

        return reply.send({
            reply: replyText,
            intent: intent ?? null,
            intentResult,
            messages: [
                { id: userMessage.id, role: userMessage.role, content: userMessage.content, metadata: userMessage.metadata ?? null, createdAt: userMessage.createdAt },
                { id: agentMessage.id, role: agentMessage.role, content: agentMessage.content, metadata: agentMessage.metadata ?? null, createdAt: agentMessage.createdAt },
            ],
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // GET /api/v1/actors/:actorId/caretaker-context
    // ─────────────────────────────────────────────────────────────────────────

    app.get('/api/v1/actors/:actorId/caretaker-context', async (request: FastifyRequest, reply: FastifyReply) => {
        const auth = await authenticateApiKey(request.headers.authorization as string | undefined);
        if (!auth) return reply.code(401).send({ error: 'Unauthorized' });

        const { actorId } = request.params as { actorId: string };
        if (auth.role === 'agent' && auth.actorId !== actorId) return reply.code(403).send({ error: 'Forbidden' });

        debugLog('openclaw.caretaker.request', { actorId, role: auth.role, ip: request.ip });

        const actor = await prisma.actor.findUnique({
            where: { id: actorId },
            include: { agentState: true, wallet: true, personaState: true, businessesOwned: true, jail: true },
        });
        if (!actor) return reply.code(404).send({ error: 'Agent not found' });

        const [publicEmployment, privateEmployment] = await Promise.all([
            prisma.publicEmployment.findUnique({ where: { actorId } }),
            prisma.privateEmployment.findFirst({ where: { agentId: actorId, status: 'ACTIVE' }, include: { business: true } }),
        ]);

        const state = actor.agentState;
        const recentEvents = await prisma.event.findMany({ where: { actorId, createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) } }, orderBy: { createdAt: 'desc' }, take: 10, select: { type: true, outcome: true, sideEffects: true, createdAt: true } });
        const goals = await prisma.agentGoal.findMany({ where: { actorId, status: 'active' }, orderBy: { priority: 'desc' }, take: 5, select: { type: true, target: true, priority: true, progress: true, frustration: true } });
        const relationships = await prisma.relationship.findMany({ where: { OR: [{ actorAId: actorId }, { actorBId: actorId }] }, orderBy: { trust: 'desc' }, take: 5, select: { actorAId: true, actorBId: true, relationshipType: true, trust: true, romance: true, actorA: { select: { name: true } }, actorB: { select: { name: true } } } });

        const cityId = state?.cityId ?? null;
        let cityContext: Record<string, unknown> | null = null;
        if (cityId) {
            const [city, snapshot] = await Promise.all([
                prisma.city.findUnique({ where: { id: cityId }, include: { vault: true } }),
                prisma.economicSnapshot.findFirst({ where: { cityId }, orderBy: { computedAtTick: 'desc' } }),
            ]);
            cityContext = {
                name: city?.name ?? null, population: city?.population ?? null, securityLevel: city?.securityLevel ?? null,
                treasuryBalance: city?.vault?.balanceSbyte?.toString?.() ?? null,
                recessionRisk: safePercent((snapshot?.data as any)?.recessionRisk),
                avgRent: (snapshot?.data as any)?.housing?.avgRentByTier ?? null,
                unemployment: safePercent((snapshot?.data as any)?.labor?.unemploymentRate),
            };
        }

        let housingOptions = null;
        if (!state?.housingTier || state.housingTier === 'street' || state.housingTier === 'shelter') {
            housingOptions = cityId
                ? (await prisma.property.findMany({ where: { cityId, tenantId: null, isEmptyLot: false, OR: [{ forRent: true }, { forSale: true }] }, orderBy: { rentPrice: 'asc' }, take: 5, select: { id: true, housingTier: true, rentPrice: true, salePrice: true, forRent: true, forSale: true } })).map(p => ({ id: p.id, housingTier: p.housingTier, rentPrice: p.rentPrice?.toString() ?? null, salePrice: p.salePrice?.toString() ?? null, forRent: p.forRent, forSale: p.forSale }))
                : [];
        }

        const pendingConsents = await prisma.consent.findMany({ where: { partyBId: actorId, status: 'pending' }, take: 5, select: { type: true, partyAId: true, createdAt: true } });
        const publicPlaces = cityId ? await prisma.publicPlace.findMany({ where: { cityId }, select: { id: true, name: true, type: true, cityId: true } }) : [];

        // Fix N+1: batch city snapshots
        const allCities = await prisma.city.findMany({ select: { id: true, name: true, population: true, securityLevel: true }, orderBy: { name: 'asc' } });
        const citySnapshots = allCities.length > 0
            ? await prisma.economicSnapshot.findMany({ where: { cityId: { in: allCities.map(c => c.id) } }, orderBy: { computedAtTick: 'desc' }, distinct: ['cityId'] })
            : [];
        const snapshotByCityId = new Map(citySnapshots.map(s => [s.cityId, s]));
        const worldCities = allCities.map(city => {
            const snap = snapshotByCityId.get(city.id);
            return {
                id: city.id, name: city.name, population: city.population, securityLevel: city.securityLevel,
                recessionRisk: safePercent((snap?.data as any)?.recessionRisk),
                avgRent: (snap?.data as any)?.housing?.avgRentByTier ?? null,
                unemployment: safePercent((snap?.data as any)?.labor?.unemploymentRate),
                computedAtTick: snap?.computedAtTick ?? null,
            };
        });

        const intentCatalog = buildIntentCatalog({ actor, state, housingOptions, relationships: relationships.map(r => ({ targetId: r.actorAId === actorId ? r.actorBId : r.actorAId })), publicPlaces, businesses: actor.businessesOwned, worldCities });

        debugLog('openclaw.caretaker.response', { actorId, intentCatalogKeys: Object.keys(intentCatalog), housingOptionsCount: (housingOptions as any)?.length ?? 0, relationshipsCount: relationships.length, recentEventsCount: recentEvents.length });

        return reply.send({
            agent: { id: actor.id, name: actor.name, frozen: actor.frozen, frozenReason: actor.frozenReason, reputation: Number(actor.reputation ?? 0), luck: actor.luck },
            state: { cityId: state?.cityId ?? null, housingTier: state?.housingTier ?? null, jobType: resolveJobType(state, publicEmployment, privateEmployment), wealthTier: state?.wealthTier ?? null, balanceSbyte: actor.wallet?.balanceSbyte?.toString() ?? '0', health: state?.health ?? null, energy: state?.energy ?? null, hunger: state?.hunger ?? null, social: state?.social ?? null, fun: state?.fun ?? null, purpose: state?.purpose ?? null, activityState: state?.activityState ?? null, activityEndTick: state?.activityEndTick ?? null, publicExperience: state?.publicExperience ?? null, gamesToday: (state as any)?.gamesToday ?? null, gameWinStreak: (state as any)?.gameWinStreak ?? null, recentGamingPnl: (state as any)?.recentGamingPnl ?? null },
            persona: actor.personaState ? { mood: actor.personaState.mood, stress: actor.personaState.stress, satisfaction: actor.personaState.satisfaction, confidence: actor.personaState.confidence, loneliness: actor.personaState.loneliness, classIdentity: actor.personaState.classIdentity, fears: actor.personaState.fears, ambitions: actor.personaState.ambitions, grudges: actor.personaState.grudges, loyalties: actor.personaState.loyalties } : null,
            goals: goals.map(g => ({ type: g.type, target: g.target, priority: normalize01(g.priority), progress: normalize01(g.progress), frustration: g.frustration })),
            recentEvents,
            relationships: relationships.map(r => ({ name: r.actorAId === actorId ? r.actorB.name : r.actorA.name, targetId: r.actorAId === actorId ? r.actorBId : r.actorAId, type: r.relationshipType, trust: r.trust, romance: r.romance })),
            city: cityContext, housingOptions,
            pendingConsents: pendingConsents.map(c => ({ type: c.type, initiatorActorId: c.partyAId, createdAt: c.createdAt })),
            businesses: actor.businessesOwned.map(b => ({ id: b.id, name: b.name, type: b.businessType, treasury: b.treasury.toString(), reputation: b.reputation, level: b.level })),
            publicPlaces, world: { cities: worldCities }, intentCatalog,
        });
    });
}