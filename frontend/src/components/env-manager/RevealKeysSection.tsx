import { useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import CollapsibleSection from './CollapsibleSection';
import { REVEAL_KEY_API, authFetch } from './api';
import { useNotification } from '../Notification';
import { useAuth } from '../../hooks/useAuth';
import { isSuperAdmin } from '../../utils/rbac';
import { studioFieldClassName, studioPrimaryButtonClassName } from '../studioTheme';

interface RevealKeysSectionProps {
  prefersReducedMotion?: boolean | null;
}

interface RevealResult {
  aesKey: string;
  aesKeyConfigured: boolean;
  masterOrigin?: 'AES_KEY' | 'JWT_SECRET' | 'ephemeral';
  masterFingerprint: string;
  masterSources?: Array<{ name: string; configured: boolean; fingerprint: string | null; active: boolean }>;
  lastMigration?: {
    schemeVersion: number | null;
    masterFingerprint: string | null;
    phase: string | null;
    finishedAt: string | null;
  } | null;
  derived: Record<string, string>;
}

const MASTER_ORIGIN_LABEL: Record<'AES_KEY' | 'JWT_SECRET' | 'ephemeral', string> = {
  AES_KEY: 'AES_KEY（主密钥，运行时生效值）',
  JWT_SECRET: '主密钥源：JWT_SECRET（过渡回退，建议尽快在上方设置 AES_KEY）',
  ephemeral: '进程级临时源（未配置 AES_KEY/JWT_SECRET，重启即变，仅非生产）',
};

function KeyRow({ label, value, onCopy }: { label: string; value: string; onCopy: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-amber-100 py-1 last:border-b-0">
      <span className="shrink-0 text-slate-600">{label}</span>
      <span className="flex min-w-0 items-center gap-2">
        <code className="truncate font-mono text-[11px] text-slate-800" title={value}>
          {value}
        </code>
        <button type="button" onClick={onCopy} className="shrink-0 text-sky-600 underline">
          复制
        </button>
      </span>
    </div>
  );
}

/**
 * 验证管理操作口令后查看单一主密钥 AES_KEY 及各用途派生子密钥（D-5）。
 * 明文只在本次会话内存中，收起/离开即清除；后端每次查看都写审计日志。
 */
export default function RevealKeysSection({ prefersReducedMotion: reducedMotionProp }: RevealKeysSectionProps) {
  const prefersReducedMotion = useReducedMotion() ?? reducedMotionProp;
  const { setNotification } = useNotification();
  const { user } = useAuth();
  const canView = isSuperAdmin(user?.role);

  const [isOpen, setIsOpen] = useState(false);
  const [opPassword, setOpPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<RevealResult | null>(null);

  const onReveal = async () => {
    if (!opPassword.trim()) {
      setNotification({ message: '请输入管理操作口令', type: 'warning' });
      return;
    }
    setLoading(true);
    try {
      const res = await authFetch(REVEAL_KEY_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationPassword: opPassword }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setResult(null);
        setNotification({ message: data?.error || '查看密钥失败', type: 'error' });
        return;
      }
      setResult(data as RevealResult);
      setOpPassword('');
    } catch {
      setNotification({ message: '查看密钥请求失败', type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const copy = (value: string) => {
    navigator.clipboard?.writeText(value).then(
      () => setNotification({ message: '已复制到剪贴板', type: 'success' }),
      () => setNotification({ message: '复制失败', type: 'error' }),
    );
  };

  if (!canView) return null;

  return (
    <CollapsibleSection
      title="查看密钥（AES_KEY 主密钥与派生子密钥）"
      description="所有内部签名/加密密钥均由单一主密钥 AES_KEY 经 HKDF 按用途派生。查看明文需再次输入管理操作口令，且每次查看都会记入审计日志。"
      sectionKey="reveal-keys"
      isOpen={isOpen}
      onToggle={() => setIsOpen((open) => !open)}
      prefersReducedMotion={prefersReducedMotion}
    >
      <div className="space-y-3 px-4 py-4 sm:px-5">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="password"
            value={opPassword}
            onChange={(event) => setOpPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void onReveal();
            }}
            placeholder="管理操作口令（二次验证）"
            aria-label="管理操作口令"
            autoComplete="off"
            className={studioFieldClassName}
          />
          <button type="button" disabled={loading} onClick={() => void onReveal()} className={studioPrimaryButtonClassName}>
            {loading ? '验证中…' : '验证并查看'}
          </button>
        </div>

        {result ? (
          <div className="space-y-1.5 rounded-xl border border-amber-200 bg-amber-50/60 p-3 text-xs">
            <div className="font-semibold text-amber-700">以下为敏感明文，请勿外泄；点击“收起并清除”或离开页面即清除。</div>
            <KeyRow
              label={MASTER_ORIGIN_LABEL[result.masterOrigin ?? (result.aesKeyConfigured ? 'AES_KEY' : 'ephemeral')]}
              value={result.aesKey || '（空）'}
              onCopy={() => result.aesKey && copy(result.aesKey)}
            />
            <div className="text-[11px] text-slate-400">
              主密钥指纹 {result.masterFingerprint}
              {result.masterOrigin && result.masterOrigin !== 'AES_KEY'
                ? ' · 所有派生子密钥均由该生效主密钥源经 HKDF 派生'
                : null}
            </div>

            {result.masterSources && result.masterSources.length > 0 ? (
              <div className="mt-2 rounded-lg border border-amber-100 bg-white/60 p-2">
                <div className="font-semibold text-slate-600">主密钥源（运行时）</div>
                {result.masterSources.map((source) => (
                  <div key={source.name} className="flex items-center justify-between gap-2 py-0.5">
                    <span className="text-slate-600">
                      {source.name}
                      {source.active ? <span className="ml-1 rounded bg-emerald-100 px-1 text-emerald-700">生效中</span> : null}
                    </span>
                    <span className="font-mono text-[11px] text-slate-500">
                      {source.configured ? `指纹 ${source.fingerprint}` : '未配置'}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}

            {result.lastMigration ? (
              <div className="mt-2 rounded-lg border border-sky-100 bg-sky-50/60 p-2">
                <div className="font-semibold text-slate-600">上次密钥统一迁移记录</div>
                <div className="text-[11px] text-slate-500">
                  方案版本 {result.lastMigration.schemeVersion ?? '-'} · 阶段 {result.lastMigration.phase ?? '-'}
                </div>
                <div className="text-[11px] text-slate-500">
                  迁移时主密钥指纹 {result.lastMigration.masterFingerprint ?? '-'}
                  {result.lastMigration.masterFingerprint && result.lastMigration.masterFingerprint === result.masterFingerprint
                    ? ' · 与当前一致'
                    : result.lastMigration.masterFingerprint
                      ? ' · 与当前不一致（当前主密钥已变更）'
                      : ''}
                </div>
                <div className="text-[11px] text-slate-400">完成于 {result.lastMigration.finishedAt ?? '（未完成）'}</div>
              </div>
            ) : (
              <div className="mt-2 text-[11px] text-slate-400">尚无密钥统一迁移记录（security_migrations 未生成）。</div>
            )}
            <div className="pt-1 font-semibold text-slate-600">派生子密钥（hex，按用途）</div>
            {Object.entries(result.derived).map(([label, value]) => (
              <KeyRow key={label} label={label} value={value} onCopy={() => copy(value)} />
            ))}
            <button type="button" onClick={() => setResult(null)} className="mt-2 text-slate-500 underline">
              收起并清除
            </button>
          </div>
        ) : null}
      </div>
    </CollapsibleSection>
  );
}
