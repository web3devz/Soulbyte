import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import Decimal from 'decimal.js';
import { prisma } from '../db.js';
import { CONTRACTS, ERC20_ABI } from '../config/contracts.js';
import { updateCachedVaultHealth } from '../config/fees.js';
import { getDistributionRate } from '../config/economic-governor.js';
import { VaultHealthService } from './vault-health.service.js';
import { getResilientProvider } from '../config/network.js';
import { withRpcRetry } from '../utils/rpc-retry.js';
import { EventOutcome, EventType } from '../types/event.types.js';

const DISTRIBUTION_FIRST_DATE = new Date('2026-03-01T00:00:00Z');
const DISTRIBUTION_INTERVAL_DAYS = Number(process.env.DISTRIBUTION_INTERVAL_DAYS ?? 14);
const DISTRIBUTION_SNAPSHOT_LEAD_HOURS = Number(process.env.DISTRIBUTION_SNAPSHOT_LEAD_HOURS ?? 4);
const MIN_VAULT_HEALTH_DAYS = Number(process.env.DISTRIBUTION_MIN_VAULT_HEALTH_DAYS ?? 60);
const MIN_DISTRIBUTION_AMOUNT = Number(process.env.DISTRIBUTION_MIN_AMOUNT ?? 100);
const DISTRIBUTION_ENABLED = process.env.DISTRIBUTION_ENABLED !== 'false';

const MAX_RECIPIENTS = 300;
const MIN_PAYOUT_SBYTE = 1;
const MIN_DISTRIBUTION_HOLDER_BALANCE = new Decimal(
    process.env.DISTRIBUTION_MIN_HOLDER_BALANCE ?? 1
);
const MAX_TOTAL_RECIPIENTS = 400;
const PREVIEW_CACHE_TTL_MS = 60 * 1000;
const DISTRIBUTION_LOG_DIR = path.join(process.cwd(), 'logs');
const DISTRIBUTION_LOG_FILE = path.join(DISTRIBUTION_LOG_DIR, 'distribution.log');
const WEI_PER_SBYTE = new Decimal('1e18');
const SNAPSHOT_INTERVAL_MS = 2 * 60 * 60 * 1000;
const DECAY_HALF_LIFE_HOURS = Number(process.env.DISTRIBUTION_TWAB_HALF_LIFE_HOURS ?? 72);

const DISTRIBUTOR_ABI = [
    'function distribute(address[] recipients, uint256[] amounts) external',
    'function currentCycle() view returns (uint256)'
] as const;

type AggregatedHolder = {
    address: string;
    category: 'soulbyte' | 'not_soulbyte' | 'business_wallet';
    actorId: string | null;
    sbyteBalance: Decimal;
};

type TimeWeightedHolder = AggregatedHolder & {
    twab: Decimal;
    twam: Decimal;
    snapshotsRecorded: number;
    effectiveWeight: Decimal;
};

const vaultHealthService = new VaultHealthService();
const PREVIEW_CACHE = new Map<string, { cachedAt: Date; expiresAt: number; value: any }>();

function getDistributorAddress(): string {
    if (!CONTRACTS.SBYTE_DISTRIBUTOR) {
        throw new Error('SBYTE_DISTRIBUTOR_ADDRESS not configured');
    }
    return CONTRACTS.SBYTE_DISTRIBUTOR;
}

function getGodPrivateKey(): string {
    const key = process.env.GOD_WALLET_PRIVATE_KEY;
    if (!key) {
        throw new Error('GOD_WALLET_PRIVATE_KEY not configured');
    }
    return key;
}

function getExcludedAddresses(): Set<string> {
    return new Set([
        CONTRACTS.SBYTE_BONDING_CURVE,
        CONTRACTS.PUBLIC_VAULT_AND_GOD,
        CONTRACTS.PLATFORM_FEE_VAULT,
        CONTRACTS.BURN_ADDRESS,
        CONTRACTS.DEPLOYER,
        CONTRACTS.SBYTE_DISTRIBUTOR,
    ]
        .filter(Boolean)
        .map((addr) => addr.toLowerCase()));
}

function toWei(amount: Decimal): bigint {
    if (amount.lte(0)) return 0n;
    const formatted = amount.toFixed(18);
    return ethers.parseUnits(formatted, 18);
}

function nowUtc(): Date {
    return new Date();
}

