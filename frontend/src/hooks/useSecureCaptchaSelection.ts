import { useState, useEffect, useCallback, useRef } from 'react';
import {
  generateSecureCaptchaSelection,
  normalizeCaptchaWidgetAppearance,
  CaptchaType,
  DEFAULT_CAPTCHA_WIDGET_APPEARANCE,
  type CaptchaScenario,
  type CaptchaWidgetAppearance,
  type EncryptedCaptchaSelection,
} from '../utils/captchaSelection';
import getApiBaseUrl from '../api';
import { fetchWithTimeout } from '../utils/fetchWithTimeout';

interface SecureCaptchaConfig {
  captchaType: CaptchaType;
  config: {
    enabled: boolean;
    siteKey: string;
    /** 仅 trycap 返回：Cap 实例地址（用于拼 data-cap-api-endpoint）。 */
    apiEndpoint?: string;
  };
  /** 管理端统一调控的控件外观（theme/size/language/是否展示供应商署名）。 */
  widget: CaptchaWidgetAppearance;
  scenario: CaptchaScenario;
  strategy: string;
  reason: string;
  /** 控件加载失败后最多换几家（含首次），来自管理端分配策略。 */
  failoverMaxAttempts: number;
}

interface UseSecureCaptchaSelectionOptions {
  fingerprint: string;
  /** 下发场景：首访门禁传 first_visit，独立验证页传 standalone，其余默认 default。 */
  scenario?: CaptchaScenario;
}

export interface RegenerateOptions {
  /** 已经失败过的供应商（控件加载不出来时逐个排除，等于前端侧的故障转移）。 */
  exclude?: CaptchaType[];
}

const MAX_INIT_FAILURES = 5; // 连续失败达到上限后停止自动重试，避免打爆 publicLimiter
const INIT_FAILURE_BACKOFF_MS = 2000; // 失败后的基础退避时间
const DEFAULT_FAILOVER_ATTEMPTS = 2;

