// Agent Detail Page - S2a - Comprehensive agent profile

import React, { useEffect, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
    useActor,
    useAgentState,
    useAgentPersona,
    useAgentGoals,
    useAgentInventory,
    useAgentRelationships,
    useAgentMemories,
    useEvents,
    useCities,
    useActorFinanceSummary
} from '@/api/hooks';
import type { Relationship, AgentGoal, InventoryItem, AgentMemory, Event, ActorProperty, ActorBusiness } from '@/api/types';
import Avatar from '@/components/common/Avatar';
import NeedBar from '@/components/common/NeedBar';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { getEventIcon, shouldHideEvent } from '@/utils/events';
import EventDescription from '@/components/common/EventDescription';
import { formatSBYTE, truncateAddress, formatHousingTier, formatPropertyName, formatItemName } from '@/utils/format';
import './AgentDetail.css';

// Safe number formatter - prevents NaN displays
function safeNum(val: number | string | null | undefined, decimals = 0): string {
    if (val === null || val === undefined || val === '') return '—';
    const n = typeof val === 'string' ? parseFloat(val) : val;
    if (isNaN(n)) return '—';
    return decimals > 0 ? n.toFixed(decimals) : String(Math.round(n));
}

function safePercent(val: number | null | undefined): number {
    if (val === null || val === undefined || isNaN(val)) return 0;
    return Math.max(0, Math.min(100, val));
}

