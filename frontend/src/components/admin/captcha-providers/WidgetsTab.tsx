import { useCallback, useMemo, useState } from 'react';
import { FaExternalLinkAlt, FaEye, FaUndo } from 'react-icons/fa';
import {
  studioFieldClassName,
  studioPanelClassName,
  studioSecondaryButtonClassName,
} from '@/components/studioTheme';
import type { SelectionQuery } from './api';
import {
  LANGUAGE_CHOICES,
  PROVIDER_ORDER,
  type ApiResult,
  type Option,
  type ProviderId,
  type ProviderRow,
  type Scenario,
  type SelectionPreview,
  type TabActions,
  type WidgetProviderOverride,
  type WidgetSettings,
  type WidgetSize,
  type WidgetTheme,
} from './types';

export interface WidgetsTabProps extends TabActions {
  widgets: WidgetSettings;
  defaults: WidgetSettings;
  rows: ProviderRow[];
  scenarios: Option[];
  dirty: boolean;
  onChange: (patch: Partial<WidgetSettings>) => void;
  onProviderOverrideChange: (provider: ProviderId, patch: WidgetProviderOverride) => void;
  onClearOverride: (provider: ProviderId) => void;
  onReset: () => void;
  onPreview: (query: SelectionQuery) => Promise<ApiResult<SelectionPreview>>;
}

