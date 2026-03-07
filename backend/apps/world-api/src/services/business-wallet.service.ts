import { ethers } from 'ethers';
import { prisma } from '../db.js';
import { CONTRACTS, ERC20_ABI } from '../config/contracts.js';
import { getResilientProvider } from '../config/network.js';
import { decryptPrivateKey, encryptPrivateKey } from './wallet.service.js';
import { withRpcRetry } from '../utils/rpc-retry.js';
import { assertReceiptSuccess } from '../utils/onchain.js';

export class BusinessWalletService {
    private defaultProviderPromise?: Promise<ethers.JsonRpcProvider>;
    private sbyteContractPromise?: Promise<ethers.Contract>;

    constructor() {
    }

    private async getProvider(): Promise<ethers.JsonRpcProvider> {
        if (!this.defaultProviderPromise) {
            this.defaultProviderPromise = getResilientProvider();
        }
        return this.defaultProviderPromise;
    }

    /**
     * Get a provider that prefers the owner's RPC URL if configured in business.config.
     * Falls back to the default public RPC if ownerRpcUrl is not set or fails.
     */
    private async getProviderForBusiness(businessId: string): Promise<ethers.JsonRpcProvider> {
        try {
            const business = await prisma.business.findUnique({
                where: { id: businessId },
                select: { config: true }
            });
            const ownerRpcUrl = (business?.config as any)?.ownerRpcUrl;
            if (ownerRpcUrl && typeof ownerRpcUrl === 'string') {
                return getResilientProvider(ownerRpcUrl);
            }
        } catch (err) {
            console.warn(`Failed to read owner RPC for business ${businessId}, using default`, err);
        }
        return this.getProvider();
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

    async createBusinessWallet(businessId: string): Promise<{ address: string }> {
        const existing = await prisma.businessWallet.findUnique({ where: { businessId } });
        if (existing) {
            return { address: existing.walletAddress };
        }

        const wallet = ethers.Wallet.createRandom();
        const { encrypted, nonce } = encryptPrivateKey(wallet.privateKey);

        await prisma.businessWallet.create({
            data: {
                businessId,
                walletAddress: wallet.address,
                encryptedPk: encrypted,
                pkNonce: nonce,
            },
        });

        return { address: wallet.address };
    }

    async getSignerWallet(businessId: string): Promise<ethers.Wallet> {
        const wallet = await prisma.businessWallet.findUnique({ where: { businessId } });
        if (!wallet) {
            throw new Error('Business wallet not found');
        }
        const provider = await this.getProviderForBusiness(businessId);
        const privateKey = decryptPrivateKey(wallet.encryptedPk, wallet.pkNonce);
        return new ethers.Wallet(privateKey, provider);
    }

    async syncBalances(businessId: string): Promise<void> {
        const wallet = await prisma.businessWallet.findUnique({ where: { businessId } });
        if (!wallet) {
            throw new Error('Business wallet not found');
        }
        const provider = await this.getProviderForBusiness(businessId);
        const sbyteContract = await this.getSbyteContract();
        const monBalance = await withRpcRetry(
            () => provider.getBalance(wallet.walletAddress),
            'businessSyncMonBalance'
        );
        const sbyteBalance = await withRpcRetry(
            () => sbyteContract.balanceOf(wallet.walletAddress),
            'businessSyncSbyteBalance'
        );
        await prisma.businessWallet.update({
            where: { businessId },
            data: {
                balanceMon: ethers.formatEther(monBalance),
                balanceSbyte: ethers.formatUnits(sbyteBalance, 18),
            },
        });
    }

    async transferFromBusiness(
        businessId: string,
        toAddress: string,
        amount: bigint
    ): Promise<{ txHash: string; blockNumber: bigint }> {
        const signer = await this.getSignerWallet(businessId);
        const sbyteContract = await this.getSbyteContract();
        const contractWithSigner = sbyteContract.connect(signer);
        const tx = await withRpcRetry(
            () => contractWithSigner.transfer(toAddress, amount),
            'businessSbyteTransfer'
        );
        const receipt = await withRpcRetry(() => tx.wait(), 'businessSbyteTransferWait');
        assertReceiptSuccess(receipt, 'businessSbyteTransfer');
        return { txHash: tx.hash, blockNumber: BigInt(receipt?.blockNumber || 0) };
    }

    async transferMonFromBusiness(businessId: string, toAddress: string, amount: bigint): Promise<{ txHash: string }> {
        const signer = await this.getSignerWallet(businessId);
        const tx = await withRpcRetry(
            () => signer.sendTransaction({ to: toAddress, value: amount }),
            'businessMonTransfer'
        );
        const receipt = await withRpcRetry(() => tx.wait(), 'businessMonTransferWait');
        assertReceiptSuccess(receipt, 'businessMonTransfer');
        return { txHash: tx.hash };
    }
}
