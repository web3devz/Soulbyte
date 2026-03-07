// Property Detail Page

import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { usePropertyDetail } from '@/api/hooks';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import PageTitle from '@/components/common/PageTitle';
import { formatSBYTE } from '@/utils/format';
import './PropertyDetail.css';

const PropertyDetail: React.FC = () => {
    const { id } = useParams<{ id: string }>();
    const { data: property, isLoading } = usePropertyDetail(id || '');

    if (isLoading) {
        return <LoadingSpinner />;
    }

    if (!property) {
        return <div className="empty-state">Property not found</div>;
    }

    const propertyName = property.propertyName || property.housingTier || 'Property';
    const isSelfOccupied = Boolean(property.ownerId && property.tenantId && property.ownerId === property.tenantId);
    const ownerLabel = property.ownerId ? (property.ownerName || property.ownerId) : 'City House';

    return (
        <div className="property-detail">
            <PageTitle iconName="housing" emoji="🏠">{propertyName}</PageTitle>

            <section className="section">
                <div className="panel">
                    <div className="info-grid info-grid-3col">
                        <div className="info-item">
                            <span className="info-label">🏷️ Kind</span>
                            <span className="info-value">{property.lotType || property.housingTier}</span>
                        </div>
                        <div className="info-item">
                            <span className="info-label">🏙️ City</span>
                            <span className="info-value">{property.cityName || property.cityId}</span>
                        </div>
                        <div className="info-item">
                            <span className="info-label">🧱 Condition</span>
                            <span className="info-value">{property.condition ?? '—'}</span>
                        </div>
                        <div className="info-item">
                            <span className="info-label">📐 Size</span>
                            <span className="info-value">{property.terrainArea ? `${property.terrainArea} m²` : '—'}</span>
                        </div>
                        <div className="info-item">
                            <span className="info-label">💸 Rent</span>
                            <span className="info-value">{property.rentPrice ? `${formatSBYTE(property.rentPrice)}/mo` : '—'}</span>
                        </div>
                        <div className="info-item">
                            <span className="info-label">🏷️ For Sale</span>
                            <span className="info-value">
                                {property.forSale && property.salePrice ? formatSBYTE(property.salePrice) : 'No'}
                            </span>
                        </div>
                        <div className="info-item">
                            <span className="info-label">👤 Owner</span>
                            <span className="info-value">
                                {property.ownerId && !isSelfOccupied ? (
                                    <Link to={`/agents/${property.ownerId}`}>{ownerLabel}</Link>
                                ) : (
                                    ownerLabel
                                )}
                            </span>
                        </div>
                        <div className="info-item">
                            <span className="info-label">🧑‍🤝‍🧑 Tenant</span>
                            <span className="info-value">
                                {property.tenantId ? (
                                    <Link to={`/agents/${property.tenantId}`}>{property.tenantName || property.tenantId}</Link>
                                ) : 'Vacant'}
                            </span>
                        </div>
                    </div>
                </div>
            </section>
        </div>
    );
};

export default PropertyDetail;
