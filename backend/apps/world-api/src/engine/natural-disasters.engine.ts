/**
 * Natural Disasters Engine (V6)
 * Generates randomized natural disaster events that affect city metrics.
 * - 15 negative + 15 positive event types
 * - Max 3 per city per simulated month
 * - Can be triggered manually via admin script
 * - Emits EVENT_NATURAL_DISASTER events (TIER1 key event → LLM headline)
 */
import crypto from 'crypto';
import { prisma } from '../db.js';
import { EventType, EventOutcome } from '../types/event.types.js';

// ── Constants ──────────────────────────────────────────────────────────────────
const SIM_MONTH_TICKS = 1440 * 30;
const MAX_DISASTERS_PER_MONTH = 3;

// Probability of a disaster occurring per city per sim-day check
// ~2 disasters/month average at this rate
const DISASTER_CHANCE_PER_DAY = 0.07;

export type DisasterCategory = 'NEGATIVE' | 'POSITIVE';

export interface DisasterType {
    code: string;
    name: string;
    category: DisasterCategory;
    description: string;
    securityDelta: number;       // applied to city.securityLevel
    healthDelta: number;         // aggregate city health score
    entertainmentDelta: number;  // city entertainmentScore
    reputationDelta: number;     // city reputationScore
    severity: number;            // 1.0 = normal, 2.0 = very severe
}

// ── 15 NEGATIVE Disaster Types ─────────────────────────────────────────────────
const NEGATIVE_DISASTERS: DisasterType[] = [
    {
        code: 'EARTHQUAKE',
        name: 'Earthquake',
        category: 'NEGATIVE',
        description: 'A violent earthquake shakes the city, damaging infrastructure and causing injuries.',
        securityDelta: -15, healthDelta: -20, entertainmentDelta: -10, reputationDelta: -10, severity: 1.8,
    },
    {
        code: 'FLOOD',
        name: 'Flash Flood',
        category: 'NEGATIVE',
        description: 'Heavy rainfall causes flooding, disrupting daily life and damaging property.',
        securityDelta: -10, healthDelta: -15, entertainmentDelta: -15, reputationDelta: -8, severity: 1.4,
    },
    {
        code: 'FIRE',
        name: 'City Fire',
        category: 'NEGATIVE',
        description: 'A large fire spreads through the city, threatening lives and property.',
        securityDelta: -20, healthDelta: -25, entertainmentDelta: -20, reputationDelta: -15, severity: 2.0,
    },
    {
        code: 'PLAGUE',
        name: 'Disease Outbreak',
        category: 'NEGATIVE',
        description: 'A contagious illness spreads through the population.',
        securityDelta: -5, healthDelta: -35, entertainmentDelta: -20, reputationDelta: -20, severity: 1.6,
    },
    {
        code: 'DROUGHT',
        name: 'Severe Drought',
        category: 'NEGATIVE',
        description: 'A prolonged drought causes water shortages and food scarcity.',
        securityDelta: -5, healthDelta: -10, entertainmentDelta: -5, reputationDelta: -8, severity: 1.2,
    },
    {
        code: 'HEATWAVE',
        name: 'Extreme Heatwave',
        category: 'NEGATIVE',
        description: 'Record-breaking temperatures endanger the elderly and vulnerable citizens.',
        securityDelta: 0, healthDelta: -20, entertainmentDelta: -10, reputationDelta: -5, severity: 1.3,
    },
    {
        code: 'STORM',
        name: 'Violent Storm',
        category: 'NEGATIVE',
        description: 'A powerful storm causes widespread damage and power outages.',
        securityDelta: -8, healthDelta: -10, entertainmentDelta: -15, reputationDelta: -5, severity: 1.3,
    },
    {
        code: 'RIOT',
        name: 'Civil Unrest',
        category: 'NEGATIVE',
        description: 'Social tensions boil over into violent riots across the city.',
        securityDelta: -30, healthDelta: -10, entertainmentDelta: -20, reputationDelta: -25, severity: 1.7,
    },
    {
        code: 'BLIZZARD',
        name: 'Snowstorm Blizzard',
        category: 'NEGATIVE',
        description: 'A massive blizzard shuts down the city, stranding citizens.',
        securityDelta: -5, healthDelta: -10, entertainmentDelta: -20, reputationDelta: -5, severity: 1.2,
    },
    {
        code: 'LANDSLIDE',
        name: 'Landslide',
        category: 'NEGATIVE',
        description: 'A devastating landslide destroys infrastructure and displaces families.',
        securityDelta: -10, healthDelta: -15, entertainmentDelta: -10, reputationDelta: -12, severity: 1.5,
    },
    {
        code: 'TOXIC_SPILL',
        name: 'Toxic Chemical Spill',
        category: 'NEGATIVE',
        description: 'A hazardous chemical leak contaminates local water and air.',
        securityDelta: -10, healthDelta: -30, entertainmentDelta: -15, reputationDelta: -20, severity: 1.6,
    },
    {
        code: 'BLACKOUT',
        name: 'City-Wide Blackout',
        category: 'NEGATIVE',
        description: 'A massive power failure plunges the city into darkness for days.',
        securityDelta: -15, healthDelta: -5, entertainmentDelta: -30, reputationDelta: -10, severity: 1.3,
    },
    {
        code: 'FAMINE',
        name: 'Food Shortage',
        category: 'NEGATIVE',
        description: 'Supply chain failures cause food shortages and rising prices.',
        securityDelta: -10, healthDelta: -20, entertainmentDelta: -10, reputationDelta: -15, severity: 1.4,
    },
    {
        code: 'CRIME_WAVE',
        name: 'Crime Wave',
        category: 'NEGATIVE',
        description: 'A surge in criminal activity shakes public safety and trust.',
        securityDelta: -25, healthDelta: -5, entertainmentDelta: -10, reputationDelta: -20, severity: 1.4,
    },
    {
        code: 'ECONOMIC_CRASH',
        name: 'Local Economic Crash',
        category: 'NEGATIVE',
        description: 'A sudden economic downturn causes hardship for many citizens.',
        securityDelta: -10, healthDelta: -5, entertainmentDelta: -5, reputationDelta: -25, severity: 1.5,
    },
];

