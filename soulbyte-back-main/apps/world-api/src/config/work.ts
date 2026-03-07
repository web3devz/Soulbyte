// V6: Reduced from 10 → 6 so agents complete their workday faster,
// freeing time for social, leisure, and growth activities.
export const WORK_SEGMENTS_PER_DAY = 6;

// Approximate real-time work hours per full workday (for documentation).
export const WORK_HOURS_PER_DAY = 6;

// Private work is advantaged by shorter total time.
export const PRIVATE_WORK_HOURS_MULTIPLIER = 0.8;

// Owner work total hours before segmenting (private-sector advantage).
export const OWNER_WORK_HOURS = 4;

// Minimum length for any single work segment (minutes).
export const MIN_WORK_SEGMENT_MINUTES = 5;

// How long before a public employee can start a NEW segment (ticks).
// Prevents public sector workers from immediately re-starting after each segment.
// Value = 1 real hour gap between segments to allow social time.
export const PUBLIC_WORK_SEGMENT_GAP_TICKS = 12; // 12 ticks = 1 hour at 5s/tick
