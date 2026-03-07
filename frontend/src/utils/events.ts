// Event Utilities - Event type to icon/label mapping using PNG icons

import type { Event } from '@/api/types';
import { formatItemName, formatPropertyName, humanizeToken } from '@/utils/format';

export interface EventDisplay {
    icon: string;       // path to icon PNG
    emoji: string;      // fallback emoji
    label: string;
    color: string;
}

// Map for backend event types (lowercase format from backend: work, move, buy_property, etc.)
const EVENT_MAP: Record<string, EventDisplay> = {
    // Work & Economics
    'work': { icon: '/images/icons/event-types/evt-work.png', emoji: '💼', label: 'worked', color: 'var(--accent-green)' },
    'worked': { icon: '/images/icons/event-types/evt-work.png', emoji: '💼', label: 'worked', color: 'var(--accent-green)' },
    'job_search': { icon: '/images/icons/event-types/evt-work.png', emoji: '🔍', label: 'looking for work', color: 'var(--text-secondary)' },
    'job_accepted': { icon: '/images/icons/event-types/evt-work.png', emoji: '✅', label: 'accepted job offer', color: 'var(--accent-green)' },
    'salary_collected': { icon: '/images/icons/event-types/evt-work.png', emoji: '💰', label: 'collected salary', color: 'var(--accent-green)' },
    'buy_item': { icon: '/images/icons/event-types/evt-trade.png', emoji: '🛒', label: 'bought item', color: 'var(--accent-amber)' },
    'sell_item': { icon: '/images/icons/event-types/evt-trade.png', emoji: '📦', label: 'sold item', color: 'var(--accent-amber)' },
    'market_listed': { icon: '/images/icons/event-types/evt-trade.png', emoji: '📦', label: 'listed on market', color: 'var(--accent-amber)' },
    'business_founded': { icon: '/images/icons/event-types/evt-trade.png', emoji: '🏪', label: 'founded business', color: 'var(--accent-amber)' },
    'business_purchased': { icon: '/images/icons/event-types/evt-trade.png', emoji: '🏢', label: 'bought business', color: 'var(--accent-amber)' },
    'crafted': { icon: '/images/icons/event-types/evt-trade.png', emoji: '🔨', label: 'crafted item', color: 'var(--accent-amber)' },

    // Housing & Property
    'buy_property': { icon: '/images/icons/event-types/evt-housing.png', emoji: '🏘️', label: 'bought property', color: 'var(--accent-gold)' },
    'rent_property': { icon: '/images/icons/event-types/evt-housing.png', emoji: '🏠', label: 'rented property', color: 'var(--accent-green)' },
    'sell_property': { icon: '/images/icons/event-types/evt-housing.png', emoji: '🏡', label: 'sold property', color: 'var(--accent-amber)' },
    'rent_paid': { icon: '/images/icons/event-types/evt-housing.png', emoji: '🏠', label: 'paid rent', color: 'var(--text-secondary)' },
    'housing_changed': { icon: '/images/icons/event-types/evt-housing.png', emoji: '🏡', label: 'moved', color: 'var(--accent-green)' },
    'eviction': { icon: '/images/icons/event-types/evt-housing.png', emoji: '🚪', label: 'was evicted', color: 'var(--accent-red)' },

    // Social
    'socialize': { icon: '/images/icons/event-types/evt-social.png', emoji: '💬', label: 'socialized', color: 'var(--accent-blue)' },
    'flirted': { icon: '/images/icons/event-types/evt-social.png', emoji: '💘', label: 'flirted', color: 'var(--accent-pink, var(--accent-blue))' },
    'marriage': { icon: '/images/icons/event-types/evt-marriage.png', emoji: '💒', label: 'got married', color: 'var(--accent-gold)' },
    'marriage_resolved': { icon: '/images/icons/event-types/evt-marriage.png', emoji: '💒', label: 'married', color: 'var(--accent-gold)' },

    // Crime & Justice
    'crime': { icon: '/images/icons/event-types/evt-crime.png', emoji: '🔪', label: 'committed crime', color: 'var(--accent-red)' },
    'crime_success': { icon: '/images/icons/event-types/evt-crime.png', emoji: '🔪', label: 'committed crime', color: 'var(--accent-red)' },
    'imprisoned': { icon: '/images/icons/event-types/evt-jail.png', emoji: '⛓️', label: 'was arrested', color: 'var(--accent-red)' },

    // Governance
    'vote': { icon: '/images/icons/event-types/evt-governance.png', emoji: '🗳️', label: 'voted', color: 'var(--accent-purple)' },
    'voted': { icon: '/images/icons/event-types/evt-governance.png', emoji: '🗳️', label: 'voted', color: 'var(--accent-purple)' },
    'propose': { icon: '/images/icons/event-types/evt-governance.png', emoji: '📋', label: 'proposed', color: 'var(--accent-purple)' },

    // Agora
    'agora_posted': { icon: '/images/icons/event-types/evt-agora.png', emoji: '📜', label: 'posted on Agora', color: 'var(--accent-blue)' },

    // Fortune & Misfortune
    'fortune': { icon: '/images/icons/event-types/evt-fortune.png', emoji: '🍀', label: 'struck fortune', color: 'var(--accent-gold)' },
    'misfortune': { icon: '/images/icons/event-types/evt-fortune.png', emoji: '💀', label: 'suffered misfortune', color: 'var(--accent-red)' },

    // Movement & Status
    'move': { icon: '/images/icons/event-types/evt-social.png', emoji: '🚶', label: 'moved', color: 'var(--text-secondary)' },
    'rest': { icon: '/images/icons/event-types/evt-housing.png', emoji: '😴', label: 'rested', color: 'var(--text-secondary)' },
    'eat': { icon: '/images/icons/event-types/evt-trade.png', emoji: '🍽️', label: 'ate', color: 'var(--text-secondary)' },
    'reputation': { icon: '/images/icons/event-types/evt-social.png', emoji: '⭐', label: 'reputation changed', color: 'var(--text-secondary)' },

    // Wealth changes
    'wealth_tier_up': { icon: '/images/icons/event-types/evt-fortune.png', emoji: '📈', label: 'tier up', color: 'var(--accent-green)' },
    'wealth_tier_down': { icon: '/images/icons/event-types/evt-fortune.png', emoji: '📉', label: 'tier down', color: 'var(--accent-red)' },

    // Job
    'public_job_applied': { icon: '/images/icons/event-types/evt-work.png', emoji: '👔', label: 'got a job', color: 'var(--accent-green)' },
    'work_shift_completed': { icon: '/images/icons/event-types/evt-work.png', emoji: '💼', label: 'completed work', color: 'var(--accent-green)' },

    // Special
    'freeze_revived': { icon: '/images/icons/event-types/evt-freeze.png', emoji: '❄️', label: 'revived', color: 'var(--accent-blue)' },
    'battle': { icon: '/images/icons/event-types/evt-battle.png', emoji: '⚔️', label: 'battled', color: 'var(--accent-red)' },
};

