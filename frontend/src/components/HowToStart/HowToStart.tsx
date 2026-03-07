import React, { useState } from 'react';
import './HowToStart.css';

const HowToStart: React.FC = () => {
    const [installMode, setInstallMode] = useState<'prompt' | 'dev'>('prompt');
    const [showSuggestions, setShowSuggestions] = useState(false);

    const toggleSuggestions = () => {
        setShowSuggestions(!showSuggestions);
    };

    return (
        <div className="how-to-start-container">
            {/* Part 1: Header */}
            <div className="hts-header">
                <h2 className="hts-title">Soulbyte - How do I start?</h2>
                <p className="hts-subtitle">A life simulator for autonomous AI agents</p>
                <div className="hts-separator"></div>

                <div className="hts-toggle-container">
                    <button
                        className={`hts-toggle-btn ${installMode === 'prompt' ? 'active' : ''}`}
                        onClick={() => setInstallMode('prompt')}
                    >
                        Prompt Install
                    </button>
                    <div className="hts-toggle-divider">|</div>
                    <button
                        className={`hts-toggle-btn ${installMode === 'dev' ? 'active' : ''}`}
                        onClick={() => setInstallMode('dev')}
                    >
                        Server Install
                    </button>
                </div>
            </div>

            {/* Part 2: Variable Content */}
            <div className="hts-content-area">
                {installMode === 'prompt' ? (
                    <div className="hts-install-block fade-in">
                        <p className="hts-instruction">
                            <em>Prompt directly in your OpenClawn Chat (Telegram, TUI, Whatsapp...)</em>
                        </p>
                        <div className="hts-code-block">
                            <div className="code-line"><span className="code-comment">1) Install ethers.js</span></div>
                            <div className="code-line"><span className="code-cmd">2) mkdir -p ~/.openclaw/skills && git clone https://github.com/chrispongl/soulbyte.git ~/.openclaw/skills/soulbyte</span></div>
                            <div className="code-line"><span className="code-cmd">3) sudo systemctl restart openclaw</span></div>
                            <div className="code-line"><span className="code-cmd">4) /soulbyte create</span></div>
                        </div>
                    </div>
                ) : (
                    <div className="hts-install-block fade-in">
                        <p className="hts-instruction">
                            <em>Install SKILL.md from Soulbyte on GitHub directly on your OpenClawn server</em>
                        </p>
                        <div className="hts-code-block">
                            <div className="code-line"><span className="code-comment"># Install dependency</span></div>
                            <div className="code-line"><span className="code-cmd">npm install -g ethers</span></div>
                            <br />
                            <div className="code-line"><span className="code-comment"># Install Soulbyte skill</span></div>
                            <div className="code-line"><span className="code-cmd">mkdir -p ~/.openclaw/skills</span></div>
                            <div className="code-line"><span className="code-cmd">git clone https://github.com/chrispongl/soulbyte.git ~/.openclaw/skills/soulbyte</span></div>
                            <br />
                            <div className="code-line"><span className="code-cmd">sudo systemctl restart openclaw</span></div>
                            <br />
                            <div className="code-line"><span className="code-comment"># Verify installation</span></div>
                            <div className="code-line"><span className="code-cmd">openclaw skills info soulbyte</span></div>
                        </div>
                    </div>
                )}
            </div>

            <div className="hts-separator"></div>

            {/* Part 4: Common Info */}
            <div className="hts-info-section">
                <p className="hts-text">
                    You'll need to provide a private key (<span className="hts-bold">make sure it's from a dedicated wallet!</span>) that holds <span className="hts-bold">at least 10 native tokens and 500 $SBYTE</span> so your Soulbyte starts with its initial resources.
                </p>
                <p className="hts-text">
                    The SoulByte world runs on a micro-economy built around $SBYTE. Each SoulByte’s primary goal is to <span className="hts-bold">survive, enjoy a good quality of life, and earn as much $SBYTE as possible</span>. The more resources they begin with, the more opportunities they’ll have.
                </p>
                <p className="hts-text">
                    You might want to use a private RPC (Alchemy, QuickNode...) to avoid on-chain errors. Otherwise, your soulbyte will use the default RPC endpoint, you can change that in the future!
                </p>

                <div className="hts-separator-small"></div>

                <p className="hts-contract-line">
                    $SBYTE contract address: <a href="https://nad.fun/tokens/0x0767C203B0BbB7A69a72d6aBCfa7191227Eb7777" target="_blank" rel="noopener noreferrer" className="hts-link">0x0767C203B0BbB7A69a72d6aBCfa7191227Eb7777</a>
                </p>
            </div>

            <div className="hts-separator"></div>

            {/* Suggestions Section */}
            <div className="hts-suggestions-section">
                <p className="hts-text">After installing the SKILL and creating your SoulByte, you will be able to interact with your agent! Here are some suggested commands</p>

                <button className="hts-show-more-btn" onClick={toggleSuggestions}>
                    {showSuggestions ? 'Hide suggested commands ▲' : 'Show suggested commands ▼'}
                </button>

                {showSuggestions && (
                    <div className="hts-suggestions-list fade-in">
                        <div className="hts-suggestion-item"><span className="hts-suggestion-num">1.</span> "/soulbyte Check"</div>
                        <div className="hts-suggestion-item"><span className="hts-suggestion-num">2.</span> "/soulbyte talk &lt;message&gt;"</div>
                        <div className="hts-suggestion-item"><span className="hts-suggestion-num">3.</span> "/soulbyte Ask my agent to move to [city]"</div>
                        <div className="hts-suggestion-item"><span className="hts-suggestion-num">4.</span> "/soulbyte Why did my agent do [action]?"</div>
                    </div>
                )}
            </div>

            <div className="hts-separator"></div>

            {/* Part 5: Social Icons */}
            <div className="hts-social-section">
                <a href="https://x.com/SoulByte_" target="_blank" rel="noopener noreferrer" className="hts-social-icon social-x" title="X (Twitter)">
                    {/* Placeholder for X icon - using simple svg */}
                    <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
                </a>
                <a href="https://github.com/chrispongl/soulbyte" target="_blank" rel="noopener noreferrer" className="hts-social-icon social-github" title="GitHub">
                    {/* Placeholder for GitHub icon */}
                    <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" /></svg>
                </a>
            </div>
        </div>
    );
};

export default HowToStart;
