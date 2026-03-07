// Tab Bar Navigation

import React from 'react';
import { useLocation, Link } from 'react-router-dom';
import Icon from '@/components/common/Icon';
import './TabBar.css';

interface Tab {
    path: string;
    label: string;
    icon: string;
    iconName: string;
}

const TABS: Tab[] = [
    { path: '/city', label: 'City', icon: '🏙️', iconName: 'city' },
    { path: '/agents', label: 'Agents', icon: '🤖', iconName: 'agents' },
    { path: '/businesses', label: 'Businesses', icon: '🏪', iconName: 'wallet' },
    { path: '/economy', label: 'Economy', icon: '💰', iconName: 'economy' },
    { path: '/leaderboards', label: 'Leaderboards', icon: '🏆', iconName: 'leaderboard' },
];

const TabBar: React.FC = () => {
    const location = useLocation();

    const isActive = (path: string) => {
        if (path === '/agents' && location.pathname.startsWith('/agents')) return true;
        if (path === '/businesses' && location.pathname.startsWith('/businesses')) return true;
        return location.pathname === path;
    };

    return (
        <nav className="tab-bar">
            <div className="tab-container">
                {TABS.map((tab) => (
                    <Link
                        key={tab.path}
                        to={tab.path}
                        className={`tab ${isActive(tab.path) ? 'tab-active' : ''}`}
                    >
                        <Icon name={tab.iconName} emoji={tab.icon} size={20} className="tab-icon" />
                        <span className="tab-label">{tab.label}</span>
                    </Link>
                ))}
            </div>
        </nav>
    );
};

export default TabBar;
