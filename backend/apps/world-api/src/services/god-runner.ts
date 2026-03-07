/**
 * God Runner - Background loop for God Service
 * Processes pending proposals on interval
 */
import { prisma } from '../db.js';
import { processProposals } from './god.service.js';
import { distributionService } from './distribution.service.js';

const GOD_INTERVAL_MS = parseInt(process.env.GOD_INTERVAL_MS || '10000', 10);
const DISTRIBUTION_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const SNAPSHOT_CHECK_INTERVAL_MS = 10 * 60 * 1000;

let running = false;
let godLoopTimeout: NodeJS.Timeout | null = null;
let lastDistributionCheckAt = 0;
let lastSnapshotCheckAt = 0;

/**
 * Start the God service loop
 */
export async function startGodRunner(): Promise<void> {
    if (running) {
        console.log('God runner already running');
        return;
    }

    // Verify God actor exists
    const godActor = await prisma.actor.findFirst({
        where: { isGod: true },
    });

    if (!godActor) {
        console.warn('⚠ WARNING: No God actor found. Run genesis script first.');
        console.warn('  God runner will start but cannot process proposals.');
    } else {
        console.log(`✓ God actor found: ${godActor.name} (${godActor.id})`);
    }

    running = true;
    console.log(`✓ God runner started (interval: ${GOD_INTERVAL_MS}ms)`);

    godLoop();
}

/**
 * Stop the God service loop
 */
export function stopGodRunner(): void {
    running = false;
    if (godLoopTimeout) {
        clearTimeout(godLoopTimeout);
        godLoopTimeout = null;
    }
    console.log('God runner stopped');
}

/**
 * Main God loop
 */
async function godLoop(): Promise<void> {
    if (!running) return;

    try {
        // Get current tick
        const worldState = await prisma.worldState.findFirst({
            where: { id: 1 },
        });
        const currentTick = worldState?.tick ?? 0;

        // Process pending proposals
        const { approved, rejected } = await processProposals(currentTick);

        if (approved > 0 || rejected > 0) {
            console.log(`[God] Proposals: ${approved} approved, ${rejected} rejected`);
        }

        const reviewed = await processAngelReports(currentTick);
        if (reviewed > 0) {
            console.log(`[God] Angel reports reviewed: ${reviewed}`);
        }

        const now = Date.now();
        if (now - lastSnapshotCheckAt >= SNAPSHOT_CHECK_INTERVAL_MS) {
            lastSnapshotCheckAt = now;
            try {
                const snapshot = await distributionService.takeHolderBalanceSnapshot();
                if (snapshot) {
                    console.log(`[God] Snapshot tick ${snapshot.snapshotTick} (cycle ${snapshot.cycleId}) recorded ${snapshot.recorded} holders.`);
                }
            } catch (error) {
                console.error('[God] Snapshot error:', error);
            }
        }
        if (now - lastDistributionCheckAt >= DISTRIBUTION_CHECK_INTERVAL_MS) {
            lastDistributionCheckAt = now;
            try {
                const result = await distributionService.executeDistribution();
                if (result) {
                    console.log(`[God] Distribution #${result.cycle}: ${result.totalDistributed} SBYTE → ${result.recipientCount} holders. TX: ${result.txHash}`);
                }
            } catch (error) {
                console.error('[God] Distribution error:', error);
                const godActor = await prisma.actor.findFirst({ where: { isGod: true } });
                if (godActor) {
                    await prisma.adminLog.create({
                        data: {
                            godId: godActor.id,
                            action: 'DISTRIBUTION_ERROR',
                            payload: { error: String(error) }
                        }
                    });
                }
            }
        }

    } catch (error) {
        console.error('[God] Error in god loop:', error);
    }

    // Schedule next iteration
    if (running) {
        godLoopTimeout = setTimeout(godLoop, GOD_INTERVAL_MS);
    }
}

/**
 * Run a single God iteration manually (for testing)
 */
export async function runSingleGodCycle(): Promise<{
    approved: number;
    rejected: number;
}> {
    const worldState = await prisma.worldState.findFirst({
        where: { id: 1 },
    });
    const currentTick = worldState?.tick ?? 0;

    const proposalResults = await processProposals(currentTick);
    await processAngelReports(currentTick);
    return proposalResults;
}

async function processAngelReports(currentTick: number): Promise<number> {
    const pendingReports = await prisma.angelFeedbackReport.findMany({
        where: { godDecision: null },
        orderBy: { createdAt: 'asc' },
        take: 5,
    });

    let processed = 0;
    for (const report of pendingReports) {
        if (report.reportType === 'AGORA_FLAGGED_POST') {
            const samples = (report.samplePosts as any[]) ?? [];
            if (report.sentimentAvg && Number(report.sentimentAvg) < -0.5) {
                for (const sample of samples) {
                    if (!sample?.postId) continue;
                    await prisma.agoraPost.update({
                        where: { id: sample.postId },
                        data: {
                            deleted: true,
                            deletedReason: 'God moderation',
                            deletedBy: 'god',
                            deletedAt: new Date(),
                            flagged: false,
                        },
                    });
                }
                await prisma.angelFeedbackReport.update({
                    where: { id: report.id },
                    data: { godDecision: 'DELETED', godReasoning: 'Negative sentiment below threshold' },
                });
            } else {
                if (samples?.[0]?.postId) {
                    await prisma.agoraPost.update({
                        where: { id: samples[0].postId },
                        data: { flagged: false },
                    });
                }
                await prisma.angelFeedbackReport.update({
                    where: { id: report.id },
                    data: { godDecision: 'APPROVED', godReasoning: 'Content within acceptable range' },
                });
            }
            processed += 1;
            continue;
        }

        if (report.reportType === 'WORLD_SENTIMENT_REPORT') {
            await prisma.angelFeedbackReport.update({
                where: { id: report.id },
                data: { godDecision: 'ACK', godReasoning: 'Report acknowledged' },
            });
            processed += 1;
            continue;
        }
    }

    return processed;
}
