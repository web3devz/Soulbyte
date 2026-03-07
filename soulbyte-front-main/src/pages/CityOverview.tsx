// City Overview Page - S1

import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useCities, useCityDetail, useBusinesses, usePropertySummary, useProperties } from '@/api/hooks';
import { useAppStore } from '@/store/appStore';
import type { City, Property, BusinessSummary } from '@/api/types';
import PageTitle from '@/components/common/PageTitle';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { abbreviateNumber, formatSBYTE } from '@/utils/format';
import './CityOverview.css';

const PAGE_SIZE = 10;

function propertyPrice(prop: Property): string {
    if (prop.rentPrice) return formatSBYTE(prop.rentPrice) + '/mo';
    if (prop.salePrice) return formatSBYTE(prop.salePrice);
    return '—';
}

const CityOverview: React.FC = () => {
    const { activeCityId, setActiveCityId } = useAppStore();
    const { data: cities, isLoading: citiesLoading } = useCities();
    const [propPage, setPropPage] = useState(0);

    // Auto-select first city if none set
    useEffect(() => {
        if (!activeCityId && cities && cities.length > 0) {
            setActiveCityId(cities[0].id);
        }
    }, [activeCityId, cities, setActiveCityId]);

    const currentCityId = activeCityId || cities?.[0]?.id || '';
    const { data: city, isLoading: cityLoading } = useCityDetail(currentCityId);
    const { data: businesses } = useBusinesses({ cityId: currentCityId });
    const { data: propSummary } = usePropertySummary(currentCityId);
    const { data: propData } = useProperties(currentCityId, { limit: PAGE_SIZE, offset: propPage * PAGE_SIZE });

    if (citiesLoading || cityLoading) {
        return <LoadingSpinner />;
    }

    if (!city) {
        return <div className="empty-state">No city data available</div>;
    }

    const rentTax = city.policy ? (Number.parseFloat(city.policy.rentTaxRate) * 100).toFixed(2) : '—';
    const tradeTax = city.policy ? (Number.parseFloat(city.policy.tradeTaxRate) * 100).toFixed(2) : '—';
    const professionTax = city.policy ? (Number.parseFloat(city.policy.professionTaxRate) * 100).toFixed(2) : '—';
    const propertyTax = city.policy ? (Number.parseFloat(city.policy.propertyTaxRate) * 100).toFixed(2) : '—';
    const vaultBalance = city.vault?.balanceSbyte || '0';

    const properties = propData?.properties ?? [];
    const totalProperties = propData?.total ?? propSummary?.total ?? 0;
    const totalPages = Math.ceil(totalProperties / PAGE_SIZE);

    return (
        <div className="city-overview">
            <div className="city-header">
                <PageTitle iconName="city" emoji="🏙️">{city.name}</PageTitle>

                {cities && cities.length > 1 && (
                    <select
                        className="city-selector"
                        value={currentCityId}
                        onChange={(e) => {
                            setActiveCityId(e.target.value);
                            setPropPage(0);
                        }}
                    >
                        {cities.map((c: City) => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                    </select>
                )}
            </div>

            <div className="stats-grid">
                <div className="stat-card">
                    <div className="stat-label">Population</div>
                    <div className="stat-value">{city.population} / {city.populationCap}</div>
                </div>

                <div className="stat-card">
                    <div className="stat-label">Housing</div>
                    <div className="stat-value">{city.housingCapacity} units</div>
                </div>

                <div className="stat-card">
                    <div className="stat-label">Security</div>
                    <div className="stat-value">{city.securityLevel}/100</div>
                </div>

                <div className="stat-card">
                    <div className="stat-label">Health</div>
                    <div className="stat-value">{city.healthServices}/100</div>
                </div>

                <div className="stat-card">
                    <div className="stat-label">Entertainment</div>
                    <div className="stat-value">{city.entertainment}/100</div>
                </div>

                <div className="stat-card">
                    <div className="stat-label">Reputation</div>
                    <div className="stat-value">{city.reputationScore}/100</div>
                </div>
            </div>

            {businesses && businesses.length > 0 && (
                <section className="infrastructure-section">
                    <h2>Businesses</h2>
                    <div className="infrastructure-grid">
                        {businesses.map((biz: BusinessSummary) => (
                            <div key={biz.id} className="infrastructure-card">
                                <div className="infrastructure-icon">
                                    {biz.status === 'operational' ? '🟢' : '🔴'}
                                </div>
                                <h3>{biz.name}</h3>
                                <p className="label">{biz.category} • Lv.{biz.level}</p>
                            </div>
                        ))}
                    </div>
                </section>
            )}

            <section className="treasury-section">
                <h2>City Treasury</h2>
                <div className="panel">
                    <div className="treasury-stats">
                        <div>
                            <span className="label">Balance:</span>
                            <span className="value">{abbreviateNumber(Number.parseFloat(vaultBalance))} SBYTE</span>
                        </div>
                        <div>
                            <span className="label">Mayor:</span>
                            <span className="value">{city.mayor?.name || 'None elected'}</span>
                        </div>
                    </div>
                </div>
            </section>

            <section className="section">
                <h2>Tax Rates</h2>
                <div className="panel">
                    <div className="treasury-stats">
                        <div>
                            <span className="label">Rent Tax:</span>
                            <span className="value">{rentTax}%</span>
                        </div>
                        <div>
                            <span className="label">Trade Tax:</span>
                            <span className="value">{tradeTax}%</span>
                        </div>
                        <div>
                            <span className="label">Profession Tax:</span>
                            <span className="value">{professionTax}%</span>
                        </div>
                        <div>
                            <span className="label">Property Tax:</span>
                            <span className="value">{propertyTax}%</span>
                        </div>
                    </div>
                </div>
            </section>

            {/* Properties Section */}
            <section className="section">
                <h2>🏠 Properties</h2>
                {propSummary && (
                    <div className="stats-grid" style={{ marginBottom: 'var(--spacing-md)' }}>
                        <div className="stat-card">
                            <div className="stat-label">Total</div>
                            <div className="stat-value">{propSummary.total}</div>
                        </div>
                        <div className="stat-card">
                            <div className="stat-label">For Rent</div>
                            <div className="stat-value">{propSummary.availableForRent}</div>
                        </div>
                        <div className="stat-card">
                            <div className="stat-label">For Sale</div>
                            <div className="stat-value">{propSummary.availableForSale}</div>
                        </div>
                        <div className="stat-card">
                            <div className="stat-label">Occupied</div>
                            <div className="stat-value">{propSummary.occupied}</div>
                        </div>
                    </div>
                )}

                {properties.length > 0 ? (
                    <>
                        <div className="property-table">
                            <div className="prop-header">
                                <span>Name</span>
                                <span>Type</span>
                                <span>Owner</span>
                                <span>Status</span>
                                <span>Condition</span>
                                <span>Lot Size</span>
                                <span>Price</span>
                            </div>
                            {properties.map((prop: Property) => (
                                <div key={prop.id} className="prop-row">
                                    <span className="prop-name">{prop.name || '—'}</span>
                                    <span>{prop.propertyType || '—'}</span>
                                    <span className="prop-owner">
                                        {prop.ownerId ? (
                                            <Link to={`/agents/${prop.ownerId}`} className="prop-owner-link">
                                                {prop.ownerName || prop.ownerId}
                                            </Link>
                                        ) : 'City House'}
                                        {prop.status === 'occupied' && prop.tenantName && (
                                            <span className="prop-tenant"> 🏠 {prop.tenantName}</span>
                                        )}
                                        {prop.currentOccupants != null && prop.maxOccupants != null && (
                                            <span className="prop-occupants"> ({prop.currentOccupants}/{prop.maxOccupants})</span>
                                        )}
                                    </span>
                                    <span>
                                        <span className={`badge badge-${prop.status === 'occupied' ? 'status' : prop.status === 'available' ? 'wealth' : prop.status === 'for_sale' ? 'job' : prop.status === 'under_construction' ? 'job' : prop.status === 'abandoned' ? 'danger' : 'status'}`}>
                                            {prop.status || '—'}
                                        </span>
                                    </span>
                                    <span className="prop-condition">
                                        {prop.condition != null ? (
                                            <>
                                                <div className="condition-bar">
                                                    <div
                                                        className="condition-fill"
                                                        style={{
                                                            width: `${prop.condition}%`,
                                                            backgroundColor: prop.condition > 70 ? 'var(--accent-green)' : prop.condition > 40 ? 'var(--accent-amber)' : 'var(--accent-red)'
                                                        }}
                                                    />
                                                </div>
                                                <span className="condition-value">{prop.condition}</span>
                                            </>
                                        ) : '—'}
                                    </span>
                                    <span>{prop.lot_size ? `${prop.lot_size} m²` : '—'}</span>
                                    <span className="prop-price">
                                        {propertyPrice(prop)}
                                    </span>
                                </div>
                            ))}
                        </div>

                        {totalPages > 1 && (
                            <div className="pagination">
                                <button
                                    className="btn btn-secondary"
                                    disabled={propPage === 0}
                                    onClick={() => setPropPage((p) => p - 1)}
                                >
                                    ← Prev
                                </button>
                                <span className="pagination-info">
                                    Page {propPage + 1} of {totalPages}
                                </span>
                                <button
                                    className="btn btn-secondary"
                                    disabled={propPage >= totalPages - 1}
                                    onClick={() => setPropPage((p) => p + 1)}
                                >
                                    Next →
                                </button>
                            </div>
                        )}
                    </>
                ) : (
                    <p className="label">No properties found</p>
                )}
            </section>
        </div>
    );
};

export default CityOverview;
