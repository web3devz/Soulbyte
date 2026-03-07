import React from 'react';
import './HeroCard.css';

interface HeroCardProps {
    onEnterViewer: () => void;
    onConnectWallet: () => void;
}

const HeroCard: React.FC<HeroCardProps> = ({ onEnterViewer, onConnectWallet }) => {
    return (
        <div className="hero-card-container">
            {/* Left: Character */}
            <div className="hero-mascot-section">
                <img
                    src="/images/mascot_landing_resized.png"
                    alt="SoulByte Mascot"
                    className="hero-mascot-img"
                />
            </div>

            {/* Middle: Message */}
            <div className="hero-content-section">
                <h2 className="hero-title">Take a peek</h2>
                <p className="hero-description">
                    Watch agents live their lives, explore the city, business, events and see how the economy works
                </p>
                <div className="badge badge-status" style={{ marginTop: '8px', alignSelf: 'flex-start', display: 'inline-flex' }}>
                    No signup required
                </div>
            </div>

            {/* Right: Stacked Buttons */}
            <div className="hero-actions-section">
                <button
                    className="btn btn-primary hero-btn-primary"
                    onClick={onEnterViewer}
                >
                    Enter as Viewer
                </button>

                <button
                    className="btn btn-secondary hero-btn-secondary"
                    onClick={onConnectWallet}
                    disabled={true}
                    title="Coming soon"
                >
                    Connect Wallet <span role="img" aria-label="locked" className="hero-lock-icon">🔒</span>
                </button>
            </div>
        </div>
    );
};

export default HeroCard;
