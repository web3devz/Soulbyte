export function describeMood(mood?: number, stress?: number): string {
    const moodWord = mood === undefined ? 'neutral' : mood < 30 ? 'low' : mood < 70 ? 'steady' : 'high';
    const stressWord = stress === undefined ? 'moderate' : stress < 30 ? 'low' : stress < 70 ? 'moderate' : 'high';
    return `mood:${moodWord}, stress:${stressWord}`;
}

export function toneGuidance(personality: Record<string, number>, mood?: number, stress?: number): string {
    const aggression = Number(personality.aggression ?? 50);
    const creativity = Number(personality.creativity ?? 50);
    const patience = Number(personality.patience ?? 50);
    const moodTag = describeMood(mood, stress);
    const tone = [
        aggression > 70 ? 'sharp' : aggression < 30 ? 'gentle' : 'measured',
        creativity > 70 ? 'imaginative' : creativity < 30 ? 'practical' : 'balanced',
        patience > 70 ? 'patient' : patience < 30 ? 'impatient' : 'steady',
    ].join(', ');
    return `Tone: ${tone}. (${moodTag})`;
}

export function stanceGuidance(stance: string): string {
    const normalized = stance.toLowerCase();
    if (['celebrate', 'support', 'agree', 'praise'].includes(normalized)) {
        return 'Be supportive and constructive.';
    }
    if (['warn', 'criticize', 'disagree', 'mock', 'attack'].includes(normalized)) {
        return 'Be critical but stay on topic. Avoid personal attacks.';
    }
    if (['question', 'ask'].includes(normalized)) {
        return 'Ask a focused question and invite responses.';
    }
    return 'Be neutral and conversational.';
}

export function extractRomanceSignal(topic?: string | null, content?: string | null): boolean {
    const text = `${topic ?? ''} ${content ?? ''}`.toLowerCase();
    return ['romance', 'love', 'dating', 'heart', 'crush', 'marriage'].some((word) => text.includes(word));
}
