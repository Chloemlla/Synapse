import { m } from 'framer-motion';
import { FaSync } from 'react-icons/fa';
import CollapsibleSection from './CollapsibleSection';
import type { ChatProviderItem, ChatWireFormat } from './types';
import { NO_DURATION } from './motion';
import {
  studioDangerButtonClassName,
  studioFieldClassName,
  studioPrimaryButtonClassName,
  studioSecondaryButtonClassName,
  studioTileClassName,
} from '../studioTheme';

const WIRE_LABELS: Record<ChatWireFormat, string> = {
  'openai-chat': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  anthropic: 'Anthropic Messages',
};

const REFRESH_BUTTON_CLASS = studioPrimaryButtonClassName;

export interface LibreChatProvidersSectionProps {
  isOpen: boolean;
  onToggle: (key: string) => void;
  prefersReducedMotion: boolean | null | undefined;
  isMobile?: boolean;
  loading: boolean;
  saving: boolean;
  deletingId: string | null;
  providers: ChatProviderItem[];
  providerId: string | null;
  providerFilterGroup: string;
  providerBaseUrl: string;
  providerApiKey: string;
  providerModel: string;
  providerWire: ChatWireFormat;
  providerGroup: string;
  providerEnabled: boolean;
  providerVision: boolean;
  providerWeight: number;
  onFilterGroupChange: (value: string) => void;
  onBaseUrlChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onWireChange: (value: ChatWireFormat) => void;
  onGroupChange: (value: string) => void;
  onEnabledChange: (value: boolean) => void;
  onVisionChange: (value: boolean) => void;
  onWeightChange: (value: number) => void;
  onRefresh: () => void;
  onSave: () => void;
  onReset: () => void;
  onEdit: (provider: ChatProviderItem) => void;
  onDelete: (id: string) => void;
  disabled?: boolean;
}

