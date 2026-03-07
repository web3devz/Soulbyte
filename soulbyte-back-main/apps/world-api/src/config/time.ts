export const TICK_INTERVAL_MS = parseInt(process.env.TICK_INTERVAL_MS || '5000', 10);

// Simulation time: 1 tick = 1 minute (legacy assumption in work logic)
export const SIM_TICKS_PER_HOUR = 60;
export const SIM_DAY_TICKS = 24 * SIM_TICKS_PER_HOUR;

// Real-time day in ticks (24h human time)
export const REAL_DAY_TICKS = Math.max(
    1,
    Math.round((24 * 60 * 60 * 1000) / TICK_INTERVAL_MS)
);

// Real-time ticks per minute (human time)
export const REAL_TICKS_PER_MINUTE = Math.max(
    1,
    Math.round((60 * 1000) / TICK_INTERVAL_MS)
);
