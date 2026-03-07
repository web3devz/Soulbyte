/**
 * God Service - Backend authority for proposal approval
 * God is NOT an agent. God is a system bot/service.
 * 
 * Responsibilities:
 * - Approve/reject city proposals
 * - Burn SBYTE for upgrades
 * - Log all actions to admin_log
 */
import { prisma } from '../db.js';
import { EventType, EventOutcome } from '../types/event.types.js';
import { Decimal } from 'decimal.js';
import { getLatestSnapshot } from './economy-snapshot.service.js';
import type { Prisma } from '../../../../generated/prisma/index.js';
import { GOVERNANCE_TAX_LIMITS } from '../config/governance.js';
import { validateGovernanceProposal } from './governance-validation.js';

type TransactionClient = Prisma.TransactionClient;

interface ProposalRecord {
    id: string;
    cityId: string;
    mayorId: string;
    type: string;
    payload: unknown;
    status: string;
    city?: {
        id: string;
        mayorId: string | null;
        population: number;
        vault?: { balanceSbyte: unknown } | null;
        policies?: {
            cityFeeRate: unknown;
            rentTaxRate?: unknown;
            tradeTaxRate?: unknown;
            professionTaxRate?: unknown;
            businessTaxRate?: unknown;
            lastTaxChangeTick?: unknown;
        } | null;
    } | null;
}

/**
 * Process pending proposals
 * Called by God runner on interval
 */
export async function processProposals(currentTick: number): Promise<{
    approved: number;
    rejected: number;
}> {
    let approved = 0;
    let rejected = 0;

    // Get God actor
    const godActor = await prisma.actor.findFirst({
        where: { isGod: true },
    });

    if (!godActor) {
        console.error('ERROR: No God actor found! Cannot process proposals.');
        return { approved: 0, rejected: 0 };
    }

    // Get pending proposals
    const pendingProposals = await prisma.cityProposal.findMany({
        where: { status: 'pending' },
        include: {
            city: {
                include: {
                    vault: true,
                    policies: true,
                },
            },
        },
        orderBy: { createdAt: 'asc' },
    });

    for (const proposal of pendingProposals) {
        try {
            const proposalRecord: ProposalRecord = {
                id: proposal.id,
                cityId: proposal.cityId,
                mayorId: proposal.mayorId,
                type: proposal.type,
                payload: proposal.payload,
                status: proposal.status,
                city: proposal.city ? {
                    id: proposal.city.id,
                    mayorId: proposal.city.mayorId,
                    population: proposal.city.population,
                    vault: proposal.city.vault,
                    policies: proposal.city.policies,
                } : null,
            };

            const result = await validateAndExecuteProposal(proposalRecord, godActor.id, currentTick);

            if (result.approved) {
                approved++;
                console.log(`  Proposal ${proposal.id} APPROVED: ${proposal.type}`);
            } else {
                rejected++;
                console.log(`  Proposal ${proposal.id} REJECTED: ${result.reason}`);
            }
        } catch (error) {
            console.error(`  Error processing proposal ${proposal.id}:`, error);
            // Mark as rejected on error
            await prisma.cityProposal.update({
                where: { id: proposal.id },
                data: {
                    status: 'rejected',
                    payload: {
                        ...(proposal.payload as object),
                        rejectReason: `Error: ${error}`,
                    },
                },
            });
            rejected++;
        }
    }

    return { approved, rejected };
}

/**
 * Approve a single proposal by ID (admin RPC)
 */
