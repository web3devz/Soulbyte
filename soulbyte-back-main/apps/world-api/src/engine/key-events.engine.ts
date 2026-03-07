export interface KeyEventClassification {
    isKeyEvent: boolean;
    tier: 'breaking' | 'notable' | null;
    headline: string | null;
    agoraTriggerBoard: string | null;
    requiresWebhook: boolean;
}

export interface KeyEventPriorityClassification {
    isKeyEvent: boolean;
    priority: 'high' | 'medium' | 'low' | null;
}

type TemplateMeta = Record<string, unknown>;

// TODO(Phase 3): add EVENT_ELECTION_WINNER once the EventType enum supports it.
const TIER1_EVENTS: Record<string, { board: string | null; headlineTemplate: string }> = {
    EVENT_BUSINESS_FOUNDED: { board: 'economy', headlineTemplate: '{actor} opened a new {businessType} in {city}' },
    EVENT_BUSINESS_CONVERTED: { board: 'economy', headlineTemplate: '{actor} opened a new {businessType} in {city}' },
    EVENT_BUSINESS_CLOSED: { board: 'economy', headlineTemplate: "{actor}'s {businessType} has closed in {city}" },
    EVENT_CRIME_COMMITTED: { board: 'society', headlineTemplate: '{actor} committed {crimeType} in {city}' },
    EVENT_IMPRISONED: { board: 'society', headlineTemplate: '{actor} was jailed in {city}' },
    EVENT_MARRIAGE_RESOLVED: { board: 'society', headlineTemplate: '{actorA} and {actorB} got married in {city}' },
    EVENT_DIVORCE: { board: 'society', headlineTemplate: '{actorA} and {actorB} divorced in {city}' },
    EVENT_PROPOSAL_APPROVED: { board: 'politics', headlineTemplate: "Mayor's {proposalType} proposal approved in {city}" },
    EVENT_PROPOSAL_REJECTED: { board: 'politics', headlineTemplate: "Mayor's {proposalType} proposal rejected in {city}" },
    EVENT_GOD_RECESSION_INTERVENTION: { board: 'politics', headlineTemplate: 'Divine intervention in {city}: {reason}' },
    EVENT_UNFROZEN: { board: 'survival', headlineTemplate: '{actor} revived from freeze in {city}' },
    EVENT_FROZEN: { board: 'survival', headlineTemplate: '{actor} entered freeze in {city}' },
    // V6: Luck events upgraded to TIER1 (breaking) to generate LLM headlines
    EVENT_LIFE_EVENT_FORTUNE: { board: 'philosophy', headlineTemplate: '{actor} experienced an extraordinary stroke of fortune in {city}' },
    EVENT_LIFE_EVENT_MISFORTUNE: { board: 'society', headlineTemplate: '{actor} suffered a terrible misfortune in {city}' },
    // V6: Natural disasters as breaking news
    EVENT_NATURAL_DISASTER: { board: 'society', headlineTemplate: 'Natural disaster strikes {city}: {disasterType}' },
};


const TIER2_EVENTS: Record<string, (meta: TemplateMeta) => KeyEventClassification | null> = {
    EVENT_CITY_PULSE: (meta) => ({
        isKeyEvent: true,
        tier: 'notable',
        headline: meta.city
            ? `Daily report: ${meta.city} economy ${meta.economicHealth ?? 'stable'}`
            : 'Daily city report',
        agoraTriggerBoard: 'economy',
        requiresWebhook: false,
    }),
    EVENT_LIFE_EVENT_FORTUNE: () => ({
        isKeyEvent: true,
        tier: 'notable',
        headline: null,
        agoraTriggerBoard: 'philosophy',
        requiresWebhook: true,
    }),
    EVENT_LIFE_EVENT_MISFORTUNE: () => ({
        isKeyEvent: true,
        tier: 'notable',
        headline: null,
        agoraTriggerBoard: 'philosophy',
        requiresWebhook: true,
    }),
    EVENT_EMPLOYEE_QUIT_UNPAID: () => ({
        isKeyEvent: true,
        tier: 'notable',
        headline: null,
        agoraTriggerBoard: 'economy',
        requiresWebhook: true,
    }),
    EVENT_BUSINESS_CRITICAL_FUNDS: () => ({
        isKeyEvent: true,
        tier: 'notable',
        headline: null,
        agoraTriggerBoard: null,
        requiresWebhook: false,
    }),
    EVENT_CITY_UPGRADED: () => ({
        isKeyEvent: true,
        tier: 'notable',
        headline: null,
        agoraTriggerBoard: 'politics',
        requiresWebhook: true,
    }),
    EVENT_CITY_TAX_CHANGED: () => ({
        isKeyEvent: true,
        tier: 'notable',
        headline: null,
        agoraTriggerBoard: 'politics',
        requiresWebhook: true,
    }),
    EVENT_ALLIANCE_RESOLVED: (meta) => {
        if (String(meta.action || '').toLowerCase() !== 'accept') return null;
        return {
            isKeyEvent: true,
            tier: 'notable',
            headline: null,
            agoraTriggerBoard: 'strategy',
            requiresWebhook: false,
        };
    },
    EVENT_ALLIANCE_BETRAYED: () => ({
        isKeyEvent: true,
        tier: 'notable',
        headline: null,
        agoraTriggerBoard: 'strategy',
        requiresWebhook: true,
    }),
    EVENT_BUSINESS_SOLD: () => ({
        isKeyEvent: true,
        tier: 'notable',
        headline: null,
        agoraTriggerBoard: 'economy',
        requiresWebhook: true,
    }),
    EVENT_HOUSING_CHANGED: (meta) => {
        const tier = String(meta.newHousingTier || meta.housingTier || '').toLowerCase();
        const notable = ['villa', 'estate', 'palace', 'citadel'].includes(tier);
        if (!notable) return null;
        return {
            isKeyEvent: true,
            tier: 'notable',
            headline: null,
            agoraTriggerBoard: null,
            requiresWebhook: false,
        };
    },
};

