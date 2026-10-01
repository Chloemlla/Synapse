import { useEffect, useState } from 'react';
import getApiBaseUrl from '../api';

interface CapConfig {
  siteKey: string;
  enabled: boolean;
  apiEndpoint: string;
}

interface UseCapConfigOptions {
  usePublicConfig?: boolean;
}

/**
 * 读取 trycap（Cap）的公开配置。
 * 与 useHCaptchaConfig 同形：只拿到 siteKey 与实例地址，secret 永远留在服务端。
 */
export const useCapConfig = (options: UseCapConfigOptions = {}) => {
  const [config, setConfig] = useState<CapConfig>({ siteKey: '', enabled: false, apiEndpoint: '' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        setLoading(true);
        setError(null);

        const endpoint = options.usePublicConfig
          ? '/api/turnstile/public-config'
          : '/api/turnstile/cap-config';

        const response = await fetch(`${getApiBaseUrl()}${endpoint}`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();

        setConfig({
          siteKey: data.capSiteKey || data.siteKey || '',
          enabled: Boolean(data.capEnabled ?? data.enabled),
          apiEndpoint: data.capApiEndpoint || data.apiEndpoint || '',
        });
      } catch (err) {
        console.error('Failed to fetch Cap config:', err);
        setError(err instanceof Error ? err.message : 'Unknown error');
        setConfig({ siteKey: '', enabled: false, apiEndpoint: '' });
      } finally {
        setLoading(false);
      }
    };

    fetchConfig();
  }, [options.usePublicConfig]);

  return { config, loading, error };
};
