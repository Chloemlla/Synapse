import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 回归：ManagedCaptcha 是页面 captchaStatus 的**唯一**写入者，页面绝不能反过来按
 * captchaStatus 决定它的挂载。本页曾经把控件塞进 `captchaStatus.required` 的分支里，
 * 而控件挂载后先回报一次「还没问到」，随即被这次回报卸载 —— 之后无人再能更新 captchaStatus，
 * 页面永远停在首帧的「正在加载验证组件...」，控件再不出现，提交只能撞后端的「缺少人机验证」。
 */
const h = vi.hoisted(() => ({
  statusCallback: null as null | ((status: unknown) => void),
  mounts: 0,
  unmounts: 0,
}));

vi.mock('../components/ManagedCaptcha', async () => {
  const React = await vi.importActual<typeof import('react')>('react');

  const CaptchaStub = ({ onStatusChange }: { onStatusChange?: (status: unknown) => void }) => {
    React.useEffect(() => {
      h.statusCallback = onStatusChange ?? null;
      h.mounts += 1;
      // 与真实组件一致：挂载后立刻回报一次「还没有服务端结论」的状态
      onStatusChange?.({ required: false, loading: true, error: null, provider: null, solved: false });
      return () => {
        h.unmounts += 1;
      };
    }, [onStatusChange]);
    return React.createElement('div', { 'data-testid': 'captcha-stub' });
  };

  return { default: CaptchaStub };
});

import CloudflareChallengePage from '../components/CloudflareChallengePage';

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/challenge']}>
      <CloudflareChallengePage />
    </MemoryRouter>,
  );

beforeEach(() => {
  h.statusCallback = null;
  h.mounts = 0;
  h.unmounts = 0;
});

describe('CloudflareChallengePage：控件不得因自身的状态回报被卸载', () => {
  it('控件首次回报「结论未到」后仍保持挂载，也不谎报「尚未启用」', async () => {
    renderPage();

    await waitFor(() => expect(h.mounts).toBeGreaterThan(0));
    expect(screen.getByTestId('captcha-stub')).toBeInTheDocument();
    expect(h.unmounts).toBe(0);
    expect(screen.queryByText('人机验证尚未启用')).toBeNull();
  });

  it('控件回报「不需要验证」也仍保持挂载（挂载不得由 captchaStatus 决定）', async () => {
    renderPage();
    await waitFor(() => expect(h.mounts).toBeGreaterThan(0));

    act(() => {
      h.statusCallback?.({ required: false, loading: false, error: null, provider: null, solved: false });
    });

    expect(screen.getByTestId('captcha-stub')).toBeInTheDocument();
    expect(h.unmounts).toBe(0);
  });

  it('控件回报「需要验证」后展示验证区，控件依旧在文档里', async () => {
    renderPage();
    await waitFor(() => expect(h.mounts).toBeGreaterThan(0));

    act(() => {
      h.statusCallback?.({ required: true, loading: false, error: null, provider: 'turnstile', solved: false });
    });

    expect(screen.getByTestId('captcha-stub')).toBeInTheDocument();
    expect(h.unmounts).toBe(0);
    expect(screen.queryByText('人机验证尚未启用')).toBeNull();
  });
});
