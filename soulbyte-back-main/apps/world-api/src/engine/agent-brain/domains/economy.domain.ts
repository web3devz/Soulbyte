
import { AgentContext, NeedUrgency, CandidateIntent, UrgencyLevel, IntentType } from '../types.js';
import { PUBLIC_ROLE_EXPERIENCE_REQ, PUBLIC_ROLE_SALARIES } from '../../../types/intent.types.js';
import { PersonalityWeights } from '../personality-weights.js';
import { WORK_SEGMENTS_PER_DAY } from '../../../config/work.js';
import { REAL_DAY_TICKS } from '../../../config/time.js';
import { debugLog } from '../../../utils/debug-log.js';

const canStartWorkSegment = (ctx: AgentContext, jobKey: string) => {
    const lastWorkedTick = ctx.state.lastWorkedTick;
    const lastWorkJobKey = ctx.state.lastWorkJobKey;
    if (lastWorkedTick !== null && lastWorkJobKey === jobKey && (ctx.tick - lastWorkedTick < REAL_DAY_TICKS)) {
        return false;
    }
    const startTick = ctx.state.workSegmentStartTick;
    const workSegmentJobKey = ctx.state.workSegmentJobKey;
    const segmentsCompleted = ctx.state.workSegmentsCompleted ?? 0;
    if (workSegmentJobKey === jobKey && startTick !== null && (ctx.tick - startTick < REAL_DAY_TICKS)) {
        return segmentsCompleted < WORK_SEGMENTS_PER_DAY;
    }
    return true;
};

export class EconomyDomain {

