import { useId } from 'react';
import { FaSync } from 'react-icons/fa';
import CollapsibleSection from './CollapsibleSection';
import InfoBox from './InfoBox';
import { StudioErrorState, StudioLoadingState } from '../studioFeedback';
import {
  studioDangerButtonClassName,
  studioFieldClassName,
  studioPrimaryButtonClassName,
  studioSecondaryButtonClassName,
  studioSubPanelClassName,
} from '../studioTheme';
import type { CDictUpstreamConfigUpdate } from './types';

export type CDictUpstreamDraft = Omit<CDictUpstreamConfigUpdate, 'ttsAppKey' | 'clearTtsAppKey'> & {
  ttsAppKey: string;
  clearTtsAppKey: boolean;
};

interface CDictUpstreamConfigSectionProps {
  isOpen: boolean;
  onToggle: (key: string) => void;
  prefersReducedMotion?: boolean | null;
  readOnly: boolean;
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  resetting: boolean;
  busy: boolean;
  readError: string;
  actionError: string;
  draft: CDictUpstreamDraft;
  hasTtsAppKey: boolean;
  updatedAt?: string;
  onDraftChange: (patch: Partial<CDictUpstreamDraft>) => void;
  onRefresh: () => void;
  onSave: () => void;
  onReset: () => void;
}

const TEXT_FIELDS = [
  { key: 'translateBaseUrl', label: '翻译服务地址', env: 'VIVO_TRANSLATE_BASE_URL', type: 'url' },
  { key: 'translateAppId', label: '翻译应用 ID', env: 'VIVO_TRANSLATE_APP_ID', type: 'text' },
  { key: 'ttsUrl', label: '朗读服务地址', env: 'VIVO_TTS_URL', type: 'url' },
  { key: 'ttsAppId', label: '朗读应用 ID', env: 'VIVO_TTS_APP_ID', type: 'text' },
] as const;

export default function CDictUpstreamConfigSection({
  isOpen, onToggle, prefersReducedMotion, readOnly, loaded, loading, saving,
  resetting, busy, readError, actionError, draft, hasTtsAppKey, updatedAt,
  onDraftChange, onRefresh, onSave, onReset,
}: CDictUpstreamConfigSectionProps) {
  const id = useId();
  const disabled = readOnly || !loaded || busy || Boolean(readError);

  return (
    <CollapsibleSection
      title="CDict 翻译与朗读配置"
      description="管理 CDict 使用的 vivo 在线翻译与朗读服务，与客户端请求配置、赞赏配置分别保存。"
      sectionKey="cdictUpstream"
      isOpen={isOpen}
      onToggle={onToggle}
      prefersReducedMotion={prefersReducedMotion}
      headerRight={
        <button
          type="button"
          onClick={onRefresh}
          disabled={!isOpen || busy}
          className={studioSecondaryButtonClassName}
        >
          <FaSync className="h-4 w-4 shrink-0" aria-hidden /> 刷新
        </button>
      }
    >
      <InfoBox className="space-y-2">
        <p>保存后当前服务实例使用新配置；地址与应用 ID 会显示当前有效值。密钥不会回填，留空表示保持现有密钥。</p>
        <p>清除朗读密钥会停用 vivo 在线朗读；恢复部署默认值则删除所有后台覆盖，重新使用部署环境的配置（可能重新启用朗读）。</p>
      </InfoBox>
      {readOnly && <p className="text-sm text-slate-600">当前为只读模式，仅超级管理员可以保存或恢复默认值。</p>}
      {loading && <StudioLoadingState text="正在读取 CDict 翻译与朗读配置..." minHeightClassName="min-h-32" />}
      {readError && <StudioErrorState message={readError} onRetry={busy ? undefined : onRefresh} />}
      {actionError && <StudioErrorState message={actionError} />}

      <fieldset disabled={disabled} className="min-w-0 space-y-4">
        <legend className="sr-only">CDict vivo 服务配置</legend>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {TEXT_FIELDS.map(({ key, label, env, type }) => (
            <div key={key} className="min-w-0">
              <label htmlFor={`${id}-${key}`} className="mb-1 block text-sm font-medium text-slate-700">
                {label}（{env}）
              </label>
              <input
                id={`${id}-${key}`}
                type={type}
                value={draft[key]}
                onChange={(event) => onDraftChange({ [key]: event.target.value })}
                autoComplete="off"
                spellCheck={false}
                className={studioFieldClassName}
              />
            </div>
          ))}
        </div>
        <div className={studioSubPanelClassName}>
          <label htmlFor={`${id}-ttsAppKey`} className="mb-1 block text-sm font-medium text-slate-700">
            朗读应用密钥（VIVO_TTS_APP_KEY）
          </label>
          <input
            id={`${id}-ttsAppKey`}
            type="password"
            value={draft.ttsAppKey}
            disabled={disabled || draft.clearTtsAppKey}
            onChange={(event) => onDraftChange({ ttsAppKey: event.target.value })}
            placeholder="输入新密钥；留空保持现有密钥"
            autoComplete="new-password"
            spellCheck={false}
            aria-describedby={`${id}-key-state`}
            className={studioFieldClassName}
          />
          <p id={`${id}-key-state`} className="mt-2 text-xs text-slate-600">
            当前朗读密钥：{!loaded ? '尚未读取' : hasTtsAppKey ? '已设置（不显示原文）' : '未设置'}
          </p>
          <label className="mt-3 flex items-start gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={draft.clearTtsAppKey}
              onChange={(event) => onDraftChange({ clearTtsAppKey: event.target.checked })}
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-slate-900 focus:ring-slate-300"
            />
            保存时清除当前朗读密钥并停用 vivo 在线朗读（保存前需再次确认）
          </label>
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center justify-end gap-3">
        <button type="button" onClick={onReset} disabled={disabled} className={studioDangerButtonClassName}>
          {resetting ? '恢复中...' : '恢复部署默认值'}
        </button>
        <button type="button" onClick={onSave} disabled={disabled} className={studioPrimaryButtonClassName}>
          {saving ? '保存中...' : '保存/更新'}
        </button>
      </div>
      <p className="text-xs text-slate-500">
        最后更新时间：{updatedAt ? new Date(updatedAt).toLocaleString() : '-'}
      </p>
    </CollapsibleSection>
  );
}
