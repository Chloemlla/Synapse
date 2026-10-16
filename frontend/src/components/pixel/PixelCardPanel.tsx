import { FaCheckCircle, FaExclamationTriangle, FaSync } from "react-icons/fa";
import { cn } from "../../utils/cn";
import {
  studioFieldClassName,
  studioGhostButtonClassName,
  studioPanelClassName,
  studioPillClassName,
  studioPrimaryButtonClassName,
  studioSubPanelClassName,
} from "../studioTheme";
import { PIXEL_SERVICE_LABELS, type PixelCardQuota, type PixelServiceType, type PixelSettings } from "../../types/pixel";

// PIX-02 卡密验证/额度 + PIX-03 服务选择。
// 额度同时显示「展示值」与「计费单位」，因为上游两套字段量纲不同，混用会显示成两倍/一半。
type Props = {
  card: string;
  onCardChange: (value: string) => void;
  onVerify: () => void;
  verifying: boolean;
  quota: PixelCardQuota | null;
  settings: PixelSettings | null;
  settingsError: string;
  serviceType: PixelServiceType;
  onServiceTypeChange: (type: PixelServiceType) => void;
  onOpenHistory: () => void;
};

export default function PixelCardPanel({
  card,
  onCardChange,
  onVerify,
  verifying,
  quota,
  settings,
  settingsError,
  serviceType,
  onServiceTypeChange,
  onOpenHistory,
}: Props) {
  const services = settings?.services ?? [];

  return (
    <section className={studioPanelClassName} aria-labelledby="pixel-card-heading">
      <div className="mb-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">Card & Quota</p>
        <h2 id="pixel-card-heading" className="mt-1 text-lg font-semibold text-slate-900">卡密与额度</h2>
        <p className="mt-1 text-sm text-slate-500">输入卡密后可以查看剩余额度与可选服务。</p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          className={studioFieldClassName}
          value={card}
          onChange={(event) => onCardChange(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") onVerify(); }}
          placeholder="请输入卡密"
          autoComplete="off"
          spellCheck={false}
          aria-label="卡密"
        />
        <button type="button" onClick={onVerify} disabled={verifying || !card.trim()} className={studioPrimaryButtonClassName}>
          {verifying ? <FaSync className="animate-spin" /> : <FaCheckCircle />} {verifying ? "验证中…" : "验证卡密"}
        </button>
      </div>
      <p className="mt-2 text-xs text-slate-500">卡密只在本页内存中使用，不会保存到浏览器。</p>

      {quota && (
        <div className={cn(studioSubPanelClassName, "mt-3")}>
          <div className="flex flex-wrap items-center gap-2">
            <span className={studioPillClassName(quota.valid)}>{quota.valid ? "卡密可用" : "卡密不可用"}</span>
            {quota.remainingQuota !== null && <span className="text-sm text-slate-700">剩余额度 <strong className="font-semibold">{quota.remainingQuota}</strong>{quota.totalQuota ? ` / ${quota.totalQuota}` : ""}</span>}
            {quota.remainingUnits !== null && <span className="text-xs text-slate-500">计费单位剩余 {quota.remainingUnits}{quota.totalUnits !== null ? ` / ${quota.totalUnits}` : ""}</span>}
          </div>
          {quota.message && <p className="mt-2 text-sm text-slate-600">{quota.message}</p>}
          {!quota.valid && quota.historyAvailable && (
            <button type="button" onClick={onOpenHistory} className={cn(studioGhostButtonClassName, "mt-2")}>查看历史任务</button>
          )}
        </div>
      )}

      <div className="mt-4 border-t border-slate-200 pt-4">
        <h3 className="text-sm font-semibold text-slate-900">服务类型</h3>
        {settingsError && <p className="mt-2 text-sm text-amber-700">{settingsError}</p>}
        {services.length === 0 && !settingsError && <p className="mt-2 text-sm text-slate-500">暂时读不到可选服务，请稍后重试。</p>}
        <div className="mt-2 space-y-2">
          {services.map((option) => (
            <label
              key={option.type}
              className={cn(
                "flex items-start gap-3 rounded-2xl border px-3 py-2",
                option.enabled ? "border-slate-200 bg-white/80" : "border-slate-200 bg-slate-50 opacity-70",
                serviceType === option.type && option.enabled && "border-slate-900",
              )}
            >
              <input
                type="radio"
                name="pixel-service"
                className="mt-1"
                checked={serviceType === option.type}
                disabled={!option.enabled}
                onChange={() => onServiceTypeChange(option.type)}
              />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-slate-800">{PIXEL_SERVICE_LABELS[option.type] ?? option.type}</span>
                <span className="mt-0.5 block text-xs text-slate-500">
                  预估每个账号 {option.quotaCost} 额度{option.enabled ? "" : " · 当前不可用"}
                </span>
              </span>
            </label>
          ))}
        </div>
        {settings && !settings.autoBindEnabled && (
          <p className="mt-2 flex items-start gap-2 text-xs text-amber-700">
            <FaExclamationTriangle className="mt-0.5 shrink-0" />
            绑卡相关服务当前被关闭，只能使用「仅提取链接」；已选择的服务会自动回退。
          </p>
        )}
        <p className="mt-2 text-xs text-slate-500">这里显示的是预估额度，实际扣额以服务端与上游返回为准。</p>
      </div>
    </section>
  );
}
