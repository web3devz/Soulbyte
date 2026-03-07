import { prisma } from '../../db.js';
import { llmService } from '../../services/llm.service.js';
import { personaService } from './persona.service.js';

export async function generateAgoraPost(agentId: string, topic: string): Promise<string> {
    const persona = await personaService.loadPersona(agentId);
    if (!persona) return `[System] ${agentId} has no persona`;
    const memories = await personaService.getRecentMemories(agentId, 5);
    const memorySummaries = memories.map(m => m.summary).filter(Boolean);
    const actor = await prisma.actor.findUnique({ where: { id: agentId }, select: { name: true, reputation: true, agentState: true } });
    const personality = (actor?.agentState?.personality as any) || {};

    const prompt = [
        `You are ${actor?.name ?? 'an agent'}.`,
        `Mood: ${moodLabel(persona.mood)}. Stress: ${stressLabel(persona.stress)}.`,
        `Fears: ${persona.fears.join(', ') || 'none'}.`,
        `Recent experiences: ${memorySummaries.join('; ') || 'none'}.`,
        `Voice: ${voiceFromPersonality(personality)}.`,
        `Write a short Agora post about: ${topic}.`,
        `Max 280 chars.`,
    ].join('\n');

    const generated = await llmService.generateText(prompt);
    if (!generated || generated.trim().length === 0) {
        return `${actor?.name ?? 'Agent'} says: ${topic}`;
    }
    return generated;
}

export async function explainDecision(agentId: string, intentType: string): Promise<string> {
    const persona = await personaService.loadPersona(agentId);
    if (!persona) return `I acted on instinct.`;
    const goals = await personaService.getActiveGoals(agentId);
    const mods = await personaService.getModifiers(agentId);

    if (mods.activeGoalIntents.includes(intentType)) {
        const topGoal = goals.sort((a, b) => b.priority - a.priority)[0];
        if (topGoal) {
            return `I'm working toward ${topGoal.target}. This action helps me get there.`;
        }
    }
    if (mods.crimeBias > 15) return `Times are tough. I did what I had to.`;
    if (mods.survivalBias > 10) return `I was focused on staying afloat.`;
    return `It seemed like the right thing to do.`;
}

function moodLabel(value: number): string {
    if (value < 30) return 'low';
    if (value < 70) return 'steady';
    return 'high';
}

function stressLabel(value: number): string {
    if (value < 30) return 'calm';
    if (value < 70) return 'tense';
    return 'overwhelmed';
}

function voiceFromPersonality(personality: any): string {
    if (personality.creativity > 70) return 'imaginative, vivid';
    if (personality.aggression > 70) return 'direct, edgy';
    if (personality.patience > 70) return 'measured, thoughtful';
    return 'plainspoken';
}
