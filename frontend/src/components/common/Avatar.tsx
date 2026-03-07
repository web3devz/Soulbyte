// Avatar Component - Agent avatar display

import React from 'react';
import { getAvatarPath } from '@/utils/avatars';
import './Avatar.css';

interface AvatarProps {
    actorId: string;
    actorName?: string;
    size?: number;
}

const Avatar: React.FC<AvatarProps> = ({ actorId, actorName, size = 48 }) => {
    const src = getAvatarPath(actorId);

    return (
        <img
            src={src}
            alt={actorName || actorId}
            className="avatar"
            style={{
                width: size,
                height: size,
                objectFit: 'cover',
            }}
            title={actorName}
        />
    );
};

export default Avatar;
