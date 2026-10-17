import { useCallback, useEffect, useRef, useState } from 'react';
import { FaCheckCircle, FaCopy } from 'react-icons/fa';
import { cn } from '../../utils/cn';

// 条文指纹（sha256）展示与复制。
//
// 条文指纹是公开信息（政策页页脚本来就完整印出），它的用途是让用户把「我同意时的那份文本」
// 与「现在页面上的文本」逐字对上。因此这里允许完整展示与复制，不做脱敏；
// 真正不能外泄的是同意记录的 checksum（服务端签名），它不在这里出现。

/** navigator.clipboard 在明文 HTTP 或部分内嵌浏览器里不可用，需要兜底。 */
const writeClipboard = async (value: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.setAttribute('readonly', 'readonly');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand('copy');
      textarea.remove();
      return ok;
    } catch {
      return false;
    }
  }
};

export interface PolicyDocumentFingerprintProps {
  label: string;
  value: string;
  /** compact：列表里只展示前 12 位（复制仍是完整值）；full：完整展示，便于逐字核对。 */
  variant?: 'full' | 'compact';
  /** mismatch：该记录与当前条文不是同一份时用琥珀色强调。 */
  tone?: 'default' | 'mismatch';
  className?: string;
}

export default function PolicyDocumentFingerprint({
  label,
  value,
  variant = 'full',
  tone = 'default',
  className,
}: PolicyDocumentFingerprintProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  const handleCopy = useCallback(async () => {
    if (!value) return;
    if (!(await writeClipboard(value))) return;
    setCopied(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 1800);
  }, [value]);

  const display = variant === 'compact' && value.length > 12 ? `${value.slice(0, 12)}…` : value;

  return (
    <span className={cn('inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-5', className)}>
      <span className="shrink-0 text-slate-500">{label}</span>
      <code
        className={cn(
          'break-all font-mono text-[10px]',
          tone === 'mismatch' ? 'text-amber-700' : 'text-slate-600',
        )}
      >
        {display}
      </code>
      <button
        type="button"
        onClick={() => void handleCopy()}
        aria-label={`复制${label}`}
        className={cn(
          'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold transition print:hidden',
          copied
            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
            : 'border-slate-200 bg-white/80 text-slate-500 hover:border-slate-300 hover:text-slate-700',
        )}
      >
        {copied ? <FaCheckCircle aria-hidden /> : <FaCopy aria-hidden />}
        {copied ? '已复制' : '复制'}
      </button>
    </span>
  );
}