// Also map the legacy EVENT_* prefix format (for backwards compatibility)
const LEGACY_PREFIX_MAP: Record<string, string> = {
    'EVENT_SALARY_COLLECTED': 'salary_collected',
    'EVENT_RENT_PAID': 'rent_paid',
    'EVENT_EVICTION': 'eviction',
    'EVENT_CRIME_SUCCESS': 'crime_success',
    'EVENT_IMPRISONED': 'imprisoned',
    'EVENT_MARRIAGE_RESOLVED': 'marriage_resolved',
    'EVENT_FLIRTED': 'flirted',
    'EVENT_BUSINESS_FOUNDED': 'business_founded',
    'EVENT_AGORA_POSTED': 'agora_posted',
    'EVENT_MARKET_LISTED': 'market_listed',
    'EVENT_FORTUNE': 'fortune',
    'EVENT_MISFORTUNE': 'misfortune',
    'EVENT_WEALTH_TIER_UP': 'wealth_tier_up',
    'EVENT_WEALTH_TIER_DOWN': 'wealth_tier_down',
    'EVENT_FREEZE_REVIVED': 'freeze_revived',
    'EVENT_CRAFTED': 'crafted',
    'EVENT_HOUSING_CHANGED': 'housing_changed',
    'EVENT_VOTED': 'voted',
    'EVENT_PUBLIC_JOB_APPLIED': 'public_job_applied',
    'EVENT_WORK_SHIFT_COMPLETED': 'work_shift_completed',
    'EVENT_BUSINESS_PURCHASED': 'business_purchased',
    'EVENT_PROPERTY_PURCHASED': 'buy_property',
};

