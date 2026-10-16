import { useEffect, useRef, useState } from "react";
import { studioGhostButtonClassName, studioModalCardClassName, studioModalOverlayClassName, studioPrimaryButtonClassName } from "../studioTheme";
import { acknowledgePixelNoticeToday } from "./pixelPreferences";

// PIX-01 操作提示：首次进入先讲清「这个功能会拿你的账号做什么」，
// 打开操作说明后才允许勾选确认；「今天不再弹出」只是浏览器便利状态，
// 真正的授权仍是服务端同意门禁（account-credential → terms + specific-terms）。
const CAUTIONS = [
  "这里会把账号交给你选择的外部折扣链接服务处理：账号邮箱、密码、辅助邮箱与 2FA 秘钥会实时传给它。",
  "请只提交你本人或已获授权的账号；不要提交他人账号。",
  "提交后请勿重复点击：重复提交可能造成重复扣额。结果不确定时先去历史任务里确认。",
  "服务类型决定是否继续绑卡；绑卡会改动账号的支付设置，请确认你接受这个后果。",
  "额度按账号个数估算，最终扣额以服务端与上游返回为准。",
];

type Props = {
  open: boolean;
  onClose: () => void;
  onAcknowledge: () => void;
};

export default function PixelNoticeDialog({ open, onClose, onAcknowledge }: Props) {
  const [confirmed, setConfirmed] = useState(false);
  const [dismissToday, setDismissToday] = useState(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) {
      setConfirmed(false);
      setDismissToday(false);
      return undefined;
    }
    const previousFocus = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => closeRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus?.();
    };
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div className={studioModalOverlayClassName} role="presentation" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="pixel-notice-title"
        className={studioModalCardClassName}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="pixel-notice-title" className="text-lg font-semibold text-slate-900">使用前请先了解</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-slate-600">
          {CAUTIONS.map((item) => <li key={item}>{item}</li>)}
        </ul>
        <label className="mt-4 flex items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" className="mt-1" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
          我已阅读并确认上述说明，提交的账号是我本人或已获授权管理的账号。
        </label>
        <label className="mt-2 flex items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" className="mt-1" checked={dismissToday} onChange={(event) => setDismissToday(event.target.checked)} />
          今天不再弹出这个提示
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" ref={closeRef} onClick={onClose} className={studioGhostButtonClassName}>稍后再说</button>
          <button
            type="button"
            disabled={!confirmed}
            onClick={() => {
              if (dismissToday) acknowledgePixelNoticeToday();
              onAcknowledge();
            }}
            className={studioPrimaryButtonClassName}
          >
            开始使用
          </button>
        </div>
      </section>
    </div>
  );
}
