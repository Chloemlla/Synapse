import React, { useCallback, useEffect, useState } from 'react';
import { FiAlertCircle, FiLoader, FiPaperclip, FiRefreshCw } from 'react-icons/fi';
import { cn } from '../../utils/cn';
import { ticketApi } from '../../api/ticketApi';
import { useConfirm } from '../confirm/ConfirmDialogProvider';
import {
  studioEyebrowClassName,
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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | undefined>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const setting = await ticketApi.getAttachmentSettings();
      setEnabled(setting.userUploadEnabled);
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
        await ticketApi.saveAttachmentSettings(next);
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
      onNotify?.({ type: 'success', message: '已恢复默认（普通用户不能上传附件）' });
    } catch {
      onNotify?.({ type: 'error', message: '恢复默认失败，请重试' });
    } finally {
      setSaving(false);
    }
  }, [confirm, onNotify]);

  return (
    <section className={cn(studioPanelClassName, 'shrink-0 p-3 sm:p-4')} aria-label="工单附件上传开关">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-2xl bg-slate-900 text-white">
            <FiPaperclip size={13} />
          </span>
          <div className="min-w-0">
            <div className={studioEyebrowClassName}>Attachment policy</div>
            <div className="truncate text-xs font-semibold text-slate-900">
              普通用户附件上传：{enabled ? '已开启' : '默认关闭（仅附件链接）'}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {loading ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-slate-400">
              <FiLoader className="animate-spin" size={12} /> 读取中
            </span>
          ) : loadError ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-rose-600">
              <FiAlertCircle size={12} /> {loadError}
            </span>
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
          : '普通用户只能提交附件链接（我们只存 URL，不代为下载或转存）；需要收文件时再开启上传。'}
        {updatedAt ? ` 上次修改：${new Date(updatedAt).toLocaleString()}` : ''}
      </p>
    </section>
  );
};

export default TicketAttachmentSettingsCard;
