import { m } from 'framer-motion';
import { FaSync } from 'react-icons/fa';
import CollapsibleSection from './CollapsibleSection';
import {
  InfoBadge,
  studioFieldClassName,
  studioPrimaryButtonClassName,
  studioSecondaryButtonClassName,
} from '../studioTheme';
import type {
  ChatWireFormat,
  GeoGebraAiAdminStatus,
  GeoGebraAiProviderMode,
  GeoGebraLibreChatProviderOption,
} from './types';

const WIRE_LABELS: Record<ChatWireFormat, string> = {
  'openai-chat': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  anthropic: 'Anthropic Messages',
};

const MODE_LABELS: Record<GeoGebraAiProviderMode, string> = {
  env: '沿用环境变量',
  custom: '独立配置',
  librechat: '复用 LibreChat 提供者',
};

const SOURCE_LABELS: Record<GeoGebraAiProviderMode, string> = {
  env: '环境变量',
  custom: '独立配置',
  librechat: 'LibreChat 提供者',
};

export interface GeoGebraAiConfigSectionProps {
  isOpen: boolean;
  onToggle: (key: string) => void;
  prefersReducedMotion: boolean | null | undefined;
  loading: boolean;
  saving: boolean;
  mode: GeoGebraAiProviderMode;
  baseUrl: string;
  apiKey: string;
  model: string;
  vision: boolean;
  librechatProviderId: string;
  providers: GeoGebraLibreChatProviderOption[];
  status: GeoGebraAiAdminStatus | null;
  hasApiKey: boolean;
  apiKeyMasked: string;
  updatedAt: string | null;
  onModeChange: (value: GeoGebraAiProviderMode) => void;
  onBaseUrlChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onVisionChange: (value: boolean) => void;
  onLibrechatProviderChange: (value: string) => void;
  onRefresh: () => void;
  onSave: () => void;
  disabled?: boolean;
}

/**
 * GeoGebra AI 提供商配置（运行时配置页）。
 *
 * 只呈现「要做什么 / 现在什么状态」：三种来源二选一，密钥只显示脱敏片段，
 * 解析失败的原因直接给管理员看（例如所选 LibreChat 提供者协议不兼容），
 * 但不会把地址、密钥或内部请求细节铺到界面上。
 */
