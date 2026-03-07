export const GAMING_CONFIG = {
    // Frequency
    MIN_TICKS_BETWEEN_GAMES: 60,
    MAX_GAMES_PER_SIM_DAY: 10,
    CHALLENGE_EXPIRY_TICKS: 30,

    // Stakes
    MIN_STAKE: 100,
    MAX_STAKE_PERCENT_OF_BALANCE: 0.015,
    MAX_STAKE_ABSOLUTE: 500,
    BROKE_PROTECTION_FLOOR: 50,

    // Energy + need effects
    ENERGY_COST: 8,
    FUN_GAIN_WIN: 20,
    FUN_GAIN_LOSS: 5,
    SOCIAL_GAIN: 10,
    PURPOSE_GAIN: 3,

    // Outcome Modifiers
    BASE_WIN_CHANCE: 50,
    LUCK_WEIGHT: 0.2,
    PERSONALITY_WEIGHT: 0.08,
    REPUTATION_WEIGHT: 0.05,
    HOUSE_EDGE_SCORE_BONUS: 8,

    // PnL Sensitivity
    LOSS_AVERSION_THRESHOLD: -100,
    LOSS_AVERSION_COOLDOWN_TICKS: 360,
    WIN_STREAK_BOOST: 5,

    // Game Types
    GAME_TYPES: {
        DICE: { name: 'Dice', luckWeight: 0.25, personalityWeight: 0.05 },
        CARDS: { name: 'Cards', luckWeight: 0.15, personalityWeight: 0.15 },
        STRATEGY: { name: 'Strategy', luckWeight: 0.05, personalityWeight: 0.25 },
    }
} as const;
