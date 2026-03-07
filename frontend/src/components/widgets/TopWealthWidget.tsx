// Top Wealth Widget - Sidebar widget showing top 5 balances

import React from 'react';
import { Link } from 'react-router-dom';
import Icon from '@/components/common/Icon';
import { useWealthLeaderboard } from '@/api/hooks';
import type { WealthRanking } from '@/api/types';
import { formatSBYTE } from '@/utils/format';
import './TopWealthWidget.css';

const TopWealthWidget: React.FC = () => {
    const { data, isLoading } = useWealthLeaderboard();
    const topWealth = (data?.leaderboard ?? []).slice(0, 5);

    return (
        <div className="widget top-wealth-widget">
            <h3 className="widget-title">
                <Icon name="wallet" emoji="💰" size={16} />
                <span className="widget-title-text">Top 5 Wealth</span>
            </h3>

            <div className="widget-content">
                {isLoading ? (
                    <p className="label">Loading...</p>
                ) : topWealth.length > 0 ? (
                    topWealth.map((entry: WealthRanking, index: number) => (
                        <div key={entry.actorId} className="wealth-row">
                            <span className="wealth-rank">#{index + 1}</span>
                            <Link to={`/agents/${entry.actorId}`} className="wealth-name">
                                {entry.actorName || entry.actorId}
                            </Link>
                            <span className="wealth-balance">{formatSBYTE(entry.balance)}</span>
                        </div>
                    ))
                ) : (
                    <p className="label">No wealth data yet</p>
                )}
            </div>
        </div>
    );
};

export default TopWealthWidget;
