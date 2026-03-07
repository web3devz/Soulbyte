import { prisma } from '../db.js';

export async function applyRelationshipDecay(_currentTick: number): Promise<number> {
    const relationships = await prisma.relationship.findMany();
    let updated = 0;
    for (const rel of relationships) {
        const base = rel.relationshipType === 'FRIENDSHIP' ? 0.08 : 0.04;
        const strength = Number(rel.strength ?? 0);
        const extra = Math.max(0, (strength - 30) / 200);
        const decay = base + extra;
        const next = Math.max(-100, Math.min(100, strength - decay));
        const romance = Number(rel.romance ?? 0);
        const romanceBase = 0.02;
        const romanceExtra = Math.max(0, (romance - 20) / 500);
        const romanceDecay = romanceBase + romanceExtra;
        const nextRomance = Math.max(0, Math.min(100, romance - romanceDecay));
        await prisma.relationship.update({
            where: { actorAId_actorBId: { actorAId: rel.actorAId, actorBId: rel.actorBId } },
            data: {
                strength: Number(next.toFixed(2)),
                romance: Number(nextRomance.toFixed(2))
            }
        });
        updated += 1;
    }
    return updated;
}
