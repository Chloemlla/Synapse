import React, { useRef, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { studioPillClassName, studioSurfaceClassName } from './studioTheme';
import { StudioErrorNote } from './studioFeedback';
import { UnifiedLoadingSpinner } from './LoadingSpinner';
import { useReducedMotion } from '../hooks/useReducedMotion';

interface AudioPreviewProps {
    audioUrl: string | null;
    onClose?: () => void;
}

export const AudioPreview: React.FC<AudioPreviewProps> = ({ audioUrl, onClose }) => {
    const reducedMotion = useReducedMotion();
    const audioRef = useRef<HTMLAudioElement>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [playbackRate, setPlaybackRate] = useState(1);
    const [isLoading, setIsLoading] = useState(true);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    useEffect(() => {
        if (audioRef.current) {
            audioRef.current.playbackRate = playbackRate;
        }
    }, [playbackRate]);

    useEffect(() => {
        if (audioUrl && audioRef.current) {
            // 自动暂停上一个音频
            audioRef.current.pause();
            audioRef.current.currentTime = 0;
            setIsLoading(true);
            setCurrentTime(0);
            setDuration(0);
            setIsPlaying(false);
            setErrorMessage(null);
            
            audioRef.current.load();

            const handleLoadedMetadata = () => {
                if (audioRef.current) {
                    setDuration(audioRef.current.duration);
                }
            };

            const handleCanPlay = () => {
                setIsLoading(false);
                // 自动播放，失败时不报错
                audioRef.current?.play().then(() => {
                    setIsPlaying(true);
                }).catch(() => {
                    setIsPlaying(false);
                });
            };

            const handleError = () => {
                setIsLoading(false);
                setIsPlaying(false);
                setDuration(0);
                setErrorMessage('音频加载失败，请重试，或下载后收听。');
            };

            audioRef.current.addEventListener('loadedmetadata', handleLoadedMetadata);
            audioRef.current.addEventListener('canplay', handleCanPlay);
            audioRef.current.addEventListener('error', handleError);

            return () => {
                audioRef.current?.removeEventListener('loadedmetadata', handleLoadedMetadata);
                audioRef.current?.removeEventListener('canplay', handleCanPlay);
                audioRef.current?.removeEventListener('error', handleError);
            };
        }
    }, [audioUrl]);

    const handleTimeUpdate = () => {
        if (audioRef.current) {
            setCurrentTime(audioRef.current.currentTime);
        }
    };

    const handlePlayPause = () => {
        if (audioRef.current) {
            if (isPlaying) {
                audioRef.current.pause();
            } else {
                void audioRef.current.play().catch(() => {
                    setIsPlaying(false);
                    setErrorMessage('播放失败，请重试，或下载后收听。');
                });
            }
            setIsPlaying(!isPlaying);
        }
    };

    const handleRetry = () => {
        setErrorMessage(null);
        setIsLoading(true);
        audioRef.current?.load();
    };

    // 拖动进度条时暂停，松开后恢复
    const [isSeeking, setIsSeeking] = useState(false);
    const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
        const time = parseFloat(e.target.value);
        if (audioRef.current) {
            audioRef.current.currentTime = time;
            setCurrentTime(time);
        }
    };
    const handleSeekStart = () => {
        setIsSeeking(true);
        if (audioRef.current) {
            audioRef.current.pause();
        }
    };
    const handleSeekEnd = () => {
        setIsSeeking(false);
        if (audioRef.current && isPlaying) {
            audioRef.current.play().catch(() => {
                setIsPlaying(false);
                setErrorMessage('播放失败，请重试，或下载后收听。');
            });
        }
    };

    const formatTime = (time: number) => {
        const minutes = Math.floor(time / 60);
        const seconds = Math.floor(time % 60);
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    };

    if (!audioUrl) return null;

    return (
        <AnimatePresence>
            <motion.div
                initial={reducedMotion ? false : { opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className={`${studioSurfaceClassName} z-30 mt-6 w-full`}
            >
                <div className="bg-slate-900 p-4">
                    <div className="flex justify-between items-center">
                        <h3 className="text-white font-semibold">音频预览</h3>
                        {onClose && (
                            <button
                                type="button"
                                onClick={onClose}
                                aria-label="关闭预览"
                                className="inline-flex min-h-11 min-w-11 items-center justify-center text-white transition-colors hover:text-slate-200"
                            >
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        )}
                    </div>
                </div>

                <div className="relative p-4 bg-white/90">
                    <div className="flex flex-col space-y-4">
                        <div className="flex items-center space-x-4">
                            <button
                                type="button"
                                onClick={handlePlayPause}
                                aria-label={isPlaying ? '暂停' : '播放'}
                                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full bg-slate-100 p-2 transition-colors hover:bg-slate-200"
                                disabled={isLoading}
                            >
                                {isPlaying ? (
                                    <svg className="h-6 w-6 text-slate-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                                    </svg>
                                ) : (
                                    <svg className="h-6 w-6 text-slate-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                    </svg>
                                )}
                            </button>

                            <div className="flex-1">
                                <input
                                    type="range"
                                    aria-label="播放进度"
                                    min={0}
                                    max={duration || 0}
                                    value={currentTime}
                                    onChange={handleSeek}
                                    onMouseDown={handleSeekStart}
                                    onMouseUp={handleSeekEnd}
                                    onTouchStart={handleSeekStart}
                                    onTouchEnd={handleSeekEnd}
                                    className="w-full h-2 bg-slate-200 rounded-full appearance-none cursor-pointer"
                                />
                            </div>

                            <div className="text-sm text-slate-600 whitespace-nowrap">
                                {formatTime(currentTime)} / {formatTime(duration)}
                            </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm text-slate-600">播放速度:</span>
                            <div className="flex flex-wrap gap-2">
                                {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
                                    <button
                                        key={rate}
                                        type="button"
                                        onClick={() => setPlaybackRate(rate)}
                                        className={studioPillClassName(playbackRate === rate)}
                                    >
                                        {rate}x
                                    </button>
                                ))}
                            </div>
                        </div>
                        {errorMessage && (
                            <StudioErrorNote className="flex flex-wrap items-center gap-2">
                                <span className="min-w-0 break-words">{errorMessage}</span>
                                <button
                                    type="button"
                                    onClick={handleRetry}
                                    className={studioPillClassName(false)}
                                >
                                    重试
                                </button>
                            </StudioErrorNote>
                        )}
                    </div>
                    {isLoading && (
                        <div className="absolute inset-0 flex items-center justify-center bg-slate-950/20">
                            <UnifiedLoadingSpinner size="md" text="" />
                        </div>
                    )}
                </div>
                <audio
                    ref={audioRef}
                    src={audioUrl}
                    onTimeUpdate={handleTimeUpdate}
                    onEnded={() => setIsPlaying(false)}
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                    onError={() => {
                        setIsLoading(false);
                        setIsPlaying(false);
                        setErrorMessage((current) => current ?? '音频加载失败，请重试，或下载后收听。');
                    }}
                />
            </motion.div>
        </AnimatePresence>
    );
}; 