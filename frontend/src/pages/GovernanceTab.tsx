// Governance Tab Page - S5

import React from 'react';
import { useCities, useCityDetail, useGovernanceProposals, useGovernanceElections } from '@/api/hooks';
import PageTitle from '@/components/common/PageTitle';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import './GovernanceTab.css';

const GovernanceTab: React.FC = () => {
    const { data: cities, isLoading } = useCities();
    const mainCity = cities?.[0];
    const { data: cityDetail } = useCityDetail(mainCity?.id || '');
    const { data: proposalsData } = useGovernanceProposals(mainCity?.id || '');
    const { data: electionsData } = useGovernanceElections(mainCity?.id || '');

    if (isLoading) {
        return <LoadingSpinner />;
    }

    const proposals = proposalsData?.proposals || [];
    const currentElection = electionsData?.current;
    const electionHistory = electionsData?.history || [];
    const policy = cityDetail?.policy;

    const rentTax = policy ? (parseFloat(policy.rentTaxRate) * 100).toFixed(2) : '—';
    const tradeTax = policy ? (parseFloat(policy.tradeTaxRate) * 100).toFixed(2) : '—';
    const professionTax = policy ? (parseFloat(policy.professionTaxRate) * 100).toFixed(2) : '—';
    const propertyTax = policy ? (parseFloat(policy.propertyTaxRate) * 100).toFixed(2) : '—';

    return (
        <div className="governance-tab">
            <PageTitle iconName="governance" emoji="🏛️">Governance</PageTitle>

            <section className="section">
                <h2>City Government</h2>
                <div className="panel">
                    <div className="gov-grid">
                        <div><span className="label">City:</span> <span className="value">{mainCity?.name || 'Genesis City'}</span></div>
                        <div><span className="label">Mayor:</span> <span className="value">{cityDetail?.mayor?.name || 'None elected'}</span></div>
                        <div><span className="label">Population:</span> <span className="value">{mainCity?.population || 0}</span></div>
                        <div><span className="label">Reputation:</span> <span className="value">{mainCity?.reputationScore || 0}/100</span></div>
                    </div>
                </div>
            </section>

            <section className="section">
                <h2>Tax Rates</h2>
                <div className="panel">
                    <div className="tax-grid">
                        <div className="tax-item">
                            <span className="tax-label">Rent Tax</span>
                            <span className="tax-value">{rentTax}%</span>
                        </div>
                        <div className="tax-item">
                            <span className="tax-label">Trade Tax</span>
                            <span className="tax-value">{tradeTax}%</span>
                        </div>
                        <div className="tax-item">
                            <span className="tax-label">Profession Tax</span>
                            <span className="tax-value">{professionTax}%</span>
                        </div>
                        <div className="tax-item">
                            <span className="tax-label">Property Tax</span>
                            <span className="tax-value">{propertyTax}%</span>
                        </div>
                    </div>
                </div>
            </section>

            <section className="section">
                <h2>Recent Proposals</h2>
                {proposals.length > 0 ? (
                    <div className="proposals-list">
                        {proposals.map((proposal) => (
                            <div key={proposal.id} className="card">
                                <div className="proposal-header">
                                    <span className="badge badge-job">{proposal.type}</span>
                                    <span className="badge badge-status">{proposal.status}</span>
                                </div>
                                {proposal.mayor && (
                                    <p className="label">Proposed by: {proposal.mayor.name}</p>
                                )}
                                <p className="label">{new Date(proposal.createdAt).toLocaleDateString()}</p>
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="empty-state">
                        <div className="empty-state-icon">📋</div>
                        <p className="empty-state-text">No proposals yet</p>
                    </div>
                )}
            </section>

            <section className="section">
                <h2>Elections</h2>
                {currentElection ? (
                    <div className="panel">
                        <p className="label mb-sm">
                            Status: <strong>{currentElection.status}</strong> (Cycle {currentElection.cycle})
                        </p>
                        {currentElection.candidates.length > 0 && (
                            <div className="candidates-list">
                                {currentElection.candidates.map((c) => (
                                    <div key={c.id} className="candidate-item">
                                        <span className="value">{c.name}</span>
                                        <span className="label">{c.voteCount} votes</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                ) : electionHistory.length > 0 ? (
                    <div className="panel">
                        <p className="label mb-sm">Last election winner: <strong>{electionHistory[0].winnerName || 'Unknown'}</strong></p>
                        <p className="label">Total votes: {electionHistory[0].totalVotes}</p>
                    </div>
                ) : (
                    <div className="panel">
                        <p className="label">No elections recorded yet</p>
                    </div>
                )}
            </section>
        </div>
    );
};

export default GovernanceTab;
