import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { isAdminRole } from '../utils/rbac';
import {
    studioBadgeClassName,
    studioModalOverlayClassName,
    studioMutedPrimaryButtonClassName,
    studioFieldClassName,
    studioSecondaryButtonClassName,
    studioSurfaceClassName,
} from './studioTheme';

interface DebugInfo {
    action: string;
    timestamp: string;
    [key: string]: any;
}

interface DebugInfoModalProps {
    isOpen: boolean;
    onClose: () => void;
    debugInfos: DebugInfo[];
    userRole?: string; // 添加用户角色属性
}

const DESKTOP_ONLY_HINT = '仅管理员可见';

export const DebugInfoModal: React.FC<DebugInfoModalProps> = ({ isOpen, onClose, debugInfos, userRole }) => {
    const [copiedKey, setCopiedKey] = useState<string | null>(null);
    const [keyword, setKeyword] = useState('');
    const closeButtonRef = useRef<HTMLButtonElement | null>(null);
    const previouslyFocusedRef = useRef<HTMLElement | null>(null);

    // 检查用户是否为管理员。非管理员直接不渲染 —— 注意这一步必须发生在任何副作用之前：
    // 旧实现在这里打了 console.log，于是每次父组件重渲染都会往控制台写一行（且发生在
    // isOpen 判断之前，关着的时候也在写）。
    const isAdmin = isAdminRole(userRole);

    const visibleInfos = useMemo(() => {
        const needle = keyword.trim().toLowerCase();
        if (!needle) return debugInfos;
        return debugInfos.filter((info) =>
            JSON.stringify(info).toLowerCase().includes(needle),
        );
    }, [debugInfos, keyword]);

    // 对话框语义：Esc 关闭 + 打开时把焦点移进模态、关闭时还给触发元素。
    useEffect(() => {
        if (!isOpen || !isAdmin) return undefined;
        previouslyFocusedRef.current = (document.activeElement as HTMLElement | null) ?? null;
        const timer = setTimeout(() => closeButtonRef.current?.focus(), 0);

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                onClose();
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            clearTimeout(timer);
            document.removeEventListener('keydown', handleKeyDown);
            previouslyFocusedRef.current?.focus?.();
        };
    }, [isAdmin, isOpen, onClose]);

    if (!isAdmin) return null;
    if (!isOpen) return null;

    const serialize = (info: DebugInfo) => JSON.stringify(info, null, 2);

    const copyOne = async (key: string, info: DebugInfo) => {
        try {
            await navigator.clipboard.writeText(serialize(info));
            setCopiedKey(key);
            setTimeout(() => setCopiedKey(null), 2000);
        } catch {
            setCopiedKey(null);
        }
    };

    const copyAll = async () => {
        try {
            const debugText = visibleInfos
                .map((info) => `[${info.timestamp}] ${info.action}: ${serialize(info)}`)
                .join('\n\n');
            await navigator.clipboard.writeText(debugText);
            setCopiedKey('__all__');
            setTimeout(() => setCopiedKey(null), 2000);
        } catch {
            setCopiedKey(null);
        }
    };

    const downloadAll = () => {
        const payload = {
            exportedAt: new Date().toISOString(),
            count: visibleInfos.length,
            entries: visibleInfos,
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `passkey-debug-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
        anchor.click();
        URL.revokeObjectURL(url);
    };

    return (
        <AnimatePresence>
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
                className={studioModalOverlayClassName}
                onClick={onClose}
            >
                <motion.div
                    role='dialog'
                    aria-modal='true'
                    aria-labelledby='passkey-debug-title'
                    initial={{ scale: 0.9, opacity: 0, y: 50 }}
                    animate={{ scale: 1, opacity: 1, y: 0 }}
                    exit={{ scale: 0.9, opacity: 0, y: 50 }}
                    transition={{ duration: 0.4, type: "spring", stiffness: 300, damping: 25 }}
                    className={`${studioSurfaceClassName} w-full max-w-4xl mx-auto my-8 max-h-[90vh]`}
                    onClick={(e) => e.stopPropagation()}
                >
                    {/* 标题栏 */}
                    <div className="bg-gradient-to-r from-rose-500 to-orange-500 text-white p-6">
                        <div className="flex items-start justify-between gap-3">
                            <div className="flex items-start gap-3 min-w-0">
                                <motion.div
                                    animate={{ rotate: 360 }}
                                    transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                                    className="w-8 h-8 shrink-0 bg-white bg-opacity-20 rounded-full flex items-center justify-center"
                                >
                                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                                    </svg>
                                </motion.div>
                                <div className="min-w-0">
                                    <h2 id='passkey-debug-title' className="text-xl sm:text-2xl font-bold">Passkey 调试信息（{DESKTOP_ONLY_HINT}）</h2>
                                    <p className="text-xs sm:text-sm opacity-90">把这份信息附到问题反馈里，便于定位登录失败的原因</p>
                                </div>
                            </div>
                            <button
                                ref={closeButtonRef}
                                onClick={onClose}
                                aria-label="关闭调试信息"
                                className="shrink-0 text-white hover:text-slate-200 transition-colors"
                            >
                                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>
                    </div>

                    {/* 筛选 */}
                    {debugInfos.length > 3 ? (
                        <div className="border-b border-slate-200 px-6 py-3">
                            <label className="block">
                                <span className="sr-only">按关键词筛选调试信息</span>
                                <input
                                    type="search"
                                    value={keyword}
                                    onChange={(event) => setKeyword(event.target.value)}
                                    placeholder="按关键词筛选（动作、字段名、值）"
                                    className={studioFieldClassName}
                                />
                            </label>
                        </div>
                    ) : null}

                    {/* 内容区域 */}
                    <div className="p-6 max-h-[60vh] overflow-y-auto">
                        <div className="space-y-4">
                            {visibleInfos.length === 0 ? (
                                <p className="py-10 text-center text-sm text-slate-500">
                                    {debugInfos.length === 0 ? '本次会话还没有调试记录' : '没有匹配当前关键词的记录'}
                                </p>
                            ) : null}
                            {visibleInfos.map((info, index) => {
                                const key = `${info.timestamp}-${info.action}-${index}`;
                                return (
                                    <motion.div
                                        key={key}
                                        initial={{ opacity: 0, x: -20 }}
                                        animate={{ opacity: 1, x: 0 }}
                                        transition={{ duration: 0.3, delay: Math.min(index, 8) * 0.05 }}
                                        className="bg-slate-50/80 rounded-2xl p-4 border-l-4 border-slate-500"
                                    >
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="flex-1 min-w-0">
                                                <div className="flex flex-wrap items-center gap-2 mb-2">
                                                    <span className="text-sm font-medium text-slate-500">
                                                        {new Date(info.timestamp).toLocaleTimeString()}
                                                    </span>
                                                    <span className={studioBadgeClassName('slate')}>
                                                        {info.action}
                                                    </span>
                                                    <button
                                                        type='button'
                                                        onClick={() => void copyOne(key, info)}
                                                        className={`${studioSecondaryButtonClassName} ml-auto px-2 py-1 text-[11px]`}
                                                        aria-label={`复制第 ${index + 1} 条调试信息`}
                                                    >
                                                        {copiedKey === key ? '已复制' : '复制本条'}
                                                    </button>
                                                </div>
                                                <div className="text-sm text-slate-700 space-y-1">
                                                    {Object.entries(info).map(([field, value]) => {
                                                        if (field === 'action' || field === 'timestamp') return null;
                                                        return (
                                                            <div key={field} className="flex">
                                                                <span className="font-medium text-slate-600 w-24 flex-shrink-0">
                                                                    {field}:
                                                                </span>
                                                                <span className="text-slate-800 break-all">
                                                                    {typeof value === 'object'
                                                                        ? JSON.stringify(value, null, 2)
                                                                        : String(value)
                                                                    }
                                                                </span>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        </div>
                                    </motion.div>
                                );
                            })}
                        </div>
                    </div>

                    {/* 底部操作栏 */}
                    <div className="bg-slate-50/80 px-6 py-4 border-t border-slate-200">
                        <div className="flex flex-col sm:flex-row items-center justify-between gap-2">
                        <div className="text-sm text-slate-600">
                            共 {visibleInfos.length} 条
                            {visibleInfos.length !== debugInfos.length ? `（已从 ${debugInfos.length} 条中筛选）` : ''}
                        </div>
                        <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
                            <motion.button
                                whileHover={{ scale: 1.05 }}
                                whileTap={{ scale: 0.95 }}
                                onClick={() => void copyAll()}
                                className={`inline-flex items-center justify-center gap-2 rounded-2xl px-5 py-3.5 text-sm font-semibold text-white transition w-full sm:w-auto ${
                                    copiedKey === '__all__'
                                        ? 'bg-emerald-500'
                                        : 'bg-emerald-500 hover:bg-emerald-600'
                                }`}
                            >
                                {copiedKey === '__all__' ? '已复制!' : '复制全部'}
                            </motion.button>
                            <motion.button
                                whileHover={{ scale: 1.05 }}
                                whileTap={{ scale: 0.95 }}
                                onClick={downloadAll}
                                className={`${studioSecondaryButtonClassName} w-full sm:w-auto`}
                            >
                                下载 JSON
                            </motion.button>
                            <motion.button
                                whileHover={{ scale: 1.05 }}
                                whileTap={{ scale: 0.95 }}
                                onClick={onClose}
                                className={`${studioMutedPrimaryButtonClassName} w-full sm:w-auto`}
                            >
                                关闭
                            </motion.button>
                        </div>
                    </div>
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>
    );
};
