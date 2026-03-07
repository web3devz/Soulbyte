// Icon component with image fallback to emoji

import React, { useState } from 'react';
import './Icon.css';

interface IconProps {
    name: string;
    emoji: string;
    size?: number;
    className?: string;
}

const Icon: React.FC<IconProps> = ({ name, emoji, size = 20, className = '' }) => {
    const [imageError, setImageError] = useState(false);
    const imagePath = `/images/icons/icon-${name}.png`;

    if (imageError) {
        return <span className={`icon icon-emoji ${className}`}>{emoji}</span>;
    }

    return (
        <img
            src={imagePath}
            alt={emoji}
            className={`icon icon-image ${className}`}
            style={{ width: size, height: size }}
            onError={() => setImageError(true)}
        />
    );
};

export default Icon;
