import { prisma } from '../../db.js';

const NEIGHBORHOOD_RADIUS = 50;

const PROXIMITY_EFFECTS: Record<string, number> = {
    RESTAURANT: 0.05,
    CLINIC: 0.04,
    BANK: 0.02,
    CASINO: -0.02,
    HOSPITAL: 0.03,
    SCHOOL: 0.04,
    POLICE_STATION: 0.02,
    IMPORT_CENTER: 0.01,
};

export class NeighborhoodEngine {
    async computeNeighborhoodScores(cityId: string, tick: number): Promise<void> {
        const properties = await prisma.property.findMany({
            where: { cityId, isEmptyLot: false },
            select: { id: true, latitude: true, longitude: true }
        });

        const businesses = await prisma.business.findMany({
            where: { cityId, status: 'ACTIVE' },
            select: { businessType: true, landId: true }
        });

        const businessLandIds = Array.from(new Set(businesses.map((biz) => biz.landId)));
        const businessLandMap = new Map(
            (
                await prisma.property.findMany({
                    where: { id: { in: businessLandIds } },
                    select: { id: true, latitude: true, longitude: true }
                })
            ).map((land) => [land.id, land])
        );

        const publicPlaces = await prisma.publicPlace.findMany({
            where: { cityId },
            select: { type: true, latitude: true, longitude: true }
        });

        const crimeCount = await prisma.crime.count({
            where: { cityId, tick: { gte: tick - 2000 } }
        });
        const crimePenalty = crimeCount >= 3 ? -Math.min(0.1, crimeCount / 300) : 0;

        for (const prop of properties) {
            if (!prop.latitude || !prop.longitude) continue;

            let score = 0;

            for (const biz of businesses) {
                const land = businessLandMap.get(biz.landId);
                const lat = land?.latitude;
                const lng = land?.longitude;
                if (!lat || !lng) continue;
                const dist = this.distance(prop, { latitude: lat, longitude: lng });
                if (dist > NEIGHBORHOOD_RADIUS) continue;
                const effect = PROXIMITY_EFFECTS[biz.businessType] ?? 0;
                const distanceFactor = 1 - dist / NEIGHBORHOOD_RADIUS;
                score += effect * distanceFactor;
            }

            for (const pp of publicPlaces) {
                if (!pp.latitude || !pp.longitude) continue;
                const dist = this.distance(prop, pp);
                if (dist > NEIGHBORHOOD_RADIUS) continue;
                const effect = PROXIMITY_EFFECTS[pp.type] ?? 0;
                const distanceFactor = 1 - dist / NEIGHBORHOOD_RADIUS;
                score += effect * distanceFactor;
            }

            score += crimePenalty;

            const finalScore = Math.max(-1.0, Math.min(1.0, score));
            await prisma.property.update({
                where: { id: prop.id },
                data: { neighborhoodScore: finalScore, lastNeighborhoodTick: tick }
            });
        }
    }

    private distance(a: { latitude: any; longitude: any }, b: { latitude: any; longitude: any }): number {
        const dx = Number(a.latitude) - Number(b.latitude);
        const dy = Number(a.longitude) - Number(b.longitude);
        return Math.sqrt(dx * dx + dy * dy);
    }
}

export const neighborhoodEngine = new NeighborhoodEngine();
