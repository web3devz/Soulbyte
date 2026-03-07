// LoadingSpinner Component

import React from 'react';
import './LoadingSpinner.css';

const LoadingSpinner: React.FC = () => {
    return (
        <div className="loading-spinner">
            <div className="spinner" />
            <p className="loading-text">Loading...</p>
        </div>
    );
};

export default LoadingSpinner;
