import { Decimal } from 'decimal.js';
import { BUSINESS_TAX_LIMITS, GOVERNANCE_TAX_LIMITS, UPGRADE_COSTS_PER_UNIT } from '../config/governance.js';

type CityPolicy = {
    rentTaxRate?: unknown;
    tradeTaxRate?: unknown;
    professionTaxRate?: unknown;
    businessTaxRate?: unknown;
    lastTaxChangeTick?: unknown;
};

type ValidationContext = {
    proposalType: string;
    payload: Record<string, unknown>;
    vaultBalance: Decimal;
    cityPolicy?: CityPolicy | null;
    currentTick: number;
};

const ABSURD_LIMIT = 1_000_000;

function asNumber(value: unknown): number | null {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    return num;
}

export function validateGovernanceProposal(context: ValidationContext): {
    blockReasons: string[];
    warnReasons: string[];
    estimatedCost: Decimal;
    normalizedPayload: Record<string, unknown>;
} {
    const { proposalType, payload, vaultBalance, cityPolicy, currentTick } = context;
    const blockReasons: string[] = [];
    const warnReasons: string[] = [];
    const normalizedPayload: Record<string, unknown> = { ...payload };

    let estimatedCost = new Decimal(0);

    if (proposalType === 'tax_change') {
        const rentTaxRate = asNumber(payload.newTaxRate ?? payload.rentTaxRate);
        if (rentTaxRate === null) {
            blockReasons.push('Tax rate is not a valid number');
        } else if (rentTaxRate < GOVERNANCE_TAX_LIMITS.rentTax.min || rentTaxRate > GOVERNANCE_TAX_LIMITS.rentTax.max) {
            blockReasons.push(`Tax rate out of bounds: ${rentTaxRate}`);
        }

        if (payload.tradeTaxRate !== undefined) {
            const tradeTaxRate = asNumber(payload.tradeTaxRate);
            if (tradeTaxRate === null) {
                blockReasons.push('Trade tax rate is not a valid number');
            } else if (tradeTaxRate < GOVERNANCE_TAX_LIMITS.tradeTax.min || tradeTaxRate > GOVERNANCE_TAX_LIMITS.tradeTax.max) {
                blockReasons.push(`Trade tax out of bounds: ${tradeTaxRate}`);
            }
        }

        if (payload.professionTaxRate !== undefined) {
            const professionTaxRate = asNumber(payload.professionTaxRate);
            if (professionTaxRate === null) {
                blockReasons.push('Profession tax rate is not a valid number');
            } else if (professionTaxRate < GOVERNANCE_TAX_LIMITS.professionTax.min || professionTaxRate > GOVERNANCE_TAX_LIMITS.professionTax.max) {
                blockReasons.push(`Profession tax out of bounds: ${professionTaxRate}`);
            }
        }

        if (payload.cityFeeRate !== undefined) {
            const cityFeeRate = asNumber(payload.cityFeeRate);
            if (cityFeeRate === null) {
                blockReasons.push('City fee rate is not a valid number');
            } else if (cityFeeRate < GOVERNANCE_TAX_LIMITS.cityFeeRate.min || cityFeeRate > GOVERNANCE_TAX_LIMITS.cityFeeRate.max) {
                blockReasons.push(`City fee out of bounds: ${cityFeeRate}`);
            }
        }

        if (payload.businessTaxRate !== undefined) {
            const businessTaxRate = asNumber(payload.businessTaxRate);
            if (businessTaxRate === null) {
                blockReasons.push('Business tax rate is not a valid number');
            } else if (businessTaxRate < BUSINESS_TAX_LIMITS.minRate || businessTaxRate > BUSINESS_TAX_LIMITS.godMaxRate) {
                blockReasons.push('Business tax rate out of bounds');
            } else if (cityPolicy?.businessTaxRate !== undefined) {
                const currentRate = Number(cityPolicy.businessTaxRate);
                if (Math.abs(businessTaxRate - currentRate) > BUSINESS_TAX_LIMITS.rateChangeLimit) {
                    blockReasons.push('Business tax change too large');
                }
                if (
                    cityPolicy.lastTaxChangeTick &&
                    currentTick - Number(cityPolicy.lastTaxChangeTick) < BUSINESS_TAX_LIMITS.changeCooldownTicks
                ) {
                    blockReasons.push('Business tax change cooldown');
                }
            }
        }
    }

    if (proposalType === 'security') {
        const securityFunding = asNumber(payload.securityFunding ?? payload.funding ?? payload.amount);
        if (securityFunding === null) {
            blockReasons.push('Security funding is not a valid number');
        } else {
            if (securityFunding <= 0) blockReasons.push('Security funding set to 0 or negative');
            estimatedCost = new Decimal(securityFunding);
        }
    }

    if (proposalType === 'aid') {
        const aidAmount = asNumber(payload.amount ?? payload.aidAmount);
        if (aidAmount === null) {
            blockReasons.push('Aid amount is not a valid number');
        } else {
            if (aidAmount < 0) blockReasons.push('Aid amount is negative');
            estimatedCost = new Decimal(aidAmount);
        }
    }

    if (proposalType === 'upgrade') {
        const upgradeType = String(payload.upgradeType ?? '');
        const amount = asNumber(payload.amount) ?? 10;
        if (!upgradeType || !UPGRADE_COSTS_PER_UNIT[upgradeType]) {
            blockReasons.push('Invalid upgrade type');
        } else {
            const unitCost = UPGRADE_COSTS_PER_UNIT[upgradeType];
            estimatedCost = new Decimal(amount).mul(unitCost);
        }
        normalizedPayload.amount = amount;
    }

    if (estimatedCost.gt(0) && vaultBalance.lt(estimatedCost)) {
        blockReasons.push('Insufficient treasury');
    }

    for (const [key, value] of Object.entries(payload)) {
        if (typeof value !== 'number') continue;
        if (!Number.isFinite(value)) {
            blockReasons.push(`Non-finite value in payload: ${key}`);
            continue;
        }
        if (Math.abs(value) > ABSURD_LIMIT) {
            blockReasons.push(`Absurd value in payload: ${key}=${value}`);
        }
        if (value < 0 && !key.toLowerCase().includes('delta')) {
            blockReasons.push(`Negative value not allowed: ${key}=${value}`);
        }
    }

    return { blockReasons, warnReasons, estimatedCost, normalizedPayload };
}
