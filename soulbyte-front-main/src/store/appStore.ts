// Zustand Store - Global application state

import { create } from 'zustand';

interface AppState {
    // Active city selection
    activeCityId: string | null;
    setActiveCityId: (cityId: string | null) => void;

    // Wallet connection
    isWalletConnected: boolean;
    connectedAddress: string | null;
    ownedAgentId: string | null;
    setWalletConnected: (address: string, agentId: string | null) => void;
    setWalletDisconnected: () => void;

    // UI preferences
    sidebarCollapsed: boolean;
    toggleSidebar: () => void;

    // Event log
    eventLogCollapsed: boolean;
    toggleEventLog: () => void;
}

export const useAppStore = create<AppState>((set) => ({
    // City selection
    activeCityId: null,
    setActiveCityId: (cityId) => set({ activeCityId: cityId }),

    // Wallet
    isWalletConnected: false,
    connectedAddress: null,
    ownedAgentId: null,
    setWalletConnected: (address, agentId) => set({
        isWalletConnected: true,
        connectedAddress: address,
        ownedAgentId: agentId,
    }),
    setWalletDisconnected: () => set({
        isWalletConnected: false,
        connectedAddress: null,
        ownedAgentId: null,
    }),

    // UI
    sidebarCollapsed: false,
    toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

    eventLogCollapsed: true,
    toggleEventLog: () => set((state) => ({ eventLogCollapsed: !state.eventLogCollapsed })),
}));
