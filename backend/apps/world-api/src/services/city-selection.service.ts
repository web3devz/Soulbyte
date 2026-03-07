import { prisma } from '../db.js';
import type { EconomicSnapshot } from './economy-snapshot.service.js';

export interface PersonalityTraits {
    ambition: number;
    riskTolerance: number;
    sociability: number;
}

export interface CityScore {
    cityId: string;
    score: number;
    reasons: string[];
}

export async function selectBirthCity(traits: PersonalityTraits): Promise<CityScore> {
    const cities = await prisma.city.findMany();
    if (cities.length === 0) {
        throw new Error('No cities available for birth');
    }

    const populations = await prisma.agentState.groupBy({
        by: ['cityId'],
        where: {
            cityId: { not: null },
            actor: { kind: 'agent', dead: false, frozen: false },
        },
        _count: { _all: true },
    });
    const popMap = new Map(populations.map((p) => [p.cityId ?? '', p._count._all]));

    const BOOTSTRAP_THRESHOLD = 100;
    const minPop = Math.min(...cities.map((c) => popMap.get(c.id) ?? 0));
    if (minPop < BOOTSTRAP_THRESHOLD) {
        const target = cities.reduce((best, city) => {
            const pop = popMap.get(city.id) ?? 0;
            const bestPop = popMap.get(best.id) ?? 0;
            return pop < bestPop ? city : best;
        });
        return { cityId: target.id, score: 1.0, reasons: ['bootstrap_equalization'] };
    }

    const scores: CityScore[] = [];
    for (const city of cities) {
        const snapshotRecord = await prisma.economicSnapshot.findFirst({
            where: { cityId: city.id },
            orderBy: { computedAtTick: 'desc' },
        });
        const snapshot = snapshotRecord?.data as EconomicSnapshot | undefined;

        if (!snapshot) {
            scores.push({ cityId: city.id, score: 50, reasons: ['no_data'] });
            continue;
        }

        let score = 50;
        const reasons: string[] = [];
        const pop = popMap.get(city.id) ?? 0;

        if (snapshot.unemployment_rate < 0.15) {
            score += 10;
            reasons.push('low_unemployment');
        } else if (snapshot.unemployment_rate > 0.3) {
            score -= 10;
            reasons.push('high_unemployment');
        }

        if (snapshot.economic_health === 'booming') {
            score += 15;
            reasons.push('booming_economy');
        } else if (snapshot.economic_health === 'recession' || snapshot.economic_health === 'crisis') {
            score -= 20;
            reasons.push('recession');
        }

        if (snapshot.recession_risk > 60) {
            score -= 15;
            reasons.push('high_recession_risk');
        }

        if (pop > 150) {
            score -= 5;
            reasons.push('crowded');
        } else if (pop < 80) {
            score += 5;
            reasons.push('less_competition');
        }

        if (snapshot.housing_vacancy_rate > 0.3) {
            score += 5;
            reasons.push('housing_available');
        } else if (snapshot.housing_vacancy_rate < 0.05) {
            score -= 10;
            reasons.push('housing_shortage');
        }

        const vault = await prisma.cityVault.findUnique({ where: { cityId: city.id } });
        if (vault && snapshot.avg_wage_public) {
            const dailyPayroll = (snapshot.avg_wage_public ?? 500) * (pop * 0.3);
            const runway = Number(vault.balanceSbyte) / Math.max(1, dailyPayroll);
            if (runway < 30) {
                score -= 10;
                reasons.push('low_city_funds');
            }
        }

        if (traits.ambition > 70 && snapshot.economic_health === 'booming') {
            score += 10;
            reasons.push('ambitious_prefers_boom');
        }
        if (traits.riskTolerance < 30 && snapshot.recession_risk > 40) {
            score -= 10;
            reasons.push('cautious_avoids_risk');
        }
        if (traits.sociability > 70 && pop > 100) {
            score += 5;
            reasons.push('social_prefers_crowd');
        }

        scores.push({ cityId: city.id, score, reasons });
    }

    const totalScore = scores.reduce((sum, s) => sum + Math.max(s.score, 1), 0);
    let roll = Math.random() * totalScore;
    for (const s of scores) {
        roll -= Math.max(s.score, 1);
        if (roll <= 0) return s;
    }

    return scores[0];
}
