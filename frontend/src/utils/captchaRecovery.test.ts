import { afterEach, describe, expect, it, vi } from 'vitest';
import { notifyCaptchaFailure, readCaptchaRequestToken, subscribeCaptchaRecovery } from './captchaRecovery';
import { fetchWithTimeout } from './fetchWithTimeout';
import { AxiosError, AxiosHeaders, type InternalAxiosRequestConfig } from 'axios';
import { api } from '../api/api';

// Exercise real interceptors with an in-memory adapter; the global axios stub has none.
vi.unmock('axios');
vi.mock('./fingerprint', () => ({ reportFingerprintOnce: vi.fn() }));
vi.mock('./ipVerification', () => ({
    buildIpVerificationHeaders: async () => ({}),
    clearIpVerificationToken: vi.fn(), emitIpVerificationRequired: vi.fn(), isExemptPath: () => false,
}));
vi.mock('./penaltyAppeal', () => ({ maybeEmitPenaltyAppealFromError: vi.fn() }));

afterEach(() => { vi.unstubAllGlobals(); });

describe('captcha recovery notifications', () => {
    it.each([
        { error: '人机验证失败，请重试' },
        { message: 'hCaptcha 验证已过期' },
        { code: 'TTS_CAPTCHA_FAILED' },
        { errorCode: 'CAPTCHA_TOKEN_EXPIRED' },
        { success: false, verified: false, captchaProvider: 'trycap' },
    ])('recognizes a rejected challenge: %j', body => {
        const listener = vi.fn();
        const unsubscribe = subscribeCaptchaRecovery(listener);
        try {
            expect(notifyCaptchaFailure(body, { captchaToken: 'challenge-a' }, 400)).toBe(true);
            expect(listener).toHaveBeenCalledWith('challenge-a');
        } finally { unsubscribe(); }
    });

    it.each([
        { error: '密码错误，请重试' }, { error: '邮箱验证码过期' },
        { error: 'TOTP 验证失败' }, { code: 'VERIFICATION_FAILED' },
        { error: '服务器错误' }, { success: true, message: '人机验证失败后已恢复' },
    ])('ignores unrelated or successful responses: %j', body => {
        expect(notifyCaptchaFailure(body, { token: 'email-token' }, 400)).toBe(false);
    });

    it('recognizes HTTP 200 business failures but ignores ordinary success text', () => {
        expect(notifyCaptchaFailure({ success: false, error: 'Turnstile 验证失败' }, {}, 200)).toBe(true);
        expect(notifyCaptchaFailure({ error: '人机验证失败，请重试' }, {}, 200)).toBe(true);
        expect(notifyCaptchaFailure({ message: '人机验证失败，请重试' }, {}, 200)).toBe(false);
        expect(notifyCaptchaFailure({ reason: 'VERIFICATION_FAILED', success: false }, { captchaToken: 'a' }, 200)).toBe(true);
    });

    it.each(['captchaToken', 'cfToken', 'turnstileToken', 'hcaptchaToken', 'capToken', 'token'])('reads %s across body encodings', key => {
        const form = new FormData();
        form.set(key, 'opaque-token');
        for (const body of [{ [key]: 'opaque-token' }, JSON.stringify({ [key]: 'opaque-token' }), form, new URLSearchParams({ [key]: 'opaque-token' })]) {
            expect(readCaptchaRequestToken(body)).toBe('opaque-token');
        }
    });

    it('uses null without a token, isolates listeners, and unsubscribes', () => {
        const throwing = subscribeCaptchaRecovery(() => { throw new Error('UI failure'); });
        const listener = vi.fn();
        const unsubscribe = subscribeCaptchaRecovery(listener);
        try {
            expect(notifyCaptchaFailure({ error: '人机验证失败，请重试' }, 'broken json', 400)).toBe(true);
            expect(listener).toHaveBeenCalledWith(null);
            unsubscribe();
            notifyCaptchaFailure({ errorCode: 'CAPTCHA_FAILED' }, {}, 400);
            expect(listener).toHaveBeenCalledTimes(1);
        } finally { throwing(); unsubscribe(); }
    });
});

describe('fetch recovery integration', () => {
    it('notifies from a cloned JSON body and preserves the original response', async () => {
        const body = { success: false, error: '人机验证失败，请重试' };
        const response = new Response(JSON.stringify(body), { status: 400, headers: { 'content-type': 'application/json' } });
        const fetchMock = vi.fn().mockResolvedValue(response);
        vi.stubGlobal('fetch', fetchMock);
        const listener = vi.fn();
        const unsubscribe = subscribeCaptchaRecovery(listener);
        try {
            const actual = await fetchWithTimeout('/api/example', { method: 'POST', body: JSON.stringify({ cfToken: 'one-use-token' }) });
            expect(actual).toBe(response);
            expect(actual.bodyUsed).toBe(false);
            expect(await actual.json()).toEqual(body);
            expect(listener).toHaveBeenCalledWith('one-use-token');
            expect(fetchMock).toHaveBeenCalledTimes(1);
        } finally { unsubscribe(); }
    });

    it('does not read streaming responses, even for a captcha-bearing request', async () => {
        const response = new Response('data: streaming', { headers: { 'content-type': 'text/event-stream' } });
        const clone = vi.spyOn(response, 'clone');
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
        expect(await fetchWithTimeout('/api/stream', { body: JSON.stringify({ captchaToken: 'token' }) })).toBe(response);
        expect(clone).not.toHaveBeenCalled();
    });

    it('preserves malformed JSON responses', async () => {
        const response = new Response('not json', { status: 500, headers: { 'content-type': 'application/json' } });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
        expect(await fetchWithTimeout('/api/example')).toBe(response);
        expect(await response.text()).toBe('not json');
    });
});

describe('axios recovery integration', () => {
    it('notifies before a 401 return and prevents replay of a rejected idempotent request', async () => {
        const listener = vi.fn();
        const unsubscribe = subscribeCaptchaRecovery(listener);
        try {
            for (const status of [401, 503]) {
                const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
                    throw new AxiosError('Rejected challenge', 'ERR_BAD_RESPONSE', config, undefined, {
                        config, data: { error: '人机验证失败，请重试' }, status,
                        statusText: 'Rejected', headers: new AxiosHeaders(),
                    });
                });
                await expect(api.put('/api/example', { captchaToken: 'old-token' }, { adapter })).rejects.toBeInstanceOf(AxiosError);
                expect(adapter).toHaveBeenCalledTimes(1);
            }
            expect(listener).toHaveBeenCalledTimes(2);
            expect(listener).toHaveBeenLastCalledWith('old-token');
        } finally { unsubscribe(); }
    });

    it('keeps a HTTP 200 business failure unchanged while notifying', async () => {
        const listener = vi.fn();
        const unsubscribe = subscribeCaptchaRecovery(listener);
        const body = { success: false, code: 'CAPTCHA_FAILED' };
        try {
            const result = await api.post('/api/example', { captchaToken: 'old-token' }, {
                adapter: async config => ({ config, data: body, status: 200, statusText: 'OK', headers: new AxiosHeaders() }),
            });
            expect(result.data).toEqual(body);
            expect(listener).toHaveBeenCalledWith('old-token');
        } finally { unsubscribe(); }
    });
});
