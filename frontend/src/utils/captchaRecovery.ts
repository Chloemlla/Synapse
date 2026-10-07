type RecoveryListener = (token: string | null) => void;
const listeners = new Set<RecoveryListener>();
const tokenFields = ['captchaToken', 'cfToken', 'turnstileToken', 'hcaptchaToken', 'capToken', 'token'] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : null;
}

function readRequestBody(body: unknown): Record<string, unknown> | null {
    if (typeof body === 'string') {
        try { return asRecord(JSON.parse(body)); } catch { return null; }
    }
    if ((typeof FormData !== 'undefined' && body instanceof FormData) ||
        (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams)) {
        return Object.fromEntries([...tokenFields, 'captchaProvider', 'captchaType'].map(key => [key, body.get(key)]));
    }
    return asRecord(body);
}

export function readCaptchaRequestToken(body: unknown): string | null {
    const record = readRequestBody(body);
    if (!record) return null;
    for (const key of tokenFields) {
        const value = record[key];
        if (typeof value === 'string' && value.trim().length > 0) return value;
    }
    return null;
}

export function subscribeCaptchaRecovery(listener: RecoveryListener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** Report rejection of a challenge without replaying the business request. */
export function notifyCaptchaFailure(responseBody: unknown, requestBody: unknown, status?: number): boolean {
    const body = asRecord(responseBody);
    if (!body || body.success === true || body.verified === true) return false;
    const failed = (typeof status === 'number' && status >= 400) || body.success === false || body.verified === false ||
        (typeof body.error === 'string' && body.error.trim().length > 0);
    if (!failed) return false;

    const request = readRequestBody(requestBody);
    const token = readCaptchaRequestToken(requestBody);
    const hasCaptchaContext = !!request && (
        tokenFields.slice(0, -1).some(key => typeof request[key] === 'string') ||
        typeof request.captchaProvider === 'string' || typeof request.captchaType === 'string'
    );
    const details = asRecord(body.details);
    const codes = [body.code, body.errorCode, body.reason, details?.code, details?.errorCode, details?.reason]
        .filter((value): value is string => typeof value === 'string');
    const explicitCode = codes.some(code => /^(?:TTS_)?CAPTCHA_[A-Z_]+$|^(?:TURNSTILE|HCAPTCHA)_(?:FAILED|REQUIRED|EXPIRED|INVALID|ERROR)$/i.test(code));
    // Generic verification codes also occur in authentication; require a captcha payload.
    const genericCode = hasCaptchaContext && codes.some(code =>
        /^(?:VERIFICATION_FAILED|LOW_SCORE|QUOTA_EXHAUSTED|timeout-or-duplicate|expired-input-response|already-seen-response|invalid-input-response)$/i.test(code));
    const messageMatch = [body.error, body.message, body.errorMessage, details?.errorMessage].some(value =>
        typeof value === 'string' && /人机验证|turnstile|hcaptcha|trycap|captcha/i.test(value) &&
        /失败|过期|失效|无效|重新验证|重试|请先完成|需要完成|fail|expired|invalid|retry|required/i.test(value));
    const rejectedProvider = body.verified === false && typeof body.captchaProvider === 'string';
    if (!explicitCode && !genericCode && !messageMatch && !rejectedProvider) return false;

    for (const listener of [...listeners]) {
        try { listener(token); } catch { /* UI recovery must not change the HTTP response contract. */ }
    }
    return true;
}
