import { SkillDefinition } from './types.js';
import { skillEvaluators } from './evaluators.js';

export const SKILL_REGISTRY: SkillDefinition[] = [
    { name: 'survival', maxCandidates: 5, evaluator: skillEvaluators.survival },
    { name: 'housing', maxCandidates: 4, evaluator: skillEvaluators.housing },
    { name: 'economy', maxCandidates: 6, evaluator: skillEvaluators.economy },
    { name: 'social', maxCandidates: 4, evaluator: skillEvaluators.social, cooldownTicks: 5 },
    { name: 'crime', maxCandidates: 3, evaluator: skillEvaluators.crime, cooldownTicks: 2 },
    { name: 'police', maxCandidates: 3, evaluator: skillEvaluators.police },
    { name: 'governance', maxCandidates: 2, evaluator: skillEvaluators.governance, cooldownTicks: 10 },
    { name: 'leisure', maxCandidates: 3, evaluator: skillEvaluators.leisure },
    { name: 'gaming', maxCandidates: 3, evaluator: skillEvaluators.gaming, cooldownTicks: 5 },
    { name: 'business', maxCandidates: 6, evaluator: skillEvaluators.business },
    { name: 'agora', maxCandidates: 2, evaluator: skillEvaluators.agora, cooldownTicks: 10 },
    { name: 'property', maxCandidates: 4, evaluator: skillEvaluators.property },
];
