// Wallet Connection Hook
// Uses MetaMask (window.ethereum) to connect, sign a message, and authenticate via /api/v1/auth/link

import { useState, useCallback } from 'react';
import { useAppStore } from '@/store/appStore';
import { apiClient } from '@/api/client';

interface WalletConnectResult {
    actorId: string;
    actorName: string;
    apiKey: string;
    city?: string;
}

interface EthereumProvider {
    request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    isMetaMask?: boolean;
}

// Storage keys
const STORAGE_KEY_API_KEY = 'soulbyte_api_key';
const STORAGE_KEY_ACTOR_ID = 'soulbyte_actor_id';
const STORAGE_KEY_ADDRESS = 'soulbyte_wallet_address';

function getEthereum(): EthereumProvider | null {
    const win = globalThis.window as Window & { ethereum?: EthereumProvider };
    return win?.ethereum ?? null;
}

export function useWalletConnect() {
    const { setWalletConnected, setWalletDisconnected } = useAppStore();
    const [isConnecting, setIsConnecting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const connect = useCallback(async () => {
        setError(null);
        setIsConnecting(true);

        try {
            const ethereum = getEthereum();
            if (!ethereum) {
                throw new Error('No wallet detected. Please install MetaMask.');
            }

            // Request accounts
            const accounts = await ethereum.request({ method: 'eth_requestAccounts' }) as string[];
            if (!accounts || accounts.length === 0) {
                throw new Error('No accounts found. Please unlock your wallet.');
            }

            const address = accounts[0];

            // Create sign message matching backend expectation
            const message = `Soulbyte OpenClaw Link: ${address}`;

            // Request personal signature
            const signature = await ethereum.request({
                method: 'personal_sign',
                params: [message, address],
            }) as string;

            // Call backend auth endpoint
            const result = await apiClient.post<WalletConnectResult>('/api/v1/auth/link', {
                wallet_address: address,
                signature,
                message,
            });

            // Store credentials
            localStorage.setItem(STORAGE_KEY_API_KEY, result.apiKey);
            localStorage.setItem(STORAGE_KEY_ACTOR_ID, result.actorId);
            localStorage.setItem(STORAGE_KEY_ADDRESS, address);

            // Update app state
            setWalletConnected(address, result.actorId);

            return result;
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'Connection failed';
            setError(msg);
            throw err;
        } finally {
            setIsConnecting(false);
        }
    }, [setWalletConnected]);

    const disconnect = useCallback(() => {
        localStorage.removeItem(STORAGE_KEY_API_KEY);
        localStorage.removeItem(STORAGE_KEY_ACTOR_ID);
        localStorage.removeItem(STORAGE_KEY_ADDRESS);
        setWalletDisconnected();
        setError(null);
    }, [setWalletDisconnected]);

    // Restore session on mount
    const restoreSession = useCallback(() => {
        const address = localStorage.getItem(STORAGE_KEY_ADDRESS);
        const actorId = localStorage.getItem(STORAGE_KEY_ACTOR_ID);
        if (address && actorId) {
            setWalletConnected(address, actorId);
            return true;
        }
        return false;
    }, [setWalletConnected]);

    return {
        connect,
        disconnect,
        restoreSession,
        isConnecting,
        error,
        hasWalletProvider: !!getEthereum(),
    };
}
