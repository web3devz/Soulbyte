import { keccak256, toUtf8Bytes } from 'ethers';

export interface PersonalityTraits {
    aggression: number;
    creativity: number;
    sociability: number;
    ambition: number;
    loyalty: number;
    riskTolerance: number;
    empathy: number;
    curiosity: number;
    workEthic: number;
    selfInterest: number;
    energyManagement: number;
    patience: number;
    luck: number;
    speed: number;
    socialNeed: number;
}

export function generateTraitsFromWallet(
    walletAddress: string,
    name: string,
    prefs?: Partial<PersonalityTraits>
): PersonalityTraits {
    const seed = keccak256(toUtf8Bytes(walletAddress + name));
    const bytes = Buffer.from(seed.slice(2), 'hex');

    const raw: PersonalityTraits = {
        aggression: Math.round((bytes[0] / 255) * 100),
        creativity: Math.round((bytes[1] / 255) * 100),
        sociability: Math.round((bytes[2] / 255) * 100),
        ambition: Math.round((bytes[3] / 255) * 100),
        loyalty: Math.round((bytes[4] / 255) * 60) + 40,
        riskTolerance: Math.round((bytes[5] / 255) * 100),
        empathy: Math.round((bytes[6] / 255) * 100),
        curiosity: Math.round((bytes[7] / 255) * 100),
        workEthic: Math.round((bytes[8] / 255) * 100),
        selfInterest: Math.round((bytes[9] / 255) * 100),
        energyManagement: Math.round((bytes[10] / 255) * 100),
        patience: Math.round((bytes[11] / 255) * 100),
        luck: Math.round((bytes[12] / 255) * 100),
        speed: Math.round((bytes[13] / 255) * 100),
        socialNeed: Math.round((bytes[14] / 255) * 100),
    };

    if (prefs) {
        for (const [key, val] of Object.entries(prefs)) {
            const numeric = Number(val);
            if (Number.isFinite(numeric) && key in raw) {
                const base = raw[key as keyof PersonalityTraits];
                raw[key as keyof PersonalityTraits] = Math.max(
                    0,
                    Math.min(100, base + Math.max(-20, Math.min(20, numeric - base)))
                );
            }
        }
    }

    return raw;
}