function formatSbyte(amount: number | Decimal, decimals: number = 2): string {
    const value = amount instanceof Decimal ? amount : new Decimal(amount);
    return value.toFixed(decimals);
}

export function aggregateHolderBalances(
    records: Array<{
        holder: string;
        accountAddress: string;
        amount: Decimal;
        category: 'business_wallet' | 'soulbyte' | 'not_soulbyte';
        actorId: string | null;
        businessId: string | null;
    }>,
    excludedAddresses: Set<string>,
    maxRecipients: number | null = MAX_RECIPIENTS
): AggregatedHolder[] {
    const soulbyteMap = new Map<string, AggregatedHolder>();
    const businessRows: AggregatedHolder[] = [];
    const otherRows: AggregatedHolder[] = [];

    for (const record of records) {
        const holder = record.holder.toLowerCase();
        if (excludedAddresses.has(holder)) continue;

        // amounts are stored in token units already
        const amountSbyte = new Decimal(record.amount.toString());
        if (amountSbyte.lte(0)) continue;

        if (record.category === 'soulbyte') {
            const key = record.actorId ?? holder;
            const existing = soulbyteMap.get(key);
            if (!existing) {
                soulbyteMap.set(key, {
                    address: record.accountAddress,
                    category: 'soulbyte',
                    actorId: record.actorId ?? null,
                    sbyteBalance: amountSbyte
                });
            } else {
                existing.sbyteBalance = existing.sbyteBalance.add(amountSbyte);
            }
            continue;
        }

        if (record.category === 'business_wallet' && record.actorId) {
            const key = record.actorId;
            const existing = soulbyteMap.get(key);
            if (!existing) {
                soulbyteMap.set(key, {
                    address: record.accountAddress,
                    category: 'soulbyte',
                    actorId: record.actorId,
                    sbyteBalance: amountSbyte
                });
            } else {
                existing.sbyteBalance = existing.sbyteBalance.add(amountSbyte);
            }
            continue;
        }

        if (record.category === 'business_wallet') {
            businessRows.push({
                address: record.accountAddress,
                category: 'business_wallet',
                actorId: record.actorId ?? null,
                sbyteBalance: amountSbyte
            });
            continue;
        }

        otherRows.push({
            address: record.accountAddress,
            category: 'not_soulbyte',
            actorId: null,
            sbyteBalance: amountSbyte
        });
    }

    const output = Array.from(soulbyteMap.values()).concat(otherRows, businessRows);
    output.sort((a, b) => b.sbyteBalance.comparedTo(a.sbyteBalance));
    if (maxRecipients === null) {
        return output;
    }
    return output.slice(0, maxRecipients);
}

export class DistributionService {
    private providerPromise?: Promise<ethers.JsonRpcProvider>;

    private async getProvider(): Promise<ethers.JsonRpcProvider> {
        if (!this.providerPromise) {
            this.providerPromise = getResilientProvider();
        }
        return this.providerPromise;
    }


    private getDistributionIntervalMs(): number {
        return DISTRIBUTION_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
    }

    async getLastDistribution(): Promise<{
        createdAt: Date;
        cycle: number;
        totalDistributed: string;
        txHash: string;
    } | null> {
        const last = await prisma.adminLog.findFirst({
            where: { action: 'DISTRIBUTION_PAYOUT' },
            orderBy: { createdAt: 'desc' }
        });
        if (!last) return null;
        const payload = (last.payload as any) ?? {};
        return {
            createdAt: last.createdAt,
            cycle: Number(payload.cycle ?? 0),
            totalDistributed: String(payload.totalDistributed ?? '0'),
            txHash: String(payload.txHash ?? '')
        };
    }

    async getNextDistributionDate(): Promise<Date> {
        const last = await this.getLastDistribution();
        if (!last) return DISTRIBUTION_FIRST_DATE;
        return new Date(last.createdAt.getTime() + this.getDistributionIntervalMs());
    }

