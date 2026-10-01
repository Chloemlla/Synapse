import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  selection: {
    captchaConfig: null as any,
    loading: false,
    error: null as string | null,
    encryptedSelection: null as any,
    regenerateSelection: vi.fn(),
    isSelectionExpired: vi.fn(() => false),
    isTurnstile: false,
    isHCaptcha: false,
    isTryCap: false,
    siteKey: '' as string,
    apiEndpoint: undefined as string | undefined,
    enabled: false,
    widget: { theme: 'auto' as const, size: 'normal' as const, language: 'auto', showProviderLabel: true },
    scenario: 'default',
    strategy: 'weighted',
    reason: '',
    failoverMaxAttempts: 2,
    excluded: [] as string[],
  },
  getFingerprint: vi.fn(async () => 'fp-1'),
}));

vi.mock('../hooks/useSecureCaptchaSelection', () => ({
  useSecureCaptchaSelection: () => h.selection,
}));

vi.mock('../utils/fingerprint', () => ({
  getFingerprint: () => h.getFingerprint(),
}));

/** 三家控件的替身：暴露按钮触发 onVerify / onError / onExpire，验证组件的回调契约。 */
// 控件被卸载后 React 仍可能从外部派发事件（Cap 的 disconnectedCallback 就会自己 reset 一次），
// 所以这里把最后一次收到的 props 记下来，便于在替身卸载后手动触发一次「过期噪音」。
const lastWidgetProps: Record<string, any> = {};

function fakeWidget(name: string) {
  return {
    default: (props: any) => {
      lastWidgetProps[name] = props;
      return (
        <div data-testid={`${name}-widget`}>
          <button type="button" onClick={() => props.onVerify(`tok-${name}`)}>
            solve-{name}
          </button>
          <button type="button" onClick={() => props.onError?.(new Error('boom'))}>
            fail-{name}
          </button>
          <button type="button" onClick={() => props.onExpire?.()}>
            expire-{name}
          </button>
        </div>
      );
    },
  };
}

vi.mock('../components/TurnstileWidget', () => ({ TurnstileWidget: fakeWidget('turnstile').default }));
vi.mock('../components/HCaptchaWidget', () => fakeWidget('hcaptcha'));
vi.mock('../components/CapWidget', () => fakeWidget('trycap'));

import ManagedCaptcha, { type ManagedCaptchaStatus } from '../components/ManagedCaptcha';

function setSelection(overrides: Partial<typeof h.selection>) {
  h.selection = {
    ...h.selection,
    captchaConfig: null,
    loading: false,
    error: null,
    regenerateSelection: vi.fn(),
    siteKey: '',
    enabled: false,
    failoverMaxAttempts: 2,
    widget: { theme: 'auto', size: 'normal', language: 'auto', showProviderLabel: true },
    ...overrides,
  } as typeof h.selection;
}

beforeEach(() => {
  vi.clearAllMocks();
  setSelection({});
});

