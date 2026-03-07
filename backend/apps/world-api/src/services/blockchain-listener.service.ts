/**
 * Blockchain Listener Service
 * Monitors SBYTE Transfer events and MON deposits
 */

import { ethers } from 'ethers';
import { prisma } from '../db.js';
import { CONTRACTS, ERC20_ABI } from '../config/contracts.js';
import { getResilientProvider, rpcSupportsLogs } from '../config/network.js';
import { resiProvider } from './resilient-provider.js';
import { withRpcRetry } from '../utils/rpc-retry.js';
import { formatSbyteForLedger } from '../utils/amounts.js';
import { DepositService } from './deposit.service.js';

/**
 * Blockchain Listener Service class
 */
export class BlockchainListenerService {
    private providerPromise: Promise<ethers.JsonRpcProvider>;
    private sbyteContractPromise: Promise<ethers.Contract>;
    private sbyteInterface: ethers.Interface;
    private genesisPassInterface: ethers.Interface | null = null;
    private depositService: DepositService;
    private isListening: boolean = false;
    private sbyteLogsSupported: boolean = true;
    private sbyteLogsWarningShown: boolean = false;
    private lastScanBlock: number = 0;
    private lastProcessedBlock: number = 0;
    private scanIntervalBlocks: number = 5;
    private scanPausedUntilMs: number = 0;
    private rateLimitWarningShown: boolean = false;
    private driftMonitorStarted: boolean = false;

    constructor() {
        this.providerPromise = getResilientProvider();
        this.sbyteContractPromise = this.providerPromise.then(
            (provider) => new ethers.Contract(CONTRACTS.SBYTE_TOKEN, ERC20_ABI, provider)
        );
        this.sbyteInterface = new ethers.Interface(ERC20_ABI);
        if (CONTRACTS.GENESIS_PASS_NFT) {
            this.genesisPassInterface = new ethers.Interface([
                'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'
            ]);
        }
        this.depositService = new DepositService();
        this.sbyteLogsSupported = rpcSupportsLogs();
        const configuredInterval = Number(process.env.MONAD_BLOCK_SCAN_INTERVAL_BLOCKS ?? '5');
        this.scanIntervalBlocks = Number.isFinite(configuredInterval) && configuredInterval > 0
            ? Math.floor(configuredInterval)
            : 5;
    }

    private async getProvider(): Promise<ethers.JsonRpcProvider> {
        return this.providerPromise;
    }

    private async getSbyteContract(): Promise<ethers.Contract> {
        return this.sbyteContractPromise;
    }

    /**
     * Start listening for blockchain events
     */
    async startListening(): Promise<void> {
        if (this.isListening) {
            console.log('Blockchain listener already running');
            return;
        }

        console.log('Starting blockchain listener...');
        this.isListening = true;

        // Get all agent wallet addresses
        const agentWallets = await prisma.agentWallet.findMany({
            select: { walletAddress: true },
        });
        const walletSet = new Set(agentWallets.map(w => w.walletAddress.toLowerCase()));

        console.log(`Monitoring ${walletSet.size} agent wallets`);

        // Listen for new blocks (for SBYTE + MON deposits)
        const provider = await this.getProvider();
        const currentBlock = await resiProvider.execute(
            (p) => p.getBlockNumber(),
            'listenerInitialBlock'
        );
        this.lastProcessedBlock = currentBlock;
        this.lastScanBlock = currentBlock;
        provider.on('block', async (blockNumber: number) => {
            try {
                if (Date.now() < this.scanPausedUntilMs) {
                    return;
                }
                if (blockNumber <= this.lastProcessedBlock) {
                    return;
                }
                if (blockNumber - this.lastProcessedBlock < this.scanIntervalBlocks) {
                    return;
                }
                const targetBlock = this.lastProcessedBlock > 0
                    ? this.lastProcessedBlock + this.scanIntervalBlocks
                    : blockNumber;
                if (targetBlock > blockNumber) {
                    return;
                }
                const fromBlock = this.lastProcessedBlock > 0 ? this.lastProcessedBlock + 1 : targetBlock;
                this.lastScanBlock = targetBlock;
                await this.scanRangeForSbyteTransfers(fromBlock, targetBlock, walletSet);
                await this.scanBlockForMONDeposits(targetBlock, walletSet);
                await this.scanRangeForNftTransfers(fromBlock, targetBlock);
                this.lastProcessedBlock = targetBlock;
            } catch (error: any) {
                if (this.isRateLimitError(error)) {
                    this.scanPausedUntilMs = Date.now() + 60_000;
                    if (!this.rateLimitWarningShown) {
                        this.rateLimitWarningShown = true;
                        console.warn(
                            'RPC rate limit hit; pausing block scans for 60s.'
                        );
                    }
                    return;
                }
                console.error('Error scanning block for deposits:', error);
            }
        });

        if (!this.driftMonitorStarted) {
            this.driftMonitorStarted = true;
            setInterval(async () => {
                try {
                    const chainTip = await resiProvider.execute(
                        (p) => p.getBlockNumber(),
                        'listenerGetBlockNumber'
                    );
                    const lastProcessed = this.lastProcessedBlock || this.lastScanBlock;
                    if (!lastProcessed) {
                        return;
                    }
                    const blockDrift = chainTip - lastProcessed;
                    const driftSeconds = blockDrift * 1;
                    if (driftSeconds > 600) {
                        console.error(
                            `[Listener] WARNING: ${driftSeconds}s behind chain tip ` +
                            `(last: ${lastProcessed}, tip: ${chainTip})`
                        );
                        await this.catchUpToChainTip(lastProcessed, chainTip, walletSet);
                    }
                } catch (error) {
                    console.error('[Listener] Drift health check failed:', error);
                }
            }, 60_000);
        }

        console.log('✓ Blockchain listener started');
    }