export default function GeoGebraAiConfigSection({
  isOpen,
  onToggle,
  prefersReducedMotion,
  loading,
  saving,
  mode,
  baseUrl,
  apiKey,
  model,
  vision,
  librechatProviderId,
  providers,
  status,
  hasApiKey,
  apiKeyMasked,
  updatedAt,
  onModeChange,
  onBaseUrlChange,
  onApiKeyChange,
  onModelChange,
  onVisionChange,
  onLibrechatProviderChange,
  onRefresh,
  onSave,
  disabled = false,
}: GeoGebraAiConfigSectionProps) {
  const isDisabled = saving || disabled;
  const compatibleProviders = providers.filter((provider) => provider.compatible && provider.enabled);

  return (
    <CollapsibleSection
      title="GeoGebra AI 提供商"
      description="GeoGebra 工作台的 AI 生成 / 解读 / 标注所用的模型服务。可单独填写，也可直接复用上面已配置的 LibreChat 提供者。"
      sectionKey="geogebraAi"
      isOpen={isOpen}
      onToggle={onToggle}
      prefersReducedMotion={prefersReducedMotion}
      headerRight={
        <div className="flex flex-wrap items-center gap-2" onClick={(event) => event.stopPropagation()}>
          {status ? (
            status.configured ? (
              <InfoBadge tone="emerald">已配置 · {SOURCE_LABELS[status.source]}</InfoBadge>
            ) : (
              <InfoBadge tone="amber">未配置</InfoBadge>
            )
          ) : null}
          <m.button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className={`${studioSecondaryButtonClassName} w-full sm:w-auto`}
            whileTap={prefersReducedMotion ? undefined : { scale: 0.95 }}
          >
            <FaSync className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> 刷新
          </m.button>
        </div>
      }
    >
      {status && !status.configured ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50/80 px-4 py-3 text-sm text-amber-800">
          <span className="font-semibold">当前不可用：</span>
          {status.reason || 'AI 能力尚未配置。'}
        </div>
      ) : null}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">配置来源</label>
          <select
            value={mode}
            onChange={(event) => onModeChange(event.target.value as GeoGebraAiProviderMode)}
            disabled={isDisabled}
            className={studioFieldClassName}
          >
            {(Object.keys(MODE_LABELS) as GeoGebraAiProviderMode[]).map((value) => (
              <option key={value} value={value}>
                {MODE_LABELS[value]}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-slate-500">
            {mode === 'env'
              ? '沿用 GEOGEBRA_AI_*；未配置时回落到站内已有的 OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL。'
              : mode === 'custom'
                ? '只给 GeoGebra 工作台单独指定模型服务，与 LibreChat 互不影响。'
                : '直接复用下方 LibreChat 提供者的地址、密钥与模型；该提供者停用或改协议时会自动变为不可用。'}
          </p>
        </div>

        {mode !== 'env' ? (
          <div className="flex items-start gap-3 md:items-center">
            <input
              id="geogebra-ai-vision"
              type="checkbox"
              checked={vision}
              onChange={(event) => onVisionChange(event.target.checked)}
              disabled={isDisabled}
              className="mt-0.5 h-4 w-4 md:mt-0"
            />
            <label htmlFor="geogebra-ai-vision" className="text-sm text-slate-700">
              模型支持图片
              <span className="block text-xs text-slate-500">开启后「按参考图生成」才会把图片发给模型。</span>
            </label>
          </div>
        ) : null}

        {mode === 'custom' ? (
          <>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Base URL</label>
              <input
                value={baseUrl}
                onChange={(event) => onBaseUrlChange(event.target.value)}
                disabled={isDisabled}
                placeholder="https://your-openai-compatible.example/v1"
                className={studioFieldClassName}
              />
              <p className="mt-1 text-xs text-slate-500">必须是 https，且不能是内网 / 环回地址。</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Model</label>
              <input
                value={model}
                onChange={(event) => onModelChange(event.target.value)}
                disabled={isDisabled}
                placeholder="gpt-4o-mini / gpt-oss-120b 等"
                className={studioFieldClassName}
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">API Key</label>
              <input
                type="password"
                value={apiKey}
                onChange={(event) => onApiKeyChange(event.target.value)}
                disabled={isDisabled}
                autoComplete="new-password"
                placeholder={hasApiKey ? `已保存（${apiKeyMasked}），留空保持不变` : 'sk-xxx'}
                className={studioFieldClassName}
              />
            </div>
          </>
        ) : null}

        {mode === 'librechat' ? (
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-slate-700 mb-1">LibreChat 提供者</label>
            <select
              value={librechatProviderId}
              onChange={(event) => onLibrechatProviderChange(event.target.value)}
              disabled={isDisabled}
              className={studioFieldClassName}
            >
              <option value="">请选择提供者</option>
              {providers.map((provider) => {
                const unavailable = !provider.compatible || !provider.enabled;
                return (
                  <option key={provider.id} value={provider.id} disabled={unavailable}>
                    {provider.model || '（未填写模型）'}
                    {provider.baseUrl ? ` · ${provider.baseUrl}` : ''}
                    {provider.group ? ` · ${provider.group}` : ''}
                    {` · ${WIRE_LABELS[provider.wire] || provider.wire}`}
                    {provider.enabled ? '' : '（已停用）'}
                    {provider.compatible ? '' : '（协议不兼容）'}
                  </option>
                );
              })}
            </select>
            <p className="mt-1 text-xs text-slate-500">
              {providers.length === 0
                ? '还没有 LibreChat 提供者。请先在上面的「LibreChat 提供者配置」里新增一条。'
                : compatibleProviders.length === 0
                  ? '现有提供者都不可复用：GeoGebra AI 只支持 OpenAI Chat Completions 格式、服务地址需为 https，且提供者必须处于启用状态。'
                  : 'GeoGebra AI 只支持 OpenAI Chat Completions 格式（Anthropic / Responses 格式不可选），提供者地址需为 https 且不能是内网地址。'}
            </p>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-3 border-t border-slate-100 pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-slate-500">
          {updatedAt ? `上次保存：${new Date(updatedAt).toLocaleString()}` : '尚未保存过在线配置'}
          <span className="ml-2">保存需要安全会话（与查看密钥相同），失效时请先在个人资料页完成身份验证。</span>
        </p>
        <m.button
          type="button"
          onClick={onSave}
          disabled={isDisabled}
          className={`${studioPrimaryButtonClassName} w-full sm:w-auto`}
          whileTap={prefersReducedMotion ? undefined : { scale: 0.96 }}
        >
          {saving ? '保存中...' : '保存'}
        </m.button>
      </div>
    </CollapsibleSection>
  );
}