function formatTitle(value: string): string {
    return value
        .toLowerCase()
        .split('_')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

const AgentDetail: React.FC = () => {
    const { id } = useParams<{ id: string }>();
    const { data: actor, isLoading: actorLoading } = useActor(id || '');
    const { data: state, isLoading: stateLoading } = useAgentState(id || '');
    const { data: persona } = useAgentPersona(id || '');
    const { data: goals } = useAgentGoals(id || '');
    const { data: inventory } = useAgentInventory(id || '');
    const { data: relationships } = useAgentRelationships(id || '');
    const { data: memories } = useAgentMemories(id || '');
    const { data: recentEvents } = useEvents({ actorId: id || '', limit: 30 });
    const lastNonEmptyEvents = useRef<Event[]>([]);
    const rawEvents = recentEvents ?? [];
    const { data: cities } = useCities();
    const { data: financeSummary } = useActorFinanceSummary(id || '');

    useEffect(() => {
        if (rawEvents.length > 0) {
            lastNonEmptyEvents.current = rawEvents;
        }
    }, [rawEvents]);

    if (actorLoading) {
        return <LoadingSpinner />;
    }

    if (!actor) {
        return <div className="empty-state">Agent not found</div>;
    }

    // Categorize relationships - ensure we have an array
    const relationshipsArray = Array.isArray(relationships) ? relationships : [];
    const friends = relationshipsArray.filter((r: Relationship) => r.relationshipType === 'FRIENDSHIP');
    const allies = relationshipsArray.filter((r: Relationship) => r.relationshipType === 'ALLIANCE');
    const enemies = relationshipsArray.filter((r: Relationship) => ['RIVALRY', 'GRUDGE'].includes(r.relationshipType));
    const allRelationships = relationshipsArray;
    const topRelationships = [...relationshipsArray]
        .sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0))
        .slice(0, 8);
    const ownedBusinesses = Array.isArray(actor.businesses) ? actor.businesses : [];
    const ownedProperties = Array.isArray(actor.properties) ? actor.properties : [];
    const cityNameById = new Map((cities ?? []).map((city) => [city.id, city.name]));

    const stableRecentEvents = rawEvents.length > 0 ? rawEvents : lastNonEmptyEvents.current;
    const visibleRecentEvents = stableRecentEvents.filter((event) => !shouldHideEvent(event));
    const housingOwnerId = state?.housing?.ownerId ?? null;
    const isSelfOwnedHousing = Boolean(housingOwnerId && housingOwnerId === actor.id);
    const housingOwnerLabel = housingOwnerId
        ? (state?.housing?.ownerName || truncateAddress(housingOwnerId))
        : 'City House';

    return (
        <div className="agent-detail">
            {/* Header */}
            <div className="agent-header">
                <Avatar actorId={actor.id} actorName={actor.name} size={96} />
                <div className="agent-header-info">
                    <h1>{actor.name}</h1>
                    <div className="agent-badges">
                        {state?.wealthTier && <span className="badge badge-wealth">{state.wealthTier}</span>}
                        {state?.publicEmployment && state.publicEmployment.endedAtTick === null ? (
                            <>
                                <span className="badge badge-job">
                                    {`${formatTitle(state.publicEmployment.role)} @ ${state.publicEmployment.publicPlaceName ?? 'Public Place'}`}
                                </span>
                                <span className="badge badge-status">
                                    {state.publicEmployment.publicPlaceName ?? state.publicEmployment.publicPlaceType ?? 'Public Employment'}
                                </span>
                            </>
                        ) : (
                            state?.jobType && <span className="badge badge-job">{state.jobType}</span>
                        )}
                        {state?.activityState && <span className="badge badge-status">{state.activityState}</span>}
                        {actor.dead && <span className="badge badge-danger">☠️ Dead</span>}
                        {actor.frozen && <span className="badge badge-frozen">❄️ Frozen</span>}
                    </div>
                    {state?.mood && <div className="agent-mood">Mood: <strong>{state.mood}</strong></div>}
                    {persona?.selfNarrative && <p className="agent-narrative"><em>"{persona.selfNarrative}"</em></p>}
                </div>
            </div>

            <div className="agent-content">
                {/* Needs - with safe values */}
                {state ? (
                    <section className="section">
                        <h2>Needs</h2>
                        <div className="needs-grid">
                            <NeedBar label="Health" value={safePercent(state.health)} />
                            <NeedBar label="Energy" value={safePercent(state.energy)} />
                            <NeedBar label="Hunger" value={safePercent(state.hunger)} />
                            <NeedBar label="Social" value={safePercent(state.social)} />
                            <NeedBar label="Fun" value={safePercent(state.fun)} />
                            <NeedBar label="Purpose" value={safePercent(state.purpose)} />
                        </div>
                    </section>
                ) : (
                    <section className="section">
                        <h2>Needs</h2>
                        <div className="panel">
                            <p className="label">{stateLoading ? 'Loading needs...' : 'Needs unavailable'}</p>
                        </div>
                    </section>
                )}

                {/* Status Card */}
                <section className="section">
                    <h2>Status</h2>
                    <div className="panel">
                        <div className="info-grid info-grid-3col">
                            <div className="info-item">
                                <span className="info-label">🏠 Housing</span>
                                <span className="info-value">{formatHousingTier(state?.housingTier)}</span>
                            </div>
                            <div className="info-item">
                                <span className="info-label">💰 Balance</span>
                                <span className="info-value">{safeNum(state?.balanceSbyte, 2)} SBYTE</span>
                            </div>
                            {actor.walletAddress && (
                                <div className="info-item">
                                    <span className="info-label">🔑 Wallet</span>
                                    <span className="info-value"><code>{truncateAddress(actor.walletAddress)}</code></span>
                                </div>
                            )}
                            <div className="info-item">
                                <span className="info-label">📅 Experience</span>
                                <span className="info-value">{safeNum(state?.publicExperience)} days</span>
                            </div>
                            <div className="info-item">
                                <span className="info-label">⭐ Reputation</span>
                                <span className="info-value">{safeNum(actor.reputation)}/100</span>
                            </div>
                            <div className="info-item">
                                <span className="info-label">🍀 Luck</span>
                                <span className="info-value">{safeNum(actor.luck)}/100</span>
                            </div>
                            <div className="info-item">
                                <span className="info-label">😡 Anger</span>
                                <span className="info-value">{safeNum(state?.anger)}/100</span>
                            </div>
                            {state?.cityId && (
                                <div className="info-item">
                                    <span className="info-label">🏙️ City</span>
                                    <span className="info-value">
                                        {cityNameById.get(state.cityId) || state.cityId}
                                    </span>
                                </div>
                            )}
                            {state?.archetype && (
                                <div className="info-item">
                                    <span className="info-label">🎭 Archetype</span>
                                    <span className="info-value">{state.archetype}</span>
                                </div>
                            )}
                            {state?.personality && (
                                <div className="info-item">
                                    <span className="info-label">🧠 Personality</span>
                                    <span className="info-value">{state.personality}</span>
                                </div>
                            )}
                        </div>
                    </div>
                </section>

                {state?.housing && (
                    <section className="section">
                        <h2>Housing</h2>
                        <div className="panel">
                            <div className="info-grid info-grid-3col">
                                <div className="info-item">
                                    <span className="info-label">🏠 Status</span>
                                    <span className="info-value">{state.housing.status}</span>
                                </div>
                                <div className="info-item">
                                    <span className="info-label">📍 Property</span>
                                    <span className="info-value">
                                        {state.housing.propertyId ? (
                                            <Link to={`/properties/${state.housing.propertyId}`}>
                                                {formatPropertyName(state.housing.propertyName, state.housing.housingTier)}
                                            </Link>
                                        ) : '—'}
                                    </span>
                                </div>
                                <div className="info-item">
                                    <span className="info-label">💸 Rent</span>
                                    <span className="info-value">
                                        {state.housing.status === 'renting' && state.housing.rentPrice !== null
                                            ? `${formatSBYTE(state.housing.rentPrice)}/mo`
                                            : '—'}
                                    </span>
                                </div>
                                <div className="info-item">
                                    <span className="info-label">👤 Owner</span>
                                    <span className="info-value">
                                        {state.housing.ownerId && !isSelfOwnedHousing ? (
                                            <Link to={`/agents/${state.housing.ownerId}`}>
                                                {housingOwnerLabel}
                                            </Link>
                                        ) : (
                                            housingOwnerLabel
                                        )}
                                    </span>
                                </div>
                                {state.housing.cityId && (
                                    <div className="info-item">
                                        <span className="info-label">🏙️ City</span>
                                        <span className="info-value">
                                            {cityNameById.get(state.housing.cityId) || state.housing.cityId}
                                        </span>
                                    </div>
                                )}
                            </div>
                        </div>
                    </section>
                )}

                {/* Persona & Psychology */}
                {persona && (
                    <section className="section">
                        <h2>Persona</h2>
                        <div className="panel">
                            <div className="info-grid info-grid-3col">
                                <div className="info-item">
                                    <span className="info-label">😊 Mood</span>
                                    <span className="info-value">{persona.mood || '—'}</span>
                                </div>
                                <div className="info-item">
                                    <span className="info-label">🏛️ Class</span>
                                    <span className="info-value">{persona.classIdentity || '—'}</span>
                                </div>
                                <div className="info-item">
                                    <span className="info-label">🗳️ Politics</span>
                                    <span className="info-value">{persona.politicalLeaning || '—'}</span>
                                </div>
                                <div className="info-item">
                                    <span className="info-label">😰 Stress</span>
                                    <span className="info-value">{safeNum(persona.stress)}/100</span>
                                </div>
                                <div className="info-item">
                                    <span className="info-label">😌 Satisfaction</span>
                                    <span className="info-value">{safeNum(persona.satisfaction)}/100</span>
                                </div>
                                <div className="info-item">
                                    <span className="info-label">💪 Confidence</span>
                                    <span className="info-value">{safeNum(persona.confidence)}/100</span>
                                </div>
                                <div className="info-item">
                                    <span className="info-label">😔 Loneliness</span>
                                    <span className="info-value">{safeNum(persona.loneliness)}/100</span>
                                </div>
                            </div>

                            {/* Fears, Ambitions, Grudges, Loyalties */}
                            <div className="persona-traits">
                                {persona.fears && persona.fears.length > 0 && (
                                    <div className="trait-row">
                                        <span className="trait-label">😨 Fears:</span>
                                        <div className="trait-tags">
                                            {persona.fears.map((f: string, i: number) => <span key={i} className="badge badge-danger">{f}</span>)}
                                        </div>
                                    </div>
                                )}
                                {persona.ambitions && persona.ambitions.length > 0 && (
                                    <div className="trait-row">
                                        <span className="trait-label">🌟 Ambitions:</span>
                                        <div className="trait-tags">
                                            {persona.ambitions.map((a: string, i: number) => <span key={i} className="badge badge-wealth">{a}</span>)}
                                        </div>
                                    </div>
                                )}
                                {persona.grudges && persona.grudges.length > 0 && (
                                    <div className="trait-row">
                                        <span className="trait-label">😤 Grudges:</span>
                                        <div className="trait-tags">
                                            {persona.grudges.map((g: string, i: number) => <span key={i} className="badge badge-status">{g}</span>)}
                                        </div>
                                    </div>
                                )}
                                {persona.loyalties && persona.loyalties.length > 0 && (
                                    <div className="trait-row">
                                        <span className="trait-label">🤝 Loyalties:</span>
                                        <div className="trait-tags">
                                            {persona.loyalties.map((l: string, i: number) => <span key={i} className="badge badge-job">{l}</span>)}
                                        </div>
                                    </div>
                                )}
                                {persona.activeGoals && persona.activeGoals.length > 0 && (
                                    <div className="trait-row">
                                        <span className="trait-label">🎯 Active Goals:</span>
                                        <div className="trait-tags">
                                            {persona.activeGoals.map((g: string, i: number) => <span key={i} className="badge badge-job">{g}</span>)}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </section>
                )}

                {/* Top Relationships */}
                {topRelationships.length > 0 && (
                    <section className="section">
                        <h2>🤝 Top Relationships</h2>
                        <div className="relationships-list">
                            {topRelationships.map((rel: Relationship) => (
                                <Link key={rel.counterpart.id} to={`/agents/${rel.counterpart.id}`} className="card card-clickable relationship-card">
                                    <Avatar actorId={rel.counterpart.id} actorName={rel.counterpart.name} size={40} />
                                    <div className="rel-info">
                                        <span className="value">{rel.counterpart.name}</span>
                                        <span className="badge badge-status">{rel.relationshipType}</span>
                                    </div>
                                    <div className="rel-scores">
                                        <span className="label">Strength: {safeNum(rel.strength)}</span>
                                        <span className="label">Trust: {safeNum(rel.trust)}</span>
                                        <span className="label">Romance: {safeNum(rel.romance)}</span>
                                    </div>
                                </Link>
                            ))}
                        </div>
                    </section>
                )}

                {/* Friends */}
                {friends.length > 0 && (
                    <section className="section">
                        <h2>😊 Friends ({friends.length})</h2>
                        <div className="relationships-list">
                            {friends.slice(0, 6).map((rel: Relationship) => (
                                <Link key={rel.counterpart.id} to={`/agents/${rel.counterpart.id}`} className="card card-clickable relationship-card">
                                    <Avatar actorId={rel.counterpart.id} actorName={rel.counterpart.name} size={32} />
                                    <div className="rel-info">
                                        <span className="value">{rel.counterpart.name}</span>
                                        <span className="badge badge-job">{rel.relationshipType}</span>
                                    </div>
                                    <div className="rel-scores">
                                        <span className="label">Strength: {safeNum(rel.strength)}</span>
                                        <span className="label">Trust: {safeNum(rel.trust)}</span>
                                    </div>
                                </Link>
                            ))}
                        </div>
                    </section>
                )}

                {/* Allies */}
                {allies.length > 0 && (
                    <section className="section">
                        <h2>🛡️ Allies ({allies.length})</h2>
                        <div className="relationships-list">
                            {allies.slice(0, 6).map((rel: Relationship) => (
                                <Link key={rel.counterpart.id} to={`/agents/${rel.counterpart.id}`} className="card card-clickable relationship-card">
                                    <Avatar actorId={rel.counterpart.id} actorName={rel.counterpart.name} size={32} />
                                    <div className="rel-info">
                                        <span className="value">{rel.counterpart.name}</span>
                                        <span className="badge badge-wealth">{rel.relationshipType}</span>
                                    </div>
                                    <div className="rel-scores">
                                        <span className="label">Strength: {safeNum(rel.strength)}</span>
                                        <span className="label">Trust: {safeNum(rel.trust)}</span>
                                    </div>
                                </Link>
                            ))}
                        </div>
                    </section>
                )}

                {/* Enemies */}
                {enemies.length > 0 && (
                    <section className="section">
                        <h2>😠 Enemies ({enemies.length})</h2>
                        <div className="relationships-list">
                            {enemies.slice(0, 6).map((rel: Relationship) => (
                                <Link key={rel.counterpart.id} to={`/agents/${rel.counterpart.id}`} className="card card-clickable relationship-card">
                                    <Avatar actorId={rel.counterpart.id} actorName={rel.counterpart.name} size={32} />
                                    <div className="rel-info">
                                        <span className="value">{rel.counterpart.name}</span>
                                        <span className="badge badge-danger">{rel.relationshipType}</span>
                                    </div>
                                    <div className="rel-scores">
                                        <span className="label">Strength: {safeNum(rel.strength)}</span>
                                        <span className="label">Betrayal: {safeNum(rel.betrayal)}</span>
                                    </div>
                                </Link>
                            ))}
                        </div>
                    </section>
                )}

                {/* All Relationships summary (if others exist) */}
                {allRelationships.length > friends.length + enemies.length + allies.length && (
                    <section className="section">
                        <h2>All Relationships ({allRelationships.length})</h2>
                        <div className="relationships-list">
                            {allRelationships.map((rel: Relationship) => (
                                <Link key={rel.counterpart.id} to={`/agents/${rel.counterpart.id}`} className="card card-clickable relationship-card">
                                    <Avatar actorId={rel.counterpart.id} actorName={rel.counterpart.name} size={28} />
                                    <div className="rel-info">
                                        <span className="value">{rel.counterpart.name}</span>
                                        <span className="badge badge-status">{rel.relationshipType}</span>
                                    </div>
                                    <div className="rel-scores">
                                        <span className="label">Strength: {safeNum(rel.strength)}</span>
                                        <span className="label">Trust: {safeNum(rel.trust)}</span>
                                        <span className="label">Romance: {safeNum(rel.romance)}</span>
                                    </div>
                                </Link>
                            ))}
                        </div>
                    </section>
                )}

                {/* Goals */}
                {goals && goals.length > 0 && (
                    <section className="section">
                        <h2>🎯 Goals</h2>
                        <div className="goals-list">
                            {goals.map((goal: AgentGoal) => (
                                <div key={goal.id} className="card">
                                    <div className="goal-header">
                                        <span className="goal-type">{goal.goalType}</span>
                                        <span className="badge badge-status">{goal.status}</span>
                                    </div>
                                    <p>{goal.target}</p>
                                    <div className="goal-progress">
                                        <div className="progress-bar">
                                            <div className="progress-fill" style={{ width: `${safePercent(goal.progress)}%` }} />
                                        </div>
                                        <span className="label">{safeNum(goal.progress)}% • Attempts: {safeNum(goal.attempts)}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>
                )}

                {/* Inventory */}
                {inventory && inventory.length > 0 && (
                    <section className="section">
                        <h2>🎒 Inventory</h2>
                        <div className="inventory-grid">
                            {inventory.map((item: InventoryItem) => (
                                <div key={item.itemDefId} className="card">
                                    <div className="item-name">{formatItemName(item.itemName)}</div>
                                    <div className="item-stats">
                                        <span className="label">Qty: {safeNum(item.quantity)}</span>
                                        <span className="label">Quality: {safeNum(item.quality)}%</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>
                )}

                {ownedBusinesses.length > 0 && (
                    <section className="section">
                        <h2>🏢 Businesses</h2>
                        <div className="inventory-grid">
                            {ownedBusinesses.map((business: ActorBusiness) => (
                                <div key={business.id} className="card">
                                    <div className="item-name">
                                        <Link to={`/businesses/${business.id}`}>{business.name}</Link>
                                    </div>
                                    <div className="item-stats">
                                        <span className="label">Kind: {business.businessType}</span>
                                        <span className="label">City: {business.cityId}</span>
                                        <span className="label">Employees: {safeNum(business.employeeCount ?? 0)}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>
                )}

                {ownedProperties.length > 0 && (
                    <section className="section">
                        <h2>🏠 Properties</h2>
                        <div className="inventory-grid">
                            {ownedProperties.map((property: ActorProperty) => (
                                <div key={property.id} className="card">
                                    <div className="item-name">
                                        <Link to={`/properties/${property.id}`}>
                                            {formatPropertyName(property.propertyName, property.housingTier)}
                                        </Link>
                                    </div>
                                    <div className="item-stats">
                                        <span className="label">Kind: {formatHousingTier(property.lotType || property.housingTier)}</span>
                                        <span className="label">
                                            City: {property.cityName || cityNameById.get(property.cityId) || property.cityId}
                                        </span>
                                        {property.terrainArea ? (
                                            <span className="label">Size: {safeNum(property.terrainArea)} m²</span>
                                        ) : null}
                                        {property.forSale && property.salePrice ? (
                                            <span className="label">For sale: {formatSBYTE(property.salePrice)}</span>
                                        ) : null}
                                        {property.tenantId ? (
                                            property.tenantId === actor.id ? (
                                                <span className="label">Occupied by owner</span>
                                            ) : (
                                                <span className="label">
                                                    Rented to{' '}
                                                    <Link to={`/agents/${property.tenantId}`}>
                                                        {property.tenantName || property.tenantId}
                                                    </Link>
                                                    {property.rentPrice ? ` • ${formatSBYTE(property.rentPrice)}/mo` : ''}
                                                </span>
                                            )
                                        ) : (
                                            <span className="label">Vacant</span>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>
                )}

                {financeSummary && (
                    <section className="section">
                        <h2>📊 Property & Gambling</h2>
                        <div className="panel">
                            <div className="info-grid info-grid-3col">
                                <div className="info-item">
                                    <span className="info-label">🏘️ Rent income</span>
                                    <span className="info-value">{formatSBYTE(financeSummary.rentEarned)}</span>
                                </div>
                                <div className="info-item">
                                    <span className="info-label">💸 Rent spent</span>
                                    <span className="info-value">{formatSBYTE(financeSummary.rentSpent)}</span>
                                </div>
                                <div className="info-item">
                                    <span className="info-label">🏡 Real estate earned</span>
                                    <span className="info-value">{formatSBYTE(financeSummary.realEstateEarned)}</span>
                                </div>
                                <div className="info-item">
                                    <span className="info-label">🏗️ Real estate spent</span>
                                    <span className="info-value">{formatSBYTE(financeSummary.realEstateSpent)}</span>
                                </div>
                                <div className="info-item">
                                    <span className="info-label">🎲 Gambling won</span>
                                    <span className="info-value">{formatSBYTE(financeSummary.gambleWon)}</span>
                                </div>
                                <div className="info-item">
                                    <span className="info-label">🎲 Gambling lost</span>
                                    <span className="info-value">{formatSBYTE(financeSummary.gambleLost)}</span>
                                </div>
                            </div>
                        </div>
                    </section>
                )}

                {state?.pendingGameChallenges && state.pendingGameChallenges.length > 0 && (
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

                {/* Recent Events */}
                {visibleRecentEvents.length > 0 && (
                    <section className="section">
                        <h2>📋 Recent Activity</h2>
                        <div className="events-list">
                            {visibleRecentEvents.map((event: Event) => (
                                <div key={event.id} className="event-row">
                                    <img src={getEventIcon(event.eventType)} alt="" className="event-icon-img" width={20} height={20} />
                                    <span className="event-label"><EventDescription event={event} /></span>
                                    <span className="label event-tick">tick {event.tick}</span>
                                </div>
                            ))}
                        </div>
                    </section>
                )}

                {/* Memories */}
                {memories && memories.length > 0 && (
                    <section className="section">
                        <h2>🧠 Memories</h2>
                        <div className="memories-list">
                            {memories.map((memory: AgentMemory) => (
                                <div key={memory.id} className="card">
                                    <p>{memory.content}</p>
                                    <div className="memory-meta">
                                        <span className="label">Importance: {safeNum(memory.importance)}</span>
                                        <span className="label">Tick: {memory.tick}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>
                )}
            </div>
        </div>
    );
};

export default AgentDetail;
