import { Decimal } from 'decimal.js';

const WEALTH_THRESHOLDS: Array<{ tier: string; min: Decimal }> = [
    { tier: 'W9', min: new Decimal(5000001) },
    { tier: 'W8', min: new Decimal(1000001) },
    { tier: 'W7', min: new Decimal(500001) },
    { tier: 'W6', min: new Decimal(100001) },
    { tier: 'W5', min: new Decimal(10001) },
    { tier: 'W4', min: new Decimal(1001) },
    { tier: 'W3', min: new Decimal(101) },
    { tier: 'W2', min: new Decimal(11) },
    { tier: 'W1', min: new Decimal(1) },
    { tier: 'W0', min: new Decimal(0) },
];

export function getWealthTierFromBalance(balance: Decimal.Value): string {
    let value: Decimal;
    try {
        value = new Decimal(balance ?? 0);
    } catch {
        return 'W0';
    }
    if (!value.isFinite() || value.isNaN()) return 'W0';
    for (const threshold of WEALTH_THRESHOLDS) {
        if (value.greaterThanOrEqualTo(threshold.min)) return threshold.tier;
    }
    return 'W0';
}
