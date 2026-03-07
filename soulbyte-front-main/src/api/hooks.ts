// React Query Hooks - API data fetching with polling and caching

import { useQuery } from '@tanstack/react-query';
import { apiClient, APIError } from './client';
import type {
    City,
    CityDetail,
    Event,
    Actor,
    ActorSearchResult,
    AgentState,
    BusinessSummary,
    BusinessDetail,
    AgoraBoard,
    AgoraThread,
    AgoraPost,
    PNLSnapshot,
    WorldState,
    PersonaState,
    AgentGoal,
    InventoryItem,
    Relationship,
    AgentMemory,
    WalletInfo,
    OnchainTransaction,
    GovernanceProposal,
    ElectionsResponse,
    GovernanceDonation,
    MarketListing,
    PropertySummary,
    PropertyDetail,
    TransactionCountResponse,
    EconomySnapshot,
    WealthRanking,
    HallOfFameEntry,
    Property,
    FinanceSummary,
} from './types';

// ==================== WORLD ====================

export function useWorldTick() {
    return useQuery<WorldState, APIError>({
        queryKey: ['world', 'tick'],
        queryFn: () => apiClient.get<WorldState>('/api/v1/world/tick'),
        refetchInterval: 5000,
        retry: 1,
    });
}

// ==================== CITIES ====================

export function useCities() {
    return useQuery<City[], APIError>({
        queryKey: ['cities'],
        queryFn: async () => {
            const res = await apiClient.get<{ cities: City[] }>('/api/v1/cities');
            return res.cities;
        },
        retry: 1,
    });
}

export function useCity(cityId: string) {
    return useQuery<City, APIError>({
        queryKey: ['cities', cityId],
        queryFn: async () => {
            const res = await apiClient.get<{ city: CityDetail }>(`/api/v1/cities/${cityId}`);
            return res.city;
        },
        enabled: !!cityId,
        retry: 1,
    });
}

export function useCityDetail(cityId: string) {
    return useQuery<CityDetail, APIError>({
        queryKey: ['cities', cityId, 'detail'],
        queryFn: async () => {
            const res = await apiClient.get<{ city: CityDetail }>(`/api/v1/cities/${cityId}`);
            return res.city;
        },
        enabled: !!cityId,
        retry: 1,
    });
}

export function useCityEconomy(cityId: string) {
    return useQuery<EconomySnapshot, APIError>({
        queryKey: ['cities', cityId, 'economy'],
        queryFn: async () => {
            const res = await apiClient.get<{ economy: EconomySnapshot }>(`/api/v1/cities/${cityId}/economy`);
            return res.economy;
        },
        enabled: !!cityId,
        refetchInterval: 30000,
        retry: 1,
    });
}

// ==================== EVENTS ====================

interface EventsParams {
    limit?: number;
    offset?: number;
    cityId?: string;
    type?: string;
    search?: string;
    actorId?: string;
}

export function useEvents(params: EventsParams = {}) {
    return useQuery<Event[], APIError>({
        queryKey: ['events', params],
        queryFn: () => apiClient.get<Event[]>('/api/v1/events', params as Record<string, string | number | boolean>),
        refetchInterval: 5000,
        retry: 1,
    });
}

// ==================== ACTORS/AGENTS ====================

export function useActor(actorId: string) {
    return useQuery<Actor, APIError>({
        queryKey: ['actors', actorId],
        queryFn: () => apiClient.get<Actor>(`/api/v1/actors/${actorId}`),
        enabled: !!actorId,
        retry: 1,
    });
}

export function useActorSearch(query: string) {
    return useQuery<ActorSearchResult[], APIError>({
        queryKey: ['actors', 'search', query],
        queryFn: async () => {
            const response = await apiClient.get<{ actors: ActorSearchResult[] }>(
                '/api/v1/actors/search',
                { q: query }
            );
            return response.actors ?? [];
        },
        enabled: query.trim().length > 0,
        retry: 1,
    });
}

export function useActorDirectory(params: { sort: 'newest' | 'popular'; limit?: number }) {
    return useQuery<Actor[], APIError>({
        queryKey: ['actors', 'directory', params],
        queryFn: async () => {
            const response = await apiClient.get<{ actors: Actor[] }>(
                '/api/v1/actors/directory',
                params as Record<string, string | number | boolean>
            );
            return response.actors ?? [];
        },
        retry: 1,
    });
}

export function useAgentState(actorId: string) {
    return useQuery<AgentState, APIError>({
        queryKey: ['actors', actorId, 'state'],
        queryFn: () => apiClient.get<AgentState>(`/api/v1/actors/${actorId}/state`),
        enabled: !!actorId,
        refetchInterval: 10000,
        retry: 1,
    });
}

export function useAgentPersona(actorId: string) {
    return useQuery<PersonaState, APIError>({
        queryKey: ['actors', actorId, 'persona'],
        queryFn: () => apiClient.get<PersonaState>(`/api/v1/actors/${actorId}/persona`),
        enabled: !!actorId,
        retry: 1,
    });
}

