/**
 * Fee Configuration
 * Platform and city fee rates in basis points (bps)
 * 1 bps = 0.01%
 */

/**
 * Fee constants
 */
const rawPlatformFeeBps = Number(process.env.PLATFORM_FEE_BPS);
const platformFeeBps = Number.isFinite(rawPlatformFeeBps) && rawPlatformFeeBps >= 0
    ? Math.floor(rawPlatformFeeBps)
    : 150;

let cachedVaultHealthDays = 75;

export const FEE_CONFIG = {
    /** Platform fee: immutable, env-configured (default 1.5% / 150 bps) */
    PLATFORM_FEE_BPS: platformFeeBps,

    /** City fee minimum: 0.05% (5 bps) */
    CITY_FEE_MIN_BPS: 5,

    /** City fee maximum (mayor-settable): 2% (200 bps) */
    CITY_FEE_MAX_BPS: 200,

    /** City fee absolute maximum (God override cap): 10% (1000 bps) */
    CITY_FEE_ABSOLUTE_MAX_BPS: 1000,

    /** Default city fee: 1.5% (150 bps) */
    CITY_FEE_DEFAULT_BPS: 150,

    /** Basis points denominator */
    BPS_DENOMINATOR: 10000n,
} as const;

export function updateCachedVaultHealth(days: number): void {
    if (!Number.isFinite(days) || days <= 0) return;
    cachedVaultHealthDays = days;
}

export function getCachedVaultHealth(): number {
    return cachedVaultHealthDays;
}

export function getDynamicFeeBps(vaultHealthDays: number): { platformBps: number; cityBps: number } {
    if (vaultHealthDays > 120) return { platformBps: 100, cityBps: 100 };
    if (vaultHealthDays > 90) return { platformBps: 125, cityBps: 125 };
    if (vaultHealthDays > 60) return { platformBps: 150, cityBps: 150 };
    if (vaultHealthDays > 30) return { platformBps: 200, cityBps: 200 };
    return { platformBps: 250, cityBps: 250 };
}

export function normalizeCityFeeBps(cityFeeBps: number, allowGodOverride: boolean = false): number {
    const maxBps = allowGodOverride ? FEE_CONFIG.CITY_FEE_ABSOLUTE_MAX_BPS : FEE_CONFIG.CITY_FEE_MAX_BPS;
    return Math.min(Math.max(cityFeeBps, FEE_CONFIG.CITY_FEE_MIN_BPS), maxBps);
}

/**
 * Fee calculation result
 */
export interface FeeCalculation {
    /** Amount going to platform fee vault */
    platformFee: bigint;
    /** Amount going to city vault */
    cityFee: bigint;
    /** Net amount after fees */
    netAmount: bigint;
    /** Total fees deducted */
    totalFees: bigint;
}

/**
 * Calculate fees for a transfer
 * @param amount - Transfer amount in wei (bigint)
 * @param cityFeeBps - City fee in basis points
 * @param platformFeeBps - Platform fee in basis points
 * @returns Fee breakdown
 */
export function calculateFees(
    amount: bigint,
    cityFeeBps: number = FEE_CONFIG.CITY_FEE_DEFAULT_BPS,
    platformFeeBps: number = FEE_CONFIG.PLATFORM_FEE_BPS
): FeeCalculation {
    if (amount <= 0n) {
        return {
            platformFee: 0n,
            cityFee: 0n,
            netAmount: 0n,
            totalFees: 0n,
        };
    }

    // Validate city fee bounds
    const validatedCityFeeBps = normalizeCityFeeBps(cityFeeBps, true);
    const validatedPlatformFeeBps = Math.max(0, Math.floor(platformFeeBps));

    const platformFee = (amount * BigInt(validatedPlatformFeeBps)) / FEE_CONFIG.BPS_DENOMINATOR;
    const cityFee = (amount * BigInt(validatedCityFeeBps)) / FEE_CONFIG.BPS_DENOMINATOR;
    const totalFees = platformFee + cityFee;
    const netAmount = amount - totalFees;

    return {
        platformFee,
        cityFee,
        netAmount,
        totalFees,
    };
}

/**
 * Calculate fees for agent-to-agent transfer (same as calculateFees)
 * @param amount - Transfer amount in wei
 * @param cityFeeBps - City fee rate
 */
export function calculateAgentTransferFees(
    amount: bigint,
    cityFeeBps: number,
    platformFeeBps?: number
): FeeCalculation {
    return calculateFees(amount, cityFeeBps, platformFeeBps);
}

/**
 * Validate city fee rate is within bounds
 * @param feeBps - Fee in basis points
 * @param isGodOverride - If true, allows up to CITY_FEE_ABSOLUTE_MAX_BPS
 * @returns true if valid
 */
export function isValidCityFee(feeBps: number, isGodOverride: boolean = false): boolean {
    const maxBps = isGodOverride ? FEE_CONFIG.CITY_FEE_ABSOLUTE_MAX_BPS : FEE_CONFIG.CITY_FEE_MAX_BPS;
    return feeBps >= FEE_CONFIG.CITY_FEE_MIN_BPS && feeBps <= maxBps;
}

/**
 * Format basis points as percentage string
 * @param bps - Basis points
 * @returns Formatted string like "0.05%"
 */
export function formatBpsAsPercent(bps: number): string {
    return `${(bps / 100).toFixed(2)}%`;
}
