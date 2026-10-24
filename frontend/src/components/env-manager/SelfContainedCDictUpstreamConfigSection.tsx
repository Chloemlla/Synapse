import { useCallback, useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { useAuth } from '../../hooks/useAuth';
import { isSuperAdmin } from '../../utils/rbac';
import { useNotification } from '../Notification';
import { useConfirm } from '../confirm/ConfirmDialogProvider';
import CDictUpstreamConfigSection, { type CDictUpstreamDraft } from './CDictUpstreamConfigSection';
import { CDICT_UPSTREAM_API, authFetch, getAuthHeaders } from './api';
import type { CDictUpstreamConfigSetting, CDictUpstreamConfigUpdate } from './types';

interface Props {
  prefersReducedMotion?: boolean | null;
}

type Action = 'refreshing' | 'saving' | 'resetting';
interface Operation {
  controller: AbortController;
}
interface Snapshot {
  config: CDictUpstreamConfigSetting;
  updatedAt?: string;
}

const EMPTY_DRAFT: CDictUpstreamDraft = {
  translateBaseUrl: '', translateAppId: '', ttsUrl: '', ttsAppId: '',
  ttsAppKey: '', clearTtsAppKey: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readSnapshot(data: Record<string, unknown>): Snapshot {
  const setting = data.setting;
  const config = isRecord(setting) ? setting.config : undefined;
  // A partial or malformed read must never turn into an editable set of defaults.
  if (!isRecord(config)
    || typeof config.translateBaseUrl !== 'string'
    || typeof config.translateAppId !== 'string'
    || typeof config.ttsUrl !== 'string'
    || typeof config.ttsAppId !== 'string'
    || typeof config.ttsAppKey !== 'string'
    || typeof config.hasTtsAppKey !== 'boolean') {
    throw new Error('配置读取不完整，请重试后再编辑。');
  }
  return {
    config: {
      translateBaseUrl: config.translateBaseUrl,
      translateAppId: config.translateAppId,
      ttsUrl: config.ttsUrl,
      ttsAppId: config.ttsAppId,
      // Only the boolean is displayed; even masked fragments never become input values.
      ttsAppKey: config.ttsAppKey,
      hasTtsAppKey: config.hasTtsAppKey,
    },
    updatedAt: isRecord(setting) && typeof setting.updatedAt === 'string' ? setting.updatedAt : undefined,
  };
}

function draftFromConfig(config: CDictUpstreamConfigSetting): CDictUpstreamDraft {
  return {
    translateBaseUrl: config.translateBaseUrl, translateAppId: config.translateAppId,
    ttsUrl: config.ttsUrl, ttsAppId: config.ttsAppId,
    ttsAppKey: '', clearTtsAppKey: false,
  };
}

function hasChanges(draft: CDictUpstreamDraft, snapshot: Snapshot | null): boolean {
  if (draft.ttsAppKey || draft.clearTtsAppKey) return true;
  if (!snapshot) return false;
  const config = snapshot.config;
  return draft.translateBaseUrl !== config.translateBaseUrl
    || draft.translateAppId !== config.translateAppId
    || draft.ttsUrl !== config.ttsUrl
    || draft.ttsAppId !== config.ttsAppId;
}

export default function SelfContainedCDictUpstreamConfigSection({ prefersReducedMotion: reducedMotionProp }: Props) {
  const prefersReducedMotion = useReducedMotion() ?? reducedMotionProp;
  const { user } = useAuth();
  const canWrite = isSuperAdmin(user?.role);
  const canWriteRef = useRef(canWrite);
  canWriteRef.current = canWrite;
  const { setNotification } = useNotification();
  const confirm = useConfirm();
  const [isOpen, setIsOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState<CDictUpstreamDraft>({ ...EMPTY_DRAFT });
  const [action, setAction] = useState<Action | null>(null);
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState('');
  const [actionError, setActionError] = useState('');
  const mountedRef = useRef(true);
  const attemptedRef = useRef(false);
  // The synchronous lock covers confirmations too, so two clicks cannot race before rerender.
  const operationRef = useRef<Operation | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationRef.current?.controller.abort();
      operationRef.current = null;
      attemptedRef.current = false;
    };
  }, []);

  const owns = useCallback((operation: Operation) => (
    mountedRef.current && operationRef.current === operation && !operation.controller.signal.aborted
  ), []);

  const begin = useCallback((nextAction: Action): Operation | null => {
    if (!mountedRef.current || operationRef.current) return null;
    const operation = { controller: new AbortController() };
    operationRef.current = operation;
    setAction(nextAction);
    return operation;
  }, []);

  const finish = useCallback((operation: Operation) => {
    if (!owns(operation)) return;
    operationRef.current = null;
    setAction(null);
    setLoading(false);
  }, [owns]);

  const request = useCallback(async (
    operation: Operation, method: 'GET' | 'POST' | 'DELETE', payload?: CDictUpstreamConfigUpdate,
  ): Promise<Record<string, unknown>> => {
    const response = await authFetch(CDICT_UPSTREAM_API, {
      method,
      headers: { ...getAuthHeaders(), ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
      signal: operation.controller.signal,
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok || !isRecord(data) || data.success !== true) {
      throw new Error(isRecord(data) && typeof data.error === 'string' ? data.error : '操作失败，请稍后重试。');
    }
    return data;
  }, []);

  const fetchConfig = useCallback(async (operation: Operation) => {
    if (!owns(operation)) return;
    setLoading(true);
    setReadError('');
    try {
      const data = await request(operation, 'GET');
      if (!owns(operation)) return;
      const next = readSnapshot(data);
      setSnapshot(next);
      setDraft(draftFromConfig(next.config));
    } catch (error) {
      if (owns(operation)) {
        setReadError('读取 CDict 翻译与朗读配置失败：' + (error instanceof Error ? error.message : '请重试。'));
      }
    } finally {
      if (owns(operation)) setLoading(false);
    }
  }, [owns, request]);

  const refresh = useCallback(async () => {
    const operation = begin('refreshing');
    if (!operation) return;
    try {
      if (hasChanges(draft, snapshot)) {
        const accepted = await confirm({
          title: '刷新并放弃未保存的修改？',
          description: '刷新会重新读取已保存配置，未保存的地址、应用 ID 与新密钥将被丢弃。',
          confirmLabel: '放弃修改并刷新',
        });
        if (!accepted || !owns(operation)) return;
      }
      setActionError('');
      await fetchConfig(operation);
    } catch {
      if (owns(operation)) setActionError('无法完成刷新确认，请重试。');
    } finally {
      finish(operation);
    }
  }, [begin, confirm, draft, fetchConfig, finish, owns, snapshot]);

  useEffect(() => {
    if (isOpen && !attemptedRef.current) {
      attemptedRef.current = true;
      void refresh();
    }
  }, [isOpen, refresh]);

  const save = useCallback(async () => {
    if (!canWriteRef.current || !snapshot || readError) return;
    const operation = begin('saving');
    if (!operation) return;
    setActionError('');
    try {
      const key = draft.ttsAppKey.trim();
      if (!draft.clearTtsAppKey && key && (key === snapshot.config.ttsAppKey || /[*•]/.test(key))) {
        setActionError('请输入完整的新朗读密钥，不能保存脱敏占位内容。');
        return;
      }
      if (draft.clearTtsAppKey) {
        const accepted = await confirm({
          title: '清除朗读密钥并停用在线朗读？',
          description: '保存后 CDict 将不能使用 vivo 在线朗读。之后可输入新密钥，或恢复部署默认值。',
          tone: 'danger', confirmLabel: '清除密钥并保存',
        });
        if (!accepted || !owns(operation) || !canWriteRef.current) return;
      }
      const payload: CDictUpstreamConfigUpdate = {
        translateBaseUrl: draft.translateBaseUrl.trim(), translateAppId: draft.translateAppId.trim(),
        ttsUrl: draft.ttsUrl.trim(), ttsAppId: draft.ttsAppId.trim(),
        ...(draft.clearTtsAppKey ? { clearTtsAppKey: true as const } : key ? { ttsAppKey: key } : {}),
      };
      await request(operation, 'POST', payload);
      if (!owns(operation)) return;
      const config: CDictUpstreamConfigSetting = {
        ...snapshot.config,
        translateBaseUrl: payload.translateBaseUrl, translateAppId: payload.translateAppId,
        ttsUrl: payload.ttsUrl, ttsAppId: payload.ttsAppId,
        ttsAppKey: draft.clearTtsAppKey || key ? '' : snapshot.config.ttsAppKey,
        hasTtsAppKey: !draft.clearTtsAppKey && (Boolean(key) || snapshot.config.hasTtsAppKey),
      };
      // Clear the secret immediately on accepted writes, even if the follow-up read fails.
      setSnapshot({ config });
      setDraft(draftFromConfig(config));
      setNotification({ message: 'CDict 翻译与朗读配置已保存', type: 'success' });
      await fetchConfig(operation);
    } catch (error) {
      if (owns(operation)) setActionError('保存失败：' + (error instanceof Error ? error.message : '请重试。'));
    } finally {
      finish(operation);
    }
  }, [begin, confirm, draft, fetchConfig, finish, owns, readError, request, setNotification, snapshot]);

  const reset = useCallback(async () => {
    if (!canWriteRef.current || !snapshot || readError) return;
    const operation = begin('resetting');
    if (!operation) return;
    try {
      const accepted = await confirm({
        title: '恢复 CDict 翻译与朗读的部署默认值？',
        description: '将删除这五项配置的所有后台覆盖并放弃未保存的修改，重新使用部署环境值。若部署环境有朗读密钥，在线朗读可能重新启用。',
        tone: 'danger', confirmLabel: '恢复部署默认值',
      });
      if (!accepted || !owns(operation) || !canWriteRef.current) return;
      setActionError('');
      await request(operation, 'DELETE');
      if (!owns(operation)) return;
      setSnapshot(null);
      setDraft((value) => ({ ...value, ttsAppKey: '', clearTtsAppKey: false }));
      setNotification({ message: '已恢复 CDict 翻译与朗读的部署默认值', type: 'success' });
      await fetchConfig(operation);
    } catch (error) {
      if (owns(operation)) setActionError('恢复默认值失败：' + (error instanceof Error ? error.message : '请重试。'));
    } finally {
      finish(operation);
    }
  }, [begin, confirm, fetchConfig, finish, owns, readError, request, setNotification, snapshot]);

  return (
    <CDictUpstreamConfigSection
      isOpen={isOpen} onToggle={() => setIsOpen((value) => !value)} prefersReducedMotion={prefersReducedMotion}
      readOnly={!canWrite} loaded={snapshot !== null} loading={loading}
      saving={action === 'saving'} resetting={action === 'resetting'} busy={action !== null}
      readError={readError} actionError={actionError} draft={draft}
      hasTtsAppKey={snapshot?.config.hasTtsAppKey ?? false} updatedAt={snapshot?.updatedAt}
      onDraftChange={(patch) => {
        if (canWriteRef.current && snapshot && !readError && !operationRef.current) {
          setDraft((value) => ({ ...value, ...patch }));
        }
      }}
      onRefresh={() => void refresh()} onSave={() => void save()} onReset={() => void reset()}
    />
  );
}
