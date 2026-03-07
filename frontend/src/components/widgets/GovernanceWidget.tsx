// Governance Widget - Sidebar widget showing governance stats

import React from 'react';
import Icon from '@/components/common/Icon';
import { useCities, useCityDetail, useGovernanceProposals, useGovernanceElections } from '@/api/hooks';
import './GovernanceWidget.css';

const GovernanceWidget: React.FC = () => {
    const { data: cities } = useCities();
    const mainCity = cities?.[0];
    const { data: cityDetail } = useCityDetail(mainCity?.id || '');
    const { data: proposalsData } = useGovernanceProposals(mainCity?.id || '');
    const { data: electionsData } = useGovernanceElections(mainCity?.id || '');

    const proposalCount = proposalsData?.proposals?.length || 0;
    const currentElection = electionsData?.current;

    return (
        <div className="widget governance-widget">
            <h3 className="widget-title">
                <Icon name="governance" emoji="🏛️" size={16} />
                <span className="widget-title-text">Governance</span>
            </h3>

            <div className="widget-content">
                <div className="widget-row">
                    <span className="widget-label">Mayor:</span>
                    <span className="widget-value">{cityDetail?.mayor?.name || 'None'}</span>
                </div>

                <div className="widget-row">
                    <span className="widget-label">Proposals:</span>
                    <span className="widget-value">{proposalCount}</span>
                </div>

                <div className="widget-row">
                    <span className="widget-label">Election:</span>
                    <span className="widget-value">
                        {currentElection ? currentElection.status : 'No active'}
                    </span>
                </div>

                <div className="widget-row">
                    <span className="widget-label">Trade Tax:</span>
                    <span className="widget-value">
                        {cityDetail?.policy
                            ? `${(Number.parseFloat(cityDetail.policy.tradeTaxRate) * 100).toFixed(1)}%`
                            : '—'}
                    </span>
                </div>
            </div>
        </div>
    );
};

export default GovernanceWidget;
