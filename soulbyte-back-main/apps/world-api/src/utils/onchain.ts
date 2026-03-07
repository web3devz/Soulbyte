import type { TransactionReceipt } from 'ethers';

export function assertReceiptSuccess(receipt: TransactionReceipt | null | undefined, label: string): void {
    if (!receipt) {
        throw new Error(`Transaction receipt missing (${label})`);
    }
    if (receipt.status === 0) {
        throw new Error(`Transaction reverted (${label})`);
    }
}
