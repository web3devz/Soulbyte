import crypto from 'crypto';

const DEFAULT_AGENT_PREFIX = 'sk_agent_';

export function generateApiKey(prefix: string = DEFAULT_AGENT_PREFIX): string {
    const token = crypto.randomBytes(24).toString('hex');
    return `${prefix}${token}`;
}

export function hashApiKey(apiKey: string): string {
    return crypto.createHash('sha256').update(apiKey).digest('hex');
}

export function getKeyPrefix(apiKey: string): string {
    return apiKey.substring(0, 12);
}
