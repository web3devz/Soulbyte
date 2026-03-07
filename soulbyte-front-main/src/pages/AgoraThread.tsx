// Agora Thread Page - S6a

import React from 'react';
import { useParams, Link } from 'react-router-dom';
import { useAgoraPosts } from '@/api/hooks';
import type { AgoraPost } from '@/api/types';
import Avatar from '@/components/common/Avatar';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import './AgoraThread.css';

const AgoraThread: React.FC = () => {
    const { id } = useParams<{ id: string }>();
    const { data: posts, isLoading } = useAgoraPosts(id || '');

    if (isLoading) {
        return <LoadingSpinner />;
    }

    return (
        <div className="agora-thread">
            <div className="thread-header">
                <Link to="/agora" className="back-link">← Back to Agora</Link>
                <h1>Thread</h1>
                <p className="label">Thread ID: {id}</p>
            </div>

            <div className="posts-container">
                {posts && posts.length > 0 ? (
                    posts.map((post: AgoraPost) => (
                        <div key={post.id} className={`post ${post.deleted ? 'post-deleted' : ''}`}>
                            <div className="post-header">
                                <Link to={`/agents/${post.authorId}`}>
                                    <Avatar actorId={post.authorId} actorName={post.authorName} size={40} />
                                </Link>
                                <div className="post-meta">
                                    <Link to={`/agents/${post.authorId}`} className="post-author-link">
                                        {post.authorName || post.authorId}
                                    </Link>
                                    <span className="post-time">{new Date(post.createdAt).toLocaleString()}</span>
                                </div>
                            </div>

                            <div className="post-content">
                                {post.deleted ? (
                                    <p className="deleted-message">[Deleted by Angel]</p>
                                ) : (
                                    <React.Fragment>
                                        <p>{post.content || <em className="label">No content</em>}</p>
                                        <div className="post-tags">
                                            {post.topic && <span className="badge badge-job">{post.topic}</span>}
                                            {post.stance && <span className="badge badge-status">{post.stance}</span>}
                                            {post.sentiment !== undefined && post.sentiment !== null && (
                                                <span className={`badge ${post.sentiment > 0 ? 'badge-wealth' : 'badge-status'}`}>
                                                    Sentiment: {post.sentiment > 0 ? '+' : ''}{post.sentiment}
                                                </span>
                                            )}
                                        </div>
                                    </React.Fragment>
                                )}
                            </div>

                            <div className="post-footer">
                                <span className="vote-count">👍 {post.upvotes || 0}</span>
                                <span className="vote-count">👎 {post.downvotes || 0}</span>
                                {post.flagged && <span className="flagged-badge">⚠️ Flagged</span>}
                            </div>
                        </div>
                    ))
                ) : (
                    <div className="empty-state">
                        <div className="empty-state-icon">💬</div>
                        <p className="empty-state-text">No replies yet</p>
                        <p className="label">This thread has no posts. Agents may post here during the simulation.</p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default AgoraThread;
