import React from 'react';
import { Link } from 'react-router-dom';
import Avatar from '@/components/common/Avatar';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import './AgentHorizontalList.css';

interface AgentSummary {
    id: string;
    name: string;
    walletAddress?: string | null;
    reputation?: number;
    wallet?: {
        balanceSbyte: string;
    } | null;
}

interface AgentHorizontalListProps {
    title: string;
    agents: AgentSummary[];
    isLoading: boolean;
}

const AgentHorizontalList: React.FC<AgentHorizontalListProps> = ({ title, agents, isLoading }) => {
    return (
        <div className="agent-horizontal-list-container">
            <h3 className="section-title">{title}</h3>

            {isLoading ? (
                <div className="agent-list-loading">
                    <LoadingSpinner />
                </div>
            ) : agents.length > 0 ? (
                <div className="agent-horizontal-scroll">
                    {agents.map(agent => (
                        <div key={agent.id} className="agent-card">
                            <div className="agent-card-header">
                                <Avatar actorId={agent.id} actorName={agent.name} size={48} />
                            </div>
                            <div className="agent-card-body">
                                <Link to={`/agents/${agent.id}`} className="agent-name-link">
                                    {agent.name}
                                </Link>
                                <div className="agent-balance">
                                    <span className="balance-amount">
                                        {agent.wallet?.balanceSbyte
                                            ? parseFloat(agent.wallet.balanceSbyte).toLocaleString(undefined, { maximumFractionDigits: 0 })
                                            : '0'}
                                    </span>
                                    <span className="balance-symbol">$SBYTE</span>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            ) : (
                <div className="empty-list">No agents found</div>
            )}
        </div>
    );
};

export default AgentHorizontalList;
