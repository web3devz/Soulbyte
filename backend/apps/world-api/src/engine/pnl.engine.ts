import { prisma } from '../db.js';
import { getNetFlowsByActor } from '../services/transaction-ledger.service.js';

const TICKS_PER_HOUR = 720;
const TICKS_PER_DAY = TICKS_PER_HOUR * 24;
const TICKS_PER_WEEK = TICKS_PER_DAY * 7;

export type NetWorthBreakdown = {
    total: number;
    wallet: number;
    business: number;
    property: number;
    debt: number;
};

export class PnlEngine {
    async takeSnapshots(tick: number): Promise<void> {
        const agents = await prisma.actor.findMany({
            where: { kind: 'agent', dead: false, frozen: false },
            select: { id: true },
        });

        for (const agent of agents) {
            const netWorth = await this.computeNetWorth(agent.id);
            await prisma.pnlSnapshot.create({
                data: {
                    actorId: agent.id,
                    tick,
                    netWorth: netWorth.total,
                    walletBalance: netWorth.wallet,
                    businessValue: netWorth.business,
                    propertyValue: netWorth.property,
                    debtValue: netWorth.debt,
                },
            });
        }

        await this.pruneOldSnapshots(tick);
        await this.refreshLeaderboard(tick);
    }

    async computeNetWorth(actorId: string): Promise<NetWorthBreakdown> {
        const wallet = await prisma.wallet.findUnique({ where: { actorId } });
        const walletBalance = Number(wallet?.balanceSbyte ?? 0);

        const businesses = await prisma.business.findMany({
            where: { ownerId: actorId, status: 'ACTIVE' },
            select: { treasury: true },
        });
        const businessValue = businesses.reduce((sum, b) => sum + Number(b.treasury ?? 0), 0);

        const properties = await prisma.property.findMany({
            where: { ownerId: actorId },
            select: { salePrice: true },
        });
        const propertyValue = properties.reduce((sum, p) => sum + Number(p.salePrice ?? 0), 0);

        const loans = await prisma.loan.findMany({
            where: { borrowerId: actorId, status: 'ACTIVE' },
            select: { outstanding: true },
        });
        const debtValue = loans.reduce((sum, l) => sum + Number(l.outstanding ?? 0), 0);

        const total = walletBalance + businessValue + propertyValue - debtValue;
        return { total, wallet: walletBalance, business: businessValue, property: propertyValue, debt: debtValue };
    }

    async refreshLeaderboard(tick: number): Promise<void> {
        const agents = await prisma.actor.findMany({
            where: { kind: 'agent', dead: false },
            select: { id: true, name: true },
        });

        await prisma.pnlLeaderboard.deleteMany({});

        const periods: Array<{ key: 'day' | 'week' | 'all_time'; startTick: number }> = [
            { key: 'day', startTick: Math.max(tick - TICKS_PER_DAY, 0) },
            { key: 'week', startTick: Math.max(tick - TICKS_PER_WEEK, 0) },
            { key: 'all_time', startTick: 0 },
        ];

        for (const period of periods) {
            const netFlows = await getNetFlowsByActor(period.startTick);
            const entries: Array<{ actorId: string; actorName: string; pnl: number; netWorth: number }> = [];

            for (const agent of agents) {
                const netWorth = await this.computeNetWorth(agent.id);
                const pnl = Number(netFlows.get(agent.id) ?? 0);

                entries.push({
                    actorId: agent.id,
                    actorName: agent.name,
                    pnl,
                    netWorth: netWorth.total,
                });
            }

            entries.sort((a, b) => b.pnl - a.pnl);
            const top50 = entries.slice(0, 50);

            if (top50.length > 0) {
                await prisma.pnlLeaderboard.createMany({
                    data: top50.map((entry, idx) => ({
                        period: period.key,
                        actorId: entry.actorId,
                        actorName: entry.actorName,
                        pnl: entry.pnl,
                        netWorth: entry.netWorth,
                        rank: idx + 1,
                    })),
                });
            }
        }
    }

    private async pruneOldSnapshots(currentTick: number): Promise<void> {
        const maxAge = TICKS_PER_HOUR * 168;
        const cutoff = Math.max(currentTick - maxAge, 0);
        await prisma.pnlSnapshot.deleteMany({
            where: { tick: { lt: cutoff } },
        });
    }
}

export const pnlEngine = new PnlEngine();
