// Page Title Component with Icon support

import React from 'react';
import Icon from '@/components/common/Icon';
import './PageTitle.css';

interface PageTitleProps {
    iconName: string;
    emoji: string;
    children: string;
}

const PageTitle: React.FC<PageTitleProps> = ({ iconName, emoji, children }) => {
    return (
        <h1 className="page-title">
            <Icon name={iconName} emoji={emoji} size={28} className="page-title-icon" />
            <span className="page-title-text">{children}</span>
        </h1>
    );
};

export default PageTitle;
