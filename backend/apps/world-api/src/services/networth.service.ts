import { Prisma } from '../../../../generated/prisma/index.js';
import { prisma } from '../db.js';
import { getWealthTierFromBalance } from '../utils/wealth-tier.js';

export type NetworthPeriod = 'all_time' | '7d' | '30d';

type CurrentNetworthRow = {
    agent_id: string;
    agent_name: string;
    created_at: Date;
    liquid_balance: unknown;
    property_assets: unknown;
    business_assets: unknown;
    net_worth: unknown;
    city: string | null;
};

type RankedEntry = {
    rank: number;
    agent_id: string;
    agent_name: string;
    agent_avatar: string | null;
    wealth_tier: string;
    net_worth: number;
    liquid_balance: number;
    property_assets: number;
    business_assets: number;
    city: string | null;
    created_at: Date;
};

type NetworthSnapshotRow = {
    agent_id: string;
    total_net_worth: unknown;
    snapshot_at?: Date;
};

const PERIOD_DAYS: Record<Exclude<NetworthPeriod, 'all_time'>, number> = {
    '7d': 7,
    '30d': 30,
};

const toNumber = (value: unknown) => {
    const num = Number(value ?? 0);
    return Number.isFinite(num) ? num : 0;
};

const safePct = (delta: number, start: number | null) => {
    if (start === null || start === 0) return null;
    return (delta / start) * 100;
};

export class NetworthService {
    private async fetchCurrentRows(): Promise<CurrentNetworthRow[]> {
        return prisma.$queryRaw<CurrentNetworthRow[]>(Prisma.sql`
            WITH property_assets AS (
                SELECT p.owner_id AS agent_id, COALESCE(SUM(p.cost_basis), 0) AS property_assets
                FROM properties p
                WHERE p.owner_id IS NOT NULL
                GROUP BY p.owner_id
            ),
            business_assets AS (
                SELECT b.owner_id AS agent_id, COALESCE(SUM(b.cost_basis), 0) AS business_assets
                FROM businesses b
                WHERE b.owner_id IS NOT NULL
                  AND b.status = 'ACTIVE'
                GROUP BY b.owner_id
            )
            SELECT
                a.id AS agent_id,
                a.name AS agent_name,
                a.created_at AS created_at,
                COALESCE(w.balance_sbyte, 0) AS liquid_balance,
                COALESCE(pa.property_assets, 0) AS property_assets,
                COALESCE(ba.business_assets, 0) AS business_assets,
                CASE
                    WHEN a.frozen = true THEN 0
                    ELSE COALESCE(w.balance_sbyte, 0) + COALESCE(pa.property_assets, 0) + COALESCE(ba.business_assets, 0)
                END AS net_worth,
                c.name AS city
            FROM actors a
            LEFT JOIN wallets w ON w.actor_id = a.id
            LEFT JOIN agent_state s ON s.actor_id = a.id
            LEFT JOIN cities c ON c.id = s.city_id
            LEFT JOIN property_assets pa ON pa.agent_id = a.id
            LEFT JOIN business_assets ba ON ba.agent_id = a.id
            WHERE a.kind = 'agent'
              AND a.is_god = false
              AND a.dead = false
        `);
    }

    private rankRows(rows: CurrentNetworthRow[], includeNegative: boolean): RankedEntry[] {
        const normalized = rows.map((row) => {
            const liquidBalance = toNumber(row.liquid_balance);
            const propertyAssets = toNumber(row.property_assets);
            const businessAssets = toNumber(row.business_assets);
            const netWorth = toNumber(row.net_worth);

            return {
                agent_id: row.agent_id,
                agent_name: row.agent_name,
                agent_avatar: null,
                wealth_tier: getWealthTierFromBalance(netWorth),
                net_worth: netWorth,
                liquid_balance: liquidBalance,
                property_assets: propertyAssets,
                business_assets: businessAssets,
                city: row.city ?? null,
                created_at: row.created_at,
            };
        });

        const filtered = includeNegative
            ? normalized
            : normalized.filter((row) => row.net_worth > 0);

        filtered.sort((a, b) => {
            if (b.net_worth !== a.net_worth) return b.net_worth - a.net_worth;
            if (b.liquid_balance !== a.liquid_balance) return b.liquid_balance - a.liquid_balance;
            return a.agent_id.localeCompare(b.agent_id);
        });

        return filtered.map((row, idx) => ({
            ...row,
            rank: idx + 1,
        }));
    }