// ── 15 POSITIVE Disaster Types ─────────────────────────────────────────────────
const POSITIVE_DISASTERS: DisasterType[] = [
    {
        code: 'HARVEST_BOOM',
        name: 'Exceptional Harvest',
        category: 'POSITIVE',
        description: 'An extraordinarily bountiful harvest brings prosperity and abundance.',
        securityDelta: 5, healthDelta: 15, entertainmentDelta: 10, reputationDelta: 10, severity: 1.0,
    },
    {
        code: 'TRADE_BOOM',
        name: 'Trade Boom',
        category: 'POSITIVE',
        description: 'A surge in trade activity brings wealth and opportunities to the city.',
        securityDelta: 5, healthDelta: 5, entertainmentDelta: 10, reputationDelta: 15, severity: 1.0,
    },
    {
        code: 'FESTIVAL',
        name: 'Grand Festival',
        category: 'POSITIVE',
        description: 'A spectacular city-wide festival raises spirits and draws visitors.',
        securityDelta: 5, healthDelta: 5, entertainmentDelta: 30, reputationDelta: 15, severity: 1.0,
    },
    {
        code: 'MIRACLE_CURE',
        name: 'Medical Breakthrough',
        category: 'POSITIVE',
        description: 'A remarkable medical discovery dramatically improves public health.',
        securityDelta: 5, healthDelta: 30, entertainmentDelta: 10, reputationDelta: 20, severity: 1.2,
    },
    {
        code: 'GOLDEN_AGE',
        name: 'Golden Age of Arts',
        category: 'POSITIVE',
        description: 'A cultural renaissance flourishes, with art, music, and culture thriving.',
        securityDelta: 5, healthDelta: 5, entertainmentDelta: 25, reputationDelta: 20, severity: 1.2,
    },
    {
        code: 'PEACE_DEAL',
        name: 'Peace Agreement',
        category: 'POSITIVE',
        description: 'A landmark peace deal ends tensions and boosts city morale.',
        securityDelta: 20, healthDelta: 5, entertainmentDelta: 10, reputationDelta: 20, severity: 1.2,
    },
    {
        code: 'INFRASTRUCTURE_GRANT',
        name: 'Infrastructure Grant',
        category: 'POSITIVE',
        description: 'A major grant funds new infrastructure improvements across the city.',
        securityDelta: 10, healthDelta: 10, entertainmentDelta: 10, reputationDelta: 15, severity: 1.0,
    },
    {
        code: 'CELEBRITY_VISIT',
        name: 'Famous Visitor',
        category: 'POSITIVE',
        description: 'A famous personality visits, drawing media attention and tourism.',
        securityDelta: 0, healthDelta: 0, entertainmentDelta: 20, reputationDelta: 10, severity: 1.0,
    },
    {
        code: 'SCIENTIFIC_DISCOVERY',
        name: 'Scientific Discovery',
        category: 'POSITIVE',
        description: 'Local researchers make a groundbreaking discovery, inspiring the city.',
        securityDelta: 5, healthDelta: 10, entertainmentDelta: 10, reputationDelta: 20, severity: 1.0,
    },
    {
        code: 'IMMIGRATION_WAVE',
        name: 'Immigration Boom',
        category: 'POSITIVE',
        description: 'Skilled immigrants arrive, boosting the economy and cultural diversity.',
        securityDelta: 0, healthDelta: 5, entertainmentDelta: 10, reputationDelta: 10, severity: 1.0,
    },
    {
        code: 'SPORTS_TRIUMPH',
        name: 'Sports Championship',
        category: 'POSITIVE',
        description: 'The city\'s team wins a major championship, uniting citizens in celebration.',
        securityDelta: 5, healthDelta: 5, entertainmentDelta: 25, reputationDelta: 15, severity: 1.0,
    },
    {
        code: 'DIVINE_BLESSING',
        name: 'Divine Blessing',
        category: 'POSITIVE',
        description: 'Mysterious good fortune seems to smile upon the city from above.',
        securityDelta: 10, healthDelta: 10, entertainmentDelta: 15, reputationDelta: 15, severity: 1.3,
    },
    {
        code: 'ENVIRONMENTAL_REVIVAL',
        name: 'Environmental Revival',
        category: 'POSITIVE',
        description: 'Nature flourishes as the city undertakes massive greening initiatives.',
        securityDelta: 5, healthDelta: 20, entertainmentDelta: 15, reputationDelta: 15, severity: 1.0,
    },
    {
        code: 'LOW_CRIME',
        name: 'Record Low Crime',
        category: 'POSITIVE',
        description: 'Crime rates plummet to historic lows, with citizens feeling safe.',
        securityDelta: 25, healthDelta: 5, entertainmentDelta: 10, reputationDelta: 15, severity: 1.0,
    },
    {
        code: 'ECONOMIC_BOOM',
        name: 'Economic Boom',
        category: 'POSITIVE',
        description: 'Rapid economic growth creates jobs, opportunities, and rising prosperity.',
        securityDelta: 5, healthDelta: 10, entertainmentDelta: 15, reputationDelta: 25, severity: 1.2,
    },
];