describe('ManagedCaptcha：后台页面共用的三家供应商下发链路', () => {
  it('三家都没可用供应商时不要求验证，也不渲染任何控件', async () => {
    const statuses: ManagedCaptchaStatus[] = [];
    setSelection({ enabled: false, siteKey: '', captchaConfig: null });

    render(<ManagedCaptcha onStatusChange={(status) => statuses.push(status)} />);

    await waitFor(() => expect(statuses.length).toBeGreaterThan(0));
    expect(statuses.at(-1)).toMatchObject({ required: false, provider: null, solved: false });
    expect(screen.queryByTestId('turnstile-widget')).toBeNull();
    expect(screen.queryByTestId('hcaptcha-widget')).toBeNull();
    expect(screen.queryByTestId('trycap-widget')).toBeNull();
  });

  it('后端选中 Turnstile 时渲染 Turnstile 控件，并把 token + provider 交给页面', async () => {
    const onSolved = vi.fn();
    setSelection({ enabled: true, siteKey: '0xsite', captchaConfig: { captchaType: 'turnstile' } });

    render(<ManagedCaptcha onSolved={onSolved} />);

    const button = await screen.findByText('solve-turnstile');
    button.click();

    await waitFor(() =>
      expect(onSolved).toHaveBeenCalledWith({ token: 'tok-turnstile', provider: 'turnstile' }),
    );
    expect(screen.getByText('人机验证通过')).toBeInTheDocument();
  });

  it('后端选中 hCaptcha / trycap 时各自渲染对应控件（不再写死 Turnstile）', async () => {
    const onSolved = vi.fn();
    setSelection({ enabled: true, siteKey: 'hc-site', captchaConfig: { captchaType: 'hcaptcha' } });

    const { unmount } = render(<ManagedCaptcha onSolved={onSolved} />);
    (await screen.findByText('solve-hcaptcha')).click();
    await waitFor(() => expect(onSolved).toHaveBeenCalledWith({ token: 'tok-hcaptcha', provider: 'hcaptcha' }));
    unmount();

    onSolved.mockClear();
    setSelection({
      enabled: true,
      siteKey: '0123456789',
      captchaConfig: { captchaType: 'trycap' },
      apiEndpoint: 'https://cap.example.com',
    });
    render(<ManagedCaptcha onSolved={onSolved} />);
    (await screen.findByText('solve-trycap')).click();
    await waitFor(() => expect(onSolved).toHaveBeenCalledWith({ token: 'tok-trycap', provider: 'trycap' }));
  });

  it('控件加载失败时排除这一家并按管理端上限换下一家', async () => {
    const onCleared = vi.fn();
    const regenerate = vi.fn();
    setSelection({
      enabled: true,
      siteKey: '0xsite',
      captchaConfig: { captchaType: 'turnstile' },
      regenerateSelection: regenerate,
      failoverMaxAttempts: 2,
    });

    render(<ManagedCaptcha onCleared={onCleared} />);

    (await screen.findByText('fail-turnstile')).click();

    await waitFor(() =>
      expect(regenerate).toHaveBeenCalledWith({ exclude: ['turnstile'] }),
    );
    expect(onCleared).toHaveBeenCalled();
  });

  it('挑战过期时清掉页面持有的令牌并提示重新完成', async () => {    const onCleared = vi.fn();
    setSelection({ enabled: true, siteKey: '0xsite', captchaConfig: { captchaType: 'turnstile' } });

    render(<ManagedCaptcha onCleared={onCleared} />);

    (await screen.findByText('expire-turnstile')).click();

    await waitFor(() => expect(onCleared).toHaveBeenCalled());
    expect(await screen.findByRole('alert')).toHaveTextContent('验证已过期');
  });

  it('控制台/诊断可注入固定指纹，不再采集浏览器指纹', async () => {
    setSelection({ enabled: true, siteKey: '0xsite', captchaConfig: { captchaType: 'turnstile' } });

    render(<ManagedCaptcha fingerprintOverride="fixed-fp" />);

    await screen.findByTestId('turnstile-widget');
    expect(h.getFingerprint).not.toHaveBeenCalled();
  });

  it('解出后再收到一次「过期」（Cap 卸载时自派发的 reset）不得回滚已验证结果', async () => {
    const onSolved = vi.fn();
    const onCleared = vi.fn();
    setSelection({
      enabled: true,
      siteKey: 'cap-site',
      captchaConfig: { captchaType: 'trycap' },
      apiEndpoint: 'https://cap.example.com',
    });

    render(<ManagedCaptcha onSolved={onSolved} onCleared={onCleared} />);

    (await screen.findByText('solve-trycap')).click();
    await waitFor(() =>
      expect(onSolved).toHaveBeenCalledWith({ token: 'tok-trycap', provider: 'trycap' }),
    );
    expect(await screen.findByText('人机验证通过')).toBeInTheDocument();

    // 控件此时已被卸载（面板改渲染「人机验证通过」），而 Cap 在断开连接时会自己 reset 一次
    // 并派发 reset；这一声噪声不得把刚拿到的令牌与通过状态抹掉成「验证已过期」。
    lastWidgetProps.trycap?.onExpire?.();

    await waitFor(() => expect(screen.getByText('人机验证通过')).toBeInTheDocument());
    expect(onCleared).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('solve-trycap')).toBeNull();
  });
});
