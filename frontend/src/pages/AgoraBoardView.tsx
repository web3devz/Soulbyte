// Agora Board View Page - Shows threads for a specific board

import React from 'react';
import { useParams, Link } from 'react-router-dom';
import { useAgoraThreads, useAgoraBoards } from '@/api/hooks';
import type { AgoraThread, AgoraBoard } from '@/api/types';
import Avatar from '@/components/common/Avatar';
import PageTitle from '@/components/common/PageTitle';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import './AgoraTab.css';

const AgoraBoardView: React.FC = () => {
    const { boardId } = useParams<{ boardId: string }>();
    const { data: boards } = useAgoraBoards();
    const { data: threads, isLoading } = useAgoraThreads(boardId || '');

    const board = boards?.find((b: AgoraBoard) => b.id === boardId);

    if (isLoading) {
        return <LoadingSpinner />;
    }

    return (
        <div className="agora-tab">
            <div className="agora-board-header">
                <Link to="/agora" className="back-link">← Back to Boards</Link>
                <PageTitle iconName="agora" emoji="📜">{board?.name || 'Board'}</PageTitle>
                {board?.description && (
                    <p className="agora-subtitle">{board.description}</p>
                )}
            </div>

            <div className="threads-list">
                {threads && threads.length > 0 ? (
                    threads.map((thread: AgoraThread) => (
                        <Link key={thread.id} to={`/agora/thread/${thread.id}`} className="thread-card card card-clickable">
                            <div className="thread-header">
                                <Avatar actorId={thread.authorId} actorName="" size={32} />
                                <div className="thread-info">
                                    <h3 className="thread-title">
                                        {thread.pinned && <span className="pin-badge">📌</span>}
                                        {thread.title}
                                    </h3>
                                    <div className="thread-meta">
                                        <span className="label">Author: {thread.authorId}</span>
                                        {thread.replyCount !== undefined && (
                                            <span className="label">💬 {thread.replyCount} replies</span>
                                        )}
                                        <span className="label">Last: {new Date(thread.lastPostAt).toLocaleDateString()}</span>
                                    </div>
                                </div>
                            </div>
                            {thread.locked && <span className="badge badge-status">🔒 Locked</span>}
                        </Link>
                    ))
                ) : (
                    <div className="empty-state">
                        <div className="empty-state-icon">💬</div>
                        <p className="empty-state-text">No threads in this board yet</p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default AgoraBoardView;
