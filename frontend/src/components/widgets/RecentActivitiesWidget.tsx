// Recent Activities Widget - Shows latest agent activities

import React, { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useEvents } from '@/api/hooks';
import type { Event } from '@/api/types';
import Avatar from '@/components/common/Avatar';
import { getEventIcon, getEventLabel, shouldHideEvent } from '@/utils/events';
import EventDescription from '@/components/common/EventDescription';
import './RecentActivitiesWidget.css';

const RecentActivitiesWidget: React.FC = () => {
    const { data: events, isLoading, error } = useEvents({ limit: 200 });
    const lastNonEmptyEvents = useRef<Event[]>([]);
    const rawEvents = events ?? [];

    useEffect(() => {
        if (rawEvents.length > 0) {
            lastNonEmptyEvents.current = rawEvents;
        }
    }, [rawEvents]);

    const stableEvents = rawEvents.length > 0 ? rawEvents : lastNonEmptyEvents.current;
    const recentEvents = stableEvents
        .filter((event) => !shouldHideEvent(event))
        .slice(0, 8);

    if (isLoading) {
        return (
            <div className="widget recent-activities-widget">
                <h3 className="widget-title">
                    <span className="widget-title-text">📋 Recent Activities</span>
                </h3>
                <div className="widget-content">
                    <p className="label">Loading...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="widget recent-activities-widget">
            <h3 className="widget-title">
                <span className="widget-title-text">📋 Recent Activities</span>
            </h3>

            <div className="widget-content">
                {error ? (
                    <p className="label">Unable to load activity</p>
                ) : recentEvents.length > 0 ? (
                    <>
                        {recentEvents.map((event: Event) => (
                            <div key={event.id} className="activity-item">
                                <img
                                    src={getEventIcon(event.eventType)}
                                    alt={getEventLabel(event.eventType)}
                                    className="activity-icon-img"
                                    width={20}
                                    height={20}
                                />
                                <div className="activity-details">
                                    {event.actorId ? (
                                        <Link to={`/agents/${event.actorId}`} className="activity-actor">
                                            <Avatar actorId={event.actorId || ''} actorName={event.actorName} size={16} />
                                            <span>{event.actorName || 'Unknown'}</span>
                                        </Link>
                                    ) : (
                                        <span className="activity-actor">
                                            <Avatar actorId={event.actorId || ''} actorName={event.actorName} size={16} />
                                            <span>{event.actorName || 'Unknown'}</span>
                                        </span>
                                    )}
                                    <span className="activity-label"><EventDescription event={event} /></span>
                                </div>
                            </div>
                        ))}
                        <Link to="/events" className="view-all-link">
                            View all →
                        </Link>
                    </>
                ) : (
                    <p className="label">No recent activity</p>
                )}
            </div>
        </div>
    );
};

export default RecentActivitiesWidget;