function interpolateTemplate(template: string, metadata: TemplateMeta): string {
    return template.replace(/\{(\w+)\}/g, (_, key: string) => {
        const raw = metadata[key];
        if (raw === undefined || raw === null) return 'Unknown';
        return String(raw);
    });
}

export function classifyKeyEvent(eventType: string, metadata: TemplateMeta): KeyEventClassification {
    const outcome = String(metadata.outcome || '').toLowerCase();
    if (eventType === 'EVENT_CRIME_COMMITTED' && outcome && outcome !== 'success') {
        return { isKeyEvent: false, tier: null, headline: null, agoraTriggerBoard: null, requiresWebhook: false };
    }
    if (eventType === 'EVENT_MARRIAGE_RESOLVED' && String(metadata.action || '').toLowerCase() !== 'accept') {
        return { isKeyEvent: false, tier: null, headline: null, agoraTriggerBoard: null, requiresWebhook: false };
    }

    if (TIER1_EVENTS[eventType]) {
        const t1 = TIER1_EVENTS[eventType];
        return {
            isKeyEvent: true,
            tier: 'breaking',
            headline: interpolateTemplate(t1.headlineTemplate, metadata),
            agoraTriggerBoard: t1.board,
            requiresWebhook: true,
        };
    }
    if (TIER2_EVENTS[eventType]) {
        const result = TIER2_EVENTS[eventType](metadata);
        if (result) return result;
    }
    return { isKeyEvent: false, tier: null, headline: null, agoraTriggerBoard: null, requiresWebhook: false };
}

export function classifyKeyEventPriority(eventType: string, metadata: TemplateMeta): KeyEventPriorityClassification {
    const outcome = String(metadata.outcome || '').toLowerCase();
    const action = String(metadata.action || '').toLowerCase();
    const delta = typeof metadata.delta === 'number' ? metadata.delta : Number(metadata.delta ?? 0);
    const cityReputationDelta = typeof metadata.cityReputationDelta === 'number'
        ? metadata.cityReputationDelta
        : Number(metadata.cityReputationDelta ?? 0);
    const multiplier = typeof metadata.multiplier === 'number' ? metadata.multiplier : Number(metadata.multiplier ?? 0);

    if (eventType === 'EVENT_BUSINESS_FOUNDED') {
        return { isKeyEvent: true, priority: 'high' };
    }
    if (eventType === 'EVENT_BUSINESS_CONVERTED') {
        return { isKeyEvent: true, priority: 'high' };
    }
    if (eventType === 'EVENT_BUSINESS_DISSOLVED') {
        return { isKeyEvent: true, priority: 'high' };
    }
    if (eventType === 'EVENT_CRIME_COMMITTED' && (!outcome || outcome === 'success')) {
        return { isKeyEvent: true, priority: 'high' };
    }
    if (eventType === 'EVENT_REPUTATION_UPDATED' && delta >= 20) {
        return { isKeyEvent: true, priority: 'high' };
    }
    if (cityReputationDelta >= 20) {
        return { isKeyEvent: true, priority: 'high' };
    }
    if (eventType === 'EVENT_MARRIAGE_RESOLVED' && action === 'accept') {
        return { isKeyEvent: true, priority: 'medium' };
    }
    if (eventType === 'EVENT_DIVORCE') {
        return { isKeyEvent: true, priority: 'medium' };
    }
    if (eventType === 'EVENT_DATING_RESOLVED' && action === 'accept') {
        return { isKeyEvent: true, priority: 'medium' };
    }
    if (eventType === 'EVENT_DATING_ENDED') {
        return { isKeyEvent: true, priority: 'medium' };
    }
    if (eventType === 'EVENT_AGENT_BORN') {
        return { isKeyEvent: true, priority: 'medium' };
    }
    if (eventType === 'EVENT_UNFROZEN') {
        return { isKeyEvent: true, priority: 'medium' };
    }
    if (eventType === 'EVENT_IMPRISONED') {
        return { isKeyEvent: true, priority: 'medium' };
    }
    if (eventType === 'EVENT_BUSINESS_CUSTOMER_VISIT' && String(metadata.casinoResult || '').toUpperCase() === 'WIN' && multiplier >= 4) {
        return { isKeyEvent: true, priority: 'low' };
    }

    return { isKeyEvent: false, priority: null };
}