const THEME_CHOICES: readonly Option[] = [
  { value: 'auto', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

const SIZE_CHOICES: readonly Option[] = [
  { value: 'normal', label: '标准' },
  { value: 'compact', label: '紧凑' },
  { value: 'flexible', label: '自适应' },
];

const PROVIDER_HINT: Record<ProviderId, string> = {
  turnstile: '原生支持 theme / size / language 三项。',
  hcaptcha: '支持 theme / language；没有 flexible 尺寸，自适应会按标准尺寸渲染。',
  trycap: '语言走控件的 data-cap-lang；深色主题由宿主上的 --cap-* 变量给出。',
};

/** 与后端 allocation.ts 的 resolveWidgetSettings 同规则：逐家覆盖优先，否则全局。 */
function resolveAppearance(widgets: WidgetSettings, provider: ProviderId) {
  const override = widgets.perProvider[provider];
  return {
    theme: override?.theme ?? widgets.theme,
    size: override?.size ?? widgets.size,
    language: override?.language ?? widgets.language,
    showProviderLabel: widgets.showProviderLabel,
  };
}

const THEME_SKIN: Record<WidgetTheme, { box: string; text: string; border: string }> = {
  auto: { box: 'bg-white', text: 'text-slate-700', border: 'border-slate-300' },
  light: { box: 'bg-white', text: 'text-slate-800', border: 'border-slate-300' },
  dark: { box: 'bg-slate-800', text: 'text-slate-100', border: 'border-slate-600' },
};

function AppearancePreview({
  provider,
  label,
  appearance,
}: {
  provider: ProviderId;
  label: string;
  appearance: ReturnType<typeof resolveAppearance>;
}) {
  const skin = THEME_SKIN[appearance.theme];
  const height = appearance.size === 'compact' ? 'h-12' : appearance.size === 'flexible' ? 'h-20 w-full' : 'h-16';
  const width = appearance.size === 'compact' ? 'w-40' : appearance.size === 'flexible' ? 'w-full' : 'w-72';

  return (
    <div className={`${studioPanelClassName} p-4`}>
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-slate-800">{label}</p>
        <span className="text-[11px] text-slate-500">{provider}</span>
      </div>
      <div className={`mt-3 flex items-center justify-center rounded-xl border ${skin.border} ${skin.box} ${width} ${height}`}>
        <span className={`text-xs ${skin.text}`}>
          {appearance.language === 'auto' ? '跟随浏览器语言' : appearance.language}
        </span>
      </div>
      <p className="mt-3 text-[11px] leading-5 text-slate-500">
        theme={appearance.theme} · size={appearance.size} · language={appearance.language} ·
        署名 {appearance.showProviderLabel ? '展示' : '隐藏'}
      </p>
      <p className="mt-1 text-[11px] leading-5 text-slate-500">{PROVIDER_HINT[provider]}</p>
    </div>
  );
}

export default function WidgetsTab(props: WidgetsTabProps) {
  const {
    canWrite,
    notify,
    widgets,
    rows,
    scenarios,
    dirty,
    onChange,
    onProviderOverrideChange,
    onClearOverride,
    onReset,
    onPreview,
  } = props;

  const [previewScenario, setPreviewScenario] = useState<Scenario>('standalone');
  const [preview, setPreview] = useState<SelectionPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const providerLabels = useMemo(() => {
    const map = new Map<ProviderId, string>();
    rows.forEach((row) => map.set(row.provider, row.label));
    PROVIDER_ORDER.forEach((provider) => {
      if (!map.has(provider)) map.set(provider, provider);
    });
    return map;
  }, [rows]);

  const runPreview = useCallback(async () => {
    setPreviewing(true);
    try {
      const result = await onPreview({ scenario: previewScenario, fingerprint: 'widgets-preview' });
      if (!result.ok || !result.data) {
        notify(result.error || '读取下发结果失败', 'error');
        return;
      }
      setPreview(result.data);
    } finally {
      setPreviewing(false);
    }
  }, [notify, onPreview, previewScenario]);

  return (
    <div className="space-y-6">
      <section className={`${studioPanelClassName} p-5`}>
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-slate-800">统一控件外观</h3>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              这里设置会随 <code>secure-captcha-config</code> 下发到浏览器，首访门禁页与独立验证页的三家控件都按它渲染；
              只含公开项（主题 / 尺寸 / 语言 / 是否展示供应商署名），权重与额度不会下发。
            </p>
          </div>
          <button type="button" onClick={onReset} disabled={!canWrite || !dirty} className={studioSecondaryButtonClassName}>
            <FaUndo className="mr-2 inline h-3 w-3" /> 撤销外观改动
          </button>
        </header>

        <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <label className="text-xs font-medium text-slate-600">
            主题
            <select
              value={widgets.theme}
              disabled={!canWrite}
              onChange={(event) => onChange({ theme: event.target.value as WidgetTheme })}
              className={`${studioFieldClassName} mt-1`}
            >
              {THEME_CHOICES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="text-xs font-medium text-slate-600">
            尺寸
            <select
              value={widgets.size}
              disabled={!canWrite}
              onChange={(event) => onChange({ size: event.target.value as WidgetSize })}
              className={`${studioFieldClassName} mt-1`}
            >
              {SIZE_CHOICES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="text-xs font-medium text-slate-600">
            语言
            <select
              value={widgets.language}
              disabled={!canWrite}
              onChange={(event) => onChange({ language: event.target.value })}
              className={`${studioFieldClassName} mt-1`}
            >
              {LANGUAGE_CHOICES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="mt-5 flex items-center gap-2 text-xs font-medium text-slate-700">
            <input
              type="checkbox"
              checked={widgets.showProviderLabel}
              disabled={!canWrite}
              onChange={(event) => onChange({ showProviderLabel: event.target.checked })}
            />
            在页面上展示供应商署名
          </label>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-base font-semibold text-slate-800">逐家覆盖与预览</h3>
          <p className="text-xs text-slate-500">留空即沿用全局设置；预览为样式示意，真实控件请到独立验证页查看。</p>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          {PROVIDER_ORDER.map((provider) => {
            const row = rows.find((entry) => entry.provider === provider);
            const override: WidgetProviderOverride = widgets.perProvider[provider] ?? {};
            const appearance = resolveAppearance(widgets, provider);

            return (
              <div key={provider} className="space-y-3">
                <AppearancePreview provider={provider} label={providerLabels.get(provider) ?? provider} appearance={appearance} />
                <div className={`${studioPanelClassName} space-y-2 p-4`}>
                  <p className="text-xs font-medium text-slate-700">覆盖项</p>
                  <label className="block text-[11px] text-slate-500">
                    主题
                    <select
                      value={override.theme ?? ''}
                      disabled={!canWrite || !row}
                      onChange={(event) =>
                        onProviderOverrideChange(provider, {
                          ...override,
                          theme: (event.target.value || undefined) as WidgetTheme | undefined,
                        })
                      }
                      className={`${studioFieldClassName} mt-1`}
                    >
                      <option value="">沿用全局（{widgets.theme}）</option>
                      {THEME_CHOICES.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-[11px] text-slate-500">
                    尺寸
                    <select
                      value={override.size ?? ''}
                      disabled={!canWrite || !row}
                      onChange={(event) =>
                        onProviderOverrideChange(provider, {
                          ...override,
                          size: (event.target.value || undefined) as WidgetSize | undefined,
                        })
                      }
                      className={`${studioFieldClassName} mt-1`}
                    >
                      <option value="">沿用全局（{widgets.size}）</option>
                      {SIZE_CHOICES.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-[11px] text-slate-500">
                    语言
                    <select
                      value={override.language ?? ''}
                      disabled={!canWrite || !row}
                      onChange={(event) =>
                        onProviderOverrideChange(provider, {
                          ...override,
                          language: event.target.value || undefined,
                        })
                      }
                      className={`${studioFieldClassName} mt-1`}
                    >
                      <option value="">沿用全局（{widgets.language}）</option>
                      {LANGUAGE_CHOICES.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    disabled={!canWrite || Object.keys(override).length === 0}
                    onClick={() => onClearOverride(provider)}
                    className={studioSecondaryButtonClassName}
                  >
                    清空该家覆盖
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className={`${studioPanelClassName} p-5`}>
        <header className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="flex items-center gap-2 text-base font-semibold text-slate-800">
            <FaEye className="h-4 w-4 text-slate-500" /> 下发结果核对
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={previewScenario}
              onChange={(event) => setPreviewScenario(event.target.value as Scenario)}
              className={studioFieldClassName}
              aria-label="核对场景"
            >
              {scenarios.map((scenario) => (
                <option key={scenario.value} value={scenario.value}>
                  {scenario.label}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => void runPreview()} disabled={previewing} className={studioSecondaryButtonClassName}>
              {previewing ? '读取中...' : '读取该场景的实际下发结果'}
            </button>
            <a href="/captcha-verify" target="_blank" rel="noreferrer" className={studioSecondaryButtonClassName}>
              <FaExternalLinkAlt className="mr-2 inline h-3 w-3" /> 打开独立验证页
            </a>
          </div>
        </header>

        {preview ? (
          <div className="mt-3 space-y-1 text-xs text-slate-600">
            <p>
              场景 <b>{preview.scenario}</b> · 会下发 <b className="text-slate-900">{preview.selection.label}</b>（
              {preview.selection.reason}）· 策略 <b>{preview.strategy}</b>
            </p>
            <p>
              该家最终外观：theme={preview.widget.theme} · size={preview.widget.size} · language={preview.widget.language} ·
              署名 {preview.widget.showProviderLabel ? '展示' : '隐藏'}
            </p>
            <p className="text-[11px] text-slate-500">
              注意：这里读的是已保存配置。若刚改了外观还没保存，先点右下角「保存全部」。
            </p>
          </div>
        ) : (
          <p className="mt-3 text-xs text-slate-500">点右侧按钮查看该场景此刻会选哪家、按什么外观渲染。</p>
        )}
      </section>
    </div>
  );
}
