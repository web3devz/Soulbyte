import React from 'react';
import { useActorDirectory } from '@/api/hooks';
import AgentHorizontalList from './AgentHorizontalList';
import './FeaturedSoulbytes.css';

const FeaturedSoulbytes: React.FC = () => {
    const { data: newerAgents, isLoading: newerLoading } = useActorDirectory({ sort: 'newest', limit: 10 });
    const { data: popularAgents, isLoading: popularLoading } = useActorDirectory({ sort: 'popular', limit: 10 });

    return (
        <div className="featured-soulbytes-section">
            <AgentHorizontalList
                title="Newer Soulbytes"
                agents={newerAgents || []}
                isLoading={newerLoading}
            />

            <AgentHorizontalList
                title="Popular Soulbytes"
                agents={popularAgents || []}
                isLoading={popularLoading}
            />
        </div>
    );
};

export default FeaturedSoulbytes;
