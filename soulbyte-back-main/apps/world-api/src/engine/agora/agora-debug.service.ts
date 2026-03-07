import { prisma } from '../../db.js';

export function isAgoraDebugEnabled(): boolean {
    return String(process.env.AGORA_DEBUG ?? '').trim().toLowerCase() === 'true';
}

export async function logAgoraDebug(params: {
    scope: string;
    actorId?: string | null;
    tick?: number | null;
    payload?: Record<string, unknown> | null;
}) {
    if (!isAgoraDebugEnabled()) return;
    try {
        await (prisma as any).agoraDebugLog.create({
            data: {
                scope: params.scope,
                actorId: params.actorId ?? null,
                tick: params.tick ?? null,
                payload: params.payload ?? null,
            },
        });
    } catch {
        // swallow logging errors
    }
}
