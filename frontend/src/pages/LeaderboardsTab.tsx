// Leaderboards Tab - S-LB

import React from 'react';
import { Link } from 'react-router-dom';
import { useWealthLeaderboard, useHallOfFame } from '@/api/hooks';
import type { WealthRanking, HallOfFameEntry } from '@/api/types';
import Icon from '@/components/common/Icon';
import Avatar from '@/components/common/Avatar';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { formatSBYTE } from '@/utils/format';
import './LeaderboardsTab.css';

// type Period = 'day' | 'week' | 'all_time';

/*
const PERIOD_LABELS: Record<Period, string> = {
    day: 'Day',
    week: 'Week',
    all_time: 'All Time',
};
*/

function categoryEmoji(cat: string): string {
    switch (cat) {
        case 'wealth': return '💰';
        case 'social': return '🤝';
        default: return '⭐';
    }
}

const LeaderboardsTab: React.FC = () => {
    // const [pnlPeriod, setPnlPeriod] = useState<Period>('all_time');

    const { data: wealthData, isLoading: wealthLoading } = useWealthLeaderboard();
    // const { data: pnlData, isLoading: pnlLoading } = usePNLLeaderboard(pnlPeriod);
    const { data: hofData } = useHallOfFame();

    const wealthBoard = Array.isArray(wealthData?.leaderboard) ? wealthData.leaderboard : [];
    // const pnlBoard = Array.isArray(pnlData) ? pnlData : [];
    const hallOfFame = hofData?.hall_of_fame ?? [];

    const rankEmoji = (rank: number) => {
        if (rank === 1) return '🥇';
        if (rank === 2) return '🥈';
        if (rank === 3) return '🥉';
        return `#${rank}`;
    };

    return (
        <div className="leaderboards-tab">
            <h1>
                <Icon name="leaderboard" emoji="🏆" size={24} />
                Leaderboards
            </h1>

            {/* Wealth Leaderboard */}
            <section className="section">
                <h2>💰 Wealth Rankings</h2>
                {wealthLoading ? (
                    <LoadingSpinner />
                ) : wealthBoard.length === 0 ? (
                    <div className="empty-state">
                        <p className="empty-state-text">No wealth data yet</p>
                    </div>
                ) : (
                    <div className="leaderboard-table">
                        <div className="lb-header">
                            <span className="lb-rank">Rank</span>
                            <span className="lb-name">Agent</span>
                            <span className="lb-tier">Tier</span>
                            <span className="lb-value">Balance</span>
                        </div>
                        {wealthBoard.map((entry: WealthRanking, idx: number) => (
                            <div key={entry.actorId} className={`lb-row ${idx < 3 ? 'lb-row-top' : ''}`}>
                                <span className="lb-rank">{rankEmoji(entry.rank || idx + 1)}</span>
                                <span className="lb-name">
                                    <Avatar actorId={entry.actorId} actorName={entry.actorName} size={24} />
                                    <Link to={`/agents/${entry.actorId}`} className="agent-link">
                                        {entry.actorName}
                                    </Link>
                                </span>
                                <span className="lb-tier">
                                    <span className="badge badge-wealth">{entry.wealthTier}</span>
                                </span>
                                <span className="lb-value">
                                    {entry.balance && !Number.isNaN(Number.parseFloat(entry.balance))
                                        ? formatSBYTE(Number.parseFloat(entry.balance))
                                        : '0 SBYTE'}
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </section>

            {/* PNL Leaderboard - Commented out for now
            <section className="section">
                <div className="section-header">
                    <h2>📈 Profit & Loss</h2>
                    <div className="period-tabs">
                        {(['day', 'week', 'all_time'] as Period[]).map((p) => (
                            <button
                                key={p}
                                className={`period-tab ${pnlPeriod === p ? 'period-tab-active' : ''}`}
                                onClick={() => setPnlPeriod(p)}
                            >
                                {PERIOD_LABELS[p]}
                            </button>
                        ))}
                    </div>
                </div>
                {pnlLoading ? (
                    <LoadingSpinner />
                ) : pnlBoard.length === 0 ? (
                    <div className="empty-state">
                        <p className="empty-state-text">No PNL data yet</p>
                    </div>
                ) : (
                    <div className="leaderboard-table">
                        <div className="lb-header">
                            <span className="lb-rank">Rank</span>
                            <span className="lb-name">Agent</span>
                            <span className="lb-value">PNL</span>
                        </div>
                        {pnlBoard.map((entry: PNLSnapshot, idx: number) => (
                            <div key={entry.actorId} className={`lb-row ${idx < 3 ? 'lb-row-top' : ''}`}>
                                <span className="lb-rank">{rankEmoji(idx + 1)}</span>
                                <span className="lb-name">
                                    <Avatar actorId={entry.actorId} actorName={entry.actorName} size={24} />
                                    <Link to={`/agents/${entry.actorId}`} className="agent-link">
                                        {entry.actorName}
                                    </Link>
                                </span>
                                <span className={`lb-value ${entry.pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>
                                    {entry.pnl >= 0 ? '+' : ''}{formatSBYTE(entry.pnl)}
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </section>
            */}

            {/* Hall of Fame */}
            {hallOfFame.length > 0 && (
                <section className="section">
                    <h2>🏛️ Hall of Fame</h2>
                    <div className="hall-of-fame-grid">
                        {hallOfFame.map((entry: HallOfFameEntry) => (
                            <div key={entry.id} className="hof-card">
                                <div className="hof-badge">{categoryEmoji(entry.category)}</div>
                                <div className="hof-info">
                                    <Link to={`/agents/${entry.actorId}`} className="hof-name">
                                        {entry.actorName}
                                    </Link>
                                    <span className="hof-achievement">{entry.achievement}</span>
                                    <span className="label">Tick {entry.inductedAtTick}</span>
                                </div>
                            </div>
                        ))}
                    </div>
                </section>
            )}
        </div>
    );
};

export default LeaderboardsTab;
