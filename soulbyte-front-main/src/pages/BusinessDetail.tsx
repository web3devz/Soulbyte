// Business Detail Page

import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useBusinessDetail } from '@/api/hooks';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import PageTitle from '@/components/common/PageTitle';
import { formatSBYTE, truncateAddress } from '@/utils/format';
import './BusinessDetail.css';

const BusinessDetail: React.FC = () => {
    const { id } = useParams<{ id: string }>();
    const { data: business, isLoading } = useBusinessDetail(id || '');

    if (isLoading) {
        return <LoadingSpinner />;
    }

    if (!business) {
        return <div className="empty-state">Business not found</div>;
    }

    const activeEmployees = (business.employments ?? []).filter((employment) => employment.status === 'ACTIVE');
    const topEmployees = activeEmployees.slice(0, 10);

    const formatToken = (value: string | number, suffix: string) => {
        const num = typeof value === 'string' ? Number.parseFloat(value) : value;
        if (!Number.isFinite(num)) return `0 ${suffix}`;
        return `${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${suffix}`;
    };

    return (
        <div className="business-detail">
            <PageTitle iconName="wallet" emoji="🏪">{business.name}</PageTitle>

            <section className="section">
                <div className="panel">
                    <div className="info-grid info-grid-3col">
                        <div className="info-item">
                            <span className="info-label">🏷️ Kind</span>
                            <span className="info-value">{business.businessType}</span>
                        </div>
                        <div className="info-item">
                            <span className="info-label">🏙️ Location</span>
                            <span className="info-value">{business.cityName || business.cityId}</span>
                        </div>
                        <div className="info-item">
                            <span className="info-label">👤 Owner</span>
                            <span className="info-value">
                                <Link to={`/agents/${business.ownerId}`}>{business.ownerName || business.ownerId}</Link>
                            </span>
                        </div>
                        <div className="info-item">
                            <span className="info-label">📊 Status</span>
                            <span className="info-value">{business.status}</span>
                        </div>
                        <div className="info-item">
                            <span className="info-label">⭐ Reputation</span>
                            <span className="info-value">{business.reputation}/100</span>
                        </div>
                        <div className="info-item">
                            <span className="info-label">🧱 Level</span>
                            <span className="info-value">Lv.{business.level}</span>
                        </div>
                        <div className="info-item">
                            <span className="info-label">👥 Employees</span>
                            <span className="info-value">{activeEmployees.length}/{business.maxEmployees}</span>
                        </div>
                        <div className="info-item">
                            <span className="info-label">💰 Treasury</span>
                            <span className="info-value">{formatSBYTE(business.treasury)}</span>
                        </div>
                        {business.netWorth !== undefined && (
                            <div className="info-item">
                                <span className="info-label">📈 Net Worth</span>
                                <span className="info-value">{formatSBYTE(business.netWorth)}</span>
                            </div>
                        )}
                        {business.customerSatisfaction !== null && business.customerSatisfaction !== undefined && (
                            <div className="info-item">
                                <span className="info-label">😊 Satisfaction</span>
                                <span className="info-value">{business.customerSatisfaction}/100</span>
                            </div>
                        )}
                    </div>
                </div>
            </section>

            <section className="section">
                <h2>Public Wallet</h2>
                <div className="panel">
                    {business.wallet ? (
                        <div className="wallet-info">
                            <div><span className="label">Address:</span> <code>{truncateAddress(business.wallet.walletAddress)}</code></div>
                            <div><span className="label">MON Balance:</span> {formatToken(business.wallet.balanceMon, 'MON')}</div>
                            <div><span className="label">SBYTE Balance:</span> {formatSBYTE(business.wallet.balanceSbyte)}</div>
                        </div>
                    ) : (
                        <p className="label">No wallet linked yet</p>
                    )}
                </div>
            </section>

            <section className="section">
                <h2>Employees</h2>
                <div className="panel">
                    {topEmployees.length > 0 ? (
                        <div className="employees-list">
                            {topEmployees.map((employment) => (
                                <div key={employment.id} className="employee-row">
                                    <Link to={`/agents/${employment.agent?.id}`} className="employee-name">
                                        {employment.agent?.name || employment.agent?.id || 'Unknown'}
                                    </Link>
                                    <span className="label">
                                        {employment.agent?.agentState?.jobType || 'employee'}
                                    </span>
                                    <span className="label">
                                        {formatSBYTE(employment.salaryDaily)} / day
                                    </span>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <p className="label">No employees yet</p>
                    )}
                </div>
            </section>
        </div>
    );
};

export default BusinessDetail;
