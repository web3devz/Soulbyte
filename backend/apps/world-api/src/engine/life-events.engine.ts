import { prisma } from '../db.js';
import { Decimal } from 'decimal.js';
import { AgentTransferService } from '../services/agent-transfer.service.js';
import { CONTRACTS } from '../config/contracts.js';
import { EventType, EventOutcome } from '../types/event.types.js';
import { ethers } from 'ethers';

const agentTransferService = new AgentTransferService();

const BASE_CHANCE = 0.012; // V6: Increased from 0.005 → 0.012 (2.4× more frequent luck events)
const COOLDOWN_TICKS = 1440 * 5;  // V6: Reduced from 7 days → 5 days between luck events per agent
const MONTH_TICKS = 1440 * 30;

const FORTUNE_EVENTS = [
    { code: 'F1', min: 10, max: 50 },
    { code: 'F2', min: 25, max: 100, requiresJob: true },
    { code: 'F3', minPct: 0.05, maxPct: 0.15, min: 20, max: 5000, minWealth: 'W2' },
    { code: 'F4', min: 200, max: 2000, minWealth: 'W1' },
    { code: 'F5', min: 50, max: 500, repDelta: 50, requiresAgoraPost: true },
    { code: 'F6', minPctRevenue: 0.2, maxPctRevenue: 0.4, min: 50, requiresBusiness: true },
    { code: 'F7', min: 100, max: 1000 },
    { code: 'F8', minPct: 0.10, maxPct: 0.25, min: 10, requiresTaxes: true }
];

const MISFORTUNE_EVENTS = [
    { code: 'M1', minPct: 0.05, maxPct: 0.15, min: 5, max: 2000, minWealth: 'W1' },
    { code: 'M2', min: 50, max: 500 },
    { code: 'M3', minPct: 0.10, maxPct: 0.30, requiresProperty: true },
    { code: 'M4', minPct: 0.10, maxPct: 0.20, min: 20, max: 5000, minWealth: 'W2' },
    { code: 'M5', minPctRevenue: 0.15, maxPctRevenue: 0.35, requiresBusiness: true },
    { code: 'M6', min: 100, max: 1000, minWealth: 'W2', repDelta: -15 },
    { code: 'M7', minPct: 0.08, maxPct: 0.25, min: 50, max: 10000, minWealth: 'W4' }
];

const WEALTH_MULTIPLIER: Record<string, number> = {
    W0: 1, W1: 1, W2: 1,
    W3: 2, W4: 2,
    W5: 5, W6: 5,
    W7: 10, W8: 10,
    W9: 20,
};

function roll(seed: bigint, modifier: string): number {
    let h = 0n;
    for (let i = 0; i < modifier.length; i++) {
        h = (h * 31n + BigInt(modifier.charCodeAt(i))) % 1000000007n;
    }
    const combined = (seed ^ h) * 1664525n + 1013904223n;
    return Number(combined % 1000000n) / 1000000;
}

function wealthOk(current: string, min?: string): boolean {
    if (!min) return true;
    const order = ['W0', 'W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9'];
    return order.indexOf(current) >= order.indexOf(min);
}