export const useSecureCaptchaSelection = (options: UseSecureCaptchaSelectionOptions) => {
  const [captchaConfig, setCaptchaConfig] = useState<SecureCaptchaConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [encryptedSelection, setEncryptedSelection] = useState<EncryptedCaptchaSelection | null>(null);
  const [hasInitialized, setHasInitialized] = useState(false);

  const { fingerprint, scenario = 'default' } = options;

  // 用 ref 持有可变状态，避免把它们放进 useCallback 依赖导致回调随 loading 重建
  const loadingRef = useRef(false);
  const failureCountRef = useRef(0);
  const excludeRef = useRef<CaptchaType[]>([]);

  /**
   * 生成安全的CAPTCHA选择并获取配置
   */
  const generateAndFetchConfig = useCallback(async () => {
    if (!fingerprint) {
      setError('浏览器指纹未提供');
      return;
    }

    // 防止重复请求（用 ref 而非 state，保持回调引用稳定）
    if (loadingRef.current) {
      console.log('请求正在进行中，跳过重复请求');
      return;
    }

    try {
      loadingRef.current = true;
      setLoading(true);
      setError(null);

      // 生成加密的随机选择（后端会忽略选择结果，按上线开关 + 权重 + 场景策略自行决定验证码类型）
      const selection = generateSecureCaptchaSelection(fingerprint, [
        CaptchaType.TURNSTILE,
        CaptchaType.HCAPTCHA,
        CaptchaType.TRYCAP,
      ]);
      setEncryptedSelection(selection);

      // 向后端请求对应的配置
      const response = await fetchWithTimeout(`${getApiBaseUrl()}/api/turnstile/secure-captcha-config`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({
          encryptedData: selection.encryptedData,
          timestamp: selection.timestamp,
          hash: selection.hash,
          fingerprint,
          scenario,
          ...(excludeRef.current.length > 0 ? { exclude: excludeRef.current } : {}),
        })
      });

      if (!response.ok) {
        // 原始状态码与后端原文只进 console；用户侧只看到可行动的中文文案
        const errorData = await response.json().catch(() => null);
        console.error(
          '获取验证方式失败:',
          response.status,
          response.statusText,
          errorData
        );
        const backendMessage =
          typeof errorData?.error === 'string' && errorData.error.trim() ? errorData.error.trim() : '';
        throw new Error(backendMessage || '验证服务暂不可用，请稍后重试');
      }

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || '获取CAPTCHA配置失败');
      }

      setCaptchaConfig({
        captchaType: data.captchaType,
        config: {
          enabled: Boolean(data?.config?.enabled),
          siteKey: typeof data?.config?.siteKey === 'string' ? data.config.siteKey : '',
          apiEndpoint: typeof data?.config?.apiEndpoint === 'string' ? data.config.apiEndpoint : undefined,
        },
        widget: normalizeCaptchaWidgetAppearance(data?.widget),
        scenario,
        strategy: typeof data?.strategy === 'string' ? data.strategy : 'weighted',
        reason: typeof data?.reason === 'string' ? data.reason : '',
        failoverMaxAttempts:
          typeof data?.failoverMaxAttempts === 'number' && data.failoverMaxAttempts > 0
            ? Math.min(3, Math.round(data.failoverMaxAttempts))
            : DEFAULT_FAILOVER_ATTEMPTS,
      });

      console.log('后端CAPTCHA选择成功:', {
        type: data.captchaType,
        enabled: data.config.enabled,
        scenario,
        excluded: excludeRef.current,
        timestamp: new Date(selection.timestamp).toISOString(),
        note: '验证码类型由后端按场景权重与分配策略决定'
      });

      failureCountRef.current = 0;
      setHasInitialized(true);

    } catch (err) {
      console.error('安全CAPTCHA选择失败:', err);
      setError(err instanceof Error && err.message ? err.message : '验证服务暂不可用，请稍后重试');
      setCaptchaConfig(null);
      setEncryptedSelection(null);

      // 失败计数 + 指数退避：消除"失败→loading翻转→回调重建→再触发"的无限重试环。
      // 达到上限后置 hasInitialized=true，初始化 effect 不再重跑，改由用户主动 regenerate。
      failureCountRef.current += 1;
      if (failureCountRef.current >= MAX_INIT_FAILURES) {
        console.warn(`安全CAPTCHA初始化连续失败 ${MAX_INIT_FAILURES} 次，停止自动重试，等待用户手动刷新`);
        setHasInitialized(true);
      } else {
        const backoffMs = INIT_FAILURE_BACKOFF_MS * Math.pow(2, Math.min(failureCountRef.current - 1, 4));
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [fingerprint, scenario]);

  /**
   * 重新生成选择；传 exclude 时把已经加载失败的供应商排除掉（前端侧故障转移）。
   */
  const regenerateSelection = useCallback((regenerateOptions: RegenerateOptions = {}) => {
    if (regenerateOptions.exclude) {
      excludeRef.current = regenerateOptions.exclude;
    }
    failureCountRef.current = 0;
    setCaptchaConfig(null);
    setEncryptedSelection(null);
    setError(null);
    setHasInitialized(false);
    void generateAndFetchConfig();
  }, [generateAndFetchConfig]);

  // 换指纹/换场景即换一轮分配，排除名单随之作废。
  useEffect(() => {
    excludeRef.current = [];
  }, [fingerprint, scenario]);

  /**
   * 检查选择是否过期
   */
  const isSelectionExpired = useCallback(() => {
    if (!encryptedSelection) return true;

    const now = Date.now();
    const timeDiff = now - encryptedSelection.timestamp;
    return timeDiff > 4 * 60 * 1000; // 4分钟后过期（留1分钟缓冲）
  }, [encryptedSelection]);

  /**
   * 初始化时生成选择（只执行一次）
   */
  useEffect(() => {
    if (fingerprint && !hasInitialized && !loading && !captchaConfig) {
      console.log('初始化CAPTCHA配置');
      generateAndFetchConfig();
    }
  }, [fingerprint, hasInitialized, loading, captchaConfig, generateAndFetchConfig]);

  return {
    captchaConfig,
    loading,
    error,
    encryptedSelection,
    regenerateSelection,
    isSelectionExpired,
    // 便利方法
    isTurnstile: captchaConfig?.captchaType === CaptchaType.TURNSTILE,
    isHCaptcha: captchaConfig?.captchaType === CaptchaType.HCAPTCHA,
    isTryCap: captchaConfig?.captchaType === CaptchaType.TRYCAP,
    siteKey: typeof captchaConfig?.config.siteKey === 'string' ? captchaConfig.config.siteKey : '',
    apiEndpoint: captchaConfig?.config.apiEndpoint,
    enabled: captchaConfig?.config.enabled || false,
    /** 管理端下发的外观；尚未拿到配置时用默认值，控件不会因为缺省值而报错。 */
    widget: captchaConfig?.widget ?? DEFAULT_CAPTCHA_WIDGET_APPEARANCE,
    scenario: captchaConfig?.scenario ?? scenario,
    strategy: captchaConfig?.strategy ?? '',
    reason: captchaConfig?.reason ?? '',
    failoverMaxAttempts: captchaConfig?.failoverMaxAttempts ?? DEFAULT_FAILOVER_ATTEMPTS,
    /** 当前已排除（加载失败）的供应商，用于展示「已自动换到下一家」。 */
    excluded: excludeRef.current,
  };
};
