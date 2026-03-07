export function getSalaryMultiplier(vaultHealthDays: number): number {
    if (vaultHealthDays > 120) return 1.2;
    if (vaultHealthDays > 90) return 1.1;
    if (vaultHealthDays > 60) return 1.0;
    if (vaultHealthDays > 30) return 0.8;
    return 0.5;
}

export function getDistributionRate(vaultHealthDays: number): number {
    if (vaultHealthDays > 120) return 0.3;
    if (vaultHealthDays > 90) return 0.2;
    if (vaultHealthDays > 60) return 0.1;
    return 0;
}
