/**
 * Monad Network Configuration
 * Chain: Monad Mainnet
 */
import { ethers } from 'ethers';

export const MONAD_CONFIG = {
    chainId: 143,
    chainName: 'Monad Mainnet',
    nativeCurrency: {
        name: 'MON',
        symbol: 'MON',
        decimals: 18,
    },
    rpcUrls: {
        default: process.env.MONAD_RPC_URL || 'https://rpc.monad.xyz',
    },
    blockExplorers: {
        monadVision: 'https://monadvision.com',
        monadScan: 'https://monadscan.com',
        socialScan: 'https://monad.socialscan.io',
    },
    networkVisualization: 'https://gmonads.com',
    version: 'v0.12.8',
    revision: 'MONAD_EIGHT',
} as const;

export const RPC_CONFIG = {
    primary: process.env.MONAD_RPC_URL || 'https://rpc.monad.xyz',
    fallbacks: [
        'https://rpc.monad.xyz',
        process.env.MONAD_RPC_FALLBACK_1,
        process.env.MONAD_RPC_FALLBACK_2,
    ].filter(Boolean) as string[],
    retryAttempts: 3,
    retryDelayMs: 1000,
    supportsLogsDefault: process.env.MONAD_RPC_SUPPORTS_LOGS !== 'false',
    blockScanIntervalBlocks: Number(process.env.MONAD_BLOCK_SCAN_INTERVAL_BLOCKS ?? '5'),
};

/**
 * Get the configured RPC URL
 */
export function getRpcUrl(): string {
    if (!process.env.MONAD_RPC_URL) {
        console.warn('MONAD_RPC_URL not set, using default RPC');
    }
    return RPC_CONFIG.primary;
}

export async function getResilientProvider(preferredRpc?: string | null): Promise<ethers.JsonRpcProvider> {
    const defaultRpc = 'https://rpc.monad.xyz';
    const preferred = preferredRpc?.trim();
    const primary = RPC_CONFIG.primary;
    const nonPrimaryFallbacks = RPC_CONFIG.fallbacks.filter((url) => url !== primary);
    const urls = preferred
        ? [
            preferred,
            primary,
            ...RPC_CONFIG.fallbacks,
        ]
        : [
            defaultRpc,
            ...nonPrimaryFallbacks.filter((url) => url !== defaultRpc),
        ];
    for (const url of urls) {
        for (let attempt = 1; attempt <= RPC_CONFIG.retryAttempts; attempt++) {
            try {
                const provider = new ethers.JsonRpcProvider(url);
                await provider.getBlockNumber();
                if (process.env.CONSOLE_LOG_DEBUG === 'true') {
                    console.log(`[rpc] selected ${url} (preferred=${Boolean(preferred)})`);
                }
                return provider;
            } catch {
                console.warn(`RPC ${url} failed (attempt ${attempt}/${RPC_CONFIG.retryAttempts})`);
                await new Promise(resolve => setTimeout(resolve, RPC_CONFIG.retryDelayMs));
            }
        }
        console.warn(`RPC ${url} exhausted retries, trying fallback...`);
    }
    throw new Error('All RPC endpoints failed');
}

export function rpcSupportsLogs(): boolean {
    return RPC_CONFIG.supportsLogsDefault;
}

/**
 * Get block explorer URL for a transaction
 */
export function getTxExplorerUrl(txHash: string): string {
    return `${MONAD_CONFIG.blockExplorers.monadScan}/tx/${txHash}`;
}

/**
 * Get block explorer URL for an address
 */
export function getAddressExplorerUrl(address: string): string {
    return `${MONAD_CONFIG.blockExplorers.monadScan}/address/${address}`;
}
