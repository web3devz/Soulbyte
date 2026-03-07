import { SIM_DAY_TICKS } from '../../config/time.js';

const AGORA_CHECKS_PER_DAY = 20;

export function getAgoraCheckIntervalTicks(): number {
    return Math.max(1, Math.floor(SIM_DAY_TICKS / AGORA_CHECKS_PER_DAY));
}

export function getAgoraCheckOffset(agentId: string, intervalTicks: number): number {
    return hashStringToInt(agentId) % Math.max(intervalTicks, 1);
}

export function shouldCheckAgora(
    tick: number,
    agentId: string,
    nextAgoraCheckTick?: number | null
): boolean {
    if (nextAgoraCheckTick !== null && nextAgoraCheckTick !== undefined) {
        return tick >= nextAgoraCheckTick;
    }
    // First-time agents should check immediately to bootstrap activity.
    return true;
}

export function computeNextAgoraCheckTick(tick: number, agentId: string): number {
    const intervalTicks = getAgoraCheckIntervalTicks();
    const offset = getAgoraCheckOffset(agentId, Math.max(1, Math.floor(intervalTicks * 0.25)));
    return tick + intervalTicks + offset;
}

function hashStringToInt(input: string): number {
    let hash = 0;
    for (let i = 0; i < input.length; i += 1) {
        hash = (hash << 5) - hash + input.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash);
}
