export type BusinessRoleTier = 1 | 2 | 3 | 4;

const ROLE_TITLES_BY_BUSINESS: Record<string, [string, string, string, string]> = {
    BANK: ['Bank Teller', 'Loan Officer', 'Senior Financial Advisor', 'Branch Manager'],
    CASINO: ['Card Dealer', 'Table Supervisor', 'Operations Chief', 'Casino Boss'],
    STORE: ['Cashier', 'Sales Associate', 'Store Supervisor', 'Store Manager'],
    RESTAURANT: ['Dishwasher', 'Line Cook', 'Sous Chef', 'Executive Chef'],
    TAVERN: ['Bartender', 'Brewmaster', 'Innkeeper', 'Guild Tavern Master'],
    GYM: ['Receptionist', 'Personal Trainer', 'Fitness Coach', 'Gym Manager'],
    CLINIC: ['Medical Assistant', 'Nurse', 'Doctor', 'Medical Director'],
    REALESTATE: ['Junior Agent', 'Property Consultant', 'Senior Realtor', 'Regional Manager'],
    WORKSHOP: ['Trainee', 'Skilled Technician', 'Senior Technician', 'Operations Manager'],
};

export function getBusinessRoleTitle(businessType: string, tier?: number | null): string | null {
    const titles = ROLE_TITLES_BY_BUSINESS[businessType];
    if (!titles) return null;
    const safeTier = Math.max(1, Math.min(4, Number(tier ?? 1))) as BusinessRoleTier;
    return titles[safeTier - 1] ?? null;
}