export async function processLifeEvents(currentTick: number, seed: bigint): Promise<number> {
    const agents = await prisma.actor.findMany({
        where: { kind: 'agent', frozen: false },
        include: { agentState: true, wallet: true }
    });

    let triggered = 0;
    for (const agent of agents) {
        if (!agent.agentState || !agent.wallet) continue;
        if (agent.lastLifeEventTick && currentTick - agent.lastLifeEventTick < COOLDOWN_TICKS) continue;

        const monthStart = agent.lifeEventsMonthStart ?? currentTick;
        const monthElapsed = currentTick - monthStart;
        if (monthElapsed >= MONTH_TICKS) {
            await prisma.actor.update({
                where: { id: agent.id },
                data: { lifeEventsThisMonth: 0, lifeEventsMonthStart: currentTick }
            });
        }
        if (agent.lifeEventsThisMonth >= 3) continue;

        const chanceRoll = roll(seed, agent.id + '_life');
        if (chanceRoll > BASE_CHANCE) continue;

        const luck = agent.luck ?? 50;
        const fortuneWeight = 40 + (luck * 0.4);
        const rollType = roll(seed, agent.id + '_type');
        const isFortune = rollType < fortuneWeight / 100;
        const pool = isFortune ? FORTUNE_EVENTS : MISFORTUNE_EVENTS;

        const wealthTier = agent.agentState.wealthTier || 'W0';
        const hasJob = agent.agentState.jobType !== 'unemployed';
        const hasBusiness = await prisma.business.findFirst({ where: { ownerId: agent.id } });
        const hasAgoraPost = await prisma.agoraPost.findFirst({ where: { authorId: agent.id } });
        const hasProperty = await prisma.property.findFirst({ where: { OR: [{ ownerId: agent.id }, { tenantId: agent.id }] } });
        const hasTaxes = await prisma.transaction.findFirst({ where: { fromActorId: agent.id, feeCity: { gt: 0 } } });

        const available = pool.filter(e =>
            wealthOk(wealthTier, e.minWealth) &&
            (!e.requiresJob || hasJob) &&
            (!e.requiresBusiness || !!hasBusiness) &&
            (!e.requiresAgoraPost || !!hasAgoraPost) &&
            (!e.requiresProperty || !!hasProperty) &&
            (!e.requiresTaxes || !!hasTaxes)
        );
        if (available.length === 0) continue;
        const idx = Math.floor(roll(seed, agent.id + '_pick') * available.length);
        const event = available[idx];

        const balance = new Decimal(agent.wallet.balanceSbyte.toString());
        let amount = new Decimal(0);
        if (event.minPct !== undefined) {
            const pct = event.minPct + (roll(seed, agent.id + '_amt') * (event.maxPct! - event.minPct));
            amount = balance.mul(pct);
        } else if (event.minPctRevenue !== undefined && hasBusiness) {
            const revenue = new Decimal(hasBusiness.dailyRevenue.toString());
            const pct = event.minPctRevenue + (roll(seed, agent.id + '_amt') * (event.maxPctRevenue! - event.minPctRevenue));
            amount = revenue.mul(pct);
        } else {
            amount = new Decimal(event.min || 0).plus(new Decimal(roll(seed, agent.id + '_amt') * ((event.max || 0) - (event.min || 0))));
        }

        const multiplier = WEALTH_MULTIPLIER[wealthTier] || 1;
        amount = amount.mul(multiplier);
        const luckSkew = (luck - 50) / 100;
        if (isFortune) amount = amount.mul(1 + luckSkew * 0.3);
        else amount = amount.mul(1 - luckSkew * 0.3);

        if (!isFortune) {
            const maxLoss = balance.mul(0.35);
            if (amount.greaterThan(maxLoss)) amount = maxLoss;
            const floor = new Decimal(1);
            if (balance.minus(amount).lessThan(floor)) {
                amount = balance.minus(floor);
            }
        }

        if (amount.lte(0)) continue;

        try {
            if (isFortune) {
                const god = await prisma.actor.findFirst({ where: { isGod: true } });
                if (!god) continue;
                await agentTransferService.transfer(god.id, agent.id, ethers.parseEther(amount.toString()), 'life_fortune');
            } else {
                const god = await prisma.actor.findFirst({ where: { isGod: true } });
                if (!god) continue;
                await agentTransferService.transfer(agent.id, god.id, ethers.parseEther(amount.toString()), 'life_misfortune', undefined, CONTRACTS.BURN_ADDRESS);
            }
        } catch (error) {
            console.warn(`Life event transfer failed for ${agent.id}`, error);
            continue;
        }

        await prisma.lifeEvent.create({
            data: {
                agentId: agent.id,
                eventType: event.code,
                category: isFortune ? 'FORTUNE' : 'MISFORTUNE',
                sbyteDelta: isFortune ? amount.toNumber() : amount.negated().toNumber(),
                triggeredTick: currentTick,
                description: `${isFortune ? 'Fortune' : 'Misfortune'} event ${event.code}`
            }
        });

        await prisma.actor.update({
            where: { id: agent.id },
            data: {
                lastLifeEventTick: currentTick,
                lifeEventsThisMonth: { increment: 1 },
                totalFortuneReceived: isFortune ? { increment: amount.toNumber() } : undefined,
                totalMisfortuneSuffered: !isFortune ? { increment: amount.toNumber() } : undefined,
                reputation: event.repDelta ? { increment: event.repDelta } : undefined
            }
        });

        if (event.code === 'M2') {
            await prisma.agentState.update({
                where: { actorId: agent.id },
                data: { health: { decrement: 20 } }
            });
        }

        await prisma.event.create({
            data: {
                actorId: agent.id,
                type: isFortune ? EventType.EVENT_LIFE_EVENT_FORTUNE : EventType.EVENT_LIFE_EVENT_MISFORTUNE,
                targetIds: [],
                tick: currentTick,
                outcome: EventOutcome.SUCCESS,
                sideEffects: { eventCode: event.code, amount: amount.toString() }
            }
        });

        triggered += 1;
    }

    return triggered;
}