const DEFAULT_EVENT: EventDisplay = {
    icon: '/images/icons/event-types/evt-social.png',
    emoji: '📋',
    label: 'took action',
    color: 'var(--text-secondary)'
};

function normalizeEventType(eventType: string): string {
    // Check legacy prefix map first
    if (LEGACY_PREFIX_MAP[eventType]) {
        return LEGACY_PREFIX_MAP[eventType];
    }
    // Strip EVENT_ prefix if present and lowercase
    if (eventType.startsWith('EVENT_')) {
        return eventType.replace('EVENT_', '').toLowerCase();
    }
    return eventType.toLowerCase();
}

export function getEventDisplay(eventType: string): EventDisplay {
    const normalized = normalizeEventType(eventType);
    return EVENT_MAP[normalized] || DEFAULT_EVENT;
}

export function getEventIcon(eventType: string): string {
    return getEventDisplay(eventType).icon;
}

export function getEventEmoji(eventType: string): string {
    return getEventDisplay(eventType).emoji;
}

export function getEventLabel(eventType: string): string {
    return getEventDisplay(eventType).label;
}

export function getEventColor(eventType: string): string {
    return getEventDisplay(eventType).color;
}

const HIDDEN_EVENT_PATTERNS: RegExp[] = [
    /on-chain balance insufficient/i,
    /challenge already pending/i,
    /event_skill_budget_exceeded/i,
    /target is busy/i,
    /escrow transfer failed: insufficient balance/i,
    /source not allowed/i,
];

export function shouldHideEvent(event: Event): boolean {
    const meta = event.metadata as Record<string, unknown> | undefined;
    const textSources = [
        typeof event.description === 'string' ? event.description : null,
        typeof event.eventType === 'string' ? event.eventType : null,
        typeof meta?.rawType === 'string' ? String(meta.rawType) : null,
        typeof meta?.reason === 'string' ? meta.reason : null,
        typeof meta?.message === 'string' ? meta.message : null,
    ].filter(Boolean) as string[];

    if (textSources.length === 0) return false;
    return textSources.some((text) => HIDDEN_EVENT_PATTERNS.some((pattern) => pattern.test(text)));
}

const HUMANIZE_DESCRIPTION_SKIP = new Set(['SBYTE', 'MON']);

function humanizeDescription(text: string): string {
    return text.replace(/\b[A-Z0-9_]{3,}\b/g, (token) => {
        if (HUMANIZE_DESCRIPTION_SKIP.has(token)) return token;
        if (token.startsWith('CONS_')) return formatItemName(token);
        if (token.startsWith('EVENT_')) return humanizeToken(token.replace('EVENT_', ''));
        if (token.includes('_')) return humanizeToken(token);
        return token;
    });
}

function formatUnknownEventLabel(rawType?: string | null): string | null {
    if (!rawType) return null;
    switch (rawType) {
        case 'EVENT_GAME_CHALLENGE':
            return 'challenged to a game';
        case 'EVENT_GAME_ACCEPTED':
            return 'accepted a game challenge';
        case 'EVENT_GAME_REJECTED':
            return 'rejected a game challenge';
        case 'EVENT_GAME_RESULT':
            return 'played a game';
        case 'EVENT_ARREST':
            return 'made an arrest';
        case 'EVENT_PATROL_LOGGED':
            return 'patrolled';
        case 'EVENT_RELEASED':
            return 'was released';
        case 'EVENT_JOB_SWITCHED':
            return 'switched jobs';
        default:
            return humanizeToken(rawType.replace('EVENT_', ''));
    }
}

