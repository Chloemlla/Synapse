import { useCallback, useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { useNotification } from '../Notification';
import { useAuth } from '../../hooks/useAuth';
import { isSuperAdmin } from '../../utils/rbac';
import GeoGebraAiConfigSection from './GeoGebraAiConfigSection';
import { GEOGEBRA_AI_SETTING_API, authFetch, getAuthHeaders } from './api';
import type {
  ChatWireFormat,
  GeoGebraAiAdminStatus,
  GeoGebraAiProviderMode,
  GeoGebraLibreChatProviderOption,
} from './types';

interface SelfContainedGeoGebraAiConfigSectionProps {
  prefersReducedMotion?: boolean | null;
}

function normalizeMode(value: unknown): GeoGebraAiProviderMode {
  return value === 'custom' || value === 'librechat' ? value : 'env';
}

function normalizeWire(value: unknown): ChatWireFormat {
  return value === 'openai-responses' || value === 'anthropic' ? value : 'openai-chat';
}

function normalizeStatus(value: unknown): GeoGebraAiAdminStatus | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.configured !== 'boolean') return null;
  return {
    configured: raw.configured,
    source: normalizeMode(raw.source),
    reason: typeof raw.reason === 'string' && raw.reason ? raw.reason : null,
  };
}

function normalizeProviders(value: unknown): GeoGebraLibreChatProviderOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const raw = item as Record<string, unknown>;
    if (typeof raw.id !== 'string' || !raw.id) return [];
    return [{
      id: raw.id,
      baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : '',
      model: typeof raw.model === 'string' ? raw.model : '',
      wire: normalizeWire(raw.wire),
      group: typeof raw.group === 'string' ? raw.group : '',
      enabled: raw.enabled !== false,
      compatible: raw.compatible === true,
    }];
  });
}

/**
 * GeoGebra AI 提供商的自包含分区：读取 / 保存都走同一个超管端点，
 * 复用 LibreChat 提供者的清单由后端一并返回（不需要前端再拉一次 providers 接口）。
 */
export default function SelfContainedGeoGebraAiConfigSection({ prefersReducedMotion: reducedMotionProp }: SelfContainedGeoGebraAiConfigSectionProps) {
  const prefersReducedMotion = useReducedMotion() ?? reducedMotionProp;
  const { user } = useAuth();
  const canWrite = isSuperAdmin(user?.role);
  const { setNotification } = useNotification();
  const [isOpen, setIsOpen] = useState(false);
  const fetchedRef = useRef(false);

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<GeoGebraAiProviderMode>('env');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [vision, setVision] = useState(false);
  const [librechatProviderId, setLibrechatProviderId] = useState('');
  const [providers, setProviders] = useState<GeoGebraLibreChatProviderOption[]>([]);
  const [status, setStatus] = useState<GeoGebraAiAdminStatus | null>(null);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [apiKeyMasked, setApiKeyMasked] = useState('');
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  const applyPayload = useCallback((payload: Record<string, unknown>) => {
    const config = payload.config && typeof payload.config === 'object' && !Array.isArray(payload.config)
      ? (payload.config as Record<string, unknown>)
      : {};
    setMode(normalizeMode(config.mode));
    setBaseUrl(typeof config.baseUrl === 'string' ? config.baseUrl : '');
    setModel(typeof config.model === 'string' ? config.model : '');
    setVision(config.vision === true);
    setLibrechatProviderId(typeof config.librechatProviderId === 'string' ? config.librechatProviderId : '');
    setHasApiKey(config.hasApiKey === true);
    setApiKeyMasked(typeof config.apiKeyMasked === 'string' ? config.apiKeyMasked : '');
    setUpdatedAt(typeof config.updatedAt === 'string' ? config.updatedAt : null);
    // 密钥永不回填：留空即保持已保存的值。
    setApiKey('');
    setProviders(normalizeProviders(payload.providers));
    setStatus(normalizeStatus(payload.status));
  }, []);

  const fetchSetting = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(GEOGEBRA_AI_SETTING_API, { headers: { ...getAuthHeaders() } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        setNotification({ message: data.error || '读取 GeoGebra AI 配置失败', type: 'error' });
        return;
      }
      applyPayload(data as Record<string, unknown>);
    } catch (error) {
      setNotification({
        message: '读取 GeoGebra AI 配置失败：' + (error instanceof Error ? error.message : '未知错误'),
        type: 'error',
      });
    } finally {
      setLoading(false);
    }
  }, [applyPayload, setNotification]);

  useEffect(() => {
    if (isOpen && !fetchedRef.current) {
      fetchedRef.current = true;
      void fetchSetting();
    }
  }, [isOpen, fetchSetting]);

  const handleSave = useCallback(() => {
    if (!canWrite || saving) return;
    setSaving(true);
    void (async () => {
      try {
        const res = await authFetch(GEOGEBRA_AI_SETTING_API, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({
            mode,
            baseUrl: baseUrl.trim(),
            apiKey: apiKey.trim(),
            model: model.trim(),
            vision,
            librechatProviderId,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
          const message = typeof data.error === 'string' && data.error ? data.error : '保存失败';
          setNotification({
            message: data.code === 'SECURITY_SESSION_REQUIRED'
              ? `${message}（请先在个人资料页完成身份验证）`
              : message,
            type: 'error',
          });
          return;
        }
        applyPayload(data as Record<string, unknown>);
        setNotification({ message: 'GeoGebra AI 提供商配置已保存', type: 'success' });
      } catch (error) {
        setNotification({
          message: '保存失败：' + (error instanceof Error ? error.message : '未知错误'),
          type: 'error',
        });
      } finally {
        setSaving(false);
      }
    })();
  }, [
    canWrite,
    saving,
    mode,
    baseUrl,
    apiKey,
    model,
    vision,
    librechatProviderId,
    applyPayload,
    setNotification,
  ]);

  return (
    <GeoGebraAiConfigSection
      isOpen={isOpen}
      onToggle={() => setIsOpen((value) => !value)}
      prefersReducedMotion={prefersReducedMotion}
      disabled={!canWrite}
      loading={loading}
      saving={saving}
      mode={mode}
      baseUrl={baseUrl}
      apiKey={apiKey}
      model={model}
      vision={vision}
      librechatProviderId={librechatProviderId}
      providers={providers}
      status={status}
      hasApiKey={hasApiKey}
      apiKeyMasked={apiKeyMasked}
      updatedAt={updatedAt}
      onModeChange={setMode}
      onBaseUrlChange={setBaseUrl}
      onApiKeyChange={setApiKey}
      onModelChange={setModel}
      onVisionChange={setVision}
      onLibrechatProviderChange={setLibrechatProviderId}
      onRefresh={() => { void fetchSetting(); }}
      onSave={handleSave}
    />
  );
}
