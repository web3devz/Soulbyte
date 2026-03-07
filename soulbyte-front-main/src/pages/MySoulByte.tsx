// My SoulByte Page - S7 (Owner-only)

import React from 'react';
import { useAppStore } from '@/store/appStore';
import { useActor, useAgentState, useCities, useWalletInfo, useWalletTransactions } from '@/api/hooks';
import { useWalletConnect } from '@/hooks/useWalletConnect';
import Avatar from '@/components/common/Avatar';
import NeedBar from '@/components/common/NeedBar';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { formatSBYTE, truncateAddress, formatPropertyName } from '@/utils/format';
import './MySoulByte.css';

function formatTitle(value: string): string {
    return value
        .toLowerCase()
        .split('_')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

const MySoulByte: React.FC = () => {
    const { isWalletConnected, ownedAgentId, connectedAddress } = useAppStore();
    const { connect, disconnect, isConnecting, error, hasWalletProvider } = useWalletConnect();
    const { data: state, isLoading: stateLoading } = useAgentState(ownedAgentId || '');
    const { data: actor } = useActor(ownedAgentId || '');
    const { data: cities } = useCities();
    const { data: wallet } = useWalletInfo(ownedAgentId || '');
    const { data: transactions } = useWalletTransactions(ownedAgentId || '', { limit: 50 });
    const ownedProperties = Array.isArray(actor?.properties) ? actor?.properties : [];
    const ownedBusinesses = Array.isArray(actor?.businesses) ? actor?.businesses : [];
    const cityNameById = new Map((cities ?? []).map((city) => [city.id, city.name]));

    if (!isWalletConnected) {
        return (
            <div className="empty-state">
                <div className="empty-state-icon">🔒</div>
                <p className="empty-state-text">Connect your wallet to view your SoulByte</p>
                {error && <p className="error-text mt-sm">{error}</p>}
                {hasWalletProvider ? (
                    <button
                        className="btn btn-primary mt-lg"
                        onClick={connect}
                        disabled={isConnecting}
                    >
                        {isConnecting ? 'Connecting...' : 'Connect Wallet'}
                    </button>
                ) : (
                    <div className="mt-lg">
                        <p className="label">No wallet detected</p>
                        <a
                            href="https://metamask.io/download/"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn btn-secondary mt-sm"
                        >
                            Install MetaMask
                        </a>
                    </div>
                )}
            </div>
        );
    }

    if (stateLoading && !state) {
        return <LoadingSpinner />;
    }

    if (!state) {
        return (
            <div className="empty-state">
                <div className="empty-state-icon">❌</div>
                <p className="empty-state-text">No SoulByte linked to this wallet</p>
                <p className="label mt-sm">Address: {connectedAddress ? truncateAddress(connectedAddress) : '—'}</p>
                <button className="btn btn-secondary mt-lg" onClick={disconnect}>
                    Disconnect
                </button>
            </div>
        );
    }

    return (
        <div className="my-soulbyte">
            <div className="soulbyte-header">
                <h1>🎮 My SoulByte</h1>
                <button className="btn btn-secondary btn-sm" onClick={disconnect}>
                    Disconnect
                </button>
            </div>

            <div className="soulbyte-overview">
                <Avatar actorId={state.actorId} size={96} />
                <div className="overview-info">
                    <h2>{state.actorId}</h2>
                    <div className="agent-badges">
                        <span className="badge badge-wealth">{state.wealthTier}</span>
                        {state.publicEmployment && state.publicEmployment.endedAtTick === null ? (
                            <>
                                <span className="badge badge-job">
                                    {`${formatTitle(state.publicEmployment.role)} @ ${state.publicEmployment.publicPlaceName ?? 'Public Place'}`}
                                </span>
                                <span className="badge badge-status">
                                    {state.publicEmployment.publicPlaceName ?? state.publicEmployment.publicPlaceType ?? 'Public Employment'}
                                </span>
                            </>
                        ) : (
                            <span className="badge badge-job">{state.jobType}</span>
                        )}
                        <span className="badge badge-status">{state.activityState}</span>
                    </div>
                </div>
            </div>

            <section className="section">
                <h2>Needs</h2>
                <div className="needs-grid">
                    <NeedBar label="Health" value={state.health} />
                    <NeedBar label="Energy" value={state.energy} />
                    <NeedBar label="Hunger" value={state.hunger} />
                    <NeedBar label="Social" value={state.social} />
                    <NeedBar label="Fun" value={state.fun} />
                    <NeedBar label="Purpose" value={state.purpose} />
                </div>
            </section>

            {state.housing && (
                <section className="section">
                    <h2>Housing</h2>
                    <div className="panel">
                        <div className="wallet-info">
                            <div><span className="label">Status:</span> {state.housing.status}</div>
                            <div>
                                <span className="label">Property:</span>{' '}
                                {state.housing.propertyId ? formatPropertyName(state.housing.propertyName, state.housing.housingTier) : '—'}
                            </div>
                            {state.housing.cityId && (
                                <div>
                                    <span className="label">City:</span>{' '}
                                    {cityNameById.get(state.housing.cityId) || state.housing.cityId}
                                </div>
                            )}
                            {state.housing.status === 'renting' && state.housing.rentPrice !== null && (
                                <div><span className="label">Rent:</span> {formatSBYTE(state.housing.rentPrice)}/mo</div>
                            )}
                        </div>
                    </div>
                </section>
            )}

            {ownedBusinesses.length > 0 && (
                <section className="section">
                    <h2>Businesses</h2>
                    <div className="transactions-list">
                        {ownedBusinesses.map((business) => (
                            <div key={business.id} className="transaction-item">
                                <span className="tx-reason">{business.name}</span>
                                <span className="tx-amount">{business.businessType}</span>
                            </div>
                        ))}
                    </div>
                </section>
            )}

            {ownedProperties.length > 0 && (
                <section className="section">
                    <h2>Properties</h2>
                    <div className="transactions-list">
                        {ownedProperties.map((property) => (
                            <div key={property.id} className="transaction-item">
                                <span className="tx-reason">{formatPropertyName(property.propertyName, property.housingTier)}</span>
                                <span className="tx-amount">
                                    {property.cityName || cityNameById.get(property.cityId) || property.cityId}
                                </span>
                            </div>
                        ))}
                    </div>
                </section>
            )}

            {state.pendingGameChallenges && state.pendingGameChallenges.length > 0 && (
                <section className="section">
                    <h2>🎲 Game Challenges</h2>
                    <div className="events-list">
                        {state.pendingGameChallenges.map((challenge) => (
                            <div key={challenge.id} className="event-row">
                                <span className="event-label">
                                    {challenge.challengerName} challenged you to {challenge.gameType}
                                    {' '}for {challenge.stake} SBYTE
                                </span>
                                <span className="label event-tick">tick {challenge.createdAtTick}</span>
                            </div>
                        ))}
                    </div>
                </section>
            )}

            <section className="section">
                <h2>Wallet</h2>
                <div className="panel">
                    {wallet ? (
                        <div className="wallet-info">
                            <div><span className="label">Address:</span> <code>{truncateAddress(wallet.walletAddress)}</code></div>
                            <div><span className="label">MON Balance:</span> {formatSBYTE(Number.parseFloat(wallet.balanceMon))}</div>
                            <div><span className="label">SBYTE Balance:</span> {formatSBYTE(Number.parseFloat(wallet.balanceSbyte))}</div>
                        </div>
                    ) : (
                        <p className="label">Wallet info loading...</p>
                    )}
                </div>
            </section>

            <section className="section">
                <h2>Recent Transactions</h2>
                <div className="transactions-list">
                    {transactions && transactions.length > 0 ? (
                        transactions.map((tx) => (
                            <div key={tx.id} className="transaction-item">
                                <span className="tx-reason">{tx.txType} · {tx.status}</span>
                                <span className="tx-amount">{formatSBYTE(Number.parseFloat(tx.amount))}</span>
                            </div>
                        ))
                    ) : (
                        <p className="label">No recent transactions</p>
                    )}
                </div>
            </section>
        </div>
    );
};

export default MySoulByte;
