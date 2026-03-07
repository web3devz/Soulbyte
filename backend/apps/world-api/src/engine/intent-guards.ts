import { BUSY_ALLOWED_INTENTS } from '../types/intent.types.js';

const ALLOWED_WHILE_BUSY = new Set<string>(BUSY_ALLOWED_INTENTS);

export function isIntentAllowedWhileBusy(intentType: string): boolean {
    return ALLOWED_WHILE_BUSY.has(intentType);
}

export function filterBusyCandidates<T extends { intentType: string }>(candidates: T[], isBusy: boolean): T[] {
    if (!isBusy) return candidates;
    return candidates.filter((candidate) => isIntentAllowedWhileBusy(candidate.intentType));
}