    private async getAggregatedHolders(limit: number | null = MAX_RECIPIENTS): Promise<AggregatedHolder[]> {
        const excluded = getExcludedAddresses();
        const [balances, agentWallets, businessWallets] = await Promise.all([
            prisma.holderBalance.findMany({
                where: { sbyteBalance: { gt: 0 } },
                select: { walletAddress: true, sbyteBalance: true }
            }),
            prisma.agentWallet.findMany({
                select: { walletAddress: true, actorId: true }
            }),
            prisma.businessWallet.findMany({
                select: { walletAddress: true, business: { select: { ownerId: true } } }
            })
        ]);

        const agentByWallet = new Map(
            agentWallets.map(row => [row.walletAddress.toLowerCase(), row.actorId])
        );
        const agentWalletByActor = new Map(
            agentWallets.map(row => [row.actorId, row.walletAddress.toLowerCase()])
        );
        const businessOwnerByWallet = new Map(
            businessWallets.map(row => [row.walletAddress.toLowerCase(), row.business?.ownerId ?? null])
        );

        const soulbyteMap = new Map<string, AggregatedHolder>();
        const businessRows: AggregatedHolder[] = [];
        const otherRows: AggregatedHolder[] = [];

        for (const balance of balances) {
            const wallet = balance.walletAddress.toLowerCase();
            if (excluded.has(wallet)) continue;
            const raw = new Decimal(balance.sbyteBalance.toString());
            if (raw.lte(0)) continue;
            const amount = raw.div(WEI_PER_SBYTE);

            const actorId = agentByWallet.get(wallet) ?? businessOwnerByWallet.get(wallet) ?? null;
            if (actorId) {
                const key = actorId;
                const primaryAddress = agentWalletByActor.get(actorId) ?? wallet;
                const existing = soulbyteMap.get(key);
                if (!existing) {
                    soulbyteMap.set(key, {
                        address: primaryAddress,
                        category: 'soulbyte',
                        actorId,
                        sbyteBalance: amount
                    });
                } else {
                    existing.sbyteBalance = existing.sbyteBalance.add(amount);
                }
                continue;
            }

            if (businessOwnerByWallet.has(wallet)) {
                businessRows.push({
                    address: wallet,
                    category: 'business_wallet',
                    actorId: null,
                    sbyteBalance: amount
                });
                continue;
            }

            otherRows.push({
                address: wallet,
                category: 'not_soulbyte',
                actorId: null,
                sbyteBalance: amount
            });
        }

        const output = Array.from(soulbyteMap.values()).concat(otherRows, businessRows);
        output.sort((a, b) => b.sbyteBalance.comparedTo(a.sbyteBalance));
        if (limit === null) {
            return output;
        }
        return output.slice(0, limit);
    }

    private getNftMultiplier(count: number): number {
        if (count >= 3) return 2.5;
        if (count >= 2) return 2.0;
        if (count >= 1) return 1.5;
        return 1.0;
    }

    private calculateShares(holders: TimeWeightedHolder[], totalDistribution: Decimal) {
        const totalWeight = holders.reduce(
            (sum, holder) => sum.add(holder.effectiveWeight),
            new Decimal(0)
        );
        if (totalWeight.lte(0)) {
            return [];
        }
        return holders.map((holder) => {
            const share = holder.effectiveWeight.div(totalWeight);
            const gross = totalDistribution.mul(share);
            const net = gross;
            return {
                holder,
                share,
                gross,
                net
            };
        }).filter((row) => row.net.gte(MIN_PAYOUT_SBYTE));
    }

    private async getCurrentCycleId(): Promise<number> {
        const last = await this.getLastDistribution();
        return last ? last.cycle + 1 : 0;
    }

    private async getSnapshotWindow(cycleId: number): Promise<{ totalExpectedSnapshots: number; totalSnapshots: number }> {
        const firstSnapshot = await prisma.holderBalanceSnapshot.findFirst({
            where: { cycleId },
            orderBy: { snapshotTick: 'asc' },
            select: { snapshotTick: true }
        });
        const lastSnapshot = await prisma.holderBalanceSnapshot.findFirst({
            where: { cycleId },
            orderBy: { snapshotTick: 'desc' },
            select: { snapshotTick: true }
        });

        if (!firstSnapshot || !lastSnapshot) {
            return {
                totalExpectedSnapshots: 1,
                totalSnapshots: 0,
                firstSnapshotTick: null,
                lastSnapshotTick: null
            };
        }

        const totalExpectedSnapshots = Math.max(1, lastSnapshot.snapshotTick - firstSnapshot.snapshotTick + 1);
        return {
            totalExpectedSnapshots,
            totalSnapshots: totalExpectedSnapshots,
            firstSnapshotTick: firstSnapshot.snapshotTick,
            lastSnapshotTick: lastSnapshot.snapshotTick
        };
    }

