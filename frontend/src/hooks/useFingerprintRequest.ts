import { useState, useEffect, useCallback } from 'react';
import { getApiBaseUrl } from '../api/api';
import { useAuthStore } from '../stores/authStore';
import { getAuthRequestGeneration } from '../utils/authRequestGeneration';

const currentIdentityKey = () => {
  const state = useAuthStore.getState();
  return `${state.isAuthenticated ? state.user?.id ?? '' : ''}:${getAuthRequestGeneration()}`;
};


interface FingerprintRequestStatus {
  requireFingerprint: boolean;
  requireFingerprintAt: number;
  fingerprintRequestDismissedOnce: boolean;
  fingerprintRequestDismissedAt: number;
}

export const useFingerprintRequest = () => {
  const [requestStatus, setRequestStatus] = useState<FingerprintRequestStatus>({
    requireFingerprint: false,
    requireFingerprintAt: 0,
    fingerprintRequestDismissedOnce: false,
    fingerprintRequestDismissedAt: 0
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // 订阅真实登录态：未登录不拉取/不轮询管理端接口（G9-06）
  const user = useAuthStore((state) => state.user);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const userId = isAuthenticated ? user?.id : undefined;
  const identityKey = `${userId ?? ''}:${getAuthRequestGeneration()}`;
  const [requestOwnerKey, setRequestOwnerKey] = useState('');

  // 检查用户是否已登录（认证由 HttpOnly Cookie 维护，无法从 JS 读取）
  const isUserLoggedIn = useCallback((): boolean => {
    return Boolean(useAuthStore.getState().isAuthenticated && useAuthStore.getState().user);
  }, []);

  // 获取用户ID用于dismissal tracking
  const getUserId = useCallback((): string => {
    return useAuthStore.getState().user?.id || '';
  }, []);

  // 检查是否在指定时间内被dismiss过
  const isDismissedRecently = useCallback((requireFingerprintAt: number): boolean => {
    const userId = getUserId();
    if (!userId || !requireFingerprintAt) return false;

    const dismissKey = `fp_request_dismissed_${userId}_${requireFingerprintAt}`;
    const dismissedAt = localStorage.getItem(dismissKey);

    if (!dismissedAt) return false;

    const dismissTime = parseInt(dismissedAt);
    const now = Date.now();
    const oneHour = 60 * 60 * 1000; // 1小时冷却时间

    return (now - dismissTime) < oneHour;
  }, [getUserId]);

  // 记录用户永久关闭（一生只能关闭一次）
  const recordDismissOnce = useCallback(async (): Promise<boolean> => {
    const requestedIdentity = currentIdentityKey();
    if (!isUserLoggedIn()) return false;
    try {
      const response = await fetch(`${getApiBaseUrl()}/api/admin/user/fingerprint/dismiss`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest'
        },
        credentials: 'include'
      });

      if (!response.ok) {
        const error = await response.json();
        console.error('记录关闭失败:', error);
        return false;
      }

      const data = await response.json();
      if (requestedIdentity !== currentIdentityKey()) return false;
      console.log(' 已记录用户永久关闭指纹请求:', data);

      // 更新本地状态
      setRequestStatus(prev => ({
        ...prev,
        fingerprintRequestDismissedOnce: true,
        fingerprintRequestDismissedAt: Date.now()
      }));

      return true;
    } catch (err) {
      console.error('记录关闭请求失败:', err);
      return false;
    }
  }, []);

  // 处理用户dismiss操作
  const handleDismiss = useCallback((shouldTrack: boolean = true): void => {
    // 如果不需要tracking（例如用户点击X按钮或背景关闭），直接返回
    if (!shouldTrack) {
      console.log(' 普通关闭，不进行 dismissal tracking');
      return;
    }

    const userId = getUserId();
    if (!userId || !requestStatus.requireFingerprintAt) return;

    console.log(' 用户主动跳过，记录 dismissal tracking（1小时冷却）');
    const dismissKey = `fp_request_dismissed_${userId}_${requestStatus.requireFingerprintAt}`;
    localStorage.setItem(dismissKey, Date.now().toString());

    // 清理旧的dismiss记录（超过24小时的）
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    Object.keys(localStorage).forEach(key => {
      if (key.startsWith('fp_request_dismissed_')) {
        const timestamp = parseInt(localStorage.getItem(key) || '0');
        if (now - timestamp > oneDay) {
          localStorage.removeItem(key);
        }
      }
    });
  }, [getUserId, requestStatus.requireFingerprintAt]);

  // 获取指纹请求状态
  const checkFingerprintRequest = useCallback(async (): Promise<FingerprintRequestStatus> => {
    if (!isUserLoggedIn()) {
      return {
        requireFingerprint: false,
        requireFingerprintAt: 0,
        fingerprintRequestDismissedOnce: false,
        fingerprintRequestDismissedAt: 0
      };
    }

    try {
      const response = await fetch(`${getApiBaseUrl()}/api/admin/user/fingerprint/status`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest'
        },
        credentials: 'include'
      });

      if (!response.ok) {
        throw new Error(`检查状态失败: ${response.status}`);
      }

      const data = await response.json();
      return {
        requireFingerprint: data.requireFingerprint || false,
        requireFingerprintAt: data.requireFingerprintAt || 0,
        fingerprintRequestDismissedOnce: data.fingerprintRequestDismissedOnce || false,
        fingerprintRequestDismissedAt: data.fingerprintRequestDismissedAt || 0
      };
    } catch (err) {
      console.error('检查指纹请求状态失败:', err);
      throw err;
    }
  }, [isUserLoggedIn]);

  // 标记指纹请求为已完成（清除请求标志）
  // 注意：此函数现在不需要调用后端，因为 /api/turnstile/fingerprint/report 已经清除了标志
  const markFingerprintRequestCompleted = useCallback((): void => {
    console.log(' 指纹请求完成，立即更新本地状态');
    // 立即更新本地状态，允许弹窗关闭
    setRequestStatus(prev => ({
      ...prev,
      requireFingerprint: false,
      requireFingerprintAt: 0
    }));
  }, []);

  // 初始化检查
  useEffect(() => {
    let active = true;
    const requestedIdentity = identityKey;
    const initializeCheck = async () => {
      if (!isUserLoggedIn()) {
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        const status = await checkFingerprintRequest();
        if (!active || requestedIdentity !== currentIdentityKey()) return;
        setRequestOwnerKey(requestedIdentity);
        setRequestStatus(status);
      } catch (err) {
        if (active && requestedIdentity === currentIdentityKey()) setError(err instanceof Error ? err.message : '检查失败');
      } finally {
        if (active && requestedIdentity === currentIdentityKey()) setLoading(false);
      }
    };

    initializeCheck();
    return () => { active = false; };
  }, [isUserLoggedIn, checkFingerprintRequest, identityKey]);

  // 定期检查（每30秒）——仅在登录态下轮询，登录后启动、登出即清理（G9-06）
  useEffect(() => {
    if (!userId) {
      return;
    }

    let active = true;

    const interval = setInterval(async () => {
      try {
        const status = await checkFingerprintRequest();
        if (active && identityKey === currentIdentityKey()) {
          setRequestOwnerKey(identityKey);
          setRequestStatus(status);
        }
      } catch (err) {
        console.error('定期检查指纹请求状态失败:', err);
      }
    }, 30000); // 30秒检查一次

    return () => { active = false; clearInterval(interval); };
  }, [userId, identityKey, checkFingerprintRequest]);

  // 每个身份代次从空提示开始；旧账号的请求不能在换号时闪现。
  useEffect(() => {
      setRequestOwnerKey('');
      setRequestStatus({
        requireFingerprint: false,
        requireFingerprintAt: 0,
        fingerprintRequestDismissedOnce: false,
        fingerprintRequestDismissedAt: 0
      });
      setError('');
  }, [identityKey]);

  // 检查是否应该显示请求弹窗
  const shouldShowRequest = Boolean(userId) && requestOwnerKey === identityKey && requestStatus.requireFingerprint &&
                           requestStatus.requireFingerprintAt > 0 &&
                           !loading &&
                           !isDismissedRecently(requestStatus.requireFingerprintAt);

  return {
    requestStatus,
    loading,
    error,
    shouldShowRequest,
    checkFingerprintRequest,
    markFingerprintRequestCompleted,
    handleDismiss,
    recordDismissOnce,
    isUserLoggedIn
  };
};