export function useAgentGoals(actorId: string, status?: string) {
    return useQuery<AgentGoal[], APIError>({
        queryKey: ['actors', actorId, 'goals', status],
        queryFn: () => apiClient.get<AgentGoal[]>(
            `/api/v1/actors/${actorId}/goals`,
            status ? { status } : undefined
        ),
        enabled: !!actorId,
        retry: 1,
    });
}

export function useAgentInventory(actorId: string) {
    return useQuery<InventoryItem[], APIError>({
        queryKey: ['actors', actorId, 'inventory'],
        queryFn: () => apiClient.get<InventoryItem[]>(`/api/v1/actors/${actorId}/inventory`),
        enabled: !!actorId,
        retry: 1,
    });
}

export function useAgentRelationships(actorId: string) {
    return useQuery<Relationship[], APIError>({
        queryKey: ['actors', actorId, 'relationships'],
        queryFn: async () => {
            const response = await apiClient.get<{ relationships: Relationship[] }>(
                `/api/v1/actors/${actorId}/relationships`
            );
            return response.relationships ?? [];
        },
        enabled: !!actorId,
        retry: 1,
    });
}

export function useAgentMemories(actorId: string, limit = 20) {
    return useQuery<AgentMemory[], APIError>({
        queryKey: ['actors', actorId, 'memories', limit],
        queryFn: () => apiClient.get<AgentMemory[]>(
            `/api/v1/actors/${actorId}/memories`,
            { limit }
        ),
        enabled: !!actorId,
        retry: 1,
    });
}

export function useActorFinanceSummary(actorId: string) {
    return useQuery<FinanceSummary, APIError>({
        queryKey: ['actors', actorId, 'finance-summary'],
        queryFn: () => apiClient.get<FinanceSummary>(`/api/v1/actors/${actorId}/finance-summary`),
        enabled: !!actorId,
        retry: 1,
    });
}

// ==================== BUSINESSES ====================

export function useBusinesses(params?: {
    ownerId?: string;
    cityId?: string;
    type?: string;
    category?: string;
    status?: string;
    sortBy?: string;
}) {
    const hasFilters = params
        ? Object.values(params).some((value) => value !== undefined && value !== null && value !== '')
        : true;
    return useQuery<BusinessSummary[], APIError>({
        queryKey: ['businesses', params],
        queryFn: async () => {
            const response = await apiClient.get<{ businesses: BusinessSummary[] }>(
                '/api/v1/businesses',
                params as Record<string, string | number | boolean>
            );
            return response.businesses ?? [];
        },
        enabled: hasFilters,
        retry: 1,
    });
}

export function useBusinessDetail(businessId: string) {
    return useQuery<BusinessDetail, APIError>({
        queryKey: ['businesses', businessId],
        queryFn: async () => {
            const response = await apiClient.get<{ business: BusinessDetail }>(`/api/v1/businesses/${businessId}`);
            return response.business;
        },
        enabled: !!businessId,
        retry: 1,
    });
}

// ==================== PNL ====================

export function usePNLLeaderboard(
    period: 'day' | 'week' | 'all_time' = 'all_time'
) {
    return useQuery<PNLSnapshot[], APIError>({
        queryKey: ['pnl', 'leaderboard', period],
        queryFn: () => apiClient.get<PNLSnapshot[]>('/api/v1/pnl/leaderboard', { period }),
        retry: 1,
    });
}

// ==================== AGORA ====================

export function useAgoraBoards() {
    return useQuery<AgoraBoard[], APIError>({
        queryKey: ['agora', 'boards'],
        queryFn: () => apiClient.get<AgoraBoard[]>('/api/v1/agora/boards'),
        retry: 1,
    });
}

export function useAgoraThreads(
    boardId: string,
    params?: { page?: number }
) {
    return useQuery<AgoraThread[], APIError>({
        queryKey: ['agora', 'threads', boardId, params],
        queryFn: () => apiClient.get<AgoraThread[]>(`/api/v1/agora/threads/${boardId}`, params as Record<string, string | number | boolean>),
        enabled: !!boardId,
        retry: 1,
    });
}

export function useAgoraPosts(
    threadId: string,
    params?: { page?: number }
) {
    return useQuery<AgoraPost[], APIError>({
        queryKey: ['agora', 'posts', threadId, params],
        queryFn: () => apiClient.get<AgoraPost[]>(`/api/v1/agora/thread/${threadId}/posts`, params as Record<string, string | number | boolean>),
        enabled: !!threadId,
        retry: 1,
    });
}

// ==================== WALLET ====================

export function useWalletInfo(actorId: string) {
    return useQuery<WalletInfo, APIError>({
        queryKey: ['wallet', actorId],
        queryFn: async () => {
            const response = await apiClient.get<{
                wallet: { address: string; balanceMon: string; balanceSbyte: string };
            }>(`/api/v1/wallet/${actorId}`);
            return {
                actorId,
                walletAddress: response.wallet.address,
                balanceMon: response.wallet.balanceMon,
                balanceSbyte: response.wallet.balanceSbyte,
            };
        },
        enabled: !!actorId,
        retry: 1,
    });
}

