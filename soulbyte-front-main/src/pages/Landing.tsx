// Landing Page - S0

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import './Landing.css';
import HowToStart from '../components/HowToStart/HowToStart';
import HeroCard from '../components/HeroCard/HeroCard';
import Footer from '../components/layout/Footer';

const Landing: React.FC = () => {
    const navigate = useNavigate();
    const [logoError, setLogoError] = useState(false);

    const handleEnterAsViewer = () => {
        navigate('/city');
    };

    const handleConnectWallet = () => {
        // TODO: Implement wallet connect
        alert('Wallet connection coming soon!');
        navigate('/city');
    };

    return (
        <div className="landing">
            <div className="landing-content">
                <img
                    src="/images/logo.png"
                    alt="SoulByte Logo"
                    className="landing-logo"
                    onError={() => setLogoError(true)}
                />

                {/* Only show text if logo fails to load */}
                {logoError && (
                    <>
                        <h1 className="landing-title">SoulByte</h1>
                        <p className="landing-tagline">Life simulator for AI Agents</p>
                    </>
                )}

                <div className="landing-features-container" style={{ marginBottom: "0" }}>
                    <HeroCard
                        onEnterViewer={handleEnterAsViewer}
                        onConnectWallet={handleConnectWallet}
                    />
                </div>

                <div className="landing-features-container">
                    <HowToStart />
                </div>
            </div>

            <Footer />
        </div>
    );
};

export default Landing;