    /**
     * Stop listening for blockchain events
     */
    stopListening(): void {
        if (!this.isListening) {
            return;
        }

        this.getSbyteContract().then(contract => contract.removeAllListeners());
        this.getProvider().then(provider => provider.removeAllListeners());
        this.isListening = false;
        console.log('Blockchain listener stopped');
    }

    /**
     * Scan a block for native MON deposits to agent wallets
     */
    private async scanBlockForMONDeposits(
        blockNumber: number,
        walletSet: Set<string>
    ): Promise<void> {
        const block = await resiProvider.execute(
            (p) => p.getBlock(blockNumber, true),
            `listenerGetBlock ${blockNumber}`
        );
        if (!block?.prefetchedTransactions) {
            return;
        }

        for (const tx of block.prefetchedTransactions) {
            const toAddress = tx.to?.toLowerCase();
            if (toAddress && walletSet.has(toAddress) && tx.value > 0n) {
                await this.depositService.processDeposit(
                    tx.hash,
                    tx.to!,
                    null, // MON transfer
                    tx.value,
                    BigInt(blockNumber)
                );
            }
        }
    }

    /**
     * Scan a block for SBYTE transfers to agent wallets
     */
    private async scanBlockForSbyteTransfers(
        blockNumber: number,
        walletSet: Set<string>
    ): Promise<void> {
        if (!this.sbyteLogsSupported) {
            return;
        }

        try {
            const transferTopic = this.sbyteInterface.getEvent('Transfer')?.topicHash;
            if (!transferTopic) {
                return;
            }

            const logs = await resiProvider.execute(
                (p) => p.getLogs({
                    address: CONTRACTS.SBYTE_TOKEN,
                    fromBlock: blockNumber,
                    toBlock: blockNumber,
                    topics: [transferTopic],
                }),
                `listenerGetLogs SBYTE ${blockNumber}`
            );

            for (const log of logs) {
                const parsed = this.sbyteInterface.parseLog(log);
                const fromAddress = String(parsed.args?.from ?? '').toLowerCase();
                const toAddress = String(parsed.args?.to ?? '').toLowerCase();
                const amount = BigInt(parsed.args?.value ?? 0n);
                if (amount === 0n) continue;

                await this.updateHolderBalance(fromAddress, toAddress, amount, BigInt(blockNumber));

                if (!toAddress || !walletSet.has(toAddress)) {
                    continue;
                }
                await this.depositService.processDeposit(
                    log.transactionHash,
                    String(parsed.args?.to),
                    CONTRACTS.SBYTE_TOKEN,
                    amount,
                    BigInt(log.blockNumber)
                );
            }
        } catch (error: any) {
            const rpcError = error?.error ?? error;
            if (rpcError?.code === -32601) {
                this.sbyteLogsSupported = false;
                if (!this.sbyteLogsWarningShown) {
                    this.sbyteLogsWarningShown = true;
                    console.warn(
                        'RPC does not support eth_getLogs; SBYTE transfer monitoring disabled.'
                    );
                }
                return;
            }
            throw error;
        }
    }