export async function approveProposalById(proposalId: string, currentTick: number): Promise<{
    status: 'approved' | 'rejected' | 'error';
    reason?: string;
}> {
    const godActor = await prisma.actor.findFirst({
        where: { isGod: true },
    });

    if (!godActor) {
        return { status: 'error', reason: 'No God actor found' };
    }

    const proposal = await prisma.cityProposal.findUnique({
        where: { id: proposalId },
        include: {
            city: {
                include: {
                    vault: true,
                    policies: true,
                },
            },
        },
    });

    if (!proposal) {
        return { status: 'error', reason: 'Proposal not found' };
    }

    const proposalRecord: ProposalRecord = {
        id: proposal.id,
        cityId: proposal.cityId,
        mayorId: proposal.mayorId,
        type: proposal.type,
        payload: proposal.payload,
        status: proposal.status,
        city: proposal.city
            ? {
                id: proposal.city.id,
                mayorId: proposal.city.mayorId,
                population: proposal.city.population,
                vault: proposal.city.vault,
                policies: proposal.city.policies,
            }
            : null,
    };

    const result = await validateAndExecuteProposal(proposalRecord, godActor.id, currentTick);
    if (result.approved) {
        return { status: 'approved' };
    }
    return { status: 'rejected', reason: result.reason };
}

/**
 * Validate and execute a single proposal
 */
async function validateAndExecuteProposal(
    proposal: ProposalRecord,
    godId: string,
    currentTick: number
): Promise<{ approved: boolean; reason?: string }> {
    const city = proposal.city;
    const vault = city?.vault;
    const payload = proposal.payload as Record<string, unknown>;

    if (!city) {
        await rejectProposal(proposal.id, proposal.type, proposal.cityId, 'City not found', godId, currentTick);
        return { approved: false, reason: 'City not found' };
    }

    // Validation 1: Mayor legitimacy
    if (city.mayorId !== proposal.mayorId) {
        await rejectProposal(proposal.id, proposal.type, proposal.cityId, 'Mayor no longer legitimate', godId, currentTick);
        return { approved: false, reason: 'Mayor no longer legitimate' };
    }

    const vaultBalance = vault ? new Decimal(String(vault.balanceSbyte)) : new Decimal(0);
    const validation = validateGovernanceProposal({
        proposalType: proposal.type,
        payload,
        vaultBalance,
        cityPolicy: proposal.city?.policies ?? null,
        currentTick,
    });
    if (validation.blockReasons.length > 0) {
        await rejectProposal(proposal.id, proposal.type, proposal.cityId, validation.blockReasons[0], godId, currentTick);
        return { approved: false, reason: validation.blockReasons[0] };
    }
    const estimatedCost = validation.estimatedCost;
    const normalizedPayload = validation.normalizedPayload;

    // Validation 3: Population threshold (simplified MVP)
    const minPopulation = getMinPopulationForProposal(proposal.type, payload);
    if (city.population < minPopulation) {
        await rejectProposal(proposal.id, proposal.type, proposal.cityId, `Population too low (need ${minPopulation})`, godId, currentTick);
        return { approved: false, reason: `Population too low` };
    }

    // Validation 4: Tax/fee bounds
    if (proposal.type === 'tax_change') {
        if (normalizedPayload.newTaxRate !== undefined && proposal.city?.policies) {
            const currentRate = Number(proposal.city.policies.rentTaxRate ?? 0);
            const newRate = Number(normalizedPayload.newTaxRate);
            if (Math.abs(newRate - currentRate) > 0.1) {
                await rejectProposal(proposal.id, proposal.type, proposal.cityId, 'Tax rate jump too large', godId, currentTick);
                return { approved: false, reason: 'Tax rate jump too large' };
            }
        }
    }

    // Validation 5: Economic intelligence guardrails
    const snapshot = getLatestSnapshot(proposal.cityId);
    if (proposal.type === 'tax_change' && normalizedPayload.newTaxRate !== undefined && snapshot && proposal.city?.policies) {
        const currentRate = Number(proposal.city.policies.rentTaxRate ?? 0);
        const newRate = Number(normalizedPayload.newTaxRate);
        if (['recession', 'crisis'].includes(snapshot.economic_health) && newRate > currentRate) {
            await rejectProposal(proposal.id, proposal.type, proposal.cityId, 'Tax increase during recession', godId, currentTick);
            return { approved: false, reason: 'Tax increase during recession' };
        }
        if (snapshot.economic_health === 'booming' && newRate < currentRate * 0.8) {
            await rejectProposal(proposal.id, proposal.type, proposal.cityId, 'Tax cut too aggressive during boom', godId, currentTick);
            return { approved: false, reason: 'Tax cut too aggressive during boom' };
        }
    }

    // All validations passed - execute proposal
    await executeProposal({ ...proposal, payload: normalizedPayload }, godId, currentTick, estimatedCost);
    return { approved: true };
}

