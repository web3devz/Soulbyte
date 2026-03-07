const HOUSING_REST_PROFILE: Record<string, { restHours: number; recoveryMult: number }> = {
    street: { restHours: 7, recoveryMult: 0.7 },
    shelter: { restHours: 6, recoveryMult: 0.8 },
    slum_room: { restHours: 5, recoveryMult: 0.9 },
    apartment: { restHours: 4, recoveryMult: 1.0 },
    condo: { restHours: 4, recoveryMult: 1.1 },
    house: { restHours: 3, recoveryMult: 1.2 },
    villa: { restHours: 3, recoveryMult: 1.3 },
    estate: { restHours: 3, recoveryMult: 1.35 },
    palace: { restHours: 2, recoveryMult: 1.4 },
    citadel: { restHours: 2, recoveryMult: 1.5 }
};

const REST_ACCESSORY_BONUSES: Record<string, { energyMult?: number; healthMult?: number }> = {
    ITEM_COMFY_PILLOW: { energyMult: 1.1, healthMult: 1.05 }
};

export function getRestProfile(housingTier: string, ownedItemNames: string[]) {
    const profile = HOUSING_REST_PROFILE[housingTier] ?? HOUSING_REST_PROFILE.street;
    let energyMult = profile.recoveryMult;
    let healthMult = profile.recoveryMult;

    for (const item of ownedItemNames) {
        const bonus = REST_ACCESSORY_BONUSES[item];
        if (!bonus) continue;
        if (bonus.energyMult) energyMult *= bonus.energyMult;
        if (bonus.healthMult) healthMult *= bonus.healthMult;
    }

    return {
        restHours: profile.restHours,
        energyMult,
        healthMult
    };
}
