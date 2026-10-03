import React, { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FaPaperPlane, FaTimes, FaUser, FaRobot } from 'react-icons/fa';
import { useLibreChat } from './LibreChatContext';
import MarkdownRenderer from './MarkdownRenderer';
import {
    studioElevatedPanelClassName,
    studioFieldClassName,
    studioModalCardClassName,
    studioModalOverlayClassName,
    studioPrimaryButtonClassName,
} from './studioTheme';

export function LibreChatRealtimeDialog() {
    const { state, actions } = useLibreChat();
    const closeButtonRef = useRef<HTMLButtonElement | null>(null);
    const previouslyFocusedRef = useRef<HTMLElement | null>(null);
    // 上下文对象每次渲染都是新引用，这里用 ref 取最新的关闭函数，
    // 让下面的副作用只依赖 rtOpen——否则每次输入都会重新抢焦点（F5-03）
    const closeDialogRef = useRef(actions.closeRealtimeDialog);
    closeDialogRef.current = actions.closeRealtimeDialog;

    // 对话框语义：打开时移入焦点、Esc 关闭、关闭后把焦点还给触发元素（F5-03）
    useEffect(() => {
        if (!state.rtOpen) return undefined;
        previouslyFocusedRef.current = (document.activeElement as HTMLElement | null) ?? null;
        const timer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                closeDialogRef.current();
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            window.clearTimeout(timer);
            document.removeEventListener('keydown', handleKeyDown);
            previouslyFocusedRef.current?.focus?.();
        };
    }, [state.rtOpen]);

    const markdownControls = {
        showCopy: true,
        showSourceToggle: true,
        showExpandToggle: true,
        defaultExpanded: false,
        collapsedHeight: 420,
    };

    const handleMarkdownCopy = (success: boolean, wholeMessage = false) => {
        actions.setNotification({
            type: success ? 'success' : 'error',
            message: success ? (wholeMessage ? 'Markdown内容已复制到剪贴板' : '代码已复制') : '复制失败',
        });
    };

    return (
        <AnimatePresence>
            {state.rtOpen && (
                <div
                    className={studioModalOverlayClassName}
                    onClick={() => closeDialogRef.current()}
                >
                    <motion.div
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="librechat-realtime-title"
                        initial={{ opacity: 0, scale: 0.95, y: 20 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95, y: 20 }}
                        className={`${studioModalCardClassName} relative max-w-2xl max-h-[90vh] overflow-y-auto`}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className={`flex items-center mb-4 ${state.rtSending ? 'pr-32' : 'pr-10'}`}>
                            <h3 id="librechat-realtime-title" className="text-lg font-semibold text-slate-800 flex items-center gap-2">
                                <FaPaperPlane className="text-slate-500" />
                                实时对话（支持上下文）
                            </h3>
                            <button
                                ref={closeButtonRef}
                                onClick={actions.closeRealtimeDialog}
                                className={
                                    state.rtSending
                                        ? "absolute top-4 right-4 inline-flex h-8 items-center justify-center gap-1 rounded-2xl border border-rose-200 bg-rose-50 px-3 text-xs font-semibold text-rose-700 transition-colors hover:bg-rose-100"
                                        : "absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-2xl border border-slate-200 hover:bg-slate-100 bg-white/90 transition-colors"
                                }
                                aria-label={state.rtSending ? '取消生成并关闭对话框' : '关闭'}
                                title={state.rtSending ? '取消生成并关闭对话框' : '关闭'}
                            >
                                <FaTimes className={state.rtSending ? "w-3 h-3" : "w-4 h-4"} />
                                {state.rtSending ? '取消生成' : null}
                            </button>
                        </div>

                        <div className="space-y-4">
                            <div>
                                <textarea
                                    className={`${studioFieldClassName} min-h-[96px] resize-y`}
                                    aria-label="实时对话消息"
                                    placeholder="请输入消息（支持上下文）"
                                    value={state.rtMessage}
                                    rows={3}
                                    maxLength={state.MAX_MESSAGE_LEN}
                                    onChange={(e) => actions.onChangeRtMessage(e.target.value)}
                                    onKeyDown={(e) => {
                                        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && state.rtCanSend) {
                                            e.preventDefault();
                                            void actions.handleRealtimeSend();
                                        }
                                    }}
                                />
                            </div>

                            <div className="flex items-center justify-between">
                                <div className="text-xs text-slate-400">{state.rtMessage.length}/{state.MAX_MESSAGE_LEN}</div>
                                {state.rtError && <div className="text-rose-700 text-sm">{state.rtError}</div>}
                            </div>

                            <div className="flex items-center justify-end gap-2">
                                <motion.button
                                    onClick={actions.handleRealtimeSend}
                                    disabled={!state.rtCanSend}
                                    className={studioPrimaryButtonClassName}
                                    whileTap={{ scale: 0.95 }}
                                >
                                    <FaPaperPlane className="w-4 h-4" />
                                    {state.rtSending ? '发送中...' : '发送'}
                                </motion.button>
                            </div>

                            <div className="mt-4">
                                {state.rtHistory.length > 0 ? (
                                    <div className="space-y-3 max-h-[45vh] overflow-auto pr-1">
                                        {state.rtHistory.map((m, idx: number) => (
                                            <motion.div
                                                key={idx}
                                                className={studioElevatedPanelClassName}
                                                initial={{ opacity: 0, y: 10 }}
                                                animate={{ opacity: 1, y: 0 }}
                                            >
                                                <div className="flex items-center gap-3 mb-3">
                                                    <div className={`w-8 h-8 rounded-full flex items-center justify-center ${m.role === 'user'
                                                        ? 'bg-slate-500'
                                                        : 'bg-emerald-500'
                                                        }`}>
                                                        {m.role === 'user' ? (
                                                            <FaUser className="w-4 h-4 text-white" />
                                                        ) : (
                                                            <FaRobot className="w-4 h-4 text-white" />
                                                        )}
                                                    </div>
                                                    <div className="flex flex-col">
                                                        <span className={`text-sm font-medium ${m.role === 'user'
                                                            ? 'text-slate-700'
                                                            : 'text-emerald-700'
                                                            }`}>
                                                            {m.role === 'user' ? '用户' : '助手'}
                                                            {state.rtStreaming && idx === state.rtHistory.length - 1 ? '（生成中...）' : ''}
                                                        </span>
                                                    </div>
                                                </div>
                                                <MarkdownRenderer
                                                    content={m.role === 'user' ? m.content : actions.sanitizeAssistantText(m.content)}
                                                    density="compact"
                                                    controls={markdownControls}
                                                    onContentCopy={(success) => handleMarkdownCopy(success, true)}
                                                    onCodeCopy={(success) => handleMarkdownCopy(success)}
                                                />
                                            </motion.div>
                                        ))}
                                    </div>
                                ) : state.rtStreaming || state.rtStreamContent ? (
                                    <motion.div
                                        className={studioElevatedPanelClassName}
                                        initial={{ opacity: 0, y: 10 }}
                                        animate={{ opacity: 1, y: 0 }}
                                    >
                                        <div className="flex items-center gap-3 mb-3">
                                            <div className="w-8 h-8 rounded-full bg-emerald-500 flex items-center justify-center">
                                                <FaRobot className="w-4 h-4 text-white" />
                                            </div>
                                            <div className="flex flex-col">
                                                <span className="text-sm font-medium text-emerald-700">
                                                    助手{state.rtStreaming ? '（生成中...）' : ''}
                                                </span>
                                            </div>
                                        </div>
                                        <MarkdownRenderer
                                            content={actions.sanitizeAssistantText(state.rtStreamContent || '')}
                                            density="compact"
                                            controls={{
                                                showCopy: false,
                                                showSourceToggle: false,
                                                showExpandToggle: false,
                                            }}
                                            onCodeCopy={(success) => handleMarkdownCopy(success)}
                                        />
                                    </motion.div>
                                ) : (
                                    <div className="text-center py-8 text-slate-500">
                                        <FaPaperPlane className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                                        输入内容并点击发送以开始单次对话
                                    </div>
                                )}
                            </div>
                        </div>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
}