/**
 * Reject a proposal
 */
async function rejectProposal(
    proposalId: string,
    proposalType: string,
    cityId: string,
    reason: string,
    godId: string,
    tick: number
): Promise<void> {
    await prisma.$transaction(async (tx: TransactionClient) => {
        // Update proposal status
        await tx.cityProposal.update({
            where: { id: proposalId },
            data: {
                status: 'rejected',
                payload: {
                    rejectReason: reason,
                },
            },
        });

        // Log to admin_log
        await tx.adminLog.create({
            data: {
                godId,
                action: 'REJECT_PROPOSAL',
                payload: {
                    proposalId,
                    proposalType,
                    cityId,
                    reason,
                    tick,
                } as any,
            },
        });

        // Create event
        await tx.event.create({
            data: {
                actorId: godId,
                type: EventType.EVENT_PROPOSAL_REJECTED,
                targetIds: [cityId],
                tick,
                outcome: EventOutcome.SUCCESS,
                sideEffects: {
                    proposalId,
                    reason,
                },
            },
        });
    });
}

/**
 * Execute an approved proposal
 */
async function executeProposal(
    proposal: ProposalRecord,
    godId: string,
    tick: number,
    cost: Decimal
): Promise<void> {
    const payload = proposal.payload as Record<string, unknown>;

    await prisma.$transaction(async (tx: TransactionClient) => {
        // 1. Burn SBYTE from city vault if cost > 0
        if (cost.gt(0)) {
            await tx.cityVault.update({
                where: { cityId: proposal.cityId },
                data: {
                    balanceSbyte: { decrement: cost.toNumber() },
                },
            });

            // Log burn
            await tx.burnLog.create({
                data: {
                    amountSbyte: cost.toNumber(),
                    reason: `${proposal.type}_proposal_${proposal.id}`,
                    tick,
                },
            });
        }

        // 2. Apply proposal effects based on type
        switch (proposal.type) {
            case 'upgrade':
                await applyUpgrade(tx, proposal.cityId, payload);
                break;
            case 'tax_change':
                await applyTaxChange(tx, proposal.cityId, payload, tick);
                break;
            case 'aid':
                await applyAid(tx, proposal.cityId, payload);
                break;
            case 'security':
                await applySecurity(tx, proposal.cityId, payload);
                break;
        }

        // 3. Update proposal status
        await tx.cityProposal.update({
            where: { id: proposal.id },
            data: {
                status: 'approved',
                updatedAt: new Date(),
            },
        });

        // 4. Log to admin_log
        await tx.adminLog.create({
            data: {
                godId,
                action: `EXECUTE_${proposal.type.toUpperCase()}`,
                payload: {
                    proposalId: proposal.id,
                    cityId: proposal.cityId,
                    cost: cost.toString(),
                    effects: payload as any,
                    tick,
                },
            },
        });

        // 5. Create event
        const eventType = getEventTypeForProposal(proposal.type);
        await tx.event.create({
            data: {
                actorId: godId,
                type: eventType,
                targetIds: [proposal.cityId],
                tick,
                outcome: EventOutcome.SUCCESS,
                sideEffects: {
                    proposalId: proposal.id,
                    cost: cost.toString(),
                    effects: payload as any,
                },
            },
        });
    });
}

/**
 * Apply infrastructure upgrade
 */
