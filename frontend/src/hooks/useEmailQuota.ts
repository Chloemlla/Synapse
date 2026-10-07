import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/api';

export interface EmailQuotaInfo {
  used: number;
  total: number;
  resetAt: string;
}

export function useEmailQuota(endpoint: string) {
  const [quota, setQuota] = useState<EmailQuotaInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    setQuota(null);
    try {
      const response = await api.get(endpoint);
      const used = Number(response.data?.used);
      const total = Number(response.data?.quotaTotal ?? response.data?.total);
      if (!Number.isFinite(used) || !Number.isFinite(total) || used < 0 || total < 0) {
        throw new Error('Invalid email quota response');
      }
      if (request === requestRef.current) {
        setQuota({ used, total, resetAt: String(response.data?.resetAt || '') });
      }
    } catch {
      // 未知不等于剩余额度为零，也不能继续显示上一次成功的余额。
      if (request === requestRef.current) setQuota(null);
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    void refresh();
    return () => { requestRef.current += 1; };
  }, [refresh]);

  return { quota, loading, refresh };
}
