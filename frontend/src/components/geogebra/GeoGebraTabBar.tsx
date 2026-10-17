import { useRef } from "react";
import { cn } from "../../utils/cn";

export type GeoGebraTabItem = {
  id: string;
  label: string;
  hint?: string;
  badge?: string;
};

type Props = {
  tabs: GeoGebraTabItem[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
  idPrefix?: string;
};

// 工作台功能区标签栏。用 roving tabindex + 方向键切换，键盘用户不需要逐个 Tab。
// 只做展示与键盘语义，面板的挂载/隐藏由页面负责（隐藏而不是卸载，避免 AI 轮询被切走中断）。
export default function GeoGebraTabBar({ tabs, value, onChange, ariaLabel, idPrefix = "geogebra-workbench" }: Props) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const move = (index: number, direction: 1 | -1) => {
    const next = (index + direction + tabs.length) % tabs.length;
    onChange(tabs[next].id);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="flex gap-1 overflow-x-auto rounded-2xl border border-slate-200 bg-white/80 p-1.5"
    >
      {tabs.map((tab, index) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(element) => { refs.current[index] = element; }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab.id}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            title={tab.hint}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") { event.preventDefault(); move(index, 1); }
              else if (event.key === "ArrowLeft") { event.preventDefault(); move(index, -1); }
              else if (event.key === "Home") { event.preventDefault(); onChange(tabs[0].id); refs.current[0]?.focus(); }
              else if (event.key === "End") {
                event.preventDefault();
                onChange(tabs[tabs.length - 1].id);
                refs.current[tabs.length - 1]?.focus();
              }
            }}
            className={cn(
              "inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl px-3 text-sm font-semibold transition",
              selected ? "bg-slate-900 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
            )}
          >
            <span>{tab.label}</span>
            {tab.badge && (
              <span className={cn(
                "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                selected ? "bg-white/15 text-white" : "bg-slate-100 text-slate-500",
              )}>
                {tab.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
