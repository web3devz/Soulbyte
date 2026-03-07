/**
 * Wallet Service
 * Manages agent blockchain wallets with encrypted private key storage
 */

import { ethers } from 'ethers';
import crypto from 'crypto';
import { prisma } from '../db.js';
import { CONTRACTS, ERC20_ABI } from '../config/contracts.js';
import { getResilientProvider } from '../config/network.js';
import { withRpcRetry } from '../utils/rpc-retry.js';
import { formatSbyteForLedger } from '../utils/amounts.js';
import { getWealthTierFromBalance } from '../utils/wealth-tier.js';

/**
 * Get encryption key from environment
 * Must be 32 bytes (64 hex characters)
 */
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

/**
 * Encrypt a private key using AES-256-GCM
 * @param privateKey - The private key to encrypt (with or without 0x prefix)
 * @returns Encrypted data and nonce
 */
export function encryptPrivateKey(privateKey: string): { encrypted: string; nonce: string } {
    const key = getEncryptionKey();
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);

    // Remove 0x prefix if present
    const cleanKey = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;

    let encrypted = cipher.update(cleanKey, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();

    // Append auth tag to encrypted data
    return {
        encrypted: encrypted + authTag.toString('hex'),
        nonce: nonce.toString('hex'),
    };
}

/**
 * Decrypt a private key using AES-256-GCM
 * @param encrypted - Encrypted private key (hex)
 * @param nonce - Nonce used for encryption (hex)
 * @returns Decrypted private key
 */
export function decryptPrivateKey(encrypted: string, nonce: string): string {
    const key = getEncryptionKey();
    const nonceBuffer = Buffer.from(nonce, 'hex');

    // Extract auth tag (last 32 hex chars = 16 bytes)
    const authTag = Buffer.from(encrypted.slice(-32), 'hex');
    const encryptedData = encrypted.slice(0, -32);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonceBuffer);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return '0x' + decrypted;
}

/**
 * Wallet Service class
 */
export class WalletService {
    private providerPromise?: Promise<ethers.JsonRpcProvider>;
    private sbyteContractPromise?: Promise<ethers.Contract>;

    constructor() {
    }

    private async getProvider(): Promise<ethers.JsonRpcProvider> {
        if (!this.providerPromise) {
            this.providerPromise = getResilientProvider();
        }
        return this.providerPromise;
    }

    private async getSbyteContract(): Promise<ethers.Contract> {
        if (!this.sbyteContractPromise) {
            const provider = await this.getProvider();
            this.sbyteContractPromise = Promise.resolve(
                new ethers.Contract(CONTRACTS.SBYTE_TOKEN, ERC20_ABI, provider)
            );
        }
        return this.sbyteContractPromise;
    }

    private async getProviderForActor(actorId?: string): Promise<ethers.JsonRpcProvider> {
        if (!actorId) {
            return this.getProvider();
        }
        const wallet = await prisma.agentWallet.findUnique({
            where: { actorId },
            select: { preferredRpc: true },
        });
        if (!wallet?.preferredRpc) {
            return this.getProvider();
        }
        return getResilientProvider(wallet.preferredRpc);
    }

    private async getSbyteContractForActor(actorId?: string): Promise<ethers.Contract> {
        const provider = await this.getProviderForActor(actorId);
        return new ethers.Contract(CONTRACTS.SBYTE_TOKEN, ERC20_ABI, provider);
    }

