import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  complete: vi.fn(),
  notify: vi.fn(),
  config: { captchaType: 'turnstile' },
}));
vi.mock('../utils/ipVerification', () => ({ completeIpVerification: (...args: unknown[]) => h.complete(...args) }));
vi.mock('../hooks/useReducedMotion', () => ({ useReducedMotion: () => false }));
vi.mock('../components/Notification', () => ({ useNotification: () => ({ setNotification: h.notify }) }));
vi.mock('../components/PenaltyAppealActions', () => ({ PenaltyAppealActions: () => null }));
vi.mock('../hooks/useSecureCaptchaSelection', () => ({
  useSecureCaptchaSelection: () => ({
    captchaConfig: h.config,
    loading: false,
    error: null,
    siteKey: 'site-key',
    enabled: true,
    widget: { theme: 'auto', size: 'normal', language: 'auto' },
    failoverMaxAttempts: 2,
    regenerateSelection: vi.fn(),
  }),
}));
vi.mock('../components/TurnstileWidget', () => ({
  TurnstileWidget: ({ onVerify }: any) => <button type="button" onClick={() => onVerify('solved-token')}>solve challenge</button>,
}));

import { MemoryRouter, Route, Routes } from 'react-router-dom';
import {
  FirstVisitVerification,
  FirstVisitVerificationPage,
} from '../components/FirstVisitVerification';

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('FirstVisitVerification request lifecycle', () => {
  it('does not let the previous fingerprint response complete the new challenge', async () => {
    let resolveOld!: (result: unknown) => void;
    h.complete.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const completed = vi.fn();
    const view = render(<FirstVisitVerification fingerprint="old" onVerificationComplete={completed} />);
    fireEvent.click(await screen.findByRole('button', { name: 'solve challenge' }));
    fireEvent.click(screen.getByRole('button', { name: '继续访问站点' }));
    await waitFor(() => expect(h.complete).toHaveBeenCalledTimes(1));
    view.rerender(<FirstVisitVerification fingerprint="new" onVerificationComplete={completed} />);
    await act(async () => resolveOld({ success: true, verified: true, token: 'old-session' }));
    expect(completed).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '继续访问站点' })).toBeDisabled();
  });

  it('releases the request lock after failure and requires a fresh challenge', async () => {
    h.complete.mockRejectedValueOnce(new Error('Rejected'));
    render(<FirstVisitVerification fingerprint="fp" onVerificationComplete={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'solve challenge' }));
    fireEvent.click(screen.getByRole('button', { name: '继续访问站点' }));
    await waitFor(() => expect(h.notify).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: '继续访问站点' })).toBeDisabled();
    h.complete.mockRejectedValueOnce(new Error('Rejected again'));
    fireEvent.click(screen.getByRole('button', { name: 'solve challenge' }));
    fireEvent.click(screen.getByRole('button', { name: '继续访问站点' }));
    await waitFor(() => expect(h.complete).toHaveBeenCalledTimes(2));
  });
});

describe('FirstVisitVerificationPage（/challenge 独立页）', () => {
  it('验证通过后按 redirectTo 回跳，并先通知 App 把闸门状态置为已验证', async () => {
    h.complete.mockResolvedValueOnce({ success: true, verified: true, token: 'session-token' });
    const completed = vi.fn();
    render(
      <MemoryRouter initialEntries={['/challenge?redirectTo=%2Ftts']}>
        <Routes>
          <Route
            path="/challenge"
            element={<FirstVisitVerificationPage fingerprint="fp" onVerificationComplete={completed} />}
          />
          <Route path="/tts" element={<div>tts target</div>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'solve challenge' }));
    fireEvent.click(screen.getByRole('button', { name: '继续访问站点' }));
    await waitFor(() => expect(completed).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('tts target')).toBeInTheDocument();
  });
});
