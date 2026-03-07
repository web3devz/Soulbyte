// Custom Hooks - useWorldTime hook

import { useWorldTick } from '@/api/hooks';
import { formatWorldTime, formatWorldTimeWithDay, tickToWorldTime } from '@/utils/time';

export function useWorldTime() {
    const { data: worldState } = useWorldTick();
    const currentTick = worldState?.tick || 0;

    return {
        currentTick,
        worldTime: tickToWorldTime(currentTick),
        formattedTime: formatWorldTime(currentTick),
        formattedTimeWithDay: formatWorldTimeWithDay(currentTick),
    };
}
