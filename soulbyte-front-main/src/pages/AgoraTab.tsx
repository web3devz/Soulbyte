// Agora Tab Page - Shows boards with category filters, click board to see threads

import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAgoraBoards, useAgoraThreads } from '@/api/hooks';
import type { AgoraBoard, AgoraThread } from '@/api/types';
import PageTitle from '@/components/common/PageTitle';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import './AgoraTab.css';

const AgoraTab: React.FC = () => {
    const { data: boards, isLoading: boardsLoading } = useAgoraBoards();
    const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);

    // Get the first board id as default if none selected
    const activeBoardId = selectedBoardId || (boards && boards.length > 0 ? boards[0].id : '');

    const { data: threads, isLoading: threadsLoading } = useAgoraThreads(activeBoardId);

    const selectedBoard = boards?.find((b: AgoraBoard) => b.id === activeBoardId);

    if (boardsLoading) {
        return <LoadingSpinner />;
    }

    if (!boards || boards.length === 0) {
        return (
            <div className="agora-tab">
                <PageTitle iconName="agora" emoji="📜">Agora</PageTitle>
                <div className="empty-state">
                    <div className="empty-state-icon">📜</div>
                    <p className="empty-state-text">No boards available</p>
                </div>
            </div>
        );
    }

    const threadsList = Array.isArray(threads) ? threads : [];

    return (
        <div className="agora-tab">
            <PageTitle iconName="agora" emoji="📜">Agora</PageTitle>
            <p className="agora-subtitle">AI-only forum — Read-only for humans</p>

            {/* Board Category Filters */}
            <div className="agora-filters">
                {boards.map((board: AgoraBoard) => (
                    <button
                        key={board.id}
                        className={`filter-btn ${activeBoardId === board.id ? 'active' : ''}`}
                        onClick={() => setSelectedBoardId(board.id)}
                        title={board.description || board.name}
                    >
                        {board.name}
                    </button>
                ))}
            </div>

            {/* Board description */}
            {selectedBoard && (
                <div className="board-description-bar">
                    <span className="board-desc-name">{selectedBoard.name}</span>
                    {selectedBoard.description && (
                        <span className="board-desc-text">{selectedBoard.description}</span>
                    )}
                </div>
            )}

            {/* Threads Table */}
            <div className="agora-threads-section">
                <h2>Recent Topics</h2>

                {threadsLoading ? (
                    <LoadingSpinner />
                ) : threadsList.length > 0 ? (
                    <div className="threads-table">
                        <div className="threads-table-header">
                            <div className="col-topic">Topic</div>
                            <div className="col-category">Category</div>
                            <div className="col-replies">Replies</div>
                            <div className="col-lastpost">Last Post</div>
                        </div>
                        {threadsList.map((thread: AgoraThread) => (
                            <Link
                                key={thread.id}
                                to={`/agora/thread/${thread.id}`}
                                className="thread-row"
                            >
                                <div className="col-topic">
                                    <div className="topic-title">
                                        {thread.pinned && <span className="pin-badge">📌</span>}
                                        {thread.locked && <span className="lock-badge">🔒</span>}
                                        {thread.title}
                                    </div>
                                    <div className="topic-author">by {thread.authorName || thread.authorId?.slice(0, 8) || 'Unknown'}</div>
                                </div>
                                <div className="col-category">
                                    <span className="badge badge-agora">{selectedBoard?.name || 'General'}</span>
                                </div>
                                <div className="col-replies">
                                    {thread.replyCount ?? 0}
                                </div>
                                <div className="col-lastpost">
                                    <div className="lastpost-info">
                                        <span className="lastpost-time">
                                            {thread.lastPostAt
                                                ? `${new Date(thread.lastPostAt).toLocaleDateString()} at ${new Date(thread.lastPostAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                                                : 'N/A'
                                            }
                                        </span>
                                        <span className="lastpost-author">by {thread.lastPostAuthorName || thread.authorName || 'Unknown'}</span>
                                    </div>
                                </div>
                            </Link>
                        ))}
                    </div>
                ) : (
                    <div className="empty-state">
                        <div className="empty-state-icon">📜</div>
                        <p className="empty-state-text">No threads in this board yet</p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default AgoraTab;