/** Build a richer description from event metadata */
export function describeEvent(event: Event): string {
    const meta = event.metadata as Record<string, unknown> | undefined;
    const rawType = typeof meta?.rawType === 'string' ? meta.rawType : event.eventType;

    if (rawType === 'EVENT_LIFE_EVENT_FORTUNE' || event.eventType === 'fortune') {
        const amount = Number(meta?.amount ?? meta?.sbyteDelta ?? 0);
        if (Number.isFinite(amount) && amount > 0) {
            return `Fortune event: gained ${amount} SBYTE`;
        }
        return 'Fortune event';
    }
    if (rawType === 'EVENT_LIFE_EVENT_MISFORTUNE' || event.eventType === 'misfortune') {
        const amount = Number(meta?.amount ?? meta?.sbyteDelta ?? 0);
        if (Number.isFinite(amount) && amount > 0) {
            return `Misfortune event: lost ${amount} SBYTE`;
        }
        return 'Misfortune event';
    }
    if (rawType === 'EVENT_CRIME_COMMITTED' || event.eventType === 'crime' || event.eventType === 'crime_success') {
        const crimeType = typeof meta?.type === 'string'
            ? meta.type
            : typeof meta?.crimeType === 'string'
                ? meta.crimeType
                : null;
        const targetName = typeof meta?.targetName === 'string' ? meta.targetName : null;
        const amount = Number(meta?.amount ?? meta?.stolenAmount ?? 0);
        const detected = typeof meta?.detected === 'boolean' ? meta.detected : null;
        const detectionNote = detected === true ? ' (detected)' : detected === false ? ' (undetected)' : '';

        if ((crimeType === 'theft' || crimeType === 'fraud') && Number.isFinite(amount) && amount > 0) {
            const verb = crimeType === 'fraud' ? 'Defrauded' : 'Stolen';
            const fromClause = targetName ? ` from ${targetName}` : '';
            return `Crime committed. ${verb} ${amount} SBYTE${fromClause}${detectionNote}.`;
        }
        if (crimeType === 'assault' && targetName) {
            return `Crime committed. Assaulted ${targetName}${detectionNote}.`;
        }
    }

    if (rawType === 'EVENT_RESTED' || event.eventType === 'rest') {
        return 'is resting';
    }

    if (event.description && typeof event.description === 'string') {
        const trimmed = event.description.trim();
        const looksLikeRaw = /^EVENT_[A-Z0-9_]+$/.test(trimmed)
            || trimmed.toLowerCase() === event.eventType?.toLowerCase();
        if (!looksLikeRaw) {
            if ((rawType === 'EVENT_SOCIALIZED' || rawType === 'socialize')
                && meta?.publicPlaceName
                && typeof meta.publicPlaceName === 'string') {
                const baseDescription = event.description.replace(/\.$/, '');
                return humanizeDescription(`${baseDescription} in ${meta.publicPlaceName}.`);
            }
            return humanizeDescription(event.description);
        }
    }

    // If backend provides a full description, use it directly
    if (meta?.description && typeof meta.description === 'string') {
        const trimmed = meta.description.trim();
        const looksLikeRaw = /^EVENT_[A-Z0-9_]+$/.test(trimmed)
            || trimmed.toLowerCase() === event.eventType?.toLowerCase();
        if (!looksLikeRaw) {
            if ((rawType === 'EVENT_SOCIALIZED' || rawType === 'socialize')
                && meta.publicPlaceName
                && typeof meta.publicPlaceName === 'string') {
                const baseDescription = meta.description.replace(/\.$/, '');
                return humanizeDescription(`${baseDescription} in ${meta.publicPlaceName}.`);
            }
            return humanizeDescription(meta.description);
        }
    }

    const base = getEventLabel(event.eventType);
    const fallbackLabel = base === 'took action' || event.eventType === 'action'
        ? formatUnknownEventLabel(rawType)
        : null;
    const baseLabel = fallbackLabel ?? base;
    if (!meta) return baseLabel;

    if (rawType === 'EVENT_GAME_RESULT' || rawType === 'game_result') {
        const stake = Number(meta.stake ?? meta.betAmount ?? 0);
        const platformFee = Number(meta.platformFee ?? 0);
        const payout = Number(meta.payout ?? 0);
        const won = typeof meta.won === 'boolean' ? meta.won : undefined;
        let winnings = Number(meta.winnings ?? meta.reward ?? 0);
        if (!Number.isFinite(winnings) || winnings === 0) {
            if (Number.isFinite(payout) && payout > 0) {
                winnings = payout;
            } else if (Number.isFinite(stake) && Number.isFinite(platformFee) && won) {
                winnings = stake * 2 - platformFee;
            }
        }
        const gameType = typeof meta.gameType === 'string' ? meta.gameType : null;
        const opponent = typeof meta.targetName === 'string'
            ? meta.targetName
            : Array.isArray(meta.targetNames) && meta.targetNames[0]
                ? String(meta.targetNames[0])
                : null;
        if (won === false && Number.isFinite(stake) && stake > 0) {
            const details = [
                `Lost ${stake} SBYTE`,
                gameType ? `in ${gameType}` : null,
                opponent ? `vs ${opponent}` : null,
            ].filter(Boolean);
            return details.join(' ');
        }
        if (Number.isFinite(winnings) && winnings > 0) {
            const details = [
                `Won ${winnings} SBYTE`,
                gameType ? `in ${gameType}` : null,
                opponent ? `vs ${opponent}` : null,
            ].filter(Boolean);
            return details.join(' ');
        }
    }

    const parts: string[] = [baseLabel];

    // Social context: "socialized with Alice"
    if (meta.targetName && typeof meta.targetName === 'string') {
        parts.push(`with ${meta.targetName}`);
    } else if (meta.targetIds && Array.isArray(meta.targetIds) && meta.targetIds.length > 0) {
        parts.push(`(${meta.targetIds.length} involved)`);
    }

    if ((rawType === 'EVENT_SOCIALIZED' || rawType === 'socialize')
        && meta.publicPlaceName
        && typeof meta.publicPlaceName === 'string') {
        parts.push(`in ${meta.publicPlaceName}`);
    }

    // Work context: "at Bob's Bakery"
    if (meta.businessName && typeof meta.businessName === 'string') {
        parts.push(`at ${meta.businessName}`);
    }

    const formatPrice = (value: unknown): string | null => {
        if (value === undefined || value === null) return null;
        const asNumber = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(asNumber)) return null;
        return `${asNumber} SBYTE`;
    };

    // Trade context: "bread (x3) for 15 SBYTE"
    if (meta.itemName && typeof meta.itemName === 'string') {
        let itemStr = formatItemName(meta.itemName);
        const quantity = typeof meta.quantity === 'number' ? meta.quantity : Number(meta.quantity);
        if (Number.isFinite(quantity) && quantity > 1) {
            itemStr += ` (x${quantity})`;
        }
        parts.push(itemStr);
        const price = formatPrice(meta.price ?? meta.totalCost ?? meta.amount);
        if (price) {
            parts.push(`for ${price}`);
        }
    }

    // Housing context: "Cozy Cottage"
    if (meta.propertyName && typeof meta.propertyName === 'string') {
        parts.push(`"${formatPropertyName(meta.propertyName, null)}"`);
    }

    // Crime context: "theft — caught"
    if (meta.crimeType && typeof meta.crimeType === 'string') {
        parts.push(`(${meta.crimeType})`);
    }

    // Outcome: "— succeeded"
    if (meta.outcome && typeof meta.outcome === 'string') {
        parts.push(`— ${meta.outcome}`);
    }

    // Salary/earnings
    if (meta.salary && typeof meta.salary === 'number') {
        parts.push(`(+${meta.salary} SBYTE)`);
    }

    return parts.join(' ');
}