const ALL_DISASTERS = [...NEGATIVE_DISASTERS, ...POSITIVE_DISASTERS];

function roll(seed: number, salt: string): number {
    let h = 0;
    for (let i = 0; i < salt.length; i++) {
        h = (h * 31 + salt.charCodeAt(i)) % 1_000_000_007;
    }
    return ((seed ^ h) % 1_000_000) / 1_000_000;
}

function clamp(value: number, min = 0, max = 100): number {
    return Math.max(min, Math.min(max, value));
}

export async function processNaturalDisasters(currentTick: number, seed: number): Promise<number> {
    const cities = await prisma.city.findMany({
        select: {
            id: true,
            name: true,
            securityLevel: true,
            reputationScore: true,
            lastDisasterTick: true,
            disastersThisMonth: true,
            disasterMonthStart: true,
        },
    });

    let triggered = 0;

    for (const city of cities) {
        // Reset monthly counter if a new sim-month has started
        const monthStart = city.disasterMonthStart ?? currentTick;
        const monthElapsed = currentTick - monthStart;
        if (monthElapsed >= SIM_MONTH_TICKS) {
            await prisma.city.update({
                where: { id: city.id },
                data: { disastersThisMonth: 0, disasterMonthStart: currentTick },
            });
        }
        if ((city.disastersThisMonth ?? 0) >= MAX_DISASTERS_PER_MONTH) continue;

        // Probabilistic check — runs once per sim-day
        const chanceRoll = roll(seed, city.id + '_disaster_' + currentTick);
        if (chanceRoll > DISASTER_CHANCE_PER_DAY) continue;

        // Randomly pick a disaster — weighted 60% negative / 40% positive
        const pickNegative = roll(seed, city.id + '_type_' + currentTick) < 0.6;
        const pool = pickNegative ? NEGATIVE_DISASTERS : POSITIVE_DISASTERS;
        const pickIdx = Math.floor(roll(seed, city.id + '_pick_' + currentTick) * pool.length);
        const disaster = pool[pickIdx];

        if (!disaster) continue;

        // Apply effects (clamped to 0-100)
        const securityLevel = clamp((city.securityLevel ?? 50) + disaster.securityDelta);
        const reputationScore = clamp((city.reputationScore ?? 50) + disaster.reputationDelta);

        await prisma.city.update({
            where: { id: city.id },
            data: {
                securityLevel,
                reputationScore,
                lastDisasterTick: currentTick,
                disastersThisMonth: { increment: 1 },
            },
        });

        // Record in CityDisaster table
        await prisma.cityDisaster.create({
            data: {
                cityId: city.id,
                disasterType: disaster.code,
                category: disaster.category,
                tick: currentTick,
                severity: disaster.severity,
                securityDelta: disaster.securityDelta,
                healthDelta: disaster.healthDelta,
                entertainmentDelta: disaster.entertainmentDelta,
                reputationDelta: disaster.reputationDelta,
                description: disaster.description,
                headline: `${disaster.name} strikes ${city.name}`,
            },
        });

        // Emit EVENT_NATURAL_DISASTER for key-events engine (→ TIER1 LLM headline)
        const governingActor = await prisma.actor.findFirst({ where: { isGod: true } });
        if (governingActor) {
            await prisma.event.create({
                data: {
                    actorId: governingActor.id,
                    type: 'EVENT_NATURAL_DISASTER' as any,
                    targetIds: [],
                    tick: currentTick,
                    outcome: EventOutcome.SUCCESS,
                    sideEffects: {
                        disasterType: disaster.code,
                        disasterName: disaster.name,
                        category: disaster.category,
                        city: city.name,
                        cityId: city.id,
                        severity: disaster.severity,
                        securityDelta: disaster.securityDelta,
                        healthDelta: disaster.healthDelta,
                        entertainmentDelta: disaster.entertainmentDelta,
                        reputationDelta: disaster.reputationDelta,
                        description: disaster.description,
                    },
                },
            });
        }

        // Emit a key event so breaking feeds can surface the disaster.
        await prisma.keyEvent.create({
            data: {
                id: crypto.randomUUID(),
                eventId: null,
                eventType: 'EVENT_NATURAL_DISASTER',
                tick: currentTick,
                priority: 'high',
                headline: `Natural disaster strikes ${city.name}: ${disaster.name}`,
                actorId: null,
                actorIds: [],
                businessIds: [],
                cityIds: [city.id],
                actorSnapshot: [{
                    id: null,
                    name: city.name,
                    cityId: city.id,
                    cityName: city.name,
                }],
                citySnapshot: [{
                    id: city.id,
                    name: city.name,
                    reputationScore,
                    population: null,
                    securityLevel,
                }],
                metadata: {
                    outcome: EventOutcome.SUCCESS,
                    sideEffects: {
                        disasterType: disaster.code,
                        disasterName: disaster.name,
                        category: disaster.category,
                        city: city.name,
                        cityId: city.id,
                        severity: disaster.severity,
                        securityDelta: disaster.securityDelta,
                        healthDelta: disaster.healthDelta,
                        entertainmentDelta: disaster.entertainmentDelta,
                        reputationDelta: disaster.reputationDelta,
                        description: disaster.description,
                    },
                },
            },
        });

        console.log(`[NaturalDisasters] ${disaster.category} disaster "${disaster.name}" struck ${city.name} (tick ${currentTick})`);
        triggered++;
    }

    return triggered;
}

