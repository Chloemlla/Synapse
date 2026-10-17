import React, { useCallback, useEffect, useState } from 'react';
import { FiAlertCircle, FiChevronDown, FiLoader, FiPaperclip, FiRefreshCw, FiUserPlus, FiX } from 'react-icons/fi';
import { cn } from '../../utils/cn';
import { ticketApi, type TicketAttachmentGrantedUser } from '../../api/ticketApi';
import { useConfirm } from '../confirm/ConfirmDialogProvider';
import {
  studioEyebrowClassName,
  studioFieldClassName,
  studioGhostButtonClassName,
  studioPanelClassName,
} from '../studioTheme';

/**
 * 管理端：工单附件上传开关（超管）。
 *
 * 为什么做成开关而不是直接放开：附件是用户上传的**任意二进制**。白名单（jpg/jpeg/png/gif/txt/pdf）
 * 与体积/数量上限只能挡住「类型不对」和「太大」，挡不住「类型对但内容是恶意文件/垃圾」。
 * 所以默认关闭，普通用户改用「附件链接」通道（我们只存 URL，不代管文件）；
 * 确实需要收文件的场景由超管在这里手动打开。
 *
 * 值存在运行时配置（`runtime_config_settings` 的 TICKET_ATTACHMENTS），保存后立即生效、
 * 多实例 ≤10s 收敛；与 env-manager 里的同名分区是同一份数据，这里是「在工单管理台顺手能改」的入口。
 */
