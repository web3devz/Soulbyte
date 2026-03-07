export const RENT_MULTIPLIER = 1;
export const PROPERTY_PRICE_MULTIPLIER = 1;

export const RENT_BY_TIER: Record<string, number> = {
    street: 0,
    shelter: 15,
    slum_room: 40,
    apartment: 100,
    condo: 300,
    house: 1500,
    villa: 8000,
    estate: 40000,
    palace: 150000,
    citadel: 500000,
};

export const GENESIS_SALE_PRICE_BY_TIER: Record<string, number> = {
    street: 0,
    shelter: 5000,
    slum_room: 12000,
    apartment: 30000,
    condo: 100000,
    house: 500000,
    villa: 3000000,
    estate: 15000000,
    palace: 60000000,
    citadel: 200000000,
};

export const DEFAULT_BUSINESS_PRICES: Record<string, number> = {
    BANK: 0,
    CASINO: 10,
    STORE: 50,
    RESTAURANT: 50,
    TAVERN: 20,
    GYM: 30,
    CLINIC: 150,
    REALESTATE: 100,
    WORKSHOP: 40,
};
