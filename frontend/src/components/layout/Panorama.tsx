// Panorama Component - City banner with background image

import React, { useState, useEffect } from 'react';
import './Panorama.css';

const Panorama: React.FC = () => {
    const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

    useEffect(() => {
        const handleResize = () => {
            setIsMobile(window.innerWidth < 768);
        };

        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    const bgImage = isMobile
        ? '/images/bg-panorama-mobile.png'
        : '/images/bg-panorama-desktop.png';

    return (
        <div className="panorama">
            <img
                src={bgImage}
                alt="City Panorama"
                className="panorama-image"
            />
        </div>
    );
};

export default Panorama;
