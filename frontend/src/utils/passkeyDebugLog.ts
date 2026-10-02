/**
 * Passkey 调试日志的模块级单例（内存，不落盘）。
 *
 * 为什么要有它：`usePasskey` 本来就把每一步（开始注册、options 摘要、失败原因…）写进了
 * 自己的 `debugInfos` state，`DebugInfoModal` 也早就写好了 —— 但**没有任何组件渲染那个
 * 弹窗、也拿不到另一个 hook 实例里的 state**，于是「调试控制台」等于不存在。
 *
 * 用 `useSyncExternalStore` 的模块级单例把日志挪到 hook 之外，管理页就能直接订阅同一份
 * 快照。刻意只在内存里保存：
 *  - 里面可能有 credential id / options 摘要这类不该落盘的字段；
 *  - 刷新即清空，符合"现场诊断"的用途。
 */

export interface PasskeyDebugEntry {
  action: string;
  timestamp: string;
  [key: string]: unknown;
}

/** 上限：调试日志不该无限增长（即使是内存）。 */
export const MAX_PASSKEY_DEBUG_ENTRIES = 200;

const EMPTY: readonly PasskeyDebugEntry[] = [];

let snapshot: readonly PasskeyDebugEntry[] = EMPTY;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function normalize(raw: unknown): PasskeyDebugEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const action = typeof record.action === 'string' && record.action.trim() ? record.action : 'unknown';
  const timestamp =
    typeof record.timestamp === 'string' && record.timestamp ? record.timestamp : new Date().toISOString();
  return { ...record, action, timestamp };
}

export const passkeyDebugLog = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot(): readonly PasskeyDebugEntry[] {
    return snapshot;
  },
  getServerSnapshot(): readonly PasskeyDebugEntry[] {
    return EMPTY;
  },
  append(raw: unknown): void {
    const entry = normalize(raw);
    if (!entry) return;
    const next = [...snapshot, entry];
    snapshot = next.length > MAX_PASSKEY_DEBUG_ENTRIES ? next.slice(next.length - MAX_PASSKEY_DEBUG_ENTRIES) : next;
    notify();
  },
  clear(): void {
    if (snapshot.length === 0) return;
    snapshot = EMPTY;
    notify();
  },
};