    private async getSnapshotMap(agentIds: string[], boundary: Date): Promise<Map<string, number>> {
        if (agentIds.length === 0) return new Map();
        const rows = await prisma.$queryRaw<NetworthSnapshotRow[]>(Prisma.sql`
            SELECT DISTINCT ON (n.agent_id)
                n.agent_id,
                n.total_net_worth
            FROM networth_snapshots n
            WHERE n.agent_id IN (${Prisma.join(agentIds)})
              AND n.snapshot_at <= ${boundary}
            ORDER BY n.agent_id, n.snapshot_at DESC
        `);

        return new Map(rows.map((row) => [row.agent_id, toNumber(row.total_net_worth)]));
    }

    private async getFirstSnapshotMap(agentIds: string[]): Promise<Map<string, { netWorth: number; snapshotAt: Date }>> {
        if (agentIds.length === 0) return new Map();
        const rows = await prisma.$queryRaw<NetworthSnapshotRow[]>(Prisma.sql`
            SELECT DISTINCT ON (n.agent_id)
                n.agent_id,
                n.total_net_worth,
                n.snapshot_at
            FROM networth_snapshots n
            WHERE n.agent_id IN (${Prisma.join(agentIds)})
            ORDER BY n.agent_id, n.snapshot_at ASC
        `);

        return new Map(rows.map((row) => [
            row.agent_id,
            { netWorth: toNumber(row.total_net_worth), snapshotAt: row.snapshot_at ?? new Date(0) }
        ]));
    }

    async getLeaderboard(params: {
        period: NetworthPeriod;
        page: number;
        limit: number;
        includeNegative: boolean;
    }) {
        const page = Math.max(1, Math.trunc(params.page || 1));
        const limit = Math.min(100, Math.max(1, Math.trunc(params.limit || 20)));
        const currentRows = await this.fetchCurrentRows();
        const ranked = this.rankRows(currentRows, params.includeNegative);
        const totalRanked = ranked.length;
        const totalPages = Math.max(1, Math.ceil(totalRanked / limit));
        const offset = (page - 1) * limit;
        const entriesPage = ranked.slice(offset, offset + limit);

        let snapshotMap: Map<string, number> | null = null;
        let periodBoundary: Date | null = null;
        let allTimeStartMap: Map<string, { netWorth: number; snapshotAt: Date }> | null = null;
        if (params.period !== 'all_time') {
            const days = PERIOD_DAYS[params.period];
            const boundary = new Date(Date.now() - (days * 24 * 60 * 60 * 1000));
            periodBoundary = boundary;
            const agentIds = entriesPage.map((entry) => entry.agent_id);
            snapshotMap = await this.getSnapshotMap(
                agentIds,
                boundary
            );
        } else {
            const agentIds = entriesPage.map((entry) => entry.agent_id);
            allTimeStartMap = await this.getFirstSnapshotMap(agentIds);
        }

        const entries = entriesPage.map((entry) => {
            const createdAtMs = entry.created_at?.getTime?.();
            const isNewForPeriod = Boolean(
                params.period !== 'all_time'
                && createdAtMs
                && periodBoundary
                && createdAtMs >= periodBoundary.getTime()
            );
            const startNetworth: number | null = params.period === 'all_time'
                ? null
                : (snapshotMap?.get(entry.agent_id) ?? null);
            const delta = startNetworth === null ? null : entry.net_worth - startNetworth;
            const allTimeGainLoss = params.period === 'all_time'
                ? (allTimeStartMap?.get(entry.agent_id) === undefined
                    ? null
                    : entry.net_worth - (allTimeStartMap.get(entry.agent_id)?.netWorth ?? entry.net_worth))
                : null;
            return {
                ...entry,
                is_new_for_period: params.period === 'all_time' ? false : isNewForPeriod,
                has_snapshot_for_period: params.period === 'all_time'
                    ? Boolean(allTimeStartMap?.has(entry.agent_id))
                    : Boolean(snapshotMap?.has(entry.agent_id)),
                delta: params.period === 'all_time' ? null : delta,
                delta_pct: params.period === 'all_time' ? null : safePct(delta ?? 0, startNetworth),
                all_time_gain_loss: allTimeGainLoss,
            };
        });

        return {
            period: params.period,
            page,
            total_pages: totalPages,
            total_ranked: totalRanked,
            entries,
        };
    }

