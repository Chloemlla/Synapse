import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FaCheck,
  FaExclamationTriangle,
  FaInfoCircle,
  FaSave,
  FaSyncAlt,
  FaUndoAlt,
  FaUserShield,
  FaUsers,
} from 'react-icons/fa';
import {
  getAdminScopeSetting,
  resetAdminScopeSetting,
  updateAdminScopeSetting,
  type AdminScopePageOption,
  type AdminScopeSetting,
} from '@/api/adminScope';
import { invalidateAdminScopeCache } from '@/hooks/useAdminScope';
import { useAuth } from '@/hooks/useAuth';
import { useNotification } from '@/components/Notification';
import ConfirmModal from '@/components/ConfirmModal';
import { isSuperAdmin } from '@/utils/rbac';
import { getBackendErrorMessage } from '@/utils/backendError';
import {
  InfoBadge,
  InfoPanel,
  InfoQueryHero,
  InfoQueryShell,
  InfoSectionTitle,
  studioFieldClassName,
  studioGhostButtonClassName,
  studioPrimaryButtonClassName,
  studioSecondaryButtonClassName,
} from '@/components/studioTheme';
import { cn } from '@/lib/utils';

/**
 * 超管：管理「普通管理员能看到的页面」。
 *
 * 与后端 `src/routes/admin/adminScope.ts` 一一对应：
 *   GET  /api/admin/admin-scope/setting  读全部可授权页面 + 当前默认授权 + 按用户覆盖
 *   PUT  /api/admin/admin-scope/setting  覆盖式保存
 *   DELETE /api/admin/admin-scope/setting 恢复默认
 *
 * 两条容易踩错、因此写在界面上的语义：
 *   1. **最终可见 = 默认授权 ∪ 该用户的覆盖**（覆盖是增量，不是替换）；
 *   2. 标注「无 API 范围」的页面只有入口、没有自己的后台接口 —— 授了它，页面里的请求仍会被
 *      服务端的页面授权守卫拒掉（fail-closed），所以这是登记表缺 `apiPrefixes`，不是权限问题。
 */

interface PagePickerProps {
  options: AdminScopePageOption[];
  selected: readonly string[];
  onToggle: (key: string) => void;
  onSetAll: (keys: string[], mode: 'add' | 'remove') => void;
  keyword: string;
  onKeywordChange: (value: string) => void;
  disabled?: boolean;
  idPrefix: string;
}

