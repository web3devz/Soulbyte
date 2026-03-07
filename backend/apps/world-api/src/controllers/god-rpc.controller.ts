import { prisma } from '../db.js';
import { computeEconomicSnapshots, getLatestSnapshot } from '../services/economy-snapshot.service.js';
import { approveProposalById } from '../services/god.service.js';
import { Decimal } from 'decimal.js';
import { PUBLIC_ROLE_SALARIES } from '../types/intent.types.js';

const PRICE_MULTIPLIER = 80;
const RENT_MULTIPLIER = 80;
const GRID_WIDTH = 50;

const HOUSING_PRICE_MAP: Record<string, { rent: number; sale: number }> = {
    shelter: { rent: 0.5 * RENT_MULTIPLIER, sale: 25 * PRICE_MULTIPLIER },
    slum_room: { rent: 1.5 * RENT_MULTIPLIER, sale: 50 * PRICE_MULTIPLIER },
    apartment: { rent: 5 * RENT_MULTIPLIER, sale: 50 * PRICE_MULTIPLIER },
    condo: { rent: 25 * RENT_MULTIPLIER, sale: 500 * PRICE_MULTIPLIER },
    house: { rent: 250 * RENT_MULTIPLIER, sale: 5000 * PRICE_MULTIPLIER },
    villa: { rent: 2500 * RENT_MULTIPLIER, sale: 50000 * PRICE_MULTIPLIER },
    estate: { rent: 12500 * RENT_MULTIPLIER, sale: 250000 * PRICE_MULTIPLIER },
    palace: { rent: 25000 * RENT_MULTIPLIER, sale: 500000 * PRICE_MULTIPLIER },
    citadel: { rent: 125000 * RENT_MULTIPLIER, sale: 2500000 * PRICE_MULTIPLIER },
};

function defaultDistribution(units: number): Record<string, number> {
    return {
        apartment: Math.floor(units * 0.4),
        condo: Math.floor(units * 0.3),
        house: Math.floor(units * 0.2),
        shelter: units - (Math.floor(units * 0.4) + Math.floor(units * 0.3) + Math.floor(units * 0.2)),
    };
}

const TERRAIN_SIZE: Record<string, { width: number; height: number }> = {
    shelter: { width: 2, height: 2 },
    slum_room: { width: 2, height: 2 },
    apartment: { width: 3, height: 3 },
    condo: { width: 4, height: 4 },
    house: { width: 5, height: 5 },
    villa: { width: 6, height: 6 },
    estate: { width: 7, height: 7 },
    palace: { width: 8, height: 8 },
    citadel: { width: 10, height: 10 },
};

async function getPlacement(cityId: string, housingTier: string, index: number) {
    const size = TERRAIN_SIZE[housingTier] || { width: 3, height: 3 };
    const x = index % GRID_WIDTH;
    const y = Math.floor(index / GRID_WIDTH);
    return {
        latitude: y,
        longitude: x,
        terrainWidth: size.width,
        terrainHeight: size.height,
        terrainArea: size.width * size.height,
    };
}

async function getCurrentTick(): Promise<number> {
    const worldState = await prisma.worldState.findFirst({ where: { id: 1 } });
    return worldState?.tick ?? 0;
}

export const godController = {
    async analyzeEconomicConditions({ city_id }: { city_id: string }) {
        const currentTick = await getCurrentTick();
        await computeEconomicSnapshots(currentTick);
        const snapshot = getLatestSnapshot(city_id);
        if (!snapshot) {
            return { success: false, error: 'No snapshot available' };
        }
        const city = await prisma.city.findUnique({
            where: { id: city_id },
            include: { vault: true },
        });
        return { success: true, snapshot, city };
    },

    async executeEmergencyExpansion({ city_id, units }: { city_id: string; units: number }) {
        const distribution = defaultDistribution(units);
        const result = await godController.createHousing({ city_id, housing_distribution: distribution });
        return { success: true, result };
    },

    async adjustPublicSalaries({ city_id, percentage }: { city_id: string; percentage: number }) {
        const systemKey = 'PUBLIC_ROLE_SALARIES';
        const existing = await prisma.systemConfig.findUnique({ where: { key: systemKey } });
        const base = existing?.value ? JSON.parse(existing.value) : null;
        const salaryMap = base && typeof base === 'object' ? base : PUBLIC_ROLE_SALARIES;
        const updated: Record<string, number> = {};
        for (const [role, value] of Object.entries(salaryMap)) {
            const numeric = Number(value);
            updated[role] = Number.isFinite(numeric) ? Number(new Decimal(numeric).mul(1 + percentage).toFixed(2)) : numeric;
        }
        const serialized = JSON.stringify(updated);
        await prisma.systemConfig.upsert({
            where: { key: systemKey },
            update: { value: serialized },
            create: { key: systemKey, value: serialized, immutable: false },
        });
        return { success: true, city_id, percentage, salaries: updated };
    },

    async approveProposal({ proposal_id }: { proposal_id: string }) {
        const currentTick = await getCurrentTick();
        const result = await approveProposalById(proposal_id, currentTick);
        const proposal = await prisma.cityProposal.findUnique({ where: { id: proposal_id } });
        return { success: true, result, proposal };
    },

    async createHousing({ city_id, housing_distribution }: { city_id: string; housing_distribution: Record<string, number> }) {
        const entries = Object.entries(housing_distribution || {});
        if (entries.length === 0) {
            return { success: false, error: 'housing_distribution is required' };
        }

        const existingCount = await prisma.property.count({ where: { cityId: city_id } });
        const creations: any[] = [];
        let counter = 0;
        for (const [tier, count] of entries) {
            const config = HOUSING_PRICE_MAP[tier] || { rent: 0, sale: 0 };
            for (let i = 0; i < count; i += 1) {
                const placement = await getPlacement(city_id, tier, existingCount + counter);
                creations.push({
                    cityId: city_id,
                    housingTier: tier,
                    rentPrice: config.rent,
                    salePrice: config.sale,
                    forSale: true,
                    forRent: true,
                    isGenesisProperty: false,
                    isEmptyLot: false,
                    latitude: placement.latitude,
                    longitude: placement.longitude,
                    terrainWidth: placement.terrainWidth,
                    terrainHeight: placement.terrainHeight,
                    terrainArea: placement.terrainArea,
                });
                counter += 1;
            }
        }

        if (creations.length === 0) {
            return { success: false, error: 'No housing created' };
        }

        await prisma.property.createMany({ data: creations });
        await prisma.city.update({
            where: { id: city_id },
            data: { housingCapacity: { increment: creations.length } },
        });
        return { success: true, created: creations.length, city_id };
    },
};
