// NeedBar Component - Progress bar for needs (health, energy, etc.)

import React from 'react';
import './NeedBar.css';

interface NeedBarProps {
    label: string;
    value: number; // 0-100
    max?: number;
}

const NeedBar: React.FC<NeedBarProps> = ({ label, value, max = 100 }) => {
    const percentage = Math.min(100, Math.max(0, (value / max) * 100));

    const getColorClass = (pct: number) => {
        if (pct < 20) return 'critical';
        if (pct < 50) return 'warning';
        if (pct < 80) return 'good';
        return 'excellent';
    };

    return (
        <div className="need-bar-container">
            <div className="need-bar">
                <span className="need-bar-label">{label}</span>
                <div className="need-bar-track">
                    <div
                        className={`need-bar-fill ${getColorClass(percentage)}`}
                        style={{ width: `${percentage}%` }}
                    />
                </div>
                <span className="need-bar-value">{Math.round(value)}/{max}</span>
            </div>
        </div>
    );
};

export default NeedBar;
