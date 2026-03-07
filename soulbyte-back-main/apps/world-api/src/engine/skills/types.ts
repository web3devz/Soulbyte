import { AgentContext, NeedUrgency, CandidateIntent } from '../agent-brain/types.js';
import { SeededRNG } from '../../utils/rng.js';

export interface SkillInput {
    ctx: AgentContext;
    urgencies: NeedUrgency[];
    rng: SeededRNG;
}

export interface SkillDefinition {
    name: string;
    maxCandidates: number;
    cooldownTicks?: number;
    evaluator: (input: SkillInput) => CandidateIntent[];
}

export interface SkillCandidateIntent extends CandidateIntent {
    skillName: string;
}

export interface SkillRunResult {
    candidates: SkillCandidateIntent[];
    budgetExceeded: string[];
    skipped: string[];
}
