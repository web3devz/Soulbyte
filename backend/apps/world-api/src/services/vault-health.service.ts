import { ethers } from 'ethers';
import Decimal from 'decimal.js';
import { prisma } from '../db.js';
import { CONTRACTS } from '../config/contracts.js';

export interface VaultHealth {
    onchainBalance: string;
    onchainBalanceFormatted: number;
    totalDailyBurnRate: number;
    healthDays: number;
    cityCosts: Array<{
        cityId: string;
        cityName: string;
        publicEmployeeCount: number;
        dailySalaryCost: number;
        dailyInfraCost: number;
    }>;
    activeAgents: number;
    computedAt: string;
}

const INFRA_COST_MULTIPLIER = 0.1;

export class VaultHealthService {
    async getOnchainVaultBalance(): Promise<bigint> {
        const vault = await prisma.holderBalance.findUnique({
            where: { walletAddress: CONTRACTS.PUBLIC_VAULT_AND_GOD.toLowerCase() },
            select: { sbyteBalance: true }
        });
        if (!vault?.sbyteBalance) {
            return 0n;
        }
        const raw = new Decimal(vault.sbyteBalance.toString());
        return BigInt(raw.toFixed(0));
    }

    async computeCityCosts(): Promise<VaultHealth['cityCosts']> {
        const [cities, employments] = await Promise.all([
            prisma.city.findMany({ select: { id: true, name: true } }),
            prisma.publicEmployment.findMany({
                where: { endedAtTick: null },
                select: { dailySalarySbyte: true, publicPlace: { select: { cityId: true } } }
            })
        ]);

        const cityMap = new Map(cities.map(city => [city.id, city.name]));
        const costByCity = new Map<string, { count: number; salary: Decimal }>();

        for (const employment of employments) {
            const cityId = employment.publicPlace?.cityId;
            if (!cityId) continue;
            const entry = costByCity.get(cityId) ?? { count: 0, salary: new Decimal(0) };
            entry.count += 1;
            entry.salary = entry.salary.add(new Decimal(employment.dailySalarySbyte.toString()));
            costByCity.set(cityId, entry);
        }

        const cityCosts: VaultHealth['cityCosts'] = [];
        for (const [cityId, entry] of costByCity.entries()) {
            const dailySalaryCost = entry.salary.toNumber();
            const dailyInfraCost = dailySalaryCost * INFRA_COST_MULTIPLIER;
            cityCosts.push({
                cityId,
                cityName: cityMap.get(cityId) ?? 'Unknown',
                publicEmployeeCount: entry.count,
                dailySalaryCost,
                dailyInfraCost
            });
        }

        // Include cities with zero public employees
        for (const city of cities) {
            if (cityCosts.some(cost => cost.cityId === city.id)) continue;
            cityCosts.push({
                cityId: city.id,
                cityName: city.name,
                publicEmployeeCount: 0,
                dailySalaryCost: 0,
                dailyInfraCost: 0
            });
        }

        return cityCosts;
    }

    async computeVaultHealth(): Promise<VaultHealth> {
        const [onchainBalance, cityCosts, activeAgents] = await Promise.all([
            this.getOnchainVaultBalance(),
            this.computeCityCosts(),
            prisma.actor.count({ where: { kind: 'agent', frozen: false, dead: false } })
        ]);

        const totalDailyBurnRate = cityCosts.reduce(
            (sum, cost) => sum + cost.dailySalaryCost + cost.dailyInfraCost,
            0
        );
        const onchainBalanceFormatted = Number(ethers.formatUnits(onchainBalance, 18));
        const healthDays = totalDailyBurnRate > 0
            ? onchainBalanceFormatted / totalDailyBurnRate
            : 9999;

        return {
            onchainBalance: onchainBalance.toString(),
            onchainBalanceFormatted,
            totalDailyBurnRate,
            healthDays,
            cityCosts,
            activeAgents,
            computedAt: new Date().toISOString()
        };
    }
}
