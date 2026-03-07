import { ethers } from 'ethers';
import { Decimal } from 'decimal.js';

export function formatSbyte(value: bigint): string {
    return ethers.formatUnits(value, 18);
}

export function formatMon(value: bigint): string {
    return ethers.formatEther(value);
}

export function formatSbyteForLedger(value: bigint | string | number): string {
    const decimal = typeof value === 'bigint'
        ? new Decimal(formatSbyte(value))
        : new Decimal(value);
    return decimal.toFixed(8);
}
