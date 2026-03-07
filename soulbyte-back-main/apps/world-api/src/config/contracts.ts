/**
 * Contract Addresses Configuration
 * Immutable after deployment - hardcoded for security
 */

import { prisma } from '../db.js';

/**
 * Contract addresses for Soulbyte on Monad
 */
export const CONTRACTS = {
    /** SBYTE ERC-20 token on nad.fun bonding curve */
    SBYTE_TOKEN: '0x0767C203B0BbB7A69a72d6aBCfa7191227Eb7777',

    /** Bonding curve contract (excluded from distributions) */
    SBYTE_BONDING_CURVE: '0xA7283D07812A02AFB7C09B60F8896BCEA3F90ACE',

    /** Deployer wallet */
    DEPLOYER: '0xf3ab6102F950a676EA5A8Fea77041396B71F2E8F',

    /** Platform fee vault - receives 0.05% of all transfers */
    PLATFORM_FEE_VAULT: '0xAfe8F7d37d32b2720c07FA5190D5a27263c1Ee68',

    /** Public vault + God wallet - holds city fees and treasury */
    PUBLIC_VAULT_AND_GOD: '0x90481285C78a7f91EAf9612CcB1F55378e94048E',

    /** Dead address for burns */
    BURN_ADDRESS: '0x000000000000000000000000000000000000dEaD',

    /** Distributor contract for holder payouts */
    SBYTE_DISTRIBUTOR: (process.env.SBYTE_DISTRIBUTOR_ADDRESS || '').trim(),

    /** Genesis Pass NFT contract (Phase 2) */
    GENESIS_PASS_NFT: (process.env.GENESIS_PASS_NFT_ADDRESS || '0xea590e0c2760e94a7685f4db64676c2b35f694a6').trim(),
} as const;

/**
 * ERC-20 minimal ABI for SBYTE token interactions
 */
export const ERC20_ABI = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function balanceOf(address owner) view returns (uint256)',
    'function transfer(address to, uint256 amount) returns (bool)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function transferFrom(address from, address to, uint256 amount) returns (bool)',
    'event Transfer(address indexed from, address indexed to, uint256 value)',
    'event Approval(address indexed owner, address indexed spender, uint256 value)',
] as const;

/**
 * Verify contract addresses match database configuration
 * Called on startup to ensure code and database are in sync
 * @throws Error if configuration mismatch detected
 */
export async function verifyContractConfig(): Promise<void> {
    console.log('Verifying contract configuration...');

    let sbyteConfig: { value: string } | null = null;
    let platformVaultConfig: { value: string } | null = null;
    let publicVaultConfig: { value: string } | null = null;
    try {
        sbyteConfig = await prisma.systemConfig.findUnique({
            where: { key: 'SBYTE_CONTRACT' },
        });

        platformVaultConfig = await prisma.systemConfig.findUnique({
            where: { key: 'PLATFORM_FEE_VAULT' },
        });

        publicVaultConfig = await prisma.systemConfig.findUnique({
            where: { key: 'PUBLIC_VAULT_AND_GOD' },
        });
    } catch (error: any) {
        if (error?.code === 'P1001') {
            console.warn('Database not reachable; skipping contract verification.');
            return;
        }
        throw error;
    }

    // If system_config is empty, this is first run - skip verification
    if (!sbyteConfig && !platformVaultConfig && !publicVaultConfig) {
        console.log('System config not initialized - skipping verification (genesis will initialize)');
        return;
    }

    // Verify each address matches
    const mismatches: string[] = [];

    if (sbyteConfig && sbyteConfig.value.toLowerCase() !== CONTRACTS.SBYTE_TOKEN.toLowerCase()) {
        mismatches.push(`SBYTE_CONTRACT: code=${CONTRACTS.SBYTE_TOKEN}, db=${sbyteConfig.value}`);
    }

    if (platformVaultConfig && platformVaultConfig.value.toLowerCase() !== CONTRACTS.PLATFORM_FEE_VAULT.toLowerCase()) {
        mismatches.push(`PLATFORM_FEE_VAULT: code=${CONTRACTS.PLATFORM_FEE_VAULT}, db=${platformVaultConfig.value}`);
    }

    if (publicVaultConfig && publicVaultConfig.value.toLowerCase() !== CONTRACTS.PUBLIC_VAULT_AND_GOD.toLowerCase()) {
        mismatches.push(`PUBLIC_VAULT_AND_GOD: code=${CONTRACTS.PUBLIC_VAULT_AND_GOD}, db=${publicVaultConfig.value}`);
    }

    if (mismatches.length > 0) {
        const errorMsg = `Contract configuration mismatch!\n${mismatches.join('\n')}`;
        console.error(errorMsg);
        throw new Error(errorMsg);
    }

    console.log('✓ Contract configuration verified');
}

/**
 * Initialize system config with contract addresses
 * Called during genesis
 */
export async function initializeSystemConfig(): Promise<void> {
    const configEntries = [
        { key: 'SBYTE_CONTRACT', value: CONTRACTS.SBYTE_TOKEN, immutable: true },
        { key: 'PLATFORM_FEE_VAULT', value: CONTRACTS.PLATFORM_FEE_VAULT, immutable: true },
        { key: 'PUBLIC_VAULT_AND_GOD', value: CONTRACTS.PUBLIC_VAULT_AND_GOD, immutable: true },
        { key: 'DEPLOYER', value: CONTRACTS.DEPLOYER, immutable: true },
    ];

    for (const entry of configEntries) {
        await prisma.systemConfig.upsert({
            where: { key: entry.key },
            create: entry,
            update: {}, // Do not update if exists
        });
    }

    console.log('✓ System config initialized with contract addresses');
}
