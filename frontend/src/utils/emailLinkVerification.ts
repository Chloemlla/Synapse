import { api } from '../api/api';
import { getFingerprint } from './fingerprint';

interface EmailVerificationResult {
  success?: boolean;
  message?: string;
  error?: string;
}

// 同一链接的多个挂载共享正在执行的请求，避免 StrictMode 重放消费两次。
// 只保存在途请求，不将验证令牌或结果写入持久存储。
const pendingVerifications = new Map<string, Promise<EmailVerificationResult>>();

export function verifyEmailLinkOnce(token: string): Promise<EmailVerificationResult> {
  const pending = pendingVerifications.get(token);
  if (pending) return pending;

  const request = (async () => {
    const fingerprint = await getFingerprint();
    if (!fingerprint) throw new Error('无法获取设备信息，请刷新页面重试');
    const response = await api.post<EmailVerificationResult>('/api/auth/verify-email-link', { token, fingerprint });
    return response.data;
  })();
  pendingVerifications.set(token, request);
  const clear = () => { pendingVerifications.delete(token); };
  void request.then(clear, clear);
  return request;
}
