
import seedrandom from 'seedrandom';

export function getDeterministicRandom(seed: string): number {
    return seedrandom(seed)();
}

/**
 * Returns a random integer between min (inclusive) and max (inclusive).
 */
export function getRandomInt(min: number, max: number, seed: string): number {
    const rng = seedrandom(seed);
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(rng() * (max - min + 1)) + min;
}

export class SeededRNG {
    private rng: () => number;

    constructor(seed: string) {
        this.rng = seedrandom(seed);
    }

    next(): number {
        return this.rng();
    }

    nextInt(min: number, max: number): number {
        min = Math.ceil(min);
        max = Math.floor(max);
        return Math.floor(this.rng() * (max - min + 1)) + min;
    }
}
