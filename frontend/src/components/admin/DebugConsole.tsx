import React, { useMemo, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { FaBug, FaEraser, FaExternalLinkAlt, FaInfoCircle, FaSearch, FaShieldAlt } from 'react-icons/fa';
import { passkeyDebugLog } from '../../utils/passkeyDebugLog';
import { useAuth } from '../../hooks/useAuth';
import { isAdminRole } from '../../utils/rbac';
import { DebugInfoModal } from '../DebugInfoModal';
import {
  InfoBadge,
  InfoMetricCard,
  InfoPanel,
  InfoSectionTitle,
  studioFieldClassName,
  studioSecondaryButtonClassName,
} from '../studioTheme';

/**
 * `/admin/debug-console` — Passkey 调试控制台。
 *
 * 为什么存在：`DebugInfoModal` 与 `usePasskey` 里的 `debugInfos` 早就写好了，但没有任何
 * 组件渲染弹窗，日志也没有跨组件共享的出口 —— 这个「模块」此前是死代码。这里直接订阅
 * `passkeyDebugLog` 单例（内存态、刷新即空），把现场诊断能力真正接上。
 */
const DebugConsole: React.FC = () => {
  const entries = useSyncExternalStore(
    passkeyDebugLog.subscribe,
    passkeyDebugLog.getSnapshot,
    passkeyDebugLog.getServerSnapshot,
  );
  const { user } = useAuth();
  const canUseModal = isAdminRole(user?.role);
  const [keyword, setKeyword] = useState('');
  const [modalOpen, setModalOpen] = useState(false);

  const filtered = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter((entry) => JSON.stringify(entry).toLowerCase().includes(needle));
  }, [entries, keyword]);

  const failureCount = useMemo(
    () => entries.filter((entry) => /fail|error/i.test(entry.action)).length,
    [entries],
  );

  const lastAt = entries.length > 0 ? entries[entries.length - 1].timestamp : null;

  return (
    <div className="space-y-6">
      <InfoPanel>
        <InfoSectionTitle
          eyebrow="Diagnostics"
          title="调试控制台"
          description="收集 Passkey 注册与登录流程中的现场记录，用于定位「某个设备/浏览器没法用 Passkey」这类只在终端复现的问题。日志只存在内存里，刷新页面即清空。"
          icon={FaBug}
          action={
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setModalOpen(true)}
                disabled={entries.length === 0 || !canUseModal}
                title={
                  !canUseModal
                    ? '需要管理员权限'
                    : entries.length === 0
                      ? '还没有调试记录'
                      : undefined
                }
                className={`${studioSecondaryButtonClassName} disabled:cursor-not-allowed disabled:opacity-50`}
              >
                <FaExternalLinkAlt className="h-3.5 w-3.5" />
                以弹窗查看
              </button>
              <button
                type="button"
                onClick={() => passkeyDebugLog.clear()}
                disabled={entries.length === 0}
                className={`${studioSecondaryButtonClassName} disabled:cursor-not-allowed disabled:opacity-50`}
              >
                <FaEraser className="h-3.5 w-3.5" />
                清空
              </button>
            </div>
          }
        />
      </InfoPanel>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <InfoMetricCard label="记录条数" value={entries.length} detail="上限 200 条，超出后丢弃最早记录" icon={FaBug} />
        <InfoMetricCard label="疑似失败" value={failureCount} detail="动作名含 fail / error" icon={FaShieldAlt} tone={failureCount > 0 ? 'rose' : 'emerald'} />
        <InfoMetricCard
          label="最近一条"
          value={lastAt ? new Date(lastAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—'}
          detail={lastAt ? new Date(lastAt).toLocaleDateString('zh-CN') : '还没有记录'}
          icon={FaInfoCircle}
        />
      </div>

      <InfoPanel>
        <InfoSectionTitle
          eyebrow="Entries"
          title="现场记录"
          icon={FaBug}
          action={
            <label className="block w-56">
              <span className="sr-only">按关键词筛选</span>
              <span className="relative block">
                <FaSearch className="pointer-events-none absolute top-1/2 left-3 h-3 w-3 -translate-y-1/2 text-slate-400" />
                <input
                  type="search"
                  value={keyword}
                  onChange={(event) => setKeyword(event.target.value)}
                  placeholder="筛选动作或字段"
                  className={`${studioFieldClassName} pl-8`}
                />
              </span>
            </label>
          }
        />

        {entries.length === 0 ? (
          <div className="py-14 text-center">
            <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
              <FaBug className="size-4" aria-hidden="true" />
            </div>
            <p className="text-sm font-semibold text-slate-700">还没有调试记录</p>
            <p className="mt-1 text-xs text-slate-500">
              在登录页或安全设置里触发一次 Passkey 注册/登录后，记录会出现在这里。
            </p>
            <Link to="/admin" className={`${studioSecondaryButtonClassName} mt-4 inline-flex`}>
              返回管理总览
            </Link>
          </div>
        ) : (
          <ul className="mt-4 space-y-2">
            {filtered.length === 0 ? (
              <li className="py-6 text-center text-sm text-slate-500">没有匹配当前关键词的记录</li>
            ) : null}
            {filtered.map((entry, index) => (
              <li key={`${entry.timestamp}-${index}`} className="rounded-2xl border border-slate-200 bg-white/80 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[11px] text-slate-400">
                    {new Date(entry.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}
                  </span>
                  <InfoBadge tone={/fail|error/i.test(entry.action) ? 'rose' : 'slate'}>{entry.action}</InfoBadge>
                </div>
                <dl className="mt-2 space-y-1 text-xs text-slate-700">
                  {Object.entries(entry)
                    .filter(([field]) => field !== 'action' && field !== 'timestamp')
                    .map(([field, value]) => (
                      <div key={field} className="flex gap-2">
                        <dt className="w-28 shrink-0 font-semibold text-slate-500">{field}</dt>
                        <dd className="min-w-0 break-all">
                          {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                        </dd>
                      </div>
                    ))}
                </dl>
              </li>
            ))}
          </ul>
        )}
      </InfoPanel>

      {canUseModal ? (
        <DebugInfoModal
          isOpen={modalOpen}
          onClose={() => setModalOpen(false)}
          debugInfos={entries.map((entry) => ({ ...entry, action: entry.action, timestamp: entry.timestamp }))}
          userRole={user?.role}
        />
      ) : null}
    </div>
  );
};

export default DebugConsole;
