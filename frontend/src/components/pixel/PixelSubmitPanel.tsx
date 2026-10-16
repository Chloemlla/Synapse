import { useEffect, useMemo, useState } from "react";
import { FaPaperPlane, FaShieldAlt } from "react-icons/fa";
import { cn } from "../../utils/cn";
import FeatureConsentGate from "../FeatureConsentGate";
import {
  studioFieldClassName,
  studioGhostButtonClassName,
  studioPanelClassName,
  studioPillClassName,
  studioPrimaryButtonClassName,
  studioSubPanelClassName,
  studioTextareaClassName,
} from "../studioTheme";
import { PIXEL_SERVICE_LABELS, type PixelServiceOption, type PixelServiceType } from "../../types/pixel";

// PIX-04 多账号提交。
//
// 三条前端纪律（服务端同样有一份，前端不是为了安全而是为了少发无效请求）：
//  1) 卡密/服务/账号三者缺一不发请求；
//  2) 账号文本只在组件 state 里存在，不写 localStorage、不写 console；
//  3) 同一份文本只有同一个幂等键：重复点击走同一个键，改了文本才换新键。
const ACCOUNT_LINE_PATTERN = /----/;
const MAX_ACCOUNTS = 200;

type Props = {
  serviceType: PixelServiceType;
  serviceOption: PixelServiceOption | null;
  cardReady: boolean;
  submitting: boolean;
  consentReady: boolean;
  /** 每次成功提交后自增，用于清空输入框（账号文本不在任何持久化位置留痕）。 */
  resetSignal: number;
  /** 非空时禁止提交，并把它当作面向用户的下一步说明。 */
  blockedReason: string;
  onSubmit: (accountsText: string) => Promise<void>;
  onOpenNotice: () => void;
};

function countAccounts(text: string): number {
  return text.split(/\r?\n/).filter((line) => line.trim()).length;
}

export default function PixelSubmitPanel({ serviceType, serviceOption, cardReady, submitting, consentReady, resetSignal, blockedReason, onSubmit, onOpenNotice }: Props) {
  const [accountsText, setAccountsText] = useState("");
  const [localError, setLocalError] = useState("");

  // 提交成功后由父组件自增 resetSignal：把内存里的账号文本清干净，
  // 既不留在 state，也不会因为组件重挂载被任何缓存捞回来。
  useEffect(() => {
    if (resetSignal > 0) setAccountsText("");
  }, [resetSignal]);

  const accountCount = useMemo(() => countAccounts(accountsText), [accountsText]);
  const estimated = useMemo(() => (serviceOption ? accountCount * serviceOption.quotaCost : 0), [accountCount, serviceOption]);
  const malformedLines = useMemo(
    () => accountsText.split(/\r?\n/).map((line, index) => ({ line, number: index + 1 }))
      .filter((item) => item.line.trim() && !ACCOUNT_LINE_PATTERN.test(item.line))
      .map((item) => item.number),
    [accountsText],
  );

  const handleSubmit = async () => {
    if (!cardReady) {
      setLocalError("请先验证卡密。");
      return;
    }
    if (!accountsText.trim()) {
      setLocalError("请先粘贴要处理的账号。");
      return;
    }
    if (accountCount > MAX_ACCOUNTS) {
      setLocalError(`一次最多提交 ${MAX_ACCOUNTS} 个账号，请分批处理。`);
      return;
    }
    if (malformedLines.length) {
      setLocalError(`第 ${malformedLines.slice(0, 5).join("、")} 行格式不正确：每行应为 邮箱----密码----辅助邮箱----2FA密钥。`);
      return;
    }
    setLocalError("");
    await onSubmit(accountsText);
  };

  return (
    <section className={studioPanelClassName} aria-labelledby="pixel-submit-heading">
      <div className="mb-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">Submit</p>
        <h2 id="pixel-submit-heading" className="mt-1 text-lg font-semibold text-slate-900">提交账号</h2>
        <p className="mt-1 text-sm text-slate-500">每行一个账号，格式为 邮箱----密码----辅助邮箱----2FA密钥。</p>
      </div>

      <div className={studioSubPanelClassName}>
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900"><FaShieldAlt /> 开始前请确认</h3>
        <ul className="mt-2 space-y-1 text-xs leading-5 text-slate-600">
          <li>服务：外部折扣链接服务（你选择的类型：{PIXEL_SERVICE_LABELS[serviceType] ?? serviceType}）。</li>
          <li>提交内容：账号邮箱、密码、辅助邮箱、2FA 秘钥。这些字段只用于本次处理，默认不会保存在 Synapse。</li>
          <li>唯一例外：收到具备法律依据的调取要求（或你明确授权）时，这一次的账号内容会被加密留存最长 30 天，每次读取都进审计；已在隐私说明中列明。</li>
          <li>配额：按账号个数预估最高 {estimated || "—"} 额度，最终以服务端与上游扣额为准。</li>
          <li>账号要求：只能提交你本人或已获授权管理的账号。</li>
          <li>停止方式：提交前可随时离开本页；提交后可在任务详情里取消仍在排队的账号。</li>
        </ul>
        <button type="button" onClick={onOpenNotice} className={cn(studioGhostButtonClassName, "mt-2")}>再看一遍操作说明</button>
      </div>

      <div className="mt-3">
        <label className="block text-xs font-semibold text-slate-600" htmlFor="pixel-accounts">
          账号列表
        </label>
        <textarea
          id="pixel-accounts"
          className={cn(studioTextareaClassName, "mt-1 min-h-40 font-mono text-xs")}
          value={accountsText}
          onChange={(event) => { setAccountsText(event.target.value); setLocalError(""); }}
          placeholder="example@mail.com----password----recovery@mail.com----ABCDEFGHIJKLMNOP"
          spellCheck={false}
          aria-describedby="pixel-accounts-hint"
        />
        <p id="pixel-accounts-hint" className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span className={studioPillClassName(accountCount > 0)}>已填写 {accountCount} 个账号</span>
          {accountCount > 0 && <span>预估最高 {estimated} 额度</span>}
          <span>账号内容只在本页内存中，离开页面即清除。</span>
        </p>
      </div>

      {localError && <p role="alert" className="mt-3 rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{localError}</p>}

      <FeatureConsentGate feature="pixel-tasks">
        {blockedReason && <p className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{blockedReason}</p>}
        <button type="button" onClick={() => void handleSubmit()} disabled={submitting || !consentReady || Boolean(blockedReason)} className={cn(studioPrimaryButtonClassName, "mt-3")}>
          <FaPaperPlane /> {submitting ? "提交中…" : "提交任务"}
        </button>
        <p className="mt-2 text-xs text-slate-500">提交后请不要重复点击；结果不确定时请先到历史任务里确认。</p>
      </FeatureConsentGate>
    </section>
  );
}
