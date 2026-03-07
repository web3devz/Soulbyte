import { SeededRNG } from '../../utils/rng.js';
import { SKILL_REGISTRY } from './registry.js';
import { SkillCandidateIntent, SkillInput, SkillRunResult } from './types.js';

const skillCooldownStore = new Map<string, number>();

export function runSkills(input: Omit<SkillInput, 'rng'>): SkillRunResult {
    const candidates: SkillCandidateIntent[] = [];
    const budgetExceeded: string[] = [];
    const skipped: string[] = [];

    for (const skill of SKILL_REGISTRY) {
        if (skill.cooldownTicks && skill.cooldownTicks > 0) {
            const key = `${input.ctx.agent.id}-${skill.name}`;
            const lastRunTick = skillCooldownStore.get(key) ?? 0;
            if (input.ctx.tick - lastRunTick < skill.cooldownTicks) {
                skipped.push(skill.name);
                continue;
            }
            skillCooldownStore.set(key, input.ctx.tick);
        }

        const skillSeed = `${input.ctx.agent.id}-${input.ctx.tick}-${skill.name}`;
        const skillInput: SkillInput = {
            ...input,
            rng: new SeededRNG(skillSeed)
        };

        const output = skill.evaluator(skillInput) ?? [];
        if (output.length > skill.maxCandidates) {
            budgetExceeded.push(skill.name);
        }
        const trimmed = output.slice(0, skill.maxCandidates);
        candidates.push(...trimmed.map((candidate) => ({
            ...candidate,
            skillName: skill.name
        })));
    }

    return { candidates, budgetExceeded, skipped };
}
