import React, { useCallback, useEffect, useState } from 'react';
import { FaCogs, FaSave } from 'react-icons/fa';
import {
  getGeoGebraAiSetting,
  saveGeoGebraAiSetting,
  type GeoGebraAiAdminSetting,
} from '@/api/geogebraAdmin';
import {
  InfoBadge,
  InfoPanel,
  studioFieldClassName,
  studioPrimaryButtonClassName,
  studioSecondaryButtonClassName,
} from '@/components/studioTheme';
import { StudioErrorNote, StudioErrorState, StudioLoadingState } from '@/components/studioFeedback';
import { useNotification } from '@/components/Notification';
import { cn } from '@/lib/utils';
import { getBackendErrorMessage } from '@/utils/backendError';
import { formatTime } from '../ip-risk-log/format';
import { DataPanel, FieldGrid, FieldRow, RefreshButton } from '../account-risk/ui';

/**
 * GeoGebra AI 提供商配置（GEO-AI）。
 *
 * 三种模式：
 *   - `env`：沿用 `GEOGEBRA_AI_*` 环境变量（只读，改不了）；
 *   - `custom`：独立填服务地址 / 密钥 / 模型（需要安全会话才能保存）；
 *   - `librechat`：复用 chat_providers 里一条 openai-chat 格式的提供者。
 *
 * 表单**不回显密钥**：`apiKey` 留空 = 保持原值。这是服务端契约，
 * 前端如果把掩码值（`sk***abcd`）当真值提交回去，会把密钥改成那串掩码。
 */