    /**
     * Import a wallet for an agent
     * Called once when human links their wallet
     * @param actorId - The agent's actor ID
     * @param privateKey - The private key to import
     * @returns The wallet address
     */
    async importWallet(actorId: string, privateKey: string): Promise<{ address: string }> {
        // Validate private key format
        if (!privateKey.match(/^(0x)?[0-9a-fA-F]{64}$/)) {
            throw new Error('Invalid private key format');
        }

        // Check if wallet already exists
        const existing = await prisma.agentWallet.findUnique({
            where: { actorId },
        });
        if (existing) {
            throw new Error('Wallet already imported for this agent');
        }

        // Derive address from private key
        const wallet = new ethers.Wallet(privateKey);
        const walletAddress = wallet.address;

        // Check if this address is already used by another agent
        const addressInUse = await prisma.agentWallet.findUnique({
            where: { walletAddress },
        });
        if (addressInUse) {
            throw new Error('This wallet address is already linked to another agent');
        }

        // Encrypt private key
        const { encrypted, nonce } = encryptPrivateKey(privateKey);

        // Get current balances
        const provider = await this.getProviderForActor(actorId);
        const sbyteContract = await this.getSbyteContractForActor(actorId);
        const monBalance = await withRpcRetry(
            () => provider.getBalance(walletAddress),
            'walletImportMonBalance'
        );
        const sbyteBalance = await withRpcRetry(
            () => sbyteContract.balanceOf(walletAddress),
            'walletImportSbyteBalance'
        );
        const currentBlock = await withRpcRetry(
            () => provider.getBlockNumber(),
            'walletImportBlockNumber'
        );

        // Store in database
        await prisma.agentWallet.create({
            data: {
                actorId,
                walletAddress,
                encryptedPk: encrypted,
                pkNonce: nonce,
                // Store human-readable decimals to fit DB precision
                balanceMon: ethers.formatEther(monBalance),
                balanceSbyte: ethers.formatUnits(sbyteBalance, 18),
                lastSyncedAt: new Date(),
                lastSyncedBlock: BigInt(currentBlock),
            },
        });

        // Also update the game wallet balance
        const sbyteFormatted = ethers.formatUnits(sbyteBalance, 18);
        const sbyteLedger = formatSbyteForLedger(sbyteFormatted);
        await prisma.wallet.upsert({
            where: { actorId },
            create: {
                actorId,
                balanceSbyte: sbyteLedger,
            },
            update: {
                balanceSbyte: sbyteLedger,
            },
        });

        console.log(`Wallet imported for agent ${actorId}: ${walletAddress}`);

        // NEVER log the private key
        return { address: walletAddress };
    }

    /**
     * Get ethers.Wallet for signing transactions (internal only)
     * @param actorId - The agent's actor ID
     * @returns ethers.Wallet instance connected to provider
     */
    async getSignerWallet(actorId: string): Promise<ethers.Wallet> {
        const agentWallet = await prisma.agentWallet.findUnique({
            where: { actorId },
        });

        if (!agentWallet) {
            throw new Error('No wallet found for agent');
        }

        const privateKey = decryptPrivateKey(agentWallet.encryptedPk, agentWallet.pkNonce);
        const provider = await this.getProviderForActor(actorId);
        return new ethers.Wallet(privateKey, provider);
    }

    /**
     * Sync wallet balances from on-chain
     * @param actorId - The agent's actor ID
     */
    async syncWalletBalances(actorId: string): Promise<void> {
        const agentWallet = await prisma.agentWallet.findUnique({
            where: { actorId },
        });

        if (!agentWallet) {
            throw new Error('No wallet found for agent');
        }

        const provider = await this.getProviderForActor(actorId);
        const sbyteContract = await this.getSbyteContractForActor(actorId);
        const monBalance = await withRpcRetry(
            () => provider.getBalance(agentWallet.walletAddress),
            'walletSyncMonBalance'
        );
        const sbyteBalance = await withRpcRetry(
            () => sbyteContract.balanceOf(agentWallet.walletAddress),
            'walletSyncSbyteBalance'
        );
        const currentBlock = await withRpcRetry(
            () => provider.getBlockNumber(),
            'walletSyncBlockNumber'
        );

        const sbyteFormatted = ethers.formatUnits(sbyteBalance, 18);
        const sbyteLedger = formatSbyteForLedger(sbyteFormatted);
        const wealthTier = getWealthTierFromBalance(sbyteLedger);

        await prisma.agentWallet.update({
            where: { actorId },
            data: {
                balanceMon: ethers.formatEther(monBalance),
                balanceSbyte: sbyteFormatted,
                lastSyncedAt: new Date(),
                lastSyncedBlock: BigInt(currentBlock),
            },
        });

        // Sync to game wallet
        await prisma.wallet.update({
            where: { actorId },
            data: {
                balanceSbyte: sbyteLedger,
            },
        });

        await prisma.agentState.updateMany({
            where: { actorId },
            data: { wealthTier },
        });
    }

    /**
     * Get wallet info for an agent (no private key)
     * @param actorId - The agent's actor ID
     */
    async getWalletInfo(actorId: string) {
        const wallet = await prisma.agentWallet.findUnique({
            where: { actorId },
            select: {
                walletAddress: true,
                balanceMon: true,
                balanceSbyte: true,
                lastSyncedAt: true,
                lastSyncedBlock: true,
                createdAt: true,
            },
        });

        return wallet;
    }

    /**
     * Check if agent has a wallet
     * @param actorId - The agent's actor ID
     */
    async hasWallet(actorId: string): Promise<boolean> {
        const wallet = await prisma.agentWallet.findUnique({
            where: { actorId },
            select: { actorId: true },
        });
        return wallet !== null;
    }
}