const PagePicker: React.FC<PagePickerProps> = ({
  options,
  selected,
  onToggle,
  onSetAll,
  keyword,
  onKeywordChange,
  disabled = false,
  idPrefix,
}) => {
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const filtered = useMemo(() => {
    const query = keyword.trim().toLowerCase();
    if (!query) return options;
    return options.filter(
      (option) =>
        option.key.toLowerCase().includes(query) || option.label.toLowerCase().includes(query),
    );
  }, [options, keyword]);

  return (
    <div className='min-w-0'>
      <div className='flex flex-wrap items-center gap-2'>
        <input
          type='search'
          value={keyword}
          onChange={(event) => onKeywordChange(event.target.value)}
          placeholder='搜索页面（名称或 key）'
          aria-label='搜索可授权页面'
          className={cn(studioFieldClassName, 'w-full sm:w-64')}
        />
        <button
          type='button'
          disabled={disabled || filtered.length === 0}
          onClick={() => onSetAll(filtered.map((option) => option.key), 'add')}
          className={cn(studioSecondaryButtonClassName, 'px-3 py-2 text-xs disabled:opacity-50')}
        >
          勾选当前 {filtered.length} 项
        </button>
        <button
          type='button'
          disabled={disabled || filtered.length === 0}
          onClick={() => onSetAll(filtered.map((option) => option.key), 'remove')}
          className={cn(studioGhostButtonClassName, 'px-3 py-2 text-xs disabled:opacity-50')}
        >
          清空当前 {filtered.length} 项
        </button>
        <span className='text-xs text-slate-500'>已选 {selected.length} 项</span>
      </div>

      <ul className='mt-3 grid max-h-96 gap-2 overflow-y-auto pr-1 sm:grid-cols-2 xl:grid-cols-3'>
        {filtered.map((option) => {
          const checked = selectedSet.has(option.key);
          const inputId = `${idPrefix}-${option.key}`;
          return (
            <li key={option.key}>
              <label
                htmlFor={inputId}
                className={cn(
                  'flex cursor-pointer items-start gap-2 rounded-xl border px-3 py-2.5 text-left transition',
                  checked
                    ? 'border-indigo-200 bg-indigo-50/70'
                    : 'border-slate-200 bg-white hover:border-slate-300',
                  disabled && 'cursor-not-allowed opacity-60',
                )}
              >
                <input
                  id={inputId}
                  type='checkbox'
                  checked={checked}
                  disabled={disabled}
                  onChange={() => onToggle(option.key)}
                  className='mt-0.5 size-4 shrink-0 rounded border-slate-300 text-indigo-600'
                />
                <span className='min-w-0'>
                  <span className='block truncate text-sm font-semibold text-slate-800'>
                    {option.label}
                  </span>
                  <span className='mt-0.5 flex flex-wrap items-center gap-1.5'>
                    <code className='rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500'>
                      {option.key}
                    </code>
                    {option.apiScopeCount === 0 ? (
                      <span className='rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700'>
                        无 API 范围
                      </span>
                    ) : (
                      <span className='text-[10px] text-slate-400'>
                        {option.apiScopeCount} 个 API 前缀
                      </span>
                    )}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
        {filtered.length === 0 ? (
          <li className='col-span-full rounded-xl border border-dashed border-slate-200 px-3 py-6 text-center text-sm text-slate-500'>
            没有匹配的页面。
          </li>
        ) : null}
      </ul>
    </div>
  );
};

const AdminScopeManager: React.FC = () => {
  const { user } = useAuth();
  const { setNotification } = useNotification();
  const canManage = isSuperAdmin(user?.role);

  const [setting, setSetting] = useState<AdminScopeSetting | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftDefaults, setDraftDefaults] = useState<string[]>([]);
  const [draftPerUser, setDraftPerUser] = useState<Record<string, string[]>>({});
  const [dirty, setDirty] = useState(false);
  const [defaultKeyword, setDefaultKeyword] = useState('');
  const [perUserKeyword, setPerUserKeyword] = useState('');
  const [activeUserId, setActiveUserId] = useState('');
  const [newUserId, setNewUserId] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getAdminScopeSetting();
      setSetting(data);
      setDraftDefaults(data.defaultPages);
      setDraftPerUser(data.perUser);
      setDirty(false);
      setActiveUserId((prev) => (prev && data.perUser[prev] ? prev : Object.keys(data.perUser)[0] ?? ''));
    } catch (err) {
      setError(getBackendErrorMessage(err, '获取页面授权配置失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!canManage) {
      setLoading(false);
      return;
    }
    void load();
  }, [canManage, load]);

  const options = setting?.availablePages ?? [];

  const toggleDefault = useCallback((key: string) => {
    setDraftDefaults((prev) => (prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]));
    setDirty(true);
  }, []);

  const setDefaultAll = useCallback((keys: string[], mode: 'add' | 'remove') => {
    if (keys.length === 0) return;
    setDraftDefaults((prev) =>
      mode === 'add'
        ? Array.from(new Set([...prev, ...keys]))
        : prev.filter((key) => !keys.includes(key)),
    );
    setDirty(true);
  }, []);

  const togglePerUser = useCallback((userId: string, key: string) => {
    setDraftPerUser((prev) => {
      const current = prev[userId] ?? [];
      const next = current.includes(key) ? current.filter((item) => item !== key) : [...current, key];
      return { ...prev, [userId]: next };
    });
    setDirty(true);
  }, []);

  const setPerUserAll = useCallback((userId: string, keys: string[], mode: 'add' | 'remove') => {
    if (keys.length === 0) return;
    setDraftPerUser((prev) => {
      const current = prev[userId] ?? [];
      const next =
        mode === 'add'
          ? Array.from(new Set([...current, ...keys]))
          : current.filter((key) => !keys.includes(key));
      return { ...prev, [userId]: next };
    });
    setDirty(true);
  }, []);

  const removeUser = useCallback((userId: string) => {
    setDraftPerUser((prev) => {
      const next = { ...prev };
      delete next[userId];
      return next;
    });
    setActiveUserId((prev) => (prev === userId ? '' : prev));
    setDirty(true);
  }, []);

  const addOrSelectUser = useCallback(() => {
    const id = newUserId.trim();
    if (!id) {
      setNotification({ type: 'warning', message: '请先填写普通管理员的用户 ID' });
      return;
    }
    setDraftPerUser((prev) => (prev[id] ? prev : { ...prev, [id]: [] }));
    setActiveUserId(id);
    setNewUserId('');
    setDirty(true);
  }, [newUserId, setNotification]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const data = await updateAdminScopeSetting({
        defaultPages: draftDefaults,
        perUser: draftPerUser,
      });
      setSetting(data);
      setDraftDefaults(data.defaultPages);
      setDraftPerUser(data.perUser);
      setDirty(false);
      // 让当前会话（若是超管自己的界面）与后续导航过滤拿到新配置
      invalidateAdminScopeCache();
      setNotification({ type: 'success', message: '页面授权已保存，普通管理员下次加载导航即生效' });
    } catch (err) {
      setNotification({ type: 'error', message: getBackendErrorMessage(err, '保存页面授权失败') });
    } finally {
      setSaving(false);
    }
  }, [draftDefaults, draftPerUser, setNotification]);

  const resetToDefault = useCallback(async () => {
    setConfirmReset(false);
    setSaving(true);
    try {
      const data = await resetAdminScopeSetting();
      setSetting(data);
      setDraftDefaults(data.defaultPages);
      setDraftPerUser(data.perUser);
      setActiveUserId('');
      setDirty(false);
      invalidateAdminScopeCache();
      setNotification({ type: 'success', message: '已恢复后端默认授权' });
    } catch (err) {
      setNotification({ type: 'error', message: getBackendErrorMessage(err, '恢复默认授权失败') });
    } finally {
      setSaving(false);
    }
  }, [setNotification]);

  const perUserIds = useMemo(() => Object.keys(draftPerUser).sort(), [draftPerUser]);

  if (!canManage) {
    return (
      <InfoQueryShell className='logshare-admin-surface'>
        <InfoPanel className='border-rose-200 bg-rose-50/70'>
          <p className='flex items-center gap-2 text-sm font-semibold text-rose-700'>
            <FaExclamationTriangle aria-hidden /> 该页面仅超级管理员可用。
          </p>
        </InfoPanel>
      </InfoQueryShell>
    );
  }

  return (
    <InfoQueryShell className='logshare-admin-surface'>
      <InfoQueryHero
        eyebrow='Access Control'
        title='普通管理员页面授权'
        description='决定普通管理员（role = admin）能看到哪些管理页面。最终可见 = 默认授权 ∪ 该用户的单独覆盖；总览始终可见。保存后普通管理员下次加载即生效（无需重启服务）。'
        icon={FaUserShield}
        meta={
          <>
            <InfoBadge tone='slate'>{options.length} 个可授权页面</InfoBadge>
            <InfoBadge tone={setting?.isDefault ? 'amber' : 'emerald'}>
              {setting?.isDefault ? '当前为默认授权' : '已自定义'}
            </InfoBadge>
            {dirty ? <InfoBadge tone='amber'>有未保存改动</InfoBadge> : null}
          </>
        }
        actions={
          <button
            type='button'
            onClick={() => void load()}
            disabled={loading || saving}
            className={cn(studioSecondaryButtonClassName, 'px-3 py-2 text-xs disabled:opacity-50')}
          >
            <FaSyncAlt className={loading ? 'animate-spin' : undefined} aria-hidden /> 重新读取
          </button>
        }
      />

      {error ? (
        <InfoPanel className='mt-4 border-rose-200 bg-rose-50/70'>
          <p className='text-sm text-rose-700'>
            {error}
            <button type='button' onClick={() => void load()} className='ml-3 font-semibold underline'>
              重试
            </button>
          </p>
        </InfoPanel>
      ) : null}

      {setting ? (
        <InfoPanel className='mt-4'>
          <div className='flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500'>
            <span>
              最后更新：
              {setting.updatedAt ? new Date(setting.updatedAt).toLocaleString() : '（从未保存，使用默认值）'}
            </span>
            <span>操作者：{setting.updatedBy || '—'}</span>
          </div>
          <p className='mt-3 flex items-start gap-2 rounded-xl border border-sky-100 bg-sky-50/70 px-3 py-2 text-[13px] leading-6 text-sky-800'>
            <FaInfoCircle className='mt-0.5 shrink-0' aria-hidden />
            <span>
              标注「无 API 范围」的页面在登记表里没有对应的 API 前缀，授给普通管理员只会放出入口，
              页面内的请求仍会被服务端拒绝 —— 需要先给该页面登记 API 前缀才能真的用起来。
            </span>
          </p>
        </InfoPanel>
      ) : null}

      <InfoPanel className='mt-4'>
        <InfoSectionTitle
          title='默认授权'
          description='所有普通管理员都拿到的页面。留空表示「除总览外什么都不给」。'
          icon={FaUsers}
          eyebrow='Default'
          action={
            <button
              type='button'
              onClick={() => setConfirmReset(true)}
              disabled={saving}
              className={cn(studioGhostButtonClassName, 'px-3 py-2 text-xs disabled:opacity-50')}
            >
              <FaUndoAlt aria-hidden /> 恢复后端默认
            </button>
          }
        />
        <div className='mt-4'>
          <PagePicker
            options={options}
            selected={draftDefaults}
            onToggle={toggleDefault}
            onSetAll={setDefaultAll}
            keyword={defaultKeyword}
            onKeywordChange={setDefaultKeyword}
            disabled={saving || loading}
            idPrefix='scope-default'
          />
        </div>
      </InfoPanel>

      <InfoPanel className='mt-4'>
        <InfoSectionTitle
          title='按用户覆盖'
          description='在默认授权之上，给某个普通管理员额外加页面（并集，不会减少默认授权）。'
          icon={FaUserShield}
          eyebrow='Per user'
        />

        <div className='mt-4 flex flex-wrap items-center gap-2'>
          <input
            type='text'
            value={newUserId}
            onChange={(event) => setNewUserId(event.target.value)}
            placeholder='普通管理员的用户 ID（如 1754476659129）'
            aria-label='要覆盖授权的用户 ID'
            className={cn(studioFieldClassName, 'w-full sm:w-80')}
          />
          <button
            type='button'
            onClick={addOrSelectUser}
            disabled={saving || loading}
            className={cn(studioSecondaryButtonClassName, 'px-3 py-2 text-xs disabled:opacity-50')}
          >
            添加 / 选择
          </button>
          <span className='text-xs text-slate-500'>
            用户 ID 可在「用户管理」列表里复制（用户名下方那行 ID）。
          </span>
        </div>

        {perUserIds.length === 0 ? (
          <p className='mt-4 rounded-xl border border-dashed border-slate-200 px-3 py-6 text-center text-sm text-slate-500'>
            还没有按用户覆盖，所有普通管理员都使用默认授权。
          </p>
        ) : (
          <>
            <div className='mt-4 flex flex-wrap gap-2'>
              {perUserIds.map((userId) => {
                const count = draftPerUser[userId]?.length ?? 0;
                const active = activeUserId === userId;
                return (
                  <button
                    key={userId}
                    type='button'
                    onClick={() => setActiveUserId(userId)}
                    aria-pressed={active}
                    className={cn(
                      'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition',
                      active
                        ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
                        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300',
                    )}
                  >
                    <code className='font-mono'>{userId}</code>
                    <span className='text-[10px] text-slate-400'>+{count}</span>
                  </button>
                );
              })}
            </div>

            {activeUserId ? (
              <div className='mt-4 rounded-2xl border border-slate-200 bg-slate-50/70 p-4'>
                <div className='flex flex-wrap items-center justify-between gap-2'>
                  <div className='text-sm font-semibold text-slate-800'>
                    正在编辑：<code className='font-mono text-xs'>{activeUserId}</code>
                  </div>
                  <button
                    type='button'
                    onClick={() => removeUser(activeUserId)}
                    disabled={saving}
                    className={cn(studioGhostButtonClassName, 'px-3 py-2 text-xs text-rose-600 disabled:opacity-50')}
                  >
                    删除该用户覆盖
                  </button>
                </div>
                <div className='mt-3'>
                  <PagePicker
                    options={options}
                    selected={draftPerUser[activeUserId] ?? []}
                    onToggle={(key) => togglePerUser(activeUserId, key)}
                    onSetAll={(keys, mode) => setPerUserAll(activeUserId, keys, mode)}
                    keyword={perUserKeyword}
                    onKeywordChange={setPerUserKeyword}
                    disabled={saving || loading}
                    idPrefix={`scope-user-${activeUserId}`}
                  />
                </div>
              </div>
            ) : null}
          </>
        )}
      </InfoPanel>

      <div className='sticky bottom-4 mt-4 flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white/90 px-4 py-3 shadow-sm backdrop-blur'>
        <button
          type='button'
          onClick={() => void save()}
          disabled={saving || loading || !dirty}
          className={cn(studioPrimaryButtonClassName, 'px-4 py-2 text-sm disabled:opacity-50')}
        >
          {saving ? <FaSyncAlt className='animate-spin' aria-hidden /> : <FaSave aria-hidden />}
          保存授权
        </button>
        <button
          type='button'
          onClick={() => {
            if (!setting) return;
            setDraftDefaults(setting.defaultPages);
            setDraftPerUser(setting.perUser);
            setDirty(false);
          }}
          disabled={saving || !dirty}
          className={cn(studioSecondaryButtonClassName, 'px-4 py-2 text-sm disabled:opacity-50')}
        >
          放弃改动
        </button>
        <span className='flex items-center gap-1.5 text-xs text-slate-500'>
          <FaCheck aria-hidden /> 保存为覆盖式写入：默认授权 + 按用户覆盖会整体替换为当前选择。
        </span>
      </div>

      <ConfirmModal
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        onConfirm={() => void resetToDefault()}
        title='恢复默认授权'
        message='将删除已保存的配置，回到后端默认（仅 users / apikeys / apikey-billing / oauth 四个页面）。此操作会立即影响所有普通管理员的可见页面。'
        confirmText='确认恢复'
        type='danger'
      />
    </InfoQueryShell>
  );
};

export default AdminScopeManager;
