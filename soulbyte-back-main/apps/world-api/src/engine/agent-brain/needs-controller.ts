
import { AgentContext, NeedUrgency, UrgencyLevel, AgentNeeds } from './types.js';
import { RENT_BY_TIER } from '../../config/economy.js';

const PUBLIC_SALARIES: Record<string, number> = {
    'NURSE': 250,
    'POLICE_OFFICER': 250,
    'TEACHER': 600,
    'DOCTOR': 1000
};

export class NeedsController {

    static evaluate(ctx: AgentContext): NeedUrgency[] {
        const urgencies: NeedUrgency[] = [];

        // --- SURVIVAL NEEDS ---
        urgencies.push(
            {
                need: 'health',
                value: ctx.needs.health,
                urgency: this.getUrgency(ctx.needs.health),
                domain: 'survival',
            },
            {
                need: 'energy',
                value: ctx.needs.energy,
                urgency: this.getEnergyUrgency(ctx.needs.energy),
                domain: 'survival',
            },
            {
                need: 'hunger',
                value: ctx.needs.hunger,
                urgency: this.getUrgency(ctx.needs.hunger),
                domain: 'survival',
            }
        );

        // --- SOCIAL NEEDS ---
        urgencies.push({
            need: 'social',
            value: ctx.needs.social,
            urgency: this.getUrgency(ctx.needs.social),
            domain: 'social',
        });

        // --- LEISURE NEEDS ---
        urgencies.push(
            {
                need: 'fun',
                value: ctx.needs.fun,
                urgency: this.getUrgency(ctx.needs.fun),
                domain: 'leisure',
            },
            {
                need: 'purpose',
                value: ctx.needs.purpose,
                urgency: this.getUrgency(ctx.needs.purpose),
                domain: 'leisure',
            }
        );

        // --- ECONOMIC URGENCY (derived, not a "need") ---
        const daysUntilBroke = this.estimateDaysUntilBroke(ctx);
        const savingsRatio = ctx.state.balanceSbyte / Math.max(1, this.estimateDailyBurn(ctx) * 30);
        if (daysUntilBroke <= 1) {
            urgencies.push({
                need: 'income',
                value: daysUntilBroke,
                urgency: UrgencyLevel.CRITICAL,
                domain: 'economic',
            });
        } else if (daysUntilBroke <= 7) {
            urgencies.push({
                need: 'income',
                value: daysUntilBroke,
                urgency: UrgencyLevel.URGENT,
                domain: 'economic',
            });
        } else if (savingsRatio < 1 || ctx.state.jobType === 'unemployed') {
            urgencies.push({
                need: 'income',
                value: savingsRatio,
                urgency: UrgencyLevel.MODERATE,
                domain: 'economic',
            });
        } else if (savingsRatio < 3) {
            urgencies.push({
                need: 'income',
                value: savingsRatio,
                urgency: UrgencyLevel.LOW,
                domain: 'economic',
            });
        }

        // Sort by urgency descending (most urgent first)
        return urgencies.sort((a, b) => b.urgency - a.urgency);
    }

    private static getUrgency(value: number): UrgencyLevel {
        if (value <= 10) return UrgencyLevel.CRITICAL;
        if (value <= 25) return UrgencyLevel.URGENT;
        if (value <= 50) return UrgencyLevel.MODERATE;
        if (value <= 75) return UrgencyLevel.LOW;
        return UrgencyLevel.NONE;
    }

    private static getEnergyUrgency(value: number): UrgencyLevel {
        if (value <= 15) return UrgencyLevel.CRITICAL;
        if (value <= 30) return UrgencyLevel.URGENT;
        if (value <= 45) return UrgencyLevel.MODERATE;
        if (value <= 65) return UrgencyLevel.LOW;
        return UrgencyLevel.NONE;
    }

    private static estimateDaysUntilBroke(ctx: AgentContext): number {
        const dailyIncome = this.estimateDailyIncome(ctx);
        const dailyBurn = this.estimateDailyBurn(ctx);
        const net = dailyIncome - dailyBurn;

        if (net >= 0) return Infinity;
        return Math.max(0, ctx.state.balanceSbyte / Math.abs(net));
    }

    private static estimateDailyIncome(ctx: AgentContext): number {
        // Public salary
        if (ctx.job.publicEmployment) {
            return PUBLIC_SALARIES[ctx.job.publicEmployment.role] ?? 0;
        }
        // Private salary
        if (ctx.job.privateEmployment) {
            return Number(ctx.job.privateEmployment.salaryDaily);
        }
        // Business income (use last period average or simply revenue)
        if (ctx.businesses.owned.length > 0) {
            return ctx.businesses.owned.reduce(
                (sum, b) => sum + (Number(b.dailyRevenue) || 0), 0
            );
        }
        return 0;
    }

    private static estimateDailyBurn(ctx: AgentContext): number {
        // Rent is the main daily cost
        const rent = RENT_BY_TIER[ctx.state.housingTier] ?? 0;
        // Rough estimate for food/needs
        const needsCost = ctx.economy?.avg_meal_price ?? 5;
        return rent + needsCost;
    }
}
