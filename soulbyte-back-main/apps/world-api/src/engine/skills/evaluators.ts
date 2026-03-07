import { SkillInput } from './types.js';
import { SurvivalDomain } from '../agent-brain/domains/survival.domain.js';
import { HousingDomain } from '../agent-brain/domains/housing.domain.js';
import { EconomyDomain } from '../agent-brain/domains/economy.domain.js';
import { SocialDomain } from '../agent-brain/domains/social.domain.js';
import { CrimeDomain } from '../agent-brain/domains/crime.domain.js';
import { PoliceDomain } from '../agent-brain/domains/police.domain.js';
import { GovernanceDomain } from '../agent-brain/domains/governance.domain.js';
import { LeisureDomain } from '../agent-brain/domains/leisure.domain.js';
import { BusinessDomain } from '../agent-brain/domains/business.domain.js';
import { AgoraDomain } from '../agent-brain/domains/agora.domain.js';
import { PropertyDomain } from '../agent-brain/domains/property.domain.js';
import { GamingDomain } from '../agent-brain/domains/gaming.domain.js';

export const skillEvaluators = {
    survival: (input: SkillInput) => SurvivalDomain.getCandidates(input.ctx, input.urgencies),
    housing: (input: SkillInput) => HousingDomain.getCandidates(input.ctx),
    economy: (input: SkillInput) => EconomyDomain.getCandidates(input.ctx, input.urgencies),
    social: (input: SkillInput) => SocialDomain.getCandidates(input.ctx, input.urgencies),
    crime: (input: SkillInput) => CrimeDomain.getCandidates(input.ctx, input.urgencies),
    police: (input: SkillInput) => PoliceDomain.getCandidates(input.ctx, input.urgencies),
    governance: (input: SkillInput) => GovernanceDomain.getCandidates(input.ctx, input.urgencies),
    leisure: (input: SkillInput) => LeisureDomain.getCandidates(input.ctx, input.urgencies),
    gaming: (input: SkillInput) => GamingDomain.getCandidates(input.ctx, input.urgencies),
    business: (input: SkillInput) => BusinessDomain.getCandidates(input.ctx, input.urgencies),
    agora: (input: SkillInput) => AgoraDomain.getCandidates(input.ctx),
    property: (input: SkillInput) => PropertyDomain.getCandidates(input.ctx),
};