const GeoGebraAiConfigTab: React.FC<{ isSuperAdmin: boolean }> = ({ isSuperAdmin }) => {
  const { setNotification } = useNotification();
  const [setting, setSetting] = useState<GeoGebraAiAdminSetting | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  const [mode, setMode] = useState<'env' | 'custom' | 'librechat'>('env');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [vision, setVision] = useState(false);
  const [providerId, setProviderId] = useState('');

  const applySetting = useCallback((res: GeoGebraAiAdminSetting) => {
    setSetting(res);
    setMode(res.config.mode);
    setBaseUrl(res.config.baseUrl);
    setModel(res.config.model);
    setVision(res.config.vision);
    setProviderId(res.config.librechatProviderId);
    setApiKey('');
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getGeoGebraAiSetting();
      applySetting(res);
      setError(null);
      setForbidden(false);
    } catch (err) {
      const code = (err as { response?: { data?: { code?: string } } })?.response?.data?.code;
      if (code === 'ADMIN_SCOPE_FORBIDDEN' || (err as { response?: { status?: number } })?.response?.status === 403) {
        setForbidden(true);
        setError(null);
      } else {
        setError(getBackendErrorMessage(err, '读取 AI 提供商配置失败'));
      }
    } finally {
      setLoading(false);
    }
  }, [applySetting]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const res = await saveGeoGebraAiSetting({
        mode,
        baseUrl,
        model,
        vision,
        librechatProviderId: providerId,
        // 留空表示保持原值：只有真的输入了新密钥才带上。
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      applySetting(res);
      setNotification({ message: 'AI 提供商配置已保存。', type: 'success' });
    } catch (err) {
      setNotification({ message: getBackendErrorMessage(err, '保存 AI 配置失败'), type: 'error' });
    } finally {
      setSaving(false);
    }
  }, [apiKey, applySetting, baseUrl, mode, model, providerId, setNotification, vision]);

  if (forbidden) {
    return (
      <DataPanel>
        <p className="text-xs leading-5 text-slate-600">
          读取 AI 提供商配置需要页面授权 <code className="rounded bg-slate-100 px-1">geogebra</code>
          （默认只有超级管理员）。当前账号没有该页面权限，接口返回 403。
        </p>
      </DataPanel>
    );
  }
  if (error && !setting) return <StudioErrorState message={error} onRetry={() => void load()} />;
  if (loading && !setting) return <StudioLoadingState minHeightClassName="min-h-[200px]" text="正在读取 AI 配置…" />;
  if (!setting) return null;

  const compatibleProviders = setting.providers.filter((provider) => provider.compatible && provider.enabled);

  return (
    <div className="space-y-4">
      <InfoPanel compact>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <InfoBadge tone={setting.status.configured ? 'emerald' : 'amber'}>
              {setting.status.configured ? `已生效 · ${setting.status.source}` : '未生效'}
            </InfoBadge>
            <InfoBadge tone="slate">密钥 {setting.config.hasApiKey ? setting.config.apiKeyMasked : '未配置'}</InfoBadge>
            <span>更新 {formatTime(setting.config.updatedAt)} · {setting.config.updatedBy || '未知'}</span>
          </div>
          <RefreshButton onClick={() => void load()} loading={loading} />
        </div>
        {setting.status.reason ? <p className="mt-2 text-xs text-amber-700">{setting.status.reason}</p> : null}
      </InfoPanel>

      {!isSuperAdmin ? (
        <StudioErrorNote>
          保存 AI 配置需要超级管理员与安全会话。当前账号可以查看，但不能保存（服务端会拒绝）。
        </StudioErrorNote>
      ) : null}

      <InfoPanel compact>
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <FaCogs className="text-slate-400" aria-hidden />提供商模式
        </h3>
        <div className="mt-3 flex flex-wrap gap-2">
          {([
            { key: 'env', label: '环境变量', hint: '沿用 GEOGEBRA_AI_* 环境变量；此模式下表单不可编辑' },
            { key: 'custom', label: '独立配置', hint: '单独填地址、密钥与模型' },
            { key: 'librechat', label: '复用 LibreChat', hint: '复用 chat_providers 里一条 openai-chat 提供者' },
          ] as const).map((item) => (
            <button
              key={item.key}
              type="button"
              title={item.hint}
              aria-pressed={mode === item.key}
              onClick={() => setMode(item.key)}
              className={cn(
                'inline-flex min-h-11 items-center rounded-full border px-3.5 py-2 text-xs font-semibold transition sm:min-h-0',
                mode === item.key
                  ? 'border-slate-900 bg-slate-900 text-white'
                  : 'border-slate-200 bg-white/80 text-slate-600 hover:border-slate-300 hover:text-slate-900',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        {mode === 'env' ? (
          <p className="mt-3 text-xs leading-5 text-slate-500">
            当前使用环境变量。要改成独立配置或复用 LibreChat，先切换上方模式再保存。
          </p>
        ) : null}

        {mode === 'custom' ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs text-slate-600">
              服务地址
              <input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://api.example.com/v1"
                className={studioFieldClassName}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-600">
              模型
              <input
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="gpt-4o-mini"
                className={studioFieldClassName}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-600 sm:col-span-2">
              API Key（留空 = 保持原值）
              <input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={setting.config.hasApiKey ? `当前已配置 ${setting.config.apiKeyMasked}` : '尚未配置'}
                autoComplete="off"
                className={studioFieldClassName}
              />
            </label>
          </div>
        ) : null}

        {mode === 'librechat' ? (
          <div className="mt-4">
            <label className="flex flex-col gap-1 text-xs text-slate-600">
              选择提供者（仅显示已启用且 openai-chat 格式）
              <select
                value={providerId}
                onChange={(event) => setProviderId(event.target.value)}
                className={studioFieldClassName}
              >
                <option value="">未选择</option>
                {compatibleProviders.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.group ? `[${provider.group}] ` : ''}{provider.model} · {provider.baseUrl}
                  </option>
                ))}
              </select>
            </label>
            {compatibleProviders.length === 0 ? (
              <p className="mt-2 text-xs text-amber-700">
                没有可复用的提供者。当前 chat_providers 里的提供者要么未启用，要么不是 openai-chat 格式。
              </p>
            ) : null}
          </div>
        ) : null}

        <label className="mt-3 flex items-center gap-2 text-xs text-slate-600">
          <input type="checkbox" checked={vision} onChange={(event) => setVision(event.target.checked)} />
          图片能力（允许 AI 读取上传的参考图）
        </label>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !isSuperAdmin || mode === 'env'}
            className={cn(studioPrimaryButtonClassName, 'min-h-11 sm:min-h-0')}
          >
            <FaSave className="mr-1 inline" />{saving ? '保存中…' : '保存'}
          </button>
          <button type="button" onClick={() => void load()} disabled={saving} className={cn(studioSecondaryButtonClassName, 'min-h-11 sm:min-h-0')}>
            放弃修改
          </button>
        </div>
        {mode === 'env' ? (
          <p className="mt-2 text-[11px] text-slate-400">env 模式下没有可保存的内容；切换模式后才能保存。</p>
        ) : null}
      </InfoPanel>

      <DataPanel>
        <h3 className="text-sm font-semibold text-slate-900">当前生效值</h3>
        <FieldGrid className="mt-2">
          <FieldRow label="模式" value={setting.config.mode} />
          <FieldRow label="服务地址" value={setting.config.baseUrl || '-'} mono />
          <FieldRow label="模型" value={setting.config.model || '-'} mono />
          <FieldRow label="密钥" value={setting.config.hasApiKey ? setting.config.apiKeyMasked : '未配置'} mono />
          <FieldRow label="图片能力" value={setting.config.vision ? '已开启' : '未开启'} />
          <FieldRow label="复用提供者" value={setting.config.librechatProviderId || '-'} mono />
          <FieldRow label="上次更新" value={formatTime(setting.config.updatedAt)} />
          <FieldRow label="更新人" value={setting.config.updatedBy || '-'} />
        </FieldGrid>
      </DataPanel>
    </div>
  );
};

export default GeoGebraAiConfigTab;