export default function LibreChatProvidersSection({
  isOpen,
  onToggle,
  prefersReducedMotion,
  isMobile = false,
  loading,
  saving,
  deletingId,
  providers,
  providerId,
  providerFilterGroup,
  providerBaseUrl,
  providerApiKey,
  providerModel,
  providerWire,
  providerGroup,
  providerEnabled,
  providerVision,
  providerWeight,
  onFilterGroupChange,
  onBaseUrlChange,
  onApiKeyChange,
  onModelChange,
  onWireChange,
  onGroupChange,
  onEnabledChange,
  onVisionChange,
  onWeightChange,
  onRefresh,
  onSave,
  onReset,
  onEdit,
  onDelete,
  disabled = false,
}: LibreChatProvidersSectionProps) {
  const isDisabled = saving || disabled;
  return (
    <CollapsibleSection title="LibreChat 提供者配置" description="管理 LibreChat 多提供者 Base URL、API Key、模型和权重。用于 AI 聊天后端路由，将用户请求分发到不同 AI 提供商（OpenAI、Claude 等）。" sectionKey="providers" isOpen={isOpen} onToggle={onToggle} prefersReducedMotion={prefersReducedMotion} headerRight={
              <div className="flex flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
                <input
                  value={providerFilterGroup}
                  onChange={(e) => onFilterGroupChange(e.target.value)}
                  placeholder="按 group 过滤"
                  className={`${studioFieldClassName} sm:w-auto`}
                />
                <m.button
                  type="button"
                  onClick={onRefresh}
                  disabled={loading}
                  className={`${REFRESH_BUTTON_CLASS} w-full sm:w-auto`}
                  whileTap={{ scale: 0.95 }}
                >
                  <FaSync className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> 刷新
                </m.button>
              </div>
            }>
              {/* 表单 */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Base URL</label>
                  <input
                    value={providerBaseUrl}
                    onChange={(e) => onBaseUrlChange(e.target.value)}
                    disabled={disabled}
                    placeholder="https://your-openai-compatible.example"
                    className={studioFieldClassName}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">API Key</label>
                  <input
                    value={providerApiKey}
                    onChange={(e) => onApiKeyChange(e.target.value)}
                    disabled={disabled}
                    placeholder="re_xxx 或 sk-xxx"
                    className={studioFieldClassName}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Model</label>
                  <input
                    value={providerModel}
                    onChange={(e) => onModelChange(e.target.value)}
                    disabled={disabled}
                    placeholder="gpt-4o-mini / gpt-oss-120b 等"
                    className={studioFieldClassName}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">协议格式</label>
                  <select
                    value={providerWire}
                    onChange={(e) => onWireChange(e.target.value as ChatWireFormat)}
                    disabled={disabled}
                    className={studioFieldClassName}
                  >
                    {Object.entries(WIRE_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Group（可选）</label>
                  <input
                    value={providerGroup}
                    onChange={(e) => onGroupChange(e.target.value)}
                    disabled={disabled}
                    placeholder="自定义分组名，用于归类"
                    className={studioFieldClassName}
                  />
                </div>
                <div className="flex items-center gap-3">
                  <label className="text-sm font-medium text-slate-700">启用</label>
                  <input
                    type="checkbox"
                    checked={providerEnabled}
                    onChange={(e) => onEnabledChange(e.target.checked)}
                    disabled={disabled}
                    className="h-4 w-4"
                  />
                </div>
                {/* 与 GeoGebra AI 面板的同类勾选保持一致：id + htmlFor；长文案一侧 min-w-0，让提示能换行而不是撑宽整行。 */}
                <div className="flex items-start gap-3">
                  <input
                    id="librechat-provider-vision"
                    type="checkbox"
                    checked={providerVision}
                    onChange={(e) => onVisionChange(e.target.checked)}
                    disabled={disabled}
                    className="mt-0.5 h-4 w-4"
                  />
                  <label htmlFor="librechat-provider-vision" className="min-w-0 text-sm font-medium text-slate-700">
                    支持识图
                    <span className="block font-normal text-xs text-slate-500">
                      勾上后这个模型能看图；不勾就只会当纯文本模型用。
                    </span>
                  </label>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">权重（1-10）</label>
                  <input
                    type="number"
                    value={providerWeight}
                    onChange={(e) => onWeightChange(Math.max(1, Math.min(10, Number(e.target.value || 1))))}
                    disabled={disabled}
                    min={1}
                    max={10}
                    className={studioFieldClassName}
                  />
                </div>
              </div>

              {/* 行为约定收在可展开的「详情」里，主表单只留一句能看懂的开关说明。 */}
              <details className="mb-4 rounded-2xl border border-slate-200 px-4 py-3">
                <summary className="cursor-pointer text-sm text-slate-600">详情</summary>
                <ul className="mt-2 space-y-1 text-xs text-slate-500">
                  <li>带图片的提问只会发给勾了「支持识图」的提供者；一个都没有时直接回复无法处理，不会剔掉图照样回答。</li>
                  <li>一次最多 4 张图片、单张不超过 4 MB；不合适的图片会在调用前被拒并给出原因。</li>
                  <li>图片只用于当次提问，不写进聊天记录；下一轮追问时模型看不到之前那张图。</li>
                </ul>
              </details>

              <div className="flex items-center justify-end gap-3 mb-4">
                <m.button
                  type="button"
                  onClick={onReset}
                  className={studioSecondaryButtonClassName}
                  whileTap={{ scale: 0.96 }}
                >
                  重置
                </m.button>
                <m.button
                  type="button"
                  onClick={onSave}
                  disabled={isDisabled}
                  className={studioPrimaryButtonClassName}
                  whileTap={{ scale: 0.96 }}
                >
                  {saving ? '保存中...' : (providerId ? '更新' : '新增')}
                </m.button>
              </div>

              {/* 列表 */}
              {loading ? (
                <div className="text-slate-500 text-sm">加载中...</div>
              ) : providers.length === 0 ? (
                <div className="text-slate-500 text-sm">暂无提供者</div>
              ) : (
                <div className="overflow-x-auto rounded-2xl border border-slate-200">
                  {isMobile ? (
                    <div className="space-y-3 p-2">
                      {providers.map((p, i) => (
                        <m.div
                          key={p.id}
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={prefersReducedMotion ? NO_DURATION : { duration: 0.25, delay: i * 0.04 }}
                          className={`${studioTileClassName} p-3`}
                        >
                          <div className="text-sm text-slate-800 break-all">
                            <div className="font-semibold">{p.baseUrl}</div>
                            <div className="mt-1">Model：{p.model}</div>
                            <div className="mt-1">格式：{WIRE_LABELS[p.wire] || p.wire}</div>
                            <div className="mt-1">Group：{p.group || '-'}</div>
                            <div className="mt-1">Enabled：{p.enabled ? '是' : '否'}｜Weight：{p.weight}</div>
                            <div className="mt-1">识图：{p.vision ? '是' : '否'}</div>
                            <div className="mt-1 font-mono text-xs text-slate-700">{p.apiKey}</div>
                            <div className="mt-1 text-xs text-slate-500">{p.updatedAt ? new Date(p.updatedAt).toLocaleString() : '-'}</div>
                          </div>
                          <div className="mt-2 flex items-center justify-end gap-2">
                            <m.button
                              type="button"
                              onClick={() => onEdit(p)}
                              disabled={disabled}
                              className={studioSecondaryButtonClassName}
                              whileTap={{ scale: 0.95 }}
                            >
                              编辑
                            </m.button>
                            <m.button
                              type="button"
                              onClick={() => onDelete(p.id)}
                              disabled={deletingId === p.id || disabled}
                              className={studioDangerButtonClassName}
                              whileTap={{ scale: 0.95 }}
                            >
                              {deletingId === p.id ? '删除中...' : '删除'}
                            </m.button>
                          </div>
                        </m.div>
                      ))}
                    </div>
                  ) : (
                    <table className="min-w-full">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200">
                          <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Base URL</th>
                          <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Model</th>
                          <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">格式</th>
                          <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Group</th>
                          <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Enabled</th>
                          <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">识图</th>
                          <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Weight</th>
                          <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">API Key（脱敏）</th>
                          <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Updated</th>
                          <th className="px-4 py-3 text-right text-sm font-semibold text-slate-700">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {providers.map((p, i) => (
                          <m.tr
                            key={p.id}
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={prefersReducedMotion ? NO_DURATION : { duration: 0.25, delay: i * 0.04 }}
                            className="border-b last:border-b-0"
                          >
                            <td className="px-4 py-3 text-sm text-slate-800 break-all">{p.baseUrl}</td>
                            <td className="px-4 py-3 text-sm text-slate-800">{p.model}</td>
                            <td className="px-4 py-3 text-sm text-slate-800">{WIRE_LABELS[p.wire] || p.wire}</td>
                            <td className="px-4 py-3 text-sm text-slate-800">{p.group || '-'}</td>
                            <td className="px-4 py-3 text-sm text-slate-800">{p.enabled ? '是' : '否'}</td>
                            <td className="px-4 py-3 text-sm text-slate-800">{p.vision ? '是' : '否'}</td>
                            <td className="px-4 py-3 text-sm text-slate-800">{p.weight}</td>
                            <td className="px-4 py-3 font-mono text-sm text-slate-700">{p.apiKey}</td>
                            <td className="px-4 py-3 text-sm text-slate-600">{p.updatedAt ? new Date(p.updatedAt).toLocaleString() : '-'}</td>
                            <td className="px-4 py-3 text-right">
                              <div className="flex items-center justify-end gap-2">
                                <m.button
                                  type="button"
                                  onClick={() => onEdit(p)}
                                  disabled={disabled}
                                  className={studioSecondaryButtonClassName}
                                  whileTap={{ scale: 0.95 }}
                                >
                                  编辑
                                </m.button>
                                <m.button
                                  type="button"
                                  onClick={() => onDelete(p.id)}
                                  disabled={deletingId === p.id || disabled}
                                  className={studioDangerButtonClassName}
                                  whileTap={{ scale: 0.95 }}
                                >
                                  {deletingId === p.id ? '删除中...' : '删除'}
                                </m.button>
                              </div>
                            </td>
                          </m.tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </CollapsibleSection>
  );
}
