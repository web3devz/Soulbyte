// Economy Tab Page - S4

import React from 'react';
import PageTitle from '@/components/common/PageTitle';
import { useTransactionCount, useMarketListings, useCities, useCityEconomy } from '@/api/hooks';
import { formatSBYTE } from '@/utils/format';
import type { MarketListing } from '@/api/types';
import './EconomyTab.css';

const EconomyTab: React.FC = () => {
    const { data: cities } = useCities();
    const mainCity = cities?.[0];
    const { data: txCount } = useTransactionCount();
    const { data: marketData } = useMarketListings({ limit: 20, sort: 'price_desc' });
    const { data: economy } = useCityEconomy(mainCity?.id || '');

    const listings = marketData?.listings || [];

    return (
        <div className="economy-tab">
            <PageTitle iconName="economy" emoji="💰">Economy</PageTitle>

            <div className="section-header-bar">
                <h2>Market Overview</h2>
            </div>

            <div className="stats-grid">
                <div className="stat-card">
                    <div className="stat-label">Onchain Transactions</div>
                    <div className="stat-value">{txCount ? txCount.count.toLocaleString() : '—'}</div>
                </div>
                {/* 
                <div className="stat-card">
                    <div className="stat-label">Avg Rent</div>
                    <div className="stat-value">
                        {economy && !Number.isNaN(economy.avg_rent) && economy.avg_rent > 0
                            ? `${Math.round(economy.avg_rent)} SBYTE`
                            : '0 SBYTE'}
                    </div>
                </div>
                <div className="stat-card">
                    <div className="stat-label">Avg Salary</div>
                    <div className="stat-value">
                        {economy && !Number.isNaN(economy.avg_salary) && economy.avg_salary > 0
                            ? `${Math.round(economy.avg_salary)} SBYTE`
                            : '0 SBYTE'}
                    </div>
                </div>
                */}
                <div className="stat-card">
                    <div className="stat-label">Unemployment</div>
                    <div className="stat-value">{economy ? `${(economy.unemployment_rate * 100).toFixed(1)}%` : '—'}</div>
                </div>
            </div>

            <div className="section-header-bar mt-lg">
                <h2>Market Listings</h2>
            </div>

            {listings.length > 0 ? (
                <div className="market-listings">
                    <div className="listing-header">
                        <span>Item</span>
                        <span>Seller</span>
                        <span>Qty</span>
                        <span>Price</span>
                    </div>
                    {listings.map((listing: MarketListing) => (
                        <div key={listing.id} className="listing-row">
                            <span className="listing-item">
                                {listing.item.displayName || listing.item.description || listing.item.name}
                            </span>
                            <span className="listing-seller">{listing.seller.name}</span>
                            <span className="listing-qty">{listing.quantity}</span>
                            <span className="listing-price">{formatSBYTE(Number.parseFloat(listing.priceEach))}</span>
                        </div>
                    ))}
                </div>
            ) : (
                <div className="empty-state">
                    <div className="empty-state-icon">🏪</div>
                    <p className="empty-state-text">No active market listings</p>
                </div>
            )}
        </div>
    );
};

export default EconomyTab;