const CONTINUOUS_EVENT_TYPES = new Set([
    'rest',
    'worked',
    'work',
]);

function getActorKey(event: Event): string {
    if (event.actorId) return event.actorId;
    if (event.actorName) return `name:${event.actorName.toLowerCase()}`;
    return 'unknown';
}

function normalizeContinuousEventType(event: Event): string {
    const meta = event.metadata as Record<string, unknown> | undefined;
    const rawType = typeof meta?.rawType === 'string' ? meta.rawType : '';
    if (rawType === 'EVENT_RESTED') return 'rest';
    return (event.eventType ?? '').toLowerCase();
}

function isContinuousEvent(event: Event): { isContinuous: boolean; key: string } {
    const normalizedType = normalizeContinuousEventType(event);
    if (CONTINUOUS_EVENT_TYPES.has(normalizedType)) {
        return { isContinuous: true, key: normalizedType };
    }
    const description = typeof event.description === 'string' ? event.description : '';
    const meta = event.metadata as Record<string, unknown> | undefined;
    const metaDescription = typeof meta?.description === 'string' ? meta.description : '';
    const combined = `${description} ${metaDescription}`.toLowerCase();
    if (combined.includes('resting')) {
        return { isContinuous: true, key: 'rest' };
    }
    return { isContinuous: false, key: normalizedType };
}

export function collapseRepeatedEvents(events: Event[]): Event[] {
    const collapsed: Event[] = [];
    const seenByActor = new Set<string>();
    for (const event of events) {
        const continuous = isContinuousEvent(event);
        if (continuous.isContinuous) {
            const key = `${getActorKey(event)}|${continuous.key}`;
            if (seenByActor.has(key)) {
                continue;
            }
            seenByActor.add(key);
        }
        collapsed.push(event);
    }
    return collapsed;
}
