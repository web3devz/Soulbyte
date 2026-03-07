// Format Utilities - Number and currency formatting

export function formatSBYTE(amount: number | string): string {
    const num = typeof amount === 'string' ? parseFloat(amount) : amount;
    return num.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }) + ' SBYTE';
}

const HUMANIZE_SKIP = new Set(['SBYTE', 'MON']);

export function humanizeToken(value: string): string {
    const raw = value.trim();
    if (!raw) return value;
    const upper = raw.toUpperCase();
    if (HUMANIZE_SKIP.has(upper)) return upper;
    if (/^W\d+$/i.test(raw)) return raw.toUpperCase();
    const words = raw.replace(/_/g, ' ').toLowerCase();
    return words.replace(/\b\w/g, (char) => char.toUpperCase());
}

export function formatItemName(value: string): string {
    const raw = value.trim();
    if (raw.startsWith('CONS_')) {
        return humanizeToken(raw.replace('CONS_', ''));
    }
    return humanizeToken(raw);
}

export function formatHousingTier(value?: string | null): string {
    if (!value) return '—';
    return humanizeToken(value);
}

export function formatPropertyName(value?: string | null, fallbackTier?: string | null): string {
    const raw = (value ?? fallbackTier ?? '').trim();
    if (!raw) return 'Property';
    const hasSuffix = raw.toLowerCase().endsWith(' property');
    const base = hasSuffix ? raw.slice(0, -9) : raw;
    if (base.includes('_') || /^[A-Z0-9_]+$/.test(base)) {
        const human = humanizeToken(base);
        return hasSuffix ? `${human} Property` : human;
    }
    return raw;
}

export function abbreviateNumber(num: number): string {
    if (num < 1000) return num.toString();
    if (num < 1000000) return (num / 1000).toFixed(1) + 'K';
    if (num < 1000000000) return (num / 1000000).toFixed(1) + 'M';
    return (num / 1000000000).toFixed(1) + 'B';
}

export function formatPercentage(rate: number, decimals: number = 2): string {
    return (rate * 100).toFixed(decimals) + '%';
}

export function truncateAddress(address: string, startChars: number = 6, endChars: number = 4): string {
    if (address.length <= startChars + endChars) return address;
    return `${address.slice(0, startChars)}...${address.slice(-endChars)}`;
}
