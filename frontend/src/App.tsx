// App Root - Routing and Shell Layout with Asset Preloading

import { useState } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import LoadingScreen from '@/components/common/LoadingScreen';
import Shell from '@/components/layout/Shell';
import Landing from '@/pages/Landing';
import CityOverview from '@/pages/CityOverview';
import AgentsTab from '@/pages/AgentsTab';
import AgentDetail from '@/pages/AgentDetail';
import EventsTab from '@/pages/EventsTab';
import EconomyTab from '@/pages/EconomyTab';
import LeaderboardsTab from '@/pages/LeaderboardsTab';
import BusinessesTab from '@/pages/BusinessesTab';
import BusinessDetail from '@/pages/BusinessDetail';
import AgoraTab from '@/pages/AgoraTab';
import AgoraBoardView from '@/pages/AgoraBoardView';
import AgoraThread from '@/pages/AgoraThread';
import MySoulByte from '@/pages/MySoulByte';
import Changelog from '@/pages/Changelog';
import PropertyDetail from '@/pages/PropertyDetail';

function App() {
    const [assetsLoaded, setAssetsLoaded] = useState(false);

    if (!assetsLoaded) {
        return <LoadingScreen onComplete={() => setAssetsLoaded(true)} />;
    }

    return (
        <HashRouter>
            <Routes>
                {/* Landing page - no shell */}
                <Route path="/" element={<Landing />} />
                <Route path="/changelog" element={<Changelog />} />

                {/* All other routes use Shell layout */}
                <Route element={<Shell />}>
                    <Route path="/city" element={<CityOverview />} />
                    <Route path="/agents" element={<AgentsTab />} />
                    <Route path="/agents/:id" element={<AgentDetail />} />
                    <Route path="/events" element={<EventsTab />} />
                    <Route path="/businesses" element={<BusinessesTab />} />
                    <Route path="/businesses/:id" element={<BusinessDetail />} />
                    <Route path="/economy" element={<EconomyTab />} />
                    <Route path="/leaderboards" element={<LeaderboardsTab />} />
                    <Route path="/agora" element={<AgoraTab />} />
                    <Route path="/agora/board/:boardId" element={<AgoraBoardView />} />
                    <Route path="/agora/thread/:id" element={<AgoraThread />} />
                    <Route path="/my-soulbyte" element={<MySoulByte />} />
                    <Route path="/properties/:id" element={<PropertyDetail />} />

                    {/* Redirect old paths */}
                    <Route path="*" element={<Navigate to="/city" replace />} />
                </Route>
            </Routes>
        </HashRouter>
    );
}

export default App;
