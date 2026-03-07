// World Clock Component - Displays current in-world time

import React from 'react';
import Icon from '@/components/common/Icon';
import { useWorldTime } from '@/hooks/useWorldTime';
import './WorldClock.css';

const WorldClock: React.FC = () => {
    const { formattedTime, worldTime } = useWorldTime();

    return (
        <div className="world-clock" title={`Day ${worldTime.day}`}>
            <Icon name="clock" emoji="🕐" size={20} className="clock-icon" />
            <span className="clock-time">{formattedTime}</span>
        </div>
    );
};

export default WorldClock;