    private async getSnapshotAddresses(cycleId: number, excluded: Set<string>): Promise<string[]> {
        const where = excluded.size > 0
            ? { cycleId, walletAddress: { notIn: Array.from(excluded.values()) } }
            : { cycleId };
        const snapshots = await prisma.holderBalanceSnapshot.findMany({
            where,
            select: { walletAddress: true },
            distinct: ['walletAddress']
        });
        return snapshots.map((row) => row.walletAddress.toLowerCase());
    }

    private async computeTimeWeightedHoldings(
        cycleId: number,
        holderAddresses: string[],
        totalExpectedSnapshots: number,
        lastSnapshotTick: number | null
    ): Promise<Map<string, { twab: Decimal; twam: Decimal; snapshotsRecorded: number; effectiveWeight: Decimal }>> {
        const results = new Map<string, { twab: Decimal; twam: Decimal; snapshotsRecorded: number; effectiveWeight: Decimal }>();
        const safeTotalSnapshots = Math.max(1, totalExpectedSnapshots);
        const useDecay = Number.isFinite(DECAY_HALF_LIFE_HOURS) && DECAY_HALF_LIFE_HOURS > 0;
        const snapshotIntervalHours = SNAPSHOT_INTERVAL_MS / (60 * 60 * 1000);
        const halfLifeSnapshots = useDecay ? (DECAY_HALF_LIFE_HOURS / snapshotIntervalHours) : 0;
        const decayRatio = useDecay && halfLifeSnapshots > 0
            ? Math.exp(-Math.log(2) / halfLifeSnapshots)
            : 1;
        const weightTotal = decayRatio === 1
            ? safeTotalSnapshots
            : (1 - Math.pow(decayRatio, safeTotalSnapshots)) / (1 - decayRatio);
        const weightTotalDecimal = new Decimal(weightTotal);

        const excluded = getExcludedAddresses();
        for (const address of holderAddresses) {
            if (excluded.has(address.toLowerCase())) {
                continue;
            }
            const snapshots = await prisma.holderBalanceSnapshot.findMany({
                where: { walletAddress: address, cycleId },
                orderBy: { snapshotTick: 'asc' }
            });

            if (snapshots.length === 0) {
                results.set(address, {
                    twab: new Decimal(0),
                    twam: new Decimal(1.0),
                    snapshotsRecorded: 0,
                    effectiveWeight: new Decimal(0)
                });
                continue;
            }

            let weightedBalanceSum = new Decimal(0);
            let weightedNftSum = new Decimal(0);
            let weightSeen = 0;

            const anchorTick = lastSnapshotTick ?? snapshots[snapshots.length - 1].snapshotTick;
            for (const snapshot of snapshots) {
                const delta = Math.max(0, anchorTick - snapshot.snapshotTick);
                const weight = decayRatio === 1 ? 1 : Math.pow(decayRatio, delta);
                weightSeen += weight;
                const weightDecimal = new Decimal(weight);
                weightedBalanceSum = weightedBalanceSum.add(
                    new Decimal(snapshot.sbyteBalance.toString()).mul(weightDecimal)
                );
                weightedNftSum = weightedNftSum.add(
                    new Decimal(snapshot.nftMultiplier.toString()).mul(weightDecimal)
                );
            }

            const missingWeight = Math.max(0, weightTotal - weightSeen);
            if (missingWeight > 0) {
                weightedNftSum = weightedNftSum.add(new Decimal(missingWeight));
            }

            const twab = weightedBalanceSum.div(weightTotalDecimal);
            const twam = weightedNftSum.div(weightTotalDecimal);

            results.set(address, {
                twab,
                twam,
                snapshotsRecorded: snapshots.length,
                effectiveWeight: twab.mul(twam)
            });
        }

        return results;
    }

    async takeHolderBalanceSnapshot() {
        const lastSnapshot = await prisma.holderBalanceSnapshot.findFirst({
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true, snapshotTick: true }
        });
        const now = Date.now();
        if (lastSnapshot && now - lastSnapshot.createdAt.getTime() < SNAPSHOT_INTERVAL_MS) {
            return null;
        }

