import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
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

import ManagedCaptcha, { type ManagedCaptchaRef, type ManagedCaptchaStatus } from '../components/ManagedCaptcha';
import { notifyCaptchaFailure } from '../utils/captchaRecovery';

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
    // 拿到下发配置即「有结论」：配置说不启用，才是真的不要求验证
    setSelection({ enabled: false, siteKey: '', captchaConfig: { captchaType: 'turnstile' } });

    render(<ManagedCaptcha onStatusChange={(status) => statuses.push(status)} />);

    await waitFor(() => expect(statuses.length).toBeGreaterThan(0));
    expect(statuses.at(-1)).toMatchObject({ required: false, loading: false, provider: null, solved: false });
    expect(screen.queryByTestId('turnstile-widget')).toBeNull();
    expect(screen.queryByTestId('hcaptcha-widget')).toBeNull();
    expect(screen.queryByTestId('trycap-widget')).toBeNull();
  });

  it('服务端结论未到之前不得谎报「不需要验证」：报 loading 而非 required:false', async () => {
    const statuses: ManagedCaptchaStatus[] = [];
    // captchaConfig 为 null 且无错误 = 真实组件在「指纹尚未采集完 / 请求在途」时的状态。
    // 报成 required:false 会让页面以为不必验证而收起区块、放行提交，冻结在错误状态上。
    setSelection({ enabled: false, siteKey: '', captchaConfig: null, loading: false, error: null });

    render(<ManagedCaptcha onStatusChange={(status) => statuses.push(status)} />);

    await waitFor(() => expect(statuses.length).toBeGreaterThan(0));
    expect(statuses.at(-1)).toMatchObject({ required: false, loading: true });
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

  it('成功后保持控件挂载，真实过期时清令牌并准备新验证', async () => {
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

    expect(screen.getByTestId('trycap-widget')).toBeInTheDocument();
    expect(screen.getByTestId('trycap-widget')).not.toBeVisible();
    act(() => lastWidgetProps.trycap?.onExpire?.());

    await waitFor(() => expect(onCleared).toHaveBeenCalledTimes(1));
    expect(h.selection.regenerateSelection).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('人机验证通过')).toBeNull();
    expect(screen.getByTestId('trycap-widget')).toBeVisible();
  });

  it('trycap 未解出时的过期事件按「静默重挂」处理：不清令牌、不弹过期提示', async () => {
    const onCleared = vi.fn();
    setSelection({
      enabled: true,
      siteKey: 'cap-site',
      captchaConfig: { captchaType: 'trycap' },
      apiEndpoint: 'https://cap.example.com',
    });

    render(<ManagedCaptcha onCleared={onCleared} />);

    await screen.findByTestId('trycap-widget');
    // 尚未解出就收到 reset：Cap 控件在重挂/内部重取挑战时就会这样，不能当成「页面令牌失效」。
    lastWidgetProps.trycap?.onExpire?.();

    await waitFor(() => expect(screen.getByTestId('trycap-widget')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onCleared).not.toHaveBeenCalled();
    expect(screen.queryByText('人机验证通过')).toBeNull();
  });

  it('trycap 连续静默重挂超过上限后才提示过期（真卡死时不能无声无息）', async () => {
    const onCleared = vi.fn();
    setSelection({
      enabled: true,
      siteKey: 'cap-site',
      captchaConfig: { captchaType: 'trycap' },
      apiEndpoint: 'https://cap.example.com',
    });

    render(<ManagedCaptcha onCleared={onCleared} />);

    await screen.findByTestId('trycap-widget');
    for (let i = 0; i < 3; i += 1) {
      act(() => lastWidgetProps.trycap?.onExpire?.());
    }

    expect(await screen.findByRole('alert')).toHaveTextContent('验证已过期');
    expect(onCleared).toHaveBeenCalled();
  });

  it.each(['turnstile', 'hcaptcha', 'trycap'])('连续三轮 %s 提交后可重置，旧轮回调不能恢复旧令牌', async (provider) => {
    const ref = React.createRef<ManagedCaptchaRef>();
    const onSolved = vi.fn();
    const onCleared = vi.fn();
    setSelection({ enabled: true, siteKey: 'key', captchaConfig: { captchaType: provider } });
    render(<ManagedCaptcha ref={ref} onSolved={onSolved} onCleared={onCleared} fingerprintOverride="fp" />);
    await screen.findByTestId(`${provider}-widget`);
    for (let index = 0; index < 3; index += 1) {
      const previous = lastWidgetProps[provider];
      act(() => previous.onVerify(`token-${index}`));
      expect(onSolved).toHaveBeenCalledTimes(index + 1);
      act(() => ref.current?.reset());
      act(() => {
        previous.onVerify('stale');
        previous.onExpire();
        previous.onError();
      });
      expect(onSolved).toHaveBeenCalledTimes(index + 1);
      expect(onCleared).toHaveBeenCalledTimes(index + 1);
      expect(screen.getByTestId(`${provider}-widget`)).toBeVisible();
    }
    expect(h.selection.regenerateSelection).toHaveBeenCalledTimes(3);
  });

  it('切换场景清除旧成功状态', async () => {
    setSelection({ enabled: true, siteKey: 'key', captchaConfig: { captchaType: 'turnstile' } });
    const onCleared = vi.fn();
    const { rerender } = render(<ManagedCaptcha fingerprintOverride="fp" onCleared={onCleared} />);
    await screen.findByText('solve-turnstile');
    act(() => lastWidgetProps.turnstile.onVerify('token'));
    rerender(<ManagedCaptcha fingerprintOverride="fp" scenario="standalone" onCleared={onCleared} />);
    expect(onCleared).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('人机验证通过')).toBeNull();
  });

  it('指纹采集失败显示错误，不误报可跳过验证', async () => {
    h.getFingerprint.mockRejectedValueOnce(new Error('unavailable'));
    const statuses: ManagedCaptchaStatus[] = [];
    render(<ManagedCaptcha onStatusChange={(status) => statuses.push(status)} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('无法准备人机验证');
    expect(statuses.at(-1)).toMatchObject({ loading: false, solved: false, error: expect.any(String) });
  });

  it('自动识别后端验证失败，页面再次 reset 不重复请求，新挑战忽略旧响应', async () => {
    setSelection({ enabled: true, siteKey: 'key', captchaConfig: { captchaType: 'turnstile' } });
    const ref = React.createRef<ManagedCaptchaRef>();
    const onCleared = vi.fn();
    render(<ManagedCaptcha ref={ref} onCleared={onCleared} fingerprintOverride="fp" />);
    await screen.findByText('solve-turnstile');
    act(() => lastWidgetProps.turnstile.onVerify('first-token'));
    act(() => {
      notifyCaptchaFailure({ error: '人机验证失败，请重试' }, JSON.stringify({ captchaToken: 'first-token' }), 400);
      ref.current?.reset();
    });
    expect(onCleared).toHaveBeenCalledTimes(1);
    expect(h.selection.regenerateSelection).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('turnstile-widget')).toBeVisible();
    act(() => lastWidgetProps.turnstile.onVerify('second-token'));
    act(() => notifyCaptchaFailure({ error: '人机验证失败，请重试' }, { captchaToken: 'first-token' }, 400));
    expect(onCleared).toHaveBeenCalledTimes(1);
    expect(screen.getByText('人机验证通过')).toBeInTheDocument();
  });

  it('同页多个控件只恢复请求令牌对应的一家，不广播无归属错误', async () => {
    setSelection({ enabled: true, siteKey: 'key', captchaConfig: { captchaType: 'turnstile' } });
    const firstClear = vi.fn();
    const secondClear = vi.fn();
    const first = render(<ManagedCaptcha fingerprintOverride="first" onCleared={firstClear} />);
    await screen.findByText('solve-turnstile');
    act(() => lastWidgetProps.turnstile.onVerify('first-token'));
    render(<ManagedCaptcha fingerprintOverride="second" onCleared={secondClear} />);
    await waitFor(() => expect(screen.getAllByTestId('turnstile-widget')).toHaveLength(2));
    act(() => lastWidgetProps.turnstile.onVerify('second-token'));
    act(() => notifyCaptchaFailure({ error: '人机验证失败，请重试' }, { captchaToken: 'first-token' }, 403));
    expect(firstClear).toHaveBeenCalledTimes(1);
    expect(secondClear).not.toHaveBeenCalled();
    act(() => notifyCaptchaFailure({ error: '人机验证失败，请重试' }, {}, 403));
    expect(secondClear).not.toHaveBeenCalled();
    first.unmount();
  });
});
