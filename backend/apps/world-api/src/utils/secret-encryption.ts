import crypto from 'crypto';

function getEncryptionKey(): Buffer {
    const key = process.env.WALLET_ENCRYPTION_KEY;
    if (!key) {
        throw new Error('WALLET_ENCRYPTION_KEY environment variable not set');
    }
    if (key.length !== 64) {
        throw new Error('WALLET_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
    }
    return Buffer.from(key, 'hex');
}

export function encryptSecret(secret: string): { encrypted: string; nonce: string } {
    const key = getEncryptionKey();
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    let encrypted = cipher.update(secret, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    return {
        encrypted: encrypted + authTag.toString('hex'),
        nonce: nonce.toString('hex'),
    };
}

export function decryptSecret(encrypted: string, nonce: string): string {
    const key = getEncryptionKey();
    const nonceBuffer = Buffer.from(nonce, 'hex');
    const authTag = Buffer.from(encrypted.slice(-32), 'hex');
    const encryptedData = encrypted.slice(0, -32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonceBuffer);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}
