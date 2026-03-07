// Economy Widget - Sidebar widget showing economy stats

import React from 'react';
import Icon from '@/components/common/Icon';
import { useCities, useTransactionCount } from '@/api/hooks';
import type { City } from '@/api/types';
import { abbreviateNumber } from '@/utils/format';
import './EconomyWidget.css';

const EconomyWidget: React.FC = () => {
    const { data: cities } = useCities();
    const { data: txCount } = useTransactionCount();

    const totalPopulation = cities?.reduce((sum: number, c: City) => sum + c.population, 0) || 0;

    return (
        <div className="widget economy-widget">
            <h3 className="widget-title">
                <Icon name="economy" emoji="💰" size={16} />
                <span className="widget-title-text">Economy</span>
            </h3>

            <div className="widget-content">

                <div className="widget-row">
                    <span className="widget-label">Cities:</span>
                    <span className="widget-value">{cities?.length || 0}</span>
                </div>

                <div className="widget-row">
                    <span className="widget-label">Population:</span>
                    <span className="widget-value">{abbreviateNumber(totalPopulation)}</span>
                </div>

                <div className="widget-row">
                    <span className="widget-label">Transactions:</span>
                    <span className="widget-value">{txCount ? txCount.count.toLocaleString() : '—'}</span>
                </div>
            </div>
        </div>
    );
};

export default EconomyWidget;