    async getActorWealthStats(actorId: string) {
        const rows = await this.fetchCurrentRows();
        const rankedPositive = this.rankRows(rows, false);
        const rankedAll = this.rankRows(rows, true);
        const actorCurrent = rankedAll.find((row) => row.agent_id === actorId);
        if (!actorCurrent) return null;

        const now = Date.now();
        const boundary7d = new Date(now - (7 * 24 * 60 * 60 * 1000));
        const boundary30d = new Date(now - (30 * 24 * 60 * 60 * 1000));
        const [snap7d, snap30d] = await Promise.all([
            this.getSnapshotMap([actorId], boundary7d),
            this.getSnapshotMap([actorId], boundary30d),
        ]);

        const start7d = snap7d.get(actorId) ?? null;
        const start30d = snap30d.get(actorId) ?? null;

        // Rank delta is computed only against positive-rank history snapshots.
        const currentPositiveRank = actorCurrent.net_worth > 0
            ? rankedPositive.find((row) => row.agent_id === actorId)?.rank ?? null
            : null;

        let rank7dDelta: number | null = null;
        if (currentPositiveRank !== null) {
            const boundary = new Date(now - (7 * 24 * 60 * 60 * 1000));
            const historicalRows = await prisma.$queryRaw<NetworthSnapshotRow[]>(Prisma.sql`
                SELECT DISTINCT ON (n.agent_id)
                    n.agent_id,
                    n.total_net_worth
                FROM networth_snapshots n
                INNER JOIN actors a ON a.id = n.agent_id
                WHERE n.snapshot_at <= ${boundary}
                  AND a.kind = 'agent'
                  AND a.is_god = false
                  AND a.dead = false
                ORDER BY n.agent_id, n.snapshot_at DESC
            `);

            const historicalPositive = historicalRows
                .map((row) => ({
                    agent_id: row.agent_id,
                    total_net_worth: toNumber(row.total_net_worth),
                }))
                .filter((row) => row.total_net_worth > 0)
                .sort((a, b) => {
                    if (b.total_net_worth !== a.total_net_worth) return b.total_net_worth - a.total_net_worth;
                    return a.agent_id.localeCompare(b.agent_id);
                });

            const historicalRank = historicalPositive.findIndex((row) => row.agent_id === actorId);
            if (historicalRank >= 0) {
                // Positive value means rank improved (e.g., 20 -> 15 => +5)
                rank7dDelta = (historicalRank + 1) - currentPositiveRank;
            }
        }

        return {
            net_worth: actorCurrent.net_worth,
            liquid_balance: actorCurrent.liquid_balance,
            property_assets: actorCurrent.property_assets,
            business_assets: actorCurrent.business_assets,
            wealth_rank: currentPositiveRank,
            wealth_rank_7d_delta: rank7dDelta,
            net_worth_7d_delta: start7d === null ? null : actorCurrent.net_worth - start7d,
            net_worth_30d_delta: start30d === null ? null : actorCurrent.net_worth - start30d,
            wealth_tier: actorCurrent.wealth_tier,
        };
    }

    async takeSnapshots(at = new Date()) {
        const rows = await this.fetchCurrentRows();
        if (rows.length === 0) return 0;

        await prisma.networthSnapshot.createMany({
            data: rows.map((row) => {
                const liquidBalance = toNumber(row.liquid_balance);
                const propertyAssets = toNumber(row.property_assets);
                const businessAssets = toNumber(row.business_assets);
                const netWorth = toNumber(row.net_worth);
                return {
                    agentId: row.agent_id,
                    snapshotAt: at,
                    liquidBalance,
                    propertyAssets,
                    businessAssets,
                    totalNetWorth: netWorth,
                };
            }),
        });

        return rows.length;
    }
}

export const networthService = new NetworthService();
