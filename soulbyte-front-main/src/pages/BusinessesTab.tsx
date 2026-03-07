// Businesses Tab Page - City-wide business overview

import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useBusinesses, useCities } from '@/api/hooks';
import type { BusinessSummary, City } from '@/api/types';
import PageTitle from '@/components/common/PageTitle';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { formatSBYTE } from '@/utils/format';
import './BusinessesTab.css';

const BusinessesTab: React.FC = () => {
    const { data: businesses, isLoading } = useBusinesses({ sortBy: 'netWorth' });
    const { data: cities } = useCities();
    const [searchTerm, setSearchTerm] = useState('');

    const cityNameById = useMemo(() => {
        const map = new Map<string, string>();
        (cities ?? []).forEach((city: City) => map.set(city.id, city.name));
        return map;
    }, [cities]);

    const filtered = (businesses ?? []).filter((business) => {
        if (!searchTerm) return true;
        return business.name.toLowerCase().includes(searchTerm.toLowerCase());
    });

    if (isLoading) {
        return <LoadingSpinner />;
    }

    return (
        <div className="businesses-tab">
            <PageTitle iconName="wallet" emoji="🏪">Businesses</PageTitle>

            <div className="businesses-filters">
                <input
                    type="search"
                    placeholder="Search businesses..."
                    value={searchTerm}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchTerm(e.target.value)}
                    className="search-input"
                />
            </div>

            <div className="business-grid">
                {filtered.length > 0 ? (
                    filtered.map((business: BusinessSummary) => (
                        <Link key={business.id} to={`/businesses/${business.id}`} className="business-card">
                            <div className="business-card-header">
                                <span className={`badge badge-${business.status === 'operational' ? 'wealth' : 'status'}`}>
                                    {business.status}
                                </span>
                                <span className="badge badge-job">Lv.{business.level}</span>
                            </div>
                            <h3>{business.name}</h3>
                            <p className="label">{business.category}</p>
                            <div className="business-meta">
                                <span className="label">Owner: {business.ownerName || business.ownerId}</span>
                                <span className="label">City: {cityNameById.get(business.cityId) || business.cityId}</span>
                                <span className="label">Employees: {business.employeeCount}/{business.maxEmployees}</span>
                                <span className="label">Treasury: {formatSBYTE(business.treasury)}</span>
                            </div>
                        </Link>
                    ))
                ) : (
                    <div className="empty-state">
                        <div className="empty-state-icon">🏪</div>
                        <p className="empty-state-text">No businesses found</p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default BusinessesTab;