        const cycleId = await this.getCurrentCycleId();
        const snapshotTick = lastSnapshot ? lastSnapshot.snapshotTick + 1 : 0;
        const excluded = getExcludedAddresses();
        const holders = (await this.getAggregatedHolders(null))
            .filter((holder) => !excluded.has(holder.address.toLowerCase()));
        if (holders.length === 0) {
            return null;
        }

        const addresses = holders.map((holder) => holder.address.toLowerCase());
        const nftBalances = await prisma.holderNftBalance.findMany({
            where: { walletAddress: { in: addresses } },
            select: { walletAddress: true, passCount: true }
        });
        const nftMap = new Map(
            nftBalances.map(row => [row.walletAddress.toLowerCase(), row.passCount])
        );
        const snapshots = holders.map((holder) => {
            const address = holder.address.toLowerCase();
            const nftCount = nftMap.get(address) ?? 0;
            return {
                walletAddress: address,
                sbyteBalance: holder.sbyteBalance.toFixed(18),
                nftPassCount: nftCount,
                nftMultiplier: this.getNftMultiplier(nftCount),
                snapshotTick,
                cycleId
            };
        });

        await prisma.holderBalanceSnapshot.createMany({
            data: snapshots,
            skipDuplicates: true
        });

        return { cycleId, snapshotTick, recorded: snapshots.length };
    }

    async calculateDistributableAmount() {
        const vaultHealth = await vaultHealthService.computeVaultHealth();
        updateCachedVaultHealth(vaultHealth.healthDays);
        const safetyReserve = new Decimal(vaultHealth.totalDailyBurnRate).mul(60);
        const onchainBalance = new Decimal(vaultHealth.onchainBalanceFormatted);
        const surplus = onchainBalance.sub(safetyReserve);
        const distributionRate = getDistributionRate(vaultHealth.healthDays);
        const distributionAmount = surplus.greaterThan(0)
            ? surplus.mul(distributionRate)
            : new Decimal(0);
        return {
            vaultHealth,
            safetyReserve,
            surplus,
            distributionRate,
            distributionAmount
        };
    }

    async generatePreview(holderFilter?: string, limit?: number, offset?: number) {
        const cacheKey = `${holderFilter ?? 'all'}:${limit ?? 'all'}:${offset ?? 0}`;
        const cached = PREVIEW_CACHE.get(cacheKey);
        const nowMs = Date.now();
        if (cached && cached.expiresAt > nowMs) {
            return cached.value;
        }

        const excluded = getExcludedAddresses();
        const nextDistributionAt = await this.getNextDistributionDate();
        const snapshotAt = new Date(nextDistributionAt.getTime() - DISTRIBUTION_SNAPSHOT_LEAD_HOURS * 60 * 60 * 1000);
        const now = nowUtc();
        const countdownSeconds = Math.max(0, Math.floor((nextDistributionAt.getTime() - now.getTime()) / 1000));

        const { vaultHealth, distributionRate, distributionAmount } = await this.calculateDistributableAmount();
        const cycleId = await this.getCurrentCycleId();
        const { totalExpectedSnapshots, totalSnapshots, lastSnapshotTick } = await this.getSnapshotWindow(cycleId);
        const snapshotAddresses = await this.getSnapshotAddresses(cycleId, excluded);
        const aggregated = (await this.getAggregatedHolders(null))
            .filter((holder) => !excluded.has(holder.address.toLowerCase()));
        const aggregatedMap = new Map(
            aggregated.map((holder) => [holder.address.toLowerCase(), holder])
        );
        const addressSet = new Set<string>([...snapshotAddresses, ...aggregatedMap.keys()]);
        const holderAddresses = Array.from(addressSet.values());
        const holdingWeights = await this.computeTimeWeightedHoldings(
            cycleId,
            holderAddresses,
            totalExpectedSnapshots,
            lastSnapshotTick
        );

        const weightedHolders = holderAddresses.map((address) => {
            const base = aggregatedMap.get(address) ?? {
                address,
                category: 'not_soulbyte' as const,
                actorId: null,
                sbyteBalance: new Decimal(0)
            };
            const weight = holdingWeights.get(address) ?? {
                twab: new Decimal(0),
                twam: new Decimal(1.0),
                snapshotsRecorded: 0,
                effectiveWeight: new Decimal(0)
            };
            return {
                ...base,
                twab: weight.twab,
                twam: weight.twam,
                snapshotsRecorded: weight.snapshotsRecorded,
                effectiveWeight: weight.effectiveWeight
            };
        }).filter((holder) =>
            holder.effectiveWeight.gt(0) &&
            holder.sbyteBalance.gte(MIN_DISTRIBUTION_HOLDER_BALANCE)
        );

        weightedHolders.sort((a, b) => b.effectiveWeight.comparedTo(a.effectiveWeight));
        const topHolders = weightedHolders.slice(0, MAX_RECIPIENTS);
        const payouts = this.calculateShares(topHolders, new Decimal(distributionAmount.toString()))
            .filter((row) => !excluded.has(row.holder.address.toLowerCase()));
        const ranked = payouts.map((row, idx) => ({ ...row, rank: idx + 1 }));
        const filteredByHolder = holderFilter
            ? excluded.has(holderFilter.toLowerCase())
                ? []
                : ranked.filter((row) => row.holder.address.toLowerCase() === holderFilter.toLowerCase())
            : ranked;
        const safeLimit = limit && limit > 0 ? Math.min(limit, MAX_RECIPIENTS) : MAX_RECIPIENTS;
        const safeOffset = offset && offset > 0 ? offset : 0;
        const paged = filteredByHolder.slice(safeOffset, safeOffset + safeLimit);

        const lastDistribution = await this.getLastDistribution();
        const pagedAddresses = paged.map((row) => row.holder.address.toLowerCase());
        const currentNftBalances = pagedAddresses.length > 0
            ? await prisma.holderNftBalance.findMany({
                where: { walletAddress: { in: pagedAddresses } },
                select: { walletAddress: true, passCount: true }
            })
            : [];
        const currentNftCounts = new Map(
            currentNftBalances.map(row => [row.walletAddress.toLowerCase(), row.passCount])
        );

        const response = {
            cachedAt: new Date().toISOString(),
            firstDistributionDate: DISTRIBUTION_FIRST_DATE.toISOString(),
            nextDistributionAt: nextDistributionAt.toISOString(),
            snapshotAt: snapshotAt.toISOString(),
            countdownSeconds,
            vaultHealth: {
                onchainBalance: formatSbyte(vaultHealth.onchainBalanceFormatted),
                onchainBalanceRaw: vaultHealth.onchainBalance,
                healthDays: vaultHealth.healthDays,
                totalDailyBurnRate: vaultHealth.totalDailyBurnRate,
                eligible: vaultHealth.healthDays >= MIN_VAULT_HEALTH_DAYS
            },
            distribution: {
                estimatedAmount: distributionAmount.toNumber(),
                distributionRate,
                recipientCount: topHolders.length
            },
            holders: paged.map((row) => ({
                rank: row.rank,
                address: row.holder.address,
                category: row.holder.category,
                actorId: row.holder.actorId,
                currentBalance: row.holder.sbyteBalance.toFixed(2),
                currentNftCount: currentNftCounts.get(row.holder.address.toLowerCase()) ?? 0,
                twab: row.holder.twab.toFixed(2),
                twam: row.holder.twam.toFixed(4),
                snapshotsRecorded: row.holder.snapshotsRecorded,
                totalSnapshots,
                effectiveWeight: row.holder.effectiveWeight.toFixed(2),
                sharePercent: row.share.mul(100).toFixed(4),
                estimatedPayout: row.net.toFixed(4)
            })),
            meta: {
                lastDistribution: lastDistribution
                    ? {
                        date: lastDistribution.createdAt.toISOString(),
                        cycle: lastDistribution.cycle,
                        totalDistributed: lastDistribution.totalDistributed,
                        txHash: lastDistribution.txHash
                    }
                    : null,
                nftContractAddress: CONTRACTS.GENESIS_PASS_NFT,
                distributorContractAddress: CONTRACTS.SBYTE_DISTRIBUTOR,
                pagination: {
                    offset: safeOffset,
                    limit: safeLimit,
                    total: filteredByHolder.length,
                    hasMore: safeOffset + safeLimit < filteredByHolder.length
                }
            }
        };

        PREVIEW_CACHE.set(cacheKey, {
            cachedAt: new Date(),
            expiresAt: nowMs + PREVIEW_CACHE_TTL_MS,
            value: response
        });

        return response;
    }

    async getHistory(holder?: string, limit: number = 10) {
        if (holder) {
            const rows = await prisma.distributionLog.findMany({
                where: { walletAddress: holder.toLowerCase() },
                orderBy: { createdAt: 'desc' },
                take: limit
            });
            return {
                data: rows.map((row) => ({
                    cycle: row.cycle,
                    walletAddress: row.walletAddress,
                    actorId: row.actorId,
                    amountReceived: row.amountReceived.toString(),
                    sharePercent: row.sharePercent.toString(),
                    nftMultiplier: row.nftMultiplier.toString(),
                    txHash: row.txHash,
                    createdAt: row.createdAt
                }))
            };
        }

        const logs = await prisma.adminLog.findMany({
            where: { action: 'DISTRIBUTION_PAYOUT' },
            orderBy: { createdAt: 'desc' },
            take: limit
        });
        return {
            data: logs.map((log) => ({
                createdAt: log.createdAt,
                payload: log.payload
            }))
        };
    }

    async executeDistribution() {
        if (!DISTRIBUTION_ENABLED) {
            return null;
        }

        const now = nowUtc();
        if (now.getTime() < DISTRIBUTION_FIRST_DATE.getTime()) {
            const god = await prisma.actor.findFirst({ where: { isGod: true } });
            if (god) {
                await prisma.adminLog.create({
                    data: {
                        godId: god.id,
                        action: 'DISTRIBUTION_BEFORE_FIRST_DATE',
                        payload: { now: now.toISOString(), firstDate: DISTRIBUTION_FIRST_DATE.toISOString() }
                    }
                });
            }
            return null;
        }

        const lastDistribution = await this.getLastDistribution();
        if (lastDistribution) {
            const nextAt = new Date(lastDistribution.createdAt.getTime() + this.getDistributionIntervalMs());
            if (now.getTime() < nextAt.getTime()) {
                return null;
            }
        }

        const { vaultHealth, distributionRate, distributionAmount } = await this.calculateDistributableAmount();
        if (vaultHealth.healthDays < MIN_VAULT_HEALTH_DAYS || distributionRate <= 0) {
            const god = await prisma.actor.findFirst({ where: { isGod: true } });
            if (god) {
                await prisma.adminLog.create({
                    data: {
                        godId: god.id,
                        action: 'DISTRIBUTION_SKIPPED',
                        payload: {
                            healthDays: vaultHealth.healthDays,
                            distributionRate
                        }
                    }
                });
            }
            return null;
        }

        if (distributionAmount.lt(MIN_DISTRIBUTION_AMOUNT)) {
            return null;
        }

        const cycleId = await this.getCurrentCycleId();
        const { totalExpectedSnapshots, totalSnapshots, lastSnapshotTick } = await this.getSnapshotWindow(cycleId);
        if (totalSnapshots === 0) {
            return null;
        }
        const excluded = getExcludedAddresses();
        const snapshotAddresses = await this.getSnapshotAddresses(cycleId, excluded);
        if (snapshotAddresses.length === 0) {
            return null;
        }
        const aggregated = (await this.getAggregatedHolders(null))
            .filter((holder) => !excluded.has(holder.address.toLowerCase()));
        const aggregatedMap = new Map(
            aggregated.map((holder) => [holder.address.toLowerCase(), holder])
        );
        const holdingWeights = await this.computeTimeWeightedHoldings(
            cycleId,
            snapshotAddresses,
            totalExpectedSnapshots,
            lastSnapshotTick
        );

        const weightedHolders = snapshotAddresses.map((address) => {
            const base = aggregatedMap.get(address) ?? {
                address,
                category: 'not_soulbyte' as const,
                actorId: null,
                sbyteBalance: new Decimal(0)
            };
            const weight = holdingWeights.get(address) ?? {
                twab: new Decimal(0),
                twam: new Decimal(1.0),
                snapshotsRecorded: 0,
                effectiveWeight: new Decimal(0)
            };
            return {
                ...base,
                twab: weight.twab,
                twam: weight.twam,
                snapshotsRecorded: weight.snapshotsRecorded,
                effectiveWeight: weight.effectiveWeight
            };
        }).filter((holder) =>
            holder.effectiveWeight.gt(0) &&
            holder.sbyteBalance.gte(MIN_DISTRIBUTION_HOLDER_BALANCE)
        );

        weightedHolders.sort((a, b) => b.effectiveWeight.comparedTo(a.effectiveWeight));
        const topHolders = weightedHolders.slice(0, MAX_RECIPIENTS);
        const payouts = this.calculateShares(topHolders, new Decimal(distributionAmount.toString()))
            .filter((row) => !excluded.has(row.holder.address.toLowerCase()));
        if (payouts.length === 0) {
            return null;
        }

        const recipients: string[] = [];
        const amounts: bigint[] = [];

        for (const payout of payouts) {
            recipients.push(payout.holder.address);
            amounts.push(toWei(payout.net));
        }

        if (recipients.length > MAX_TOTAL_RECIPIENTS) {
            throw new Error(`Recipient count exceeds ${MAX_TOTAL_RECIPIENTS}`);
        }

        const provider = await this.getProvider();
        const wallet = new ethers.Wallet(getGodPrivateKey(), provider);
        const distributor = new ethers.Contract(getDistributorAddress(), DISTRIBUTOR_ABI, wallet);
        const sbyte = new ethers.Contract(CONTRACTS.SBYTE_TOKEN, ERC20_ABI, wallet);

        const totalAmountWei = amounts.reduce((sum, amt) => sum + amt, 0n);
        await withRpcRetry(
            () => sbyte.approve(getDistributorAddress(), totalAmountWei),
            'distributionApprove'
        );
        const tx = await withRpcRetry(
            () => distributor.distribute(recipients, amounts),
            'distributionExecute'
        );
        const receipt = await withRpcRetry(() => tx.wait(), 'distributionWait');
        const txHash = tx.hash ?? receipt?.hash ?? '';

        const god = await prisma.actor.findFirst({ where: { isGod: true } });
        const cycle = lastDistribution ? (lastDistribution.cycle + 1) : 1;

        if (god) {
            await prisma.adminLog.create({
                data: {
                    godId: god.id,
                    action: 'DISTRIBUTION_PAYOUT',
                    payload: {
                        cycle,
                        totalDistributed: distributionAmount.toFixed(6),
                        recipientCount: payouts.length,
                        txHash,
                        vaultHealthDays: vaultHealth.healthDays,
                        distributionRate
                    }
                }
            });
        }

        const worldState = await prisma.worldState.findFirst({ where: { id: 1 } });
        const currentTick = worldState?.tick ?? 0;
        await prisma.$transaction(async (txDb) => {
            for (const payout of payouts) {
                await txDb.distributionLog.create({
                    data: {
                        cycle,
                        walletAddress: payout.holder.address.toLowerCase(),
                        actorId: payout.holder.actorId,
                        sbyteBalance: payout.holder.twab.toFixed(18),
                        effectiveWeight: payout.holder.effectiveWeight.toFixed(18),
                        nftMultiplier: payout.holder.twam.toFixed(4),
                        sharePercent: payout.share.mul(100).toFixed(6),
                        amountReceived: payout.net.toFixed(18),
                        txHash
                    }
                });
                if (payout.holder.actorId) {
                    await txDb.event.create({
                        data: {
                            actorId: payout.holder.actorId,
                            type: EventType.EVENT_DISTRIBUTION_RECEIVED,
                            targetIds: [],
                            tick: currentTick,
                            outcome: EventOutcome.SUCCESS,
                            sideEffects: {
                                amount: payout.net.toFixed(6),
                                cycle,
                                txHash
                            }
                        }
                    });
                }
            }
        });

        fs.mkdirSync(DISTRIBUTION_LOG_DIR, { recursive: true });
        const logEntry = {
            timestamp: new Date().toISOString(),
            cycle,
            totalDistributed: distributionAmount.toFixed(6),
            recipientCount: payouts.length,
            txHash,
            vaultHealthDays: vaultHealth.healthDays,
            distributionRate
        };
        fs.appendFileSync(DISTRIBUTION_LOG_FILE, `${JSON.stringify(logEntry)}\n`, 'utf8');

        const nextCycleId = cycleId + 1;
        await prisma.holderBalanceSnapshot.deleteMany({
            where: { cycleId: { lt: nextCycleId } }
        });

        return {
            cycle,
            totalDistributed: distributionAmount.toFixed(6),
            recipientCount: payouts.length,
            txHash
        };
    }
}

export const distributionService = new DistributionService();
