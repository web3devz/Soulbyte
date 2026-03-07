export const GOVERNANCE_TAX_LIMITS = {
    rentTax: { min: 0, max: 0.25 },
    tradeTax: { min: 0, max: 0.2 },
    professionTax: { min: 0, max: 0.2 },
    cityFeeRate: { min: 0.0001, max: 0.02 },
};

export const BUSINESS_TAX_LIMITS = {
    minRate: 0.0,
    maxRate: 0.1,
    godMaxRate: 0.15,
    rateChangeLimit: 0.02,
    changeCooldownTicks: 7200,
};

export const UPGRADE_COSTS_PER_UNIT: Record<string, number> = {
    housing: 100,
    jobs: 80,
    security: 120,
    health: 150,
    entertainment: 90,
    transport: 110,
};
