import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { FaHistory } from 'react-icons/fa';
import { isAdminRole } from '../utils/rbac';
import {
  studioBadgeClassName,
  studioFieldClassName,
  studioPrimaryButtonClassName,
  studioSecondaryButtonClassName,
} from './studioTheme';
import {
  StudioEmptyState,
  StudioErrorNote,
  StudioModal,
  StudioModalHeader,
} from './studioFeedback';
import { useReducedMotion } from '../hooks/useReducedMotion';
import { cn } from '../utils/cn';

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

const TITLE_ID = 'passkey-debug-title';

export const DebugInfoModal: React.FC<DebugInfoModalProps> = ({ isOpen, onClose, debugInfos, userRole }) => {
    const [copiedKey, setCopiedKey] = useState<string | null>(null);
    const [copyError, setCopyError] = useState<string | null>(null);
    const [keyword, setKeyword] = useState('');
    const reducedMotion = useReducedMotion();

    // 检查用户是否为管理员。非管理员直接不渲染 —— 这一步发生在任何副作用之前：
    // 旧实现在这里打了 console.log，于是每次父组件重渲染都会往控制台写一行。
    const isAdmin = isAdminRole(userRole);

    const visibleInfos = useMemo(() => {
        const needle = keyword.trim().toLowerCase();
        if (!needle) return debugInfos;
        return debugInfos.filter((info) =>
            JSON.stringify(info).toLowerCase().includes(needle),
        );
    }, [debugInfos, keyword]);

    useEffect(() => {
        if (!isOpen) {
            setCopiedKey(null);
            setCopyError(null);
        }
    }, [isOpen]);

    if (!isAdmin) return null;

    const serialize = (info: DebugInfo) => JSON.stringify(info, null, 2);

    const flashCopied = (key: string) => {
        setCopiedKey(key);
        setTimeout(() => setCopiedKey(null), 2000);
    };

    const copyOne = async (key: string, info: DebugInfo) => {
        try {
            await navigator.clipboard.writeText(serialize(info));
            setCopyError(null);
            flashCopied(key);
        } catch {
            // 剪贴板被浏览器拒了必须让用户看见，否则「点了复制没反应」无从判断。
            setCopyError('复制失败，请手动选中文本后复制。');
        }
    };

    const copyAll = async () => {
        try {
            const debugText = visibleInfos
                .map((info) => `[${info.timestamp}] ${info.action}: ${serialize(info)}`)
                .join('\n\n');
            await navigator.clipboard.writeText(debugText);
            setCopyError(null);
            flashCopied('__all__');
        } catch {
            setCopyError('复制失败，请改用「下载 JSON」再附到反馈里。');
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
        <StudioModal
            open={isOpen}
            onClose={onClose}
            labelledBy={TITLE_ID}
            maxWidthClassName="max-w-4xl"
            closeLabel="关闭调试信息"
        >
            <StudioModalHeader
                title="Passkey 调试信息（仅管理员可见）"
                titleId={TITLE_ID}
                description="把这份信息附到问题反馈里，便于定位登录失败的原因"
                icon={<FaHistory className="h-5 w-5" aria-hidden="true" />}
                onClose={onClose}
                closeLabel="关闭调试信息"
            />

            {debugInfos.length > 3 ? (
                <div className="mt-5">
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

            {copyError ? <StudioErrorNote className="mt-4">{copyError}</StudioErrorNote> : null}
            {copiedKey ? (
                <p role="status" aria-live="polite" className="mt-4 text-sm text-slate-500">
                    已复制到剪贴板
                </p>
            ) : null}

            <div className="mt-4 space-y-4">
                {visibleInfos.length === 0 ? (
                    <StudioEmptyState
                        message={
                            debugInfos.length === 0
                                ? '本次会话还没有调试记录，先去尝试一次 Passkey 登录再回来。'
                                : '没有匹配当前关键词的记录，换个关键词再试。'
                        }
                    />
                ) : null}
                {visibleInfos.map((info, index) => {
                    const key = `${info.timestamp}-${info.action}-${index}`;
                    return (
                        <motion.div
                            key={key}
                            initial={reducedMotion ? false : { opacity: 0, x: -20 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ duration: 0.3, delay: reducedMotion ? 0 : Math.min(index, 8) * 0.05 }}
                            className="rounded-2xl border-l-4 border-slate-500 bg-slate-50/80 p-4"
                        >
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-medium text-slate-500">
                                    {new Date(info.timestamp).toLocaleTimeString()}
                                </span>
                                <span className={studioBadgeClassName('slate')}>{info.action}</span>
                                <button
                                    type="button"
                                    onClick={() => void copyOne(key, info)}
                                    className={cn(studioSecondaryButtonClassName, 'ml-auto min-h-11 px-3 py-1.5 text-[11px]')}
                                    aria-label={`复制第 ${index + 1} 条调试信息`}
                                >
                                    {copiedKey === key ? '已复制' : '复制本条'}
                                </button>
                            </div>
                            <div className="mt-3 space-y-1 text-sm text-slate-700">
                                {Object.entries(info).map(([field, value]) => {
                                    if (field === 'action' || field === 'timestamp') return null;
                                    return (
                                        <div key={field} className="flex">
                                            <span className="w-24 flex-shrink-0 font-medium text-slate-600">
                                                {field}:
                                            </span>
                                            <span className="break-all text-slate-800">
                                                {typeof value === 'object'
                                                    ? JSON.stringify(value, null, 2)
                                                    : String(value)}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        </motion.div>
                    );
                })}
            </div>

            <div className="mt-6 flex flex-col items-center justify-between gap-2 border-t border-slate-200 pt-4 sm:flex-row">
                <p className="text-sm text-slate-600">
                    共 {visibleInfos.length} 条
                    {visibleInfos.length !== debugInfos.length ? `（已从 ${debugInfos.length} 条中筛选）` : ''}
                </p>
                <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
                    <button
                        type="button"
                        onClick={() => void copyAll()}
                        className={cn(studioPrimaryButtonClassName, 'min-h-11 w-full sm:w-auto')}
                    >
                        复制全部
                    </button>
                    <button
                        type="button"
                        onClick={downloadAll}
                        className={cn(studioSecondaryButtonClassName, 'min-h-11 w-full sm:w-auto')}
                    >
                        下载 JSON
                    </button>
                    <button
                        type="button"
                        onClick={onClose}
                        className={cn(studioSecondaryButtonClassName, 'min-h-11 w-full sm:w-auto')}
                    >
                        关闭
                    </button>
                </div>
            </div>
        </StudioModal>
    );
};