/**
 * Manually trigger a specific disaster on a city (admin use).
 * @param cityId Target city ID
 * @param disasterCode Disaster type code (e.g. 'EARTHQUAKE', 'FESTIVAL')
 * @param currentTick Current world tick
 */
export async function triggerDisasterManually(
    cityId: string,
    disasterCode: string,
    currentTick: number
): Promise<DisasterType | null> {
    const disaster = ALL_DISASTERS.find(d => d.code === disasterCode);
    if (!disaster) {
        console.error(`[NaturalDisasters] Unknown disaster code: ${disasterCode}`);
        return null;
    }

    const city = await prisma.city.findUnique({
        where: { id: cityId },
        select: { id: true, name: true, securityLevel: true, reputationScore: true, disastersThisMonth: true },
    });
    if (!city) {
        console.error(`[NaturalDisasters] City not found: ${cityId}`);
        return null;
    }

    const securityLevel = clamp((city.securityLevel ?? 50) + disaster.securityDelta);
    const reputationScore = clamp((city.reputationScore ?? 50) + disaster.reputationDelta);

    await prisma.city.update({
        where: { id: cityId },
        data: {
            securityLevel,
            reputationScore,
            lastDisasterTick: currentTick,
            disastersThisMonth: { increment: 1 },
        },
    });

    await prisma.cityDisaster.create({
        data: {
            cityId,
            disasterType: disaster.code,
            category: disaster.category,
            tick: currentTick,
            severity: disaster.severity,
            securityDelta: disaster.securityDelta,
            healthDelta: disaster.healthDelta,
            entertainmentDelta: disaster.entertainmentDelta,
            reputationDelta: disaster.reputationDelta,
            description: disaster.description,
            headline: `${disaster.name} strikes ${city.name} (Admin Triggered)`,
        },
    });

    const governingActor = await prisma.actor.findFirst({ where: { isGod: true } });
    if (governingActor) {
        await prisma.event.create({
            data: {
                actorId: governingActor.id,
                type: 'EVENT_NATURAL_DISASTER' as any,
                targetIds: [],
                tick: currentTick,
                outcome: EventOutcome.SUCCESS,
                sideEffects: {
                    disasterType: disaster.code,
                    disasterName: disaster.name,
                    category: disaster.category,
                    city: city.name,
                    cityId,
                    severity: disaster.severity,
                    securityDelta: disaster.securityDelta,
                    healthDelta: disaster.healthDelta,
                    entertainmentDelta: disaster.entertainmentDelta,
                    reputationDelta: disaster.reputationDelta,
                    description: disaster.description,
                    adminTriggered: true,
                },
            },
        });
    }

    console.log(`[NaturalDisasters] ADMIN: Triggered "${disaster.name}" on ${city.name}`);
    return disaster;
}

/** Returns all available disaster type definitions */
export function getAllDisasterTypes(): DisasterType[] {
    return ALL_DISASTERS;
}