    private async scanRangeForSbyteTransfers(
        fromBlock: number,
        toBlock: number,
        walletSet: Set<string>
    ): Promise<void> {
        if (!this.sbyteLogsSupported) {
            return;
        }
        const transferTopic = this.sbyteInterface.getEvent('Transfer')?.topicHash;
        if (!transferTopic) {
            return;
        }
        const logs = await resiProvider.execute(
            (p) => p.getLogs({
                address: CONTRACTS.SBYTE_TOKEN,
                fromBlock,
                toBlock,
                topics: [transferTopic],
            }),
            `listenerGetLogs SBYTE ${fromBlock}-${toBlock}`
        );
        for (const log of logs) {
            const parsed = this.sbyteInterface.parseLog(log);
            const fromAddress = String(parsed.args?.from ?? '').toLowerCase();
            const toAddress = String(parsed.args?.to ?? '').toLowerCase();
            const amount = BigInt(parsed.args?.value ?? 0n);
            if (amount === 0n) continue;
            await this.updateHolderBalance(fromAddress, toAddress, amount, BigInt(log.blockNumber));
            if (toAddress && walletSet.has(toAddress)) {
                await this.depositService.processDeposit(
                    log.transactionHash,
                    String(parsed.args?.to),
                    CONTRACTS.SBYTE_TOKEN,
                    amount,
                    BigInt(log.blockNumber)
                );
            }
        }
    }

    private async scanBlockForNftTransfers(blockNumber: number): Promise<void> {
        if (!this.genesisPassInterface || !CONTRACTS.GENESIS_PASS_NFT) {
            return;
        }
        const transferTopic = this.genesisPassInterface.getEvent('Transfer')?.topicHash;
        if (!transferTopic) {
            return;
        }

        const logs = await resiProvider.execute(
            (p) => p.getLogs({
                address: CONTRACTS.GENESIS_PASS_NFT,
                fromBlock: blockNumber,
                toBlock: blockNumber,
                topics: [transferTopic],
            }),
            `listenerGetLogs NFT ${blockNumber}`
        );

        for (const log of logs) {
            const parsed = this.genesisPassInterface.parseLog(log);
            const fromAddress = String(parsed.args?.from ?? '').toLowerCase();
            const toAddress = String(parsed.args?.to ?? '').toLowerCase();
            await this.updateHolderNftBalance(fromAddress, toAddress, BigInt(blockNumber));
        }
    }

    private async scanRangeForNftTransfers(fromBlock: number, toBlock: number): Promise<void> {
        if (!this.genesisPassInterface || !CONTRACTS.GENESIS_PASS_NFT) {
            return;
        }
        const transferTopic = this.genesisPassInterface.getEvent('Transfer')?.topicHash;
        if (!transferTopic) {
            return;
        }
        const logs = await resiProvider.execute(
            (p) => p.getLogs({
                address: CONTRACTS.GENESIS_PASS_NFT,
                fromBlock,
                toBlock,
                topics: [transferTopic],
            }),
            `listenerGetLogs NFT ${fromBlock}-${toBlock}`
        );
        for (const log of logs) {
            const parsed = this.genesisPassInterface.parseLog(log);
            const fromAddress = String(parsed.args?.from ?? '').toLowerCase();
            const toAddress = String(parsed.args?.to ?? '').toLowerCase();
            await this.updateHolderNftBalance(fromAddress, toAddress, BigInt(log.blockNumber));
        }
    }

    private async updateHolderBalance(
        from: string,
        to: string,
        amount: bigint,
        blockNumber: bigint
    ): Promise<void> {
        const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
        const DEAD_ADDRESS = CONTRACTS.BURN_ADDRESS.toLowerCase();
        const amountString = amount.toString();

        if (from && from !== ZERO_ADDRESS && from !== DEAD_ADDRESS) {
            await prisma.holderBalance.upsert({
                where: { walletAddress: from },
                update: {
                    sbyteBalance: { decrement: amountString },
                    lastUpdatedAt: new Date(),
                    lastBlockNumber: blockNumber
                },
                create: {
                    walletAddress: from,
                    sbyteBalance: '0',
                    lastUpdatedAt: new Date(),
                    lastBlockNumber: blockNumber
                }
            });
        }

        if (to && to !== ZERO_ADDRESS && to !== DEAD_ADDRESS) {
            await prisma.holderBalance.upsert({
                where: { walletAddress: to },
                update: {
                    sbyteBalance: { increment: amountString },
                    lastUpdatedAt: new Date(),
                    lastBlockNumber: blockNumber
                },
                create: {
                    walletAddress: to,
                    sbyteBalance: amountString,
                    lastUpdatedAt: new Date(),
                    lastBlockNumber: blockNumber
                }
            });
        }
    }