export function useWalletTransactions(actorId: string, params?: { limit?: number; offset?: number }) {
    return useQuery<OnchainTransaction[], APIError>({
        queryKey: ['wallet', actorId, 'transactions', params],
        queryFn: async () => {
            const response = await apiClient.get<{ transactions: OnchainTransaction[] }>(
                `/api/v1/wallet/${actorId}/transactions`,
                params as Record<string, string | number | boolean>
            );
            return response.transactions ?? [];
        },
        enabled: !!actorId,
        retry: 1,
    });
}

// ==================== ECONOMY ====================

export function useTransactionCount(params?: { start_date?: string; end_date?: string; city_id?: string }) {
    return useQuery<TransactionCountResponse, APIError>({
        queryKey: ['economy', 'transactions', 'count', params],
        queryFn: () => apiClient.get<TransactionCountResponse>(
            '/api/v1/economy/transactions/count',
            params as Record<string, string | number | boolean>
        ),
        refetchInterval: 30000,
        retry: 1,
    });
}

// ==================== GOVERNANCE ====================

export function useGovernanceProposals(cityId: string, status?: string) {
    return useQuery<{ proposals: GovernanceProposal[] }, APIError>({
        queryKey: ['governance', cityId, 'proposals', status],
        queryFn: () => apiClient.get<{ proposals: GovernanceProposal[] }>(
            `/api/v1/governance/${cityId}/proposals`,
            status ? { status } : undefined
        ),
        enabled: !!cityId,
        retry: 1,
    });
}

export function useGovernanceElections(cityId: string) {
    return useQuery<ElectionsResponse, APIError>({
        queryKey: ['governance', cityId, 'elections'],
        queryFn: () => apiClient.get<ElectionsResponse>(`/api/v1/governance/${cityId}/elections`),
        enabled: !!cityId,
        retry: 1,
    });
}

export function useGovernanceDonations(cityId: string) {
    return useQuery<{ donations: GovernanceDonation[] }, APIError>({
        queryKey: ['governance', cityId, 'donations'],
        queryFn: () => apiClient.get<{ donations: GovernanceDonation[] }>(
            `/api/v1/governance/${cityId}/donations`
        ),
        enabled: !!cityId,
        retry: 1,
    });
}

// ==================== MARKET ====================

interface MarketListingsParams {
    cityId?: string;
    itemName?: string;
    sort?: 'price' | 'price_asc' | 'price_desc';
    limit?: number;
    offset?: number;
}

export function useMarketListings(params?: MarketListingsParams) {
    return useQuery<{ listings: MarketListing[] }, APIError>({
        queryKey: ['market', 'listings', params],
        queryFn: () => apiClient.get<{ listings: MarketListing[] }>(
            '/api/v1/market/listings',
            params as Record<string, string | number | boolean>
        ),
        refetchInterval: 15000,
        retry: 1,
    });
}

// ==================== PROPERTIES ====================

export function usePropertySummary(cityId: string) {
    return useQuery<PropertySummary, APIError>({
        queryKey: ['cities', cityId, 'properties', 'summary'],
        queryFn: () => apiClient.get<PropertySummary>(`/api/v1/cities/${cityId}/properties/summary`),
        enabled: !!cityId,
        retry: 1,
    });
}

// ==================== LEADERBOARDS ====================

export function useWealthLeaderboard() {
    return useQuery<{ leaderboard: WealthRanking[] }, APIError>({
        queryKey: ['leaderboards', 'wealth'],
        queryFn: () => apiClient.get<{ leaderboard: WealthRanking[] }>('/api/v1/leaderboards/wealth'),
        refetchInterval: 30000,
        retry: 1,
    });
}

export function useHallOfFame() {
    return useQuery<{ hall_of_fame: HallOfFameEntry[] }, APIError>({
        queryKey: ['hall-of-fame'],
        queryFn: () => apiClient.get<{ hall_of_fame: HallOfFameEntry[] }>('/api/v1/hall-of-fame'),
        refetchInterval: 60000,
        retry: 1,
    });
}

// ==================== PROPERTIES (PAGINATED) ====================

interface PropertiesParams {
    limit?: number;
    offset?: number;
    available?: boolean;
}

export function useProperties(cityId: string, params?: PropertiesParams) {
    return useQuery<{ properties: Property[]; total: number }, APIError>({
        queryKey: ['cities', cityId, 'properties', params],
        queryFn: () => apiClient.get<{ properties: Property[]; total: number }>(
            `/api/v1/cities/${cityId}/properties`,
            params as Record<string, string | number | boolean>
        ),
        enabled: !!cityId,
        retry: 1,
    });
}

export function usePropertyDetail(propertyId: string) {
    return useQuery<PropertyDetail, APIError>({
        queryKey: ['properties', propertyId],
        queryFn: async () => {
            const response = await apiClient.get<{ property: PropertyDetail }>(`/api/v1/properties/${propertyId}`);
            return response.property;
        },
        enabled: !!propertyId,
        retry: 1,
    });
}
