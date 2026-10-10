import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchLibreChatQuota, type LibreChatQuotaView } from '../api/librechatQuota';

/**
 * LibreChat 今日额度的唯一状态源：页面挂载时读一次，之后由「/send、/retry 响应内联的 quota」
 * 与 SSE 完成事件触发的 refresh 更新——发送/重试这两个会扣减额度的动作都当场把新值写回，
 * 因此页面上的剩余次数始终跟随后端事实，不需要用户手动刷新。
 *
 * 刷新失败**不清空**上一次已知值：额度是频繁刷新的展示项，把已知数字抹成「未知」比显示稍旧的
 * 数字更容易让人误判（与 useEmailQuota 的一次性读取取舍不同）。错误单独用 error 暴露。
 *
 * @param enabled 登录态就绪前不要发请求（否则首次加载会打一发 401，而且不会再重试）；
 *   关掉时同时清掉上一个账号的额度，避免切号后短暂显示错人的数字。
 */
export function useLibreChatQuota(enabled = true) {
  const [quota, setQuota] = useState<LibreChatQuotaView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  /** 用本地已拿到的权威额度覆盖当前值（来自发送/重试响应）。 */
  const applyQuota = useCallback((view: LibreChatQuotaView | null) => {
    if (!view) return;
    // 作废在途查询：它可能是在这次扣减之前发出的，晚到的旧数字会把剩余次数抬回去。
    requestRef.current += 1;
    setQuota(view);
    setError(null);
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const view = await fetchLibreChatQuota();
      if (request === requestRef.current) {
        setQuota(view);
        setError(null);
      }
    } catch {
      // 保留上一次已知额度，只提示这次没取到。
      if (request === requestRef.current) setError('额度暂时获取不到');
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      // 登出/切号：丢弃在途结果并清空，下一次启用时重新查。
      requestRef.current += 1;
      setQuota(null);
      setError(null);
      setLoading(true);
      return undefined;
    }
    void refresh();
    return () => {
      requestRef.current += 1;
    };
  }, [enabled, refresh]);

  return { quota, loading, error, refresh, applyQuota };
}
