import { prisma } from '../db.js';
import { pnlEngine } from '../engine/pnl.engine.js';
import { getNetFlowForActor } from './transaction-ledger.service.js';

const TICKS_PER_HOUR = 720;
const TICKS_PER_DAY = TICKS_PER_HOUR * 24;
const TICKS_PER_WEEK = TICKS_PER_DAY * 7;

type PnlBreakdown = {
    current: {
        net_worth: number;
        wallet_balance: number;
        business_value: number;
        property_value: number;
        debt_value: number;
    };
    pnl: {
        day: number;
        week: number;
        all_time: number;
    };
    history: Array<{ tick: number; net_worth: number }>;
};

export class PnlService {
    async getAgentPnl(actorId: string, historyLimit = 168): Promise<PnlBreakdown & { actor_id: string; actor_name: string }> {
        const actor = await prisma.actor.findUnique({
            where: { id: actorId },
            select: { id: true, name: true, kind: true },
        });
        if (!actor || actor.kind !== 'agent') {
            throw new Error('Agent not found');
        }

        const current = await pnlEngine.computeNetWorth(actorId);
        const snapshots = await prisma.pnlSnapshot.findMany({
            where: { actorId },
            orderBy: { tick: 'desc' },
            take: historyLimit,
        });
        const worldState = await prisma.worldState.findFirst({ where: { id: 1 } });
        const latestTick = worldState?.tick ?? snapshots[0]?.tick ?? 0;
        const dayStartTick = Math.max(latestTick - TICKS_PER_DAY, 0);
        const weekStartTick = Math.max(latestTick - TICKS_PER_WEEK, 0);
        const [dayPnl, weekPnl, allTimePnl] = await Promise.all([
            getNetFlowForActor(actorId, dayStartTick),
            getNetFlowForActor(actorId, weekStartTick),
            getNetFlowForActor(actorId, 0),
        ]);

        return {
            actor_id: actor.id,
            actor_name: actor.name,
            current: {
                net_worth: current.total,
                wallet_balance: current.wallet,
                business_value: current.business,
                property_value: current.property,
                debt_value: current.debt,
            },
            pnl: {
                day: dayPnl,
                week: weekPnl,
                all_time: allTimePnl,
            },
            history: snapshots
                .slice()
                .reverse()
                .map((snap) => ({
                    tick: snap.tick,
                    net_worth: Number(snap.netWorth),
                })),
        };
    }

    async getLeaderboard(period: 'day' | 'week' | 'all_time'): Promise<Array<{
        rank: number;
        actor_id: string;
        actor_name: string;
        pnl: number;
        net_worth: number;
    }>> {
        const entries = await prisma.pnlLeaderboard.findMany({
            where: { period },
            orderBy: { rank: 'asc' },
            take: 50,
        });

        return entries.map((entry) => ({
            rank: entry.rank,
            actor_id: entry.actorId,
            actor_name: entry.actorName,
            pnl: Number(entry.pnl),
            net_worth: Number(entry.netWorth),
        }));
    }
}

export const pnlService = new PnlService();
