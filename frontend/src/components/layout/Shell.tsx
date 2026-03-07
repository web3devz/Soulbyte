// Shell Layout Component - Main application shell

import React, { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import Panorama from './Panorama';
import TabBar from './TabBar';
import Sidebar from './Sidebar';
import { useWalletConnect } from '@/hooks/useWalletConnect';
import './Shell.css';

import Footer from './Footer';

const Shell: React.FC = () => {
    const { restoreSession } = useWalletConnect();

    // Restore wallet session on mount
    useEffect(() => {
        restoreSession();
    }, [restoreSession]);
    return (
        <div className="shell">
            <Panorama />
            <TabBar />

            <div className="shell-content">
                <main className="main-content">
                    <Outlet />
                </main>

                <aside className="sidebar-desktop">
                    <Sidebar />
                </aside>
            </div>

            <Footer />

            <aside className="sidebar-mobile">
                <Sidebar />
            </aside>
        </div>
    );
};

export default Shell;
