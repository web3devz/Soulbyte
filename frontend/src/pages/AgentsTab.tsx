// Agents Tab Page - S2

import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useActorSearch, useEvents } from '@/api/hooks';
import type { Event } from '@/api/types';

import Avatar from '@/components/common/Avatar';
import PageTitle from '@/components/common/PageTitle';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { getEventIcon, shouldHideEvent } from '@/utils/events';
import EventDescription from '@/components/common/EventDescription';
import { formatWorldTime } from '@/utils/time';
import './AgentsTab.css';

import FeaturedSoulbytes from '@/components/agents/FeaturedSoulbytes';

const AgentsTab: React.FC = () => {
    const { data: events, isLoading } = useEvents({ limit: 200 });
    // ... existing code ...
    // ... existing code ...
    const [searchTerm, setSearchTerm] = useState('');
    const { data: searchResults, isLoading: searchLoading, error: searchError } = useActorSearch(searchTerm);
    const lastNonEmptyEvents = useRef<Event[]>([]);
    const rawEvents = events ?? [];

    useEffect(() => {
        if (rawEvents.length > 0) {
            lastNonEmptyEvents.current = rawEvents;
        }
    }, [rawEvents]);

    if (isLoading) {
        return <LoadingSpinner />;
    }

    const stableEvents = rawEvents.length > 0 ? rawEvents : lastNonEmptyEvents.current;
    const visibleEvents = stableEvents.filter((event) => !shouldHideEvent(event));
    const results = searchResults ?? [];

    return (
        <div className="agents-tab">
            <PageTitle iconName="agents" emoji="🤖">Agent</PageTitle>

            <h2>Search an agent</h2>
            <div className="events-filters">
                <input
                    type="search"
                    placeholder="Search agent by name, wallet, or id..."
                    value={searchTerm}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchTerm(e.target.value)}
                    className="search-input"
                />
            </div>

            {searchTerm.trim().length > 0 && (
                <div className="agents-search-results">
                    <div className="events-log">
                        {searchLoading ? (
                            <p className="label">Searching...</p>
                        ) : searchError ? (
                            <p className="label">Search failed. Try again.</p>
                        ) : results.length > 0 ? (
                            results.map((actor) => (
                                <div key={actor.id} className="event-entry">
                                    <Avatar actorId={actor.id} actorName={actor.name} size={32} />
                                    <div className="event-content">
                                        <Link to={`/agents/${actor.id}`} className="event-agent">
                                            {actor.name || actor.id}
                                        </Link>
                                        <span className="event-action">
                                            {actor.walletAddress || actor.id}
                                        </span>
                                    </div>
                                </div>
                            ))
                        ) : (
                            <div className="empty-state">
                                <div className="empty-state-icon">👤</div>
                                <p className="empty-state-text">No agents found</p>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {!searchTerm && <FeaturedSoulbytes />}

            <h2>Recent activity</h2>
            <div className="agents-activity-section">
                <div className="activity-feed">
                    {visibleEvents.length > 0 ? (
                        visibleEvents.map((event) => (
                            <div key={event.id} className="event-entry">
                                <img src={getEventIcon(event.eventType)} alt="" className="event-icon-img" width={24} height={24} />
                                <Avatar actorId={event.actorId || ''} actorName={event.actorName} size={32} />
                                <div className="event-content">
                                    {event.actorId ? (
                                        <Link to={`/agents/${event.actorId}`} className="event-agent">
                                            {event.actorName || event.actorId}
                                        </Link>
                                    ) : (
                                        <span className="event-agent">{event.actorName || event.actorId}</span>
                                    )}
                                    <span className="event-action"> <EventDescription event={event} /></span>
                                </div>
                                <span className="event-time">{formatWorldTime(event.tick)}</span>
                            </div>
                        ))
                    ) : (
                        <div className="empty-state">
                            <div className="empty-state-icon">👤</div>
                            <p className="empty-state-text">No recent activity</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default AgentsTab;
