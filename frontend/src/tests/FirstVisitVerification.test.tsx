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

import { FirstVisitVerification } from '../components/FirstVisitVerification';

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
