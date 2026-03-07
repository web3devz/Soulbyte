// Time Utilities - Convert ticks to world time

const TICKS_PER_HOUR = 60;
const TICKS_PER_DAY = 1440;

export interface WorldTime {
    hours: number;
    minutes: number;
    day: number;
}

export function tickToWorldTime(tick: number): WorldTime {
    const day = Math.floor(tick / TICKS_PER_DAY) + 1;
    const tickInDay = tick % TICKS_PER_DAY;
    const hours = Math.floor(tickInDay / TICKS_PER_HOUR);
    const minutes = Math.floor((tickInDay % TICKS_PER_HOUR) / (TICKS_PER_HOUR / 60));

    return { hours, minutes, day };
}

export function formatWorldTime(tick: number): string {
    const { hours, minutes } = tickToWorldTime(tick);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

export function formatWorldTimeWithDay(tick: number): string {
    const { hours, minutes, day } = tickToWorldTime(tick);
    return `Day ${day}, ${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

export function formatRelativeTime(tick: number, currentTick: number): string {
    const diff = currentTick - tick;

    if (diff < 0) return 'in the future';
    if (diff < TICKS_PER_HOUR) return `${diff} ticks ago`;

    const hours = Math.floor(diff / TICKS_PER_HOUR);
    if (hours < 24) return `${hours}h ago`;

    const days = Math.floor(diff / TICKS_PER_DAY);
    return `${days}d ago`;
}