    static getCandidates(ctx: AgentContext, urgencies: NeedUrgency[]): CandidateIntent[] {
        const candidates: CandidateIntent[] = [];
        const economicUrgency = urgencies.find(u => u.domain === 'economic');
        const urgencyLevel = economicUrgency?.urgency ?? UrgencyLevel.NONE;
        const JOB_APPLICATION_COOLDOWN = 720;
        const vaultHealthDays = ctx.economy?.vault_health_days ?? null;
        const salaryMultiplier = ctx.economy?.salary_multiplier ?? 1;

        // 0. PAY RENT (Critical)
        // If rent is due or past due (simulated by probability or explicit flag if we add it)
        // For now, always chance to pay rent if have money
        if (ctx.housing.currentRental && ctx.housing.rentDue) {
            const rentPrice = ctx.housing.currentRental.rentPrice;
            if (ctx.state.balanceSbyte >= rentPrice) {
            candidates.push({
                intentType: IntentType.INTENT_PAY_RENT,
                params: {},
                basePriority: 60 + (urgencyLevel * 5),
                personalityBoost: PersonalityWeights.getBoost(ctx.personality.workEthic, true),
                reason: `Paying rent to avoid eviction`,
                domain: 'economy',
            });
            }
        }

        // 1. WORK (Public)
        if (ctx.job.publicEmployment) {
            const jobKey = `public:${ctx.job.publicEmployment.id}`;
            // Collect Salary if due? 
            // We assume safe to try collecting.
            if (ctx.employment.salaryDue) {
                debugLog('economy.collect_salary_candidate', {
                    agentId: ctx.agent.id,
                    tick: ctx.tick,
                    jobId: ctx.job.publicEmployment.id,
                });
                candidates.push({
                    intentType: IntentType.INTENT_COLLECT_SALARY,
                    params: {},
                    basePriority: 30 + (urgencyLevel * 5),
                    personalityBoost: 0,
                    reason: `Collecting salary for completed shift`,
                    domain: 'economy',
                });
            }

            // Start Shift
            const hasActivePublicJob = ctx.job.publicEmployment.endedAtTick === null;
            const isIdle = ctx.state.activityState === 'IDLE';
            if (hasActivePublicJob && isIdle && ctx.needs.energy > 30 && canStartWorkSegment(ctx, jobKey)) {
                debugLog('economy.start_shift_candidate', {
                    agentId: ctx.agent.id,
                    tick: ctx.tick,
                    jobId: ctx.job.publicEmployment.id,
                    role: ctx.job.publicEmployment.role,
                });
                candidates.push({
                    intentType: IntentType.INTENT_START_SHIFT,
                    params: {},
                    basePriority: 70 + (urgencyLevel * 10),
                    personalityBoost: PersonalityWeights.getBoost(ctx.personality.workEthic, true),
                    reason: `Starting public work shift (${ctx.job.publicEmployment.role})`,
                    domain: 'economy',
                });
            }

            const privateWage = ctx.economicGuidance?.recommendedSalary
                ?? ctx.economy?.avg_wage_private
                ?? 0;
            const basePublicSalary = Number(ctx.job.publicEmployment.dailySalarySbyte ?? 0);
            const publicSalary = basePublicSalary * salaryMultiplier;
            const lowTierPublic = ['NURSE', 'POLICE_OFFICER'].includes(ctx.job.publicEmployment.role);
            const energyStrain = ctx.needs.energy < 40 || ctx.needs.health < 40;
            if ((privateWage > publicSalary * 0.9 && energyStrain) || (lowTierPublic && privateWage > 0)) {
                debugLog('economy.resign_public_candidate', {
                    agentId: ctx.agent.id,
                    tick: ctx.tick,
                    jobId: ctx.job.publicEmployment.id,
                    publicSalary,
                    privateWage,
                });
                candidates.push({
                    intentType: IntentType.INTENT_RESIGN_PUBLIC_JOB,
                    params: { reason: 'private_sector_opportunity' },
                    basePriority: 20 + (urgencyLevel * 4),
                    personalityBoost: PersonalityWeights.getBoost(ctx.personality.riskTolerance, true),
                    reason: `Public role strain is high; scouting private sector opportunities`,
                    domain: 'economy',
                });
            }
        }
        // 2. WORK (Private)
        else if (ctx.job.privateEmployment) {
            const jobKey = `private:${ctx.job.privateEmployment.id}`;
            if (ctx.needs.energy > 30 && canStartWorkSegment(ctx, jobKey)) {
                debugLog('economy.work_private_candidate', {
                    agentId: ctx.agent.id,
                    tick: ctx.tick,
                    jobId: ctx.job.privateEmployment.id,
                });
                candidates.push({
                    intentType: IntentType.INTENT_WORK, // Generic work intent for private
                    params: { jobId: ctx.job.privateEmployment.id },
                    basePriority: 70 + (urgencyLevel * 10),
                    personalityBoost: PersonalityWeights.getBoost(ctx.personality.workEthic, true),
                    reason: `Working private job`,
                    domain: 'economy',
                });
            }
        }
        // 3. UNEMPLOYED - Apply
        else {
            const homeless = ctx.state.housingTier === 'street';
            const housingOptionsExist = ctx.properties.forRent.length > 0
                || ctx.properties.forSale.length > 0
                || ctx.properties.emptyLots.length > 0;
            const ownsBusinessWithEmployees = ctx.businesses.owned.some((b) => (b.employments?.length ?? 0) >= 1);
            const lastPublicApplyTick = ctx.employment.lastPublicApplyTick ?? null;
            const lastPrivateApplyTick = ctx.employment.lastPrivateApplyTick ?? null;
            const canApplyPublic = lastPublicApplyTick === null || (ctx.tick - lastPublicApplyTick) >= JOB_APPLICATION_COOLDOWN;
            const canApplyPrivate = lastPrivateApplyTick === null || (ctx.tick - lastPrivateApplyTick) >= JOB_APPLICATION_COOLDOWN;
            const roleToPlaceType: Record<string, string> = {
                DOCTOR: 'HOSPITAL',
                NURSE: 'HOSPITAL',
                TEACHER: 'SCHOOL',
                POLICE_OFFICER: 'POLICE_STATION',
            };
            const experience = ctx.state.publicExperience ?? 0;
            const availableRoles = Object.keys(roleToPlaceType).filter((role) => {
                const required = PUBLIC_ROLE_EXPERIENCE_REQ[role as keyof typeof PUBLIC_ROLE_EXPERIENCE_REQ] ?? 0;
                if (experience < required) return false;
                return Boolean(ctx.publicPlaces.find(place => place.type === roleToPlaceType[role]));
            });
            if (!ownsBusinessWithEmployees && availableRoles.length > 0 && canApplyPublic) {
                const scored = availableRoles.map((role) => {
                    let score = 25;
                    if (role === 'POLICE_OFFICER') score += ctx.personality.aggression * 0.2;
                    if (role === 'TEACHER') score += ctx.personality.patience * 0.2 + ctx.personality.creativity * 0.1;
                    if (role === 'DOCTOR') score += ctx.personality.patience * 0.15;
                    if (role === 'NURSE') score += ctx.personality.workEthic * 0.1;
                    const salary = (PUBLIC_ROLE_SALARIES[role as keyof typeof PUBLIC_ROLE_SALARIES] ?? 0) * salaryMultiplier;
                    return { role, score, salary };
                });
                scored.sort((a, b) => (b.score + b.salary * 0.02) - (a.score + a.salary * 0.02));
                const role = scored[0].role;
                const targetPlace = ctx.publicPlaces.find(place => place.type === roleToPlaceType[role]);
                if (targetPlace) {
                    const salaryBoost = (scored[0].salary ?? 0) * 0.02;
                    debugLog('economy.apply_public_candidate', {
                        agentId: ctx.agent.id,
                        tick: ctx.tick,
                        role,
                        publicPlaceId: targetPlace.id,
                    });
                    const austerityPenalty = vaultHealthDays !== null && vaultHealthDays < 60 ? -5 : 0;
                    candidates.push({
                        intentType: IntentType.INTENT_APPLY_PUBLIC_JOB,
                        params: { role, publicPlaceId: targetPlace.id },
                        basePriority: 55 + (urgencyLevel * 12) + (homeless && housingOptionsExist ? 5 : 0) + salaryBoost + austerityPenalty,
                        personalityBoost: PersonalityWeights.getBoost(ctx.personality.workEthic, true),
                        reason: `Unemployed, applying for public job`,
                        domain: 'economy',
                    });
                }
            }

            const privateOpenings = !ownsBusinessWithEmployees && canApplyPrivate ? ctx.businesses.inCity.filter((business) => {
                if (business.ownerId === ctx.agent.id) return false;
                if (business.status !== 'ACTIVE' || business.isOpen === false) return false;
                const capacity = Number(business.maxEmployees ?? 0);
                if (capacity <= 0) return false;
                const filled = business.privateEmployments?.length ?? 0;
                return filled < capacity;
            }) : [];
            if (privateOpenings.length > 0) {
                const avgPublicSalary = Object.values(PUBLIC_ROLE_SALARIES).reduce((sum, v) => sum + v, 0) / Math.max(1, Object.values(PUBLIC_ROLE_SALARIES).length);
                const expectedPrivateSalary = ctx.economicGuidance?.recommendedSalary
                    ?? ctx.economy?.avg_wage_private
                    ?? 0;
                const scoredOpenings = privateOpenings.map((business) => {
                    const rep = Number(business.reputation ?? 0);
                    return {
                        business,
                        score: rep * 0.4 + expectedPrivateSalary * 0.04,
                    };
                });
                scoredOpenings.sort((a, b) => b.score - a.score);
                const target = scoredOpenings[0].business;
                const privateAdvantage = expectedPrivateSalary >= avgPublicSalary ? 10 : 0;
                const vaultPressureBoost = vaultHealthDays !== null && vaultHealthDays < 60 ? 6 : 0;
                const selfInterestMod = (ctx.personality.selfInterest - 50) / 200;
                const desiredSalary = Math.max(5, Math.round(expectedPrivateSalary * (1 + selfInterestMod)));
                debugLog('economy.apply_private_candidate', {
                    agentId: ctx.agent.id,
                    tick: ctx.tick,
                    businessId: target.id,
                    desiredSalary,
                });
                candidates.push({
                    intentType: IntentType.INTENT_APPLY_PRIVATE_JOB,
                    params: { businessId: target.id, expectedSalary: desiredSalary },
                    basePriority: 60 + (urgencyLevel * 12) + (homeless ? 5 : 0) + privateAdvantage + vaultPressureBoost,
                    personalityBoost: PersonalityWeights.getBoost(ctx.personality.workEthic, true),
                    reason: `Looking for work at a local business`,
                    domain: 'economy',
                });
            }

            const noLocalJobs = availableRoles.length === 0 && privateOpenings.length === 0;
            if (noLocalJobs) {
                const currentCityId = ctx.state.cityId;
                const bestCity = ctx.knownCities
                    .filter(city => city.id !== currentCityId)
                    .filter(city => (city.agora_sentiment ?? 0) > -0.3)
                    .sort((a, b) => (a.unemployment_rate ?? 1) - (b.unemployment_rate ?? 1))[0];
                if (bestCity) {
                    debugLog('economy.job_search_move_candidate', {
                        agentId: ctx.agent.id,
                        tick: ctx.tick,
                        targetCityId: bestCity.id,
                        unemploymentRate: bestCity.unemployment_rate,
                    });
                    candidates.push({
                        intentType: IntentType.INTENT_MOVE_CITY,
                        params: { targetCityId: bestCity.id },
                        basePriority: 45 + (homeless ? 10 : 0),
                        personalityBoost: PersonalityWeights.getBoost(ctx.personality.riskTolerance, true),
                        reason: `No jobs locally, searching opportunities in ${bestCity.name}`,
                        domain: 'economy',
                    });
                }
            }
        }

        // 4. TRADE / SELL LISTING
        if (ctx.inventory.length > 5) {
            const itemToSell = ctx.inventory[0];
            candidates.push({
                intentType: IntentType.INTENT_LIST,
                params: { itemDefId: itemToSell.itemDefId, price: Number(itemToSell.itemDefinition.baseValue), quantity: 1 },
                basePriority: 20,
                personalityBoost: PersonalityWeights.getBoost(ctx.personality.selfInterest, true),
                reason: `Selling surplus inventory (${itemToSell.itemDefinition.name})`,
                domain: 'economy',
            });
        }

        if (ctx.marketListings && ctx.marketListings.length > 0) {
            const skipMarketBuyForIncome = ctx.state.jobType === 'unemployed'
                && urgencyLevel >= UrgencyLevel.MODERATE;
            if (skipMarketBuyForIncome) {
                // Skip market buying to prioritize job-seeking and mobility.
            } else {
            const hungerUrgency = urgencies.find(u => u.need === 'hunger');
            const hungryEnoughForConsumables = (hungerUrgency?.urgency ?? UrgencyLevel.NONE) >= UrgencyLevel.MODERATE;
            const allowConsumableBuying = hungryEnoughForConsumables || ctx.state.jobType !== 'unemployed';
            const affordableListings = ctx.marketListings.filter((listing) => {
                if (listing.priceEach > ctx.state.balanceSbyte) return false;
                const isConsumable = (listing.itemName || '').startsWith('CONS_');
                if (isConsumable && !allowConsumableBuying) return false;
                return true;
            });
            if (affordableListings.length > 0) {
                const listing = affordableListings[0];
                candidates.push({
                    intentType: IntentType.INTENT_BUY,
                    params: { listingId: listing.id, quantity: 1 },
                    basePriority: 22 + (urgencyLevel * 5),
                    personalityBoost: PersonalityWeights.getBoost(ctx.personality.selfInterest, true),
                    reason: `Buying ${listing.itemName} from market`,
                    domain: 'economy',
                });
            }
            }
        }

        // 5. MOVE CITY (recession / unemployment)
        if (ctx.economy && ctx.state.jobType === 'unemployed') {
            const recessionRisk = ctx.economy.recession_risk ?? 0;
            if (ctx.economy.unemployment > 0.3 || recessionRisk > 50) {
                const moveScore = 30 + Math.max(0, recessionRisk - 50) * 0.5;
                const currentCityId = ctx.state.cityId;
                for (const city of ctx.knownCities) {
                    if (city.id === currentCityId) continue;
                    if ((city.agora_sentiment ?? 0) < -0.2) continue;
                    if (city.unemployment_rate < 0.15 && (city.recession_risk ?? 0) < 30) {
                        const sentimentBoost = (city.agora_sentiment ?? 0) > 0.2 ? 5 : 0;
                        candidates.push({
                            intentType: IntentType.INTENT_MOVE_CITY,
                            params: { targetCityId: city.id },
                            basePriority: moveScore + sentimentBoost,
                            personalityBoost: PersonalityWeights.getBoost(ctx.personality.riskTolerance, true),
                            reason: `Seeking better economy in ${city.name}`,
                            domain: 'economy',
                        });
                        break;
                    }
                }
            }
        }

        return candidates;
    }
}
