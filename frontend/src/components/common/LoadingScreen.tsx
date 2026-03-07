// Loading Screen Component with Asset Preloading

import React, { useEffect, useState } from 'react';
import { preloadAllAssets } from '@/utils/assetPreloader';
import './LoadingScreen.css';

interface LoadingScreenProps {
    onComplete: () => void;
}

const LoadingScreen: React.FC<LoadingScreenProps> = ({ onComplete }) => {
    const [progress, setProgress] = useState(0);
    const [isComplete, setIsComplete] = useState(false);

    useEffect(() => {
        let mounted = true;

        const loadAssets = async () => {
            try {
                await preloadAllAssets((loaded, total) => {
                    if (mounted) {
                        const percentage = Math.round((loaded / total) * 100);
                        setProgress(percentage);
                    }
                });

                // Ensure we show 100% briefly
                if (mounted) {
                    setProgress(100);
                    setTimeout(() => {
                        setIsComplete(true);
                        setTimeout(() => {
                            onComplete();
                        }, 500); // Wait for fade out
                    }, 300);
                }
            } catch (error) {
                console.error('Error preloading assets:', error);
                // Continue anyway
                if (mounted) {
                    onComplete();
                }
            }
        };

        loadAssets();

        return () => {
            mounted = false;
        };
    }, [onComplete]);

    return (
        <div className={`loading-screen ${isComplete ? 'hidden' : ''}`}>
            <img
                src="/images/logo.png"
                alt="SoulByte Logo"
                className="loading-logo"
            />
            <div className="loading-title">SoulByte</div>
            <div className="loading-bar-container">
                <div
                    className="loading-bar-fill"
                    style={{ width: `${progress}%` }}
                />
            </div>
            <div className="loading-text">
                Loading assets... <span className="loading-percentage">{progress}%</span>
            </div>
        </div>
    );
};

export default LoadingScreen;