    private async updateHolderNftBalance(
        from: string,
        to: string,
        blockNumber: bigint
    ): Promise<void> {
        const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

        if (from && from !== ZERO_ADDRESS) {
            await prisma.holderNftBalance.upsert({
                where: { walletAddress: from },
                update: {
                    passCount: { decrement: 1 },
                    lastUpdatedAt: new Date(),
                    lastBlockNumber: blockNumber
                },
                create: {
                    walletAddress: from,
                    passCount: 0,
                    lastUpdatedAt: new Date(),
                    lastBlockNumber: blockNumber
                }
            });
        }

        if (to && to !== ZERO_ADDRESS) {
            await prisma.holderNftBalance.upsert({
                where: { walletAddress: to },
                update: {
                    passCount: { increment: 1 },
                    lastUpdatedAt: new Date(),
                    lastBlockNumber: blockNumber
                },
                create: {
                    walletAddress: to,
                    passCount: 1,
                    lastUpdatedAt: new Date(),
                    lastBlockNumber: blockNumber
                }
            });
        }
    }

    private async catchUpToChainTip(
        fromBlock: number,
        toBlock: number,
        walletSet: Set<string>
    ): Promise<void> {
        const start = Math.max(0, fromBlock + 1);
        for (let chunkStart = start; chunkStart <= toBlock; chunkStart += this.scanIntervalBlocks) {
            const chunkEnd = Math.min(chunkStart + this.scanIntervalBlocks - 1, toBlock);
            await this.scanRangeForSbyteTransfers(chunkStart, chunkEnd, walletSet);
            await this.scanRangeForNftTransfers(chunkStart, chunkEnd);
            this.lastProcessedBlock = chunkEnd;
        }
    }

    private isRateLimitError(error: any): boolean {
        const rpcError = error?.error ?? error;
        return rpcError?.code === -32007;
    }

    /**
     * Sync balances for all agent wallets
     * Called manually to ensure consistency
     */
    async syncAllBalances(): Promise<{ synced: number; errors: number }> {
        const wallets = await prisma.agentWallet.findMany();
        let synced = 0;
        let errors = 0;

        const provider = await this.getProvider();
        const sbyteContract = await this.getSbyteContract();
        for (const wallet of wallets) {
            try {
                // Get on-chain balances
                const monBalance = await withRpcRetry(
                    () => provider.getBalance(wallet.walletAddress),
                    'listenerSyncMonBalance'
                );
                const sbyteBalance = await withRpcRetry(
                    () => sbyteContract.balanceOf(wallet.walletAddress),
                    'listenerSyncSbyteBalance'
                );
                const currentBlock = await withRpcRetry(
                    () => provider.getBlockNumber(),
                    'listenerSyncBlockNumber'
                );

                // Update database
                const formattedMon = ethers.formatEther(monBalance);
                const formattedSbyte = ethers.formatUnits(sbyteBalance, 18);
                await prisma.agentWallet.update({
                    where: { actorId: wallet.actorId },
                    data: {
                        balanceMon: formattedMon,
                        balanceSbyte: formattedSbyte,
                        lastSyncedAt: new Date(),
                        lastSyncedBlock: BigInt(currentBlock),
                    },
                });

                // Sync to game wallet
                await prisma.wallet.update({
                    where: { actorId: wallet.actorId },
                    data: { balanceSbyte: formatSbyteForLedger(formattedSbyte) },
                });

                synced++;
            } catch (error) {
                console.error(`Failed to sync wallet ${wallet.walletAddress}:`, error);
                errors++;
            }
        }

        console.log(`Balance sync complete: ${synced} synced, ${errors} errors`);
        return { synced, errors };
    }

    /**
     * Refresh the list of monitored wallets
     * Call when a new wallet is imported
     */
    async refreshWalletList(): Promise<void> {
        // We need to restart listener to pick up new wallets
        if (this.isListening) {
            this.stopListening();
            await this.startListening();
        }
    }
}
