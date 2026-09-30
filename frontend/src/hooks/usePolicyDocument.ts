import { useCallback, useEffect, useState } from 'react';
import { apiWithRetry } from '../api';
import type { PolicyDocument, PolicyDocumentResponse } from '../types/policy';

/**
 * 政策条文的共享加载器。
 *
 * 条文是公开且低频变化的：政策页、登录/注册勾选清单、TTS 门禁面板都要读它。
 * 之前只有政策页会去取，其余位置只能写一句 label 让用户跳走（见
 * docs/audit-2026-09-30-policy-system.md P-15/P-20）。
 * 这里做进程内缓存 + 并发去重：同一页面里多个组件同时挂载只会打一次请求。
 */

let cached: PolicyDocument | null = null;
let inflight: Promise<PolicyDocument> | null = null;

const unwrap = (payload: PolicyDocumentResponse): PolicyDocument => {
  if (!payload?.success || !payload.document) {
    throw new Error('条文数据不完整，请稍后重试。');
  }
  return payload.document;
};

/** 取条文（默认走缓存）。`force` 为 true 时强制重新拉取（用于「重新加载」按钮）。 */
export async function loadPolicyDocument(force = false): Promise<PolicyDocument> {
  if (!force && cached) return cached;
  if (!force && inflight) return inflight;

  const request = apiWithRetry
    .get<PolicyDocumentResponse>('/api/policy/document')
    .then(({ data }) => {
      const document = unwrap(data);
      cached = document;
      return document;
    })
    .finally(() => {
      inflight = null;
    });

  inflight = request;
  return request;
}

/** 测试用：清掉进程内缓存，避免用例之间互相影响。 */
export function resetPolicyDocumentCache(): void {
  cached = null;
  inflight = null;
}

export interface UsePolicyDocumentResult {
  document: PolicyDocument | null;
  loading: boolean;
  error: unknown;
  reload: () => void;
}

/**
 * 组件侧读取条文的 hook。加载失败不抛异常，交给调用方决定降级形态
 * （例如勾选清单失败时只显示 label，不影响登录/注册本身）。
 */
export function usePolicyDocument(): UsePolicyDocumentResult {
  const [document, setDocument] = useState<PolicyDocument | null>(cached);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let active = true;
    const forced = nonce > 0;
    // 有缓存且不是手动刷新时不闪 loading：页面直接渲染已缓存的条文
    if (forced || !cached) setLoading(true);

    loadPolicyDocument(forced)
      .then((loaded) => {
        if (!active) return;
        setDocument(loaded);
        setError(null);
      })
      .catch((caught) => {
        if (!active) return;
        setError(caught);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [nonce]);

  const reload = useCallback(() => setNonce((current) => current + 1), []);

  return { document, loading, error, reload };
}
