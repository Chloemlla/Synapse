import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchFeatureConsent, recordPolicyConsent, type FeatureConsentView } from '../api/policy';
import { getBackendErrorMessage } from '../utils/backendError';

export interface UseFeatureConsentResult {
  /** 拉取中：门禁在此期间只显示占位，不闪出功能面板 */
  loading: boolean;
  /** 该用户已同意该功能要求的全部文件（服务端判定，前端不再自己算一遍） */
  ready: boolean;
  view: FeatureConsentView | null;
  /** 可读失败原因（拉取失败或记录同意失败），供门禁直接展示 —— 不吞进 console */
  error: string;
  refresh: () => Promise<void>;
  /**
   * 记录当前账号对政策的同意，成功后自动 refresh。
   * 失败时把原因写进 error 并正常返回（不抛给调用方），调用方按 error 渲染即可。
   */
  accept: () => Promise<void>;
}

/**
 * 页面门禁读取「这个功能对当前登录用户开没开」的 hook。
 *
 * 为什么状态全交给服务端：同意记录绑在 userId 上、且撤销后要立即生效（服务端无缓存），
 * 前端本地记住一个 ready 就等于在页面上留了一份会过期的缓存，用户撤销后仍能继续用。
 *
 * 为什么要自己判「组件还在不在」：拉取与记录同意都是异步的，用户可能中途切走页面；
 * 回来时组件已卸载，再 setState 只会换来一条 React 警告。
 */
export function useFeatureConsent(feature: string): UseFeatureConsentResult {
  const [view, setView] = useState<FeatureConsentView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const aliveRef = useRef(true);

  const load = useCallback(async (): Promise<void> => {
    if (!aliveRef.current) return;
    setLoading(true);
    try {
      const payload = await fetchFeatureConsent();
      if (!aliveRef.current) return;
      setView(payload.features.find(item => item.key === feature) ?? null);
      setError('');
    } catch (caught) {
      if (!aliveRef.current) return;
      setError(getBackendErrorMessage(caught, '无法获取该功能的开通状态，请稍后重试'));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [feature]);

  useEffect(() => {
    // 严格模式下 effect 会跑两遍：每次都把存活标记立起来，避免第二次挂载后状态被当成「已卸载」丢掉
    aliveRef.current = true;
    void load();
    return () => {
      aliveRef.current = false;
    };
  }, [load]);

  const accept = useCallback(async (): Promise<void> => {
    if (!aliveRef.current) return;
    setError('');
    try {
      await recordPolicyConsent();
    } catch (caught) {
      if (aliveRef.current) setError(getBackendErrorMessage(caught, '记录同意失败，请稍后重试'));
      return;
    }
    // 成功后重新拉状态而不是本地置 true：开通与否由服务端按 userId 判定，前端猜不得
    await load();
  }, [load]);

  return { loading, ready: view?.satisfied === true, view, error, refresh: load, accept };
}

export default useFeatureConsent;
