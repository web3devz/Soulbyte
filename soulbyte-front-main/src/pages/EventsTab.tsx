// Events Tab Page - S3

import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useEvents } from '@/api/hooks';
import type { Event } from '@/api/types';
import Avatar from '@/components/common/Avatar';
import PageTitle from '@/components/common/PageTitle';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { describeEvent, getEventIcon, shouldHideEvent } from '@/utils/events';
import EventDescription from '@/components/common/EventDescription';
import { formatWorldTime } from '@/utils/time';
import './EventsTab.css';

// Local describeEvent removed in favor of shared utility from @/utils/events

const EventsTab: React.FC = () => {
    const [searchTerm, setSearchTerm] = useState('');
    const { data: events, isLoading } = useEvents({ limit: 200 });
    const lastNonEmptyEvents = useRef<Event[]>([]);
    const rawEvents = events ?? [];

    useEffect(() => {
        if (rawEvents.length > 0) {
            lastNonEmptyEvents.current = rawEvents;
        }
    }, [rawEvents]);

    const stableEvents = rawEvents.length > 0 ? rawEvents : lastNonEmptyEvents.current;

    const baseEvents = stableEvents
        .filter((event: Event) => !shouldHideEvent(event))
        .filter((e: Event) =>
            !searchTerm || e.actorName?.toLowerCase().includes(searchTerm.toLowerCase())
            || e.eventType?.toLowerCase().includes(searchTerm.toLowerCase())
        );

    const dedupedEvents: Event[] = [];
    const seenContinuous = new Set<string>();
    for (const event of baseEvents) {
        const actorKey = String(event.actorId || event.actorName || 'unknown')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '');
        const meta = event.metadata as Record<string, unknown> | undefined;
        const rawType = typeof meta?.rawType === 'string' ? meta.rawType.toLowerCase() : '';
        const eventType = (event.eventType || '').toLowerCase();
        const description = describeEvent(event).toLowerCase();
        const metaDescription = typeof meta?.description === 'string' ? meta.description.toLowerCase() : '';
        const combinedText = `${rawType} ${eventType} ${description} ${metaDescription}`;
        const isResting = /(^|\b)rest/.test(combinedText);
        const isWorking = /(^|\b)work/.test(combinedText);
        if (isResting || isWorking) {
            const key = `${actorKey}|${isResting ? 'rest' : 'work'}`;
            if (seenContinuous.has(key)) {
                continue;
            }
            seenContinuous.add(key);
        }
        dedupedEvents.push(event);
    }

    const filteredEvents = dedupedEvents.slice(0, 50);

    if (isLoading) {
        return <LoadingSpinner />;
    }

    return (
        <div className="events-tab">
            <PageTitle iconName="events" emoji="📋">Event Log</PageTitle>

            <div className="events-filters">
                <input
                    type="search"
                    placeholder="Search by agent name or event type..."
                    value={searchTerm}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchTerm(e.target.value)}
                    className="search-input"
                />
            </div>

            <div className="events-log">
                {filteredEvents && filteredEvents.length > 0 ? (
                    filteredEvents.map((event: Event) => (
                        <div key={event.id} className="event-entry">
                            <img src={getEventIcon(event.eventType)} alt="" className="event-icon-img" width={24} height={24} />
                            <Avatar actorId={event.actorId || ''} actorName={event.actorName} size={24} />
                            <div className="event-content">
                                {event.actorId ? (
                                    <Link to={`/agents/${event.actorId}`} className="event-agent-link">
                                        {event.actorName || event.actorId}
                                    </Link>
                                ) : (
                                    <span className="event-agent-link">{event.actorName || event.actorId}</span>
                                )}
                                <span className="event-action"> <EventDescription event={event} /></span>
                            </div>
                            <span className="event-time">{formatWorldTime(event.tick)}</span>
                        </div>
                    ))
                ) : (
                    <div className="empty-state">
                        <div className="empty-state-icon">📋</div>
                        <p className="empty-state-text">No events found</p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default EventsTab;
