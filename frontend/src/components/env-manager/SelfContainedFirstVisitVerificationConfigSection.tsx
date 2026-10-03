import { useCallback, useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { useAuth } from '../../hooks/useAuth';
import { isSuperAdmin } from '../../utils/rbac';
import { getBackendErrorMessage } from '../../utils/backendError';
import { useNotification } from '../Notification';
import { useConfirm } from '../confirm/ConfirmDialogProvider';
import FirstVisitVerificationConfigSection from './FirstVisitVerificationConfigSection';
import { FIRST_VISIT_VERIFICATION_API, getAuthHeaders, authFetch } from './api';
import type { FirstVisitVerificationConfigSetting } from './types';

interface SelfContainedFirstVisitVerificationConfigSectionProps {
  prefersReducedMotion?: boolean | null;
}

/**
 * 首访验证闸门（FIRST_VISIT_VERIFICATION）。这是该开关唯一的配置入口：
 * 保存写运行时配置（ENABLE_FIRST_VISIT_VERIFICATION 环境变量只作启动默认值），
 * config.enableFirstVisitVerification 读内存缓存，保存后无需重启即生效。
 */
export default function SelfContainedFirstVisitVerificationConfigSection({
  prefersReducedMotion: reducedMotionProp,
}: SelfContainedFirstVisitVerificationConfigSectionProps) {
  const prefersReducedMotion = useReducedMotion() ?? reducedMotionProp;
  const { setNotification } = useNotification();
  const confirm = useConfirm();
  const { user } = useAuth();
  const canWrite = isSuperAdmin(user?.role);
  const [isOpen, setIsOpen] = useState(false);
  const fetchedRef = useRef(false);

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // 默认与后端启动默认值一致（开启）：读到库里的值之前，界面上不能先显示一个「已关闭」的假状态。
  const [enabled, setEnabled] = useState(true);
  // 是否成功读到过服务器配置：未读到之前禁止保存，否则会把界面上的默认值（enabled:true）写回线上。
  const [loaded, setLoaded] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | undefined>();

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(FIRST_VISIT_VERIFICATION_API, { headers: { ...getAuthHeaders() } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotification({ message: data.error || '获取首访验证配置失败', type: 'error' });
        return;
      }
      const cfg = (data?.setting?.config || {}) as Partial<FirstVisitVerificationConfigSetting>;
      setEnabled(cfg.enabled !== false);
      setLoaded(true);
      setUpdatedAt(data?.setting?.updatedAt);
    } catch (error) {
      setNotification({
        message: `获取首访验证配置失败：${getBackendErrorMessage(error, '未知错误')}。界面显示的开关状态不代表服务器当前值，请先点「刷新」加载成功后再保存。`,
        type: 'error',
      });
    } finally {
      setLoading(false);
    }
  }, [setNotification]);

  useEffect(() => {
    if (isOpen && !fetchedRef.current) {
      fetchedRef.current = true;
      fetchConfig();
    }
  }, [isOpen, fetchConfig]);

  const handleSave = useCallback(async () => {
    if (!canWrite) return;
    if (saving) return;
    // 未成功加载过配置时，enabled 只是界面默认值，保存会把线上状态改回默认。
    if (!loaded) {
      setNotification({ message: '配置未加载，禁止保存：请先点「刷新」成功读取服务器配置。', type: 'error' });
      return;
    }
    setSaving(true);
    try {
      const res = await authFetch(FIRST_VISIT_VERIFICATION_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotification({ message: data.error || '保存失败', type: 'error' });
        return;
      }
      setNotification({
        message: enabled ? '首访验证已开启：首次访问需通过验证' : '首访验证已关闭：所有请求视为已验证',
        type: 'success',
      });
      await fetchConfig();
    } catch (error) {
      setNotification({ message: `保存失败：${getBackendErrorMessage(error, '未知错误')}`, type: 'error' });
    } finally {
      setSaving(false);
    }
  }, [canWrite, saving, loaded, enabled, fetchConfig, setNotification]);

  const handleReset = useCallback(async () => {
    if (!canWrite) return;
    if (deleting) return;
    if (
      !(await confirm({
          title: '确认执行该操作？',
          description: '确定重置首访验证设置？重置后会回退到部署环境变量 ENABLE_FIRST_VISIT_VERIFICATION（未设置则为开启）。',
          tone: 'danger',
          confirmLabel: '重置',
        }))
    ) {
      return;
    }
    setDeleting(true);
    try {
      const res = await authFetch(FIRST_VISIT_VERIFICATION_API, { method: 'DELETE', headers: { ...getAuthHeaders() } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotification({ message: data.error || '重置失败', type: 'error' });
        return;
      }
      setNotification({ message: '已重置首访验证设置', type: 'success' });
      await fetchConfig();
    } catch (error) {
      setNotification({ message: `重置失败：${getBackendErrorMessage(error, '未知错误')}`, type: 'error' });
    } finally {
      setDeleting(false);
    }
  }, [canWrite, deleting, fetchConfig, setNotification]);

  return (
    <FirstVisitVerificationConfigSection
      isOpen={isOpen}
      onToggle={() => setIsOpen((v) => !v)}
      prefersReducedMotion={prefersReducedMotion}
      loading={loading}
      saving={saving}
      deleting={deleting}
      disabled={!canWrite || !loaded}
      enabled={enabled}
      updatedAt={updatedAt}
      onEnabledChange={setEnabled}
      onRefresh={fetchConfig}
      onSave={handleSave}
      onReset={handleReset}
    />
  );
}