async function applyUpgrade(tx: TransactionClient, cityId: string, payload: Record<string, unknown>): Promise<void> {
    const updateData: Record<string, unknown> = {};
    const amount = Number(payload.amount) || 10;

    switch (payload.upgradeType) {
        case 'housing':
            updateData.housingCapacity = { increment: amount };
            updateData.populationCap = { increment: amount };
            break;
        case 'jobs':
            updateData.jobCapacity = { increment: amount };
            break;
        case 'security':
            updateData.securityLevel = { increment: amount };
            break;
        case 'health':
            updateData.healthServices = { increment: amount };
            break;
        case 'entertainment':
            updateData.entertainment = { increment: amount };
            break;
        case 'transport':
            updateData.transport = { increment: amount };
            break;
    }

    if (Object.keys(updateData).length > 0) {
        await tx.city.update({
            where: { id: cityId },
            data: updateData,
        });
    }
}

/**
 * Apply tax rate change
 */
async function applyTaxChange(tx: TransactionClient, cityId: string, payload: Record<string, unknown>, tick: number): Promise<void> {
    const updateData: Record<string, number> = {};

    const rentTaxRate = payload.rentTaxRate ?? payload.newTaxRate;
    if (rentTaxRate !== undefined) {
        updateData.rentTaxRate = Number(rentTaxRate);
    }
    if (payload.tradeTaxRate !== undefined) {
        updateData.tradeTaxRate = Number(payload.tradeTaxRate);
    }
    if (payload.professionTaxRate !== undefined) {
        updateData.professionTaxRate = Number(payload.professionTaxRate);
    }
    if (payload.cityFeeRate !== undefined) {
        const rate = Math.min(
            Math.max(Number(payload.cityFeeRate), GOVERNANCE_TAX_LIMITS.cityFeeRate.min),
            GOVERNANCE_TAX_LIMITS.cityFeeRate.max
        );
        updateData.cityFeeRate = rate;
    }
    if (payload.businessTaxRate !== undefined) {
        const rate = Math.min(Math.max(Number(payload.businessTaxRate), BUSINESS_TAX_CONFIG.minRate), BUSINESS_TAX_CONFIG.godMaxRate);
        updateData.businessTaxRate = rate;
        updateData.lastTaxChangeTick = tick;
    }

    if (Object.keys(updateData).length > 0) {
        await tx.cityPolicy.update({
            where: { cityId },
            data: updateData,
        });
    }
}

/**
 * Apply social aid (reduces misery, burns SBYTE)
 */
async function applyAid(tx: TransactionClient, cityId: string, payload: Record<string, unknown>): Promise<void> {
    // Aid is just a SBYTE burn with positive city reputation effect
    await tx.city.update({
        where: { id: cityId },
        data: {
            reputationScore: { increment: Number(payload.reputationBonus) || 5 },
        },
    });
}

/**
 * Apply security funding
 */
async function applySecurity(tx: TransactionClient, cityId: string, payload: Record<string, unknown>): Promise<void> {
    await tx.city.update({
        where: { id: cityId },
        data: {
            securityLevel: { increment: Number(payload.amount) || 1 },
        },
    });
}

/**
 * Get minimum population for proposal type
 */
function getMinPopulationForProposal(type: string, _payload: Record<string, unknown>): number {
    // Simplified MVP thresholds
    const thresholds: Record<string, number> = {
        upgrade: 5,
        tax_change: 10,
        aid: 5,
        security: 5,
    };
    return thresholds[type] || 0;
}

/**
 * Get event type for proposal type
 */
function getEventTypeForProposal(type: string): string {
    const map: Record<string, string> = {
        upgrade: EventType.EVENT_CITY_UPGRADED,
        tax_change: EventType.EVENT_CITY_TAX_CHANGED,
        aid: EventType.EVENT_CITY_AID_APPLIED,
        security: EventType.EVENT_CITY_SECURITY_FUNDED,
    };
    return map[type] || EventType.EVENT_PROPOSAL_APPROVED;
}
