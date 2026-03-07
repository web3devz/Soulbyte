import { Prisma } from '../../../../generated/prisma/index.js';
import { prisma } from '../db.js';

type NetFlowRow = {
    actor_id: string;
    net: number | string;
};

export async function getNetFlowsByActor(startTick?: number, startDate?: Date): Promise<Map<string, number>> {
    const tickFilter = startTick !== undefined
        ? Prisma.sql`tick >= ${startTick}`
        : Prisma.sql``;
    const dateFilter = startDate
        ? Prisma.sql`created_at >= ${startDate}`
        : Prisma.sql``;
    const windowFilter = (startTick !== undefined || startDate)
        ? Prisma.sql`AND (${tickFilter} ${startTick !== undefined && startDate ? Prisma.sql`OR` : Prisma.sql``} ${dateFilter})`
        : Prisma.sql``;

    const rows = await prisma.$queryRaw<NetFlowRow[]>(Prisma.sql`
        SELECT actor_id, SUM(net) AS net
        FROM (
            SELECT "to_actor_id" AS actor_id,
                   SUM("amount" - COALESCE("fee_platform", 0) - COALESCE("fee_city", 0)) AS net
            FROM transactions
            WHERE "to_actor_id" IS NOT NULL
            ${windowFilter}
            GROUP BY "to_actor_id"
            UNION ALL
            SELECT "from_actor_id" AS actor_id,
                   SUM(-"amount") AS net
            FROM transactions
            WHERE "from_actor_id" IS NOT NULL
            ${windowFilter}
            GROUP BY "from_actor_id"
        ) flows
        GROUP BY actor_id
    `);

    const map = new Map<string, number>();
    for (const row of rows) {
        map.set(row.actor_id, Number(row.net ?? 0));
    }
    return map;
}

export async function getNetFlowForActor(actorId: string, startTick?: number, startDate?: Date): Promise<number> {
    const tickFilter = startTick !== undefined
        ? Prisma.sql`tick >= ${startTick}`
        : Prisma.sql``;
    const dateFilter = startDate
        ? Prisma.sql`created_at >= ${startDate}`
        : Prisma.sql``;
    const windowFilter = (startTick !== undefined || startDate)
        ? Prisma.sql`AND (${tickFilter} ${startTick !== undefined && startDate ? Prisma.sql`OR` : Prisma.sql``} ${dateFilter})`
        : Prisma.sql``;

    const rows = await prisma.$queryRaw<Array<{ net: number | string }>>(Prisma.sql`
        SELECT
            COALESCE(SUM(CASE WHEN "to_actor_id" = ${actorId}
                THEN ("amount" - COALESCE("fee_platform", 0) - COALESCE("fee_city", 0))
                ELSE 0 END), 0)
            + COALESCE(SUM(CASE WHEN "from_actor_id" = ${actorId}
                THEN -"amount"
                ELSE 0 END), 0) AS net
        FROM transactions
        WHERE ("to_actor_id" = ${actorId} OR "from_actor_id" = ${actorId})
        ${windowFilter}
    `);

    return Number(rows[0]?.net ?? 0);
}
