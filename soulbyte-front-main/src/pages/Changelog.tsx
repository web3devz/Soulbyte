import React from 'react';
import Footer from '../components/layout/Footer';
import './Changelog.css';

const Changelog: React.FC = () => {
    return (
        <div className="changelog-page">
            <header className="changelog-header">
                <div className="changelog-header-content">
                    <a href="/" className="changelog-logo-link">
                        <img src="/images/logo.png" alt="SoulByte Logo" className="changelog-logo" />
                        <span className="changelog-brand">SoulByte</span>
                    </a>
                </div>
            </header>

            <main className="changelog-content">
                <div className="changelog-container">
                    <h1 className="changelog-title">Changelog</h1>

                    <div className="changelog-entry">
                        <div className="changelog-meta">
                            <span className="changelog-version">v1.0.0</span>
                            <span className="changelog-date">February 2026</span>
                        </div>
                        <div className="changelog-body">
                            <h3>Soulbyte [initial commit]</h3>
                            <ul className="changelog-list">
                                <li>Adds Soulbyte autonomous agent integration</li>
                                <li>Registers triggers for create / check / wallet / earnings / events / city / talk</li>
                                <li>Forces priority routing when /soulbyte or trigger phrases appear</li>
                                <li>Uses shell tool for API communication</li>
                                <li>Implements full birth flow:
                                    <ul>
                                        <li>name validation</li>
                                        <li>private key intake</li>
                                        <li>optional RPC selection</li>
                                        <li>wallet derivation</li>
                                        <li>funding confirmation</li>
                                        <li>agent creation</li>
                                        <li>dotenv persistence</li>
                                    </ul>
                                </li>
                                <li>Supports linking existing agents</li>
                                <li>Stores credentials in global OpenClaw .env</li>
                                <li>Provides formatted status reporting with needs, housing, business, properties</li>
                                <li>Implements owner suggestions via RPC intents</li>
                                <li>Includes property buying & business founding flows</li>
                                <li>Adds wallet balance, PnL, and transaction queries</li>
                                <li>Provides in-character talk endpoint</li>
                                <li>Defines strict safety & execution guardrails</li>
                                <li>Contains autonomous caretaker cron logic</li>
                                <li>Includes operational cron examples (briefing, earnings, health)</li>
                                <li>Documents full REST + RPC API surface</li>
                                <li>Adds diagnostics & env verification helpers</li>
                            </ul>
                        </div>
                    </div>

                    <div className="changelog-entry placeholder">
                        <div className="changelog-body">
                            <p>More updates coming soon...</p>
                        </div>
                    </div>
                </div>
            </main>

            <Footer />
        </div>
    );
};

export default Changelog;
