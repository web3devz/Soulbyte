import { prisma } from '../db.js';
import { hashApiKey } from '../utils/api-key.js';

export type ApiRole = 'agent' | 'god' | 'angel' | 'admin';

export type ApiAuthContext = {
    role: ApiRole;
    actorId?: string | null;
    apiKeyId?: string | null;
    keyHash?: string | null;
};

export async function authenticateApiKey(authHeader?: string | null): Promise<ApiAuthContext | null> {
    if (!authHeader) return null;
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) return null;

    const godKey = process.env.GOD_API_KEY;
    if (godKey && token === godKey) {
        return { role: 'god', actorId: null, apiKeyId: null, keyHash: hashApiKey(token) };
    }

    const angelKey = process.env.ANGEL_API_KEY;
    if (angelKey && token === angelKey) {
        return { role: 'angel', actorId: null, apiKeyId: null, keyHash: hashApiKey(token) };
    }

    const keyHash = hashApiKey(token);
    const keyRecord = await prisma.apiKey.findFirst({
        where: {
            keyHash,
            revokedAt: null,
        },
    });

    if (!keyRecord) return null;

    await prisma.apiKey.update({
        where: { id: keyRecord.id },
        data: { lastUsedAt: new Date() },
    });

    return {
        role: keyRecord.role as ApiRole,
        actorId: keyRecord.actorId,
        apiKeyId: keyRecord.id,
        keyHash,
    };
}
