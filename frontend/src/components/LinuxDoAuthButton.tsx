import React, { useMemo, useState } from "react";
import getApiBaseUrl from "../api";
import { useAuthProviderStore } from "../stores/authProviderStore";
import { cn } from "../utils/cn";
import { authElevatedPanelClassName } from "./authStudioTheme";

interface LinuxDoAuthButtonProps {
  intent?: "login" | "register";
  label: string;
  description?: string;
  className?: string;
}

const LINUXDO_ICON_URL =
  "https://img.cdn1.vip/i/6980103489944_1770000436.png";

const LinuxDoAuthButton: React.FC<LinuxDoAuthButtonProps> = ({
  intent = "login",
  label,
  description,
  className = "",
}) => {
  const { linuxdo: config, loading } = useAuthProviderStore();
  const [redirecting, setRedirecting] = useState(false);
  const startUrl = useMemo(
    () => `${getApiBaseUrl()}/api/auth/linuxdo/start?intent=${intent}`,
    [intent],
  );

  if (loading || !config.enabled) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={() => {
        if (redirecting) return;
        // 授权是整页跳转，页面卸载前用户需要看到“已受理”，否则慢网下会反复点击。
        setRedirecting(true);
        window.location.assign(startUrl);
      }}
      disabled={redirecting}
      aria-busy={redirecting}
      className={cn(
        authElevatedPanelClassName,
        "flex w-full items-center justify-center gap-3 px-4 py-3.5 text-sm font-semibold text-slate-900 transition hover:border-slate-300 hover:bg-white disabled:cursor-wait disabled:opacity-70",
        className,
      )}
    >
      <img
        src={LINUXDO_ICON_URL}
        alt="Linux.do"
        className="h-8 w-8 rounded-full border border-slate-200 object-cover shadow-sm"
        loading="lazy"
        referrerPolicy="no-referrer"
      />
      <span className="flex flex-col items-start">
        <span>{redirecting ? "正在跳转 Linux.do…" : label}</span>
        {description ? (
          <span className="text-[11px] font-normal leading-5 text-slate-500">{description}</span>
        ) : null}
      </span>
    </button>
  );
};

export default LinuxDoAuthButton;
