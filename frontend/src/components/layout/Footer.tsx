import React from 'react';
import './Footer.css';

const Footer: React.FC = () => {
    return (
        <footer className="global-footer">
            <div className="footer-content">
                <span>© 2026 SoulByte <a href="/changelog" target="_blank" rel="noopener noreferrer" className="footer-link">v.1.0.0</a></span>
                <span className="footer-separator">|</span>
                <span>All rights reserved</span>
                <span className="footer-separator">|</span>
                <span>
                    <a href="https://docs.soulbyte.fun/" target="_blank" rel="noopener noreferrer" className="footer-link">Docs</a>
                    {' - '}
                    <a href="https://github.com/chrispongl/soulbyte" target="_blank" rel="noopener noreferrer" className="footer-link">Github</a>
                    {' - '}
                    <a href="https://x.com/SoulByte_" target="_blank" rel="noopener noreferrer" className="footer-link">X</a>
                </span>
                <span className="footer-separator">|</span>
                <span>Developed by <a href="https://x.com/cpongl" target="_blank" rel="noopener noreferrer" className="footer-link">Pongl</a></span>
            </div>
        </footer>
    );
};

export default Footer;
