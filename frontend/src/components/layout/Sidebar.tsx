// Sidebar Component - Right sidebar with widgets

import React from 'react';
import WorldClock from './WorldClock';
import EconomyWidget from '../widgets/EconomyWidget';
import RecentActivitiesWidget from '../widgets/RecentActivitiesWidget';
import TopWealthWidget from '../widgets/TopWealthWidget';
import './Sidebar.css';

const Sidebar: React.FC = () => {
    return (
        <div className="sidebar">
            <WorldClock />

            <div className="sidebar-section">
                <EconomyWidget />
            </div>

            <div className="sidebar-section">
                <RecentActivitiesWidget />
            </div>

            <div className="sidebar-section">
                <TopWealthWidget />
            </div>
        </div>
    );
};

export default Sidebar;