const TicketAttachmentSettingsCard: React.FC<{ onNotify?: (payload: { type: 'success' | 'error'; message: string }) => void }> = ({
  onNotify,
}) => {
  const confirm = useConfirm();
  const [enabled, setEnabled] = useState(false);
  /** 单独授权名单（服务端已解析成「ID + 可读名」）。 */
  const [grantedUsers, setGrantedUsers] = useState<TicketAttachmentGrantedUser[]>([]);
  const [grantInput, setGrantInput] = useState('');
  const [grantBusy, setGrantBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | undefined>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const setting = await ticketApi.getAttachmentSettings();
      setEnabled(setting.userUploadEnabled);
      setGrantedUsers(setting.userUploadAllowedUsers);
      setUpdatedAt(setting.updatedAt);
      setLoadError(null);
    } catch {
      // 读不到就不能假装是「关闭」：那会让管理员在错误的前提下改开关
      setLoadError('读取附件上传配置失败，请重试');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback(
    async (next: boolean) => {
      const ok = await confirm({
        title: next ? '允许普通用户上传附件文件？' : '关闭普通用户的附件上传？',
        description: next
          ? '开启后，任何已登录用户都能往自己的工单里上传 jpg/png/gif/txt/pdf（单个 ≤1MB、每个工单 ≤5 个）。附件正文会存进数据库，仅工单属主与超级管理员可下载。'
          : '关闭后，普通用户只能以「附件链接」的方式提交截图；已上传的附件仍然保留，可正常下载与删除。',
        tone: next ? 'danger' : 'default',
        confirmLabel: next ? '开启上传' : '关闭上传',
      });
      if (!ok) return;
      setSaving(true);
      try {
        await ticketApi.saveAttachmentSettings({ userUploadEnabled: next });
        setEnabled(next);
        onNotify?.({ type: 'success', message: next ? '已允许普通用户上传附件' : '已关闭普通用户的附件上传' });
      } catch (error) {
        const message =
          (error as { response?: { data?: { error?: string } } })?.response?.data?.error || '保存失败，请重试';
        onNotify?.({ type: 'error', message });
      } finally {
        setSaving(false);
      }
    },
    [confirm, onNotify],
  );

  const reset = useCallback(async () => {
    const ok = await confirm({
      title: '恢复默认设置？',
      description: '默认不开放普通用户上传附件（只能用附件链接）。',
      tone: 'danger',
      confirmLabel: '恢复默认',
    });
    if (!ok) return;
    setSaving(true);
    try {
      await ticketApi.resetAttachmentSettings();
      setEnabled(false);
      setGrantedUsers([]);
      onNotify?.({ type: 'success', message: '已恢复默认（普通用户不能上传附件）' });
    } catch {
      onNotify?.({ type: 'error', message: '恢复默认失败，请重试' });
    } finally {
      setSaving(false);
    }
  }, [confirm, onNotify]);

  /**
   * 保存整份名单（服务端是「整体替换」语义）。
   *
   * 先按新名单乐观更新界面，失败再回滚 —— 添加/移除都是单次点击，等一个来回
   * 才反馈在低频管理操作上没有必要；但失败必须回到原样，否则界面会显示一份没存进去的名单。
   */
  const persistGrantedUsers = useCallback(
    async (nextIds: string[], optimistic: TicketAttachmentGrantedUser[], successMessage: string) => {
      const previous = grantedUsers;
      setGrantedUsers(optimistic);
      setGrantBusy(true);
      try {
        await ticketApi.saveAttachmentSettings({ userUploadAllowedUserIds: nextIds });
        onNotify?.({ type: 'success', message: successMessage });
        // 重新拉一次：新加的用户需要服务端返回的 username/email 才能显示可读名。
        await load();
      } catch (error) {
        setGrantedUsers(previous);
        const message =
          (error as { response?: { data?: { error?: string } } })?.response?.data?.error ||
          '保存授权名单失败，请重试';
        onNotify?.({ type: 'error', message });
      } finally {
        setGrantBusy(false);
      }
    },
    [grantedUsers, load, onNotify],
  );

  const addGrant = useCallback(async () => {
    const entry = grantInput.trim();
    if (!entry) return;
    if (grantedUsers.length >= 200) {
      onNotify?.({ type: 'error', message: '单独授权最多 200 人，请先移除一些' });
      return;
    }
    const nextIds = [...grantedUsers.map((item) => item.id), entry];
    // 乐观项先用输入值占位；load() 会用服务端解析出的真实用户名/邮箱覆盖它。
    const optimistic = [...grantedUsers, { id: entry, username: entry, email: null, missing: false }];
    setGrantInput('');
    await persistGrantedUsers(nextIds, optimistic, `已授权 ${entry} 上传附件`);
  }, [grantInput, grantedUsers, onNotify, persistGrantedUsers]);

  const removeGrant = useCallback(
    async (target: TicketAttachmentGrantedUser) => {
      const nextIds = grantedUsers.filter((item) => item.id !== target.id).map((item) => item.id);
      const optimistic = grantedUsers.filter((item) => item.id !== target.id);
      await persistGrantedUsers(nextIds, optimistic, `已取消 ${target.username || target.id} 的授权`);
    },
    [grantedUsers, persistGrantedUsers],
  );

  return (
    /*
      低频设置默认收起：工单台是高频操作页，附件开关常驻顶部会白占首屏。
      summary 里只放文字与图标，不放按钮 —— 嵌套交互控件会让「展开」与「点开关」
      在触摸/键盘上互相抢占，点一下可能只展开了面板却没切换开关。
    */
    <details
      className={cn(studioPanelClassName, 'group shrink-0 p-0 sm:p-0')}
      aria-label="管理设置：工单附件上传"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-2xl p-3 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 sm:p-4 [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-2xl bg-slate-900 text-white">
            <FiPaperclip size={13} aria-hidden />
          </span>
          <span className="min-w-0">
            <span className={cn(studioEyebrowClassName, 'block')}>Attachment policy</span>
            <span className="block truncate text-xs font-semibold text-slate-900">
              管理设置 · 附件上传：
              {loading ? '读取中' : loadError ? '读取失败' : enabled ? '已开启' : '默认关闭'}
              {' '}· 单独授权 {grantedUsers.length} 人
            </span>
          </span>
        </span>
        <FiChevronDown className="shrink-0 text-slate-400 transition group-open:rotate-180" size={16} aria-hidden />
      </summary>

      <div className="border-t border-slate-200/70 p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-slate-900">
              普通用户附件上传：{enabled ? '已开启' : '默认关闭（仅附件链接）'}
            </div>
            <div className="mt-0.5 text-[10px] text-slate-400">修改后立即生效，多实例 ≤10 秒收敛。</div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {loading ? (
              <span className="inline-flex items-center gap-1 text-[11px] text-slate-400">
                <FiLoader className="animate-spin" size={12} /> 读取中
              </span>
            ) : loadError ? (
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-rose-600" role="alert">
                <span className="inline-flex items-center gap-1">
                  <FiAlertCircle size={12} /> {loadError}
                </span>
                {/* 读不到配置时给出可执行出口：只显示错误会让人以为开关就是「关闭」。 */}
                <button
                  type="button"
                  onClick={() => void load()}
                  disabled={loading}
                  className={cn(
                    studioGhostButtonClassName,
                    'h-7 gap-1 px-2.5 py-0 text-[10px] normal-case tracking-normal',
                  )}
                >
                  <FiRefreshCw size={11} aria-hidden /> 重试
                </button>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  disabled={saving}
                  onClick={() => void toggle(!enabled)}
                  className={cn(
                    'inline-flex h-7 items-center gap-1 rounded-full border px-3 text-[11px] font-semibold transition disabled:opacity-60',
                    enabled
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900',
                  )}
                >
                  {saving ? <FiLoader className="animate-spin" size={11} /> : null}
                  {enabled ? '关闭上传' : '开启上传'}
                </button>
                <button
                  type="button"
                  onClick={() => void reset()}
                  disabled={saving}
                  className={cn(studioGhostButtonClassName, 'h-7 gap-1 px-2.5 py-0 text-[10px] normal-case tracking-normal')}
                  title="恢复默认：不开放普通用户上传附件"
                >
                  <FiRefreshCw size={11} /> 恢复默认
                </button>
              </>
            )}
          </div>
        </div>

        <p className="mt-2 text-[10px] leading-4 text-slate-400">
          {enabled
            ? '普通用户可上传 jpg/jpeg/png/gif/txt/pdf（单个 ≤1MB、每工单 ≤5 个）；附件正文入库存管，仅属主与超管可下载。'
            : '普通用户只能提交附件链接（我们只存 URL，不代为下载或转存）；需要收文件时再开启上传，或在下方单独授权个别用户。'}
          {updatedAt ? ` 上次修改：${new Date(updatedAt).toLocaleString()}` : ''}
        </p>

        {/*
          单独授权：全站开关关闭时，名单里的普通用户仍可上传。
          存在的意义是「客服确实需要某个用户补一张截图，但不想为此对全站开放任意二进制上传」。
          全站开关打开时这里依然可见 —— 它不影响授权，只是说明为什么现在所有人都能传。
        */}
        <div className="mt-3 border-t border-slate-200/70 pt-3">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold text-slate-700">单独授权上传附件</span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
              {grantedUsers.length} 人
            </span>
            {enabled ? (
              <span className="text-[10px] text-slate-400">全站已开启，授权名单此时不影响结果</span>
            ) : null}
          </div>

          {grantedUsers.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {grantedUsers.map((granted) => (
                <li
                  key={granted.id}
                  className={cn(
                    'inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]',
                    granted.missing
                      ? 'border-amber-200 bg-amber-50 text-amber-800'
                      : 'border-slate-200 bg-white text-slate-700',
                  )}
                  title={granted.missing ? `用户 ${granted.id} 已不存在，建议移除以保持名单干净` : granted.id}
                >
                  <span className="min-w-0 truncate">
                    {granted.username || granted.email || granted.id}
                    {granted.missing ? '（已注销）' : ''}
                  </span>
                  <button
                    type="button"
                    onClick={() => void removeGrant(granted)}
                    disabled={grantBusy || saving}
                    aria-label={`移除 ${granted.username || granted.id} 的附件上传授权`}
                    className="shrink-0 rounded-full p-0.5 text-slate-400 transition hover:bg-slate-100 hover:text-rose-600 disabled:opacity-50"
                  >
                    <FiX size={11} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-[10px] text-slate-400">暂无单独授权的用户。</p>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={grantInput}
              onChange={(event) => setGrantInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void addGrant();
                }
              }}
              placeholder="用户名 / 邮箱 / 用户 ID"
              aria-label="要单独授权上传附件的用户"
              disabled={grantBusy || saving}
              className={cn(studioFieldClassName, 'h-8 min-w-0 flex-1 py-0 text-xs sm:max-w-xs')}
            />
            <button
              type="button"
              onClick={() => void addGrant()}
              disabled={grantBusy || saving || !grantInput.trim()}
              className={cn(
                studioGhostButtonClassName,
                'h-8 gap-1 px-3 py-0 text-[11px] normal-case tracking-normal',
              )}
            >
              {grantBusy ? <FiLoader className="animate-spin" size={11} /> : <FiUserPlus size={11} />}
              添加授权
            </button>
          </div>
          <p className="mt-1.5 text-[10px] leading-4 text-slate-400">
            只影响名单里的普通用户；管理员与超管本来就不受开关限制。名单按用户 ID 保存，改名或换邮箱不会把授权转移给别人。
          </p>
        </div>
      </div>
    </details>
  );
};

export default TicketAttachmentSettingsCard;
