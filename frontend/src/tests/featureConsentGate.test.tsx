// FeatureConsentGate 的行为测试：未同意 → 同意清单；已同意 → 直接放行；
// 勾选并记录成功后放行；记录失败要把可读原因显出来。
//
// 网络层整体 mock（frontend/vitest.setup.ts 已把 axios 换成替身），本机不真发请求。

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureConsentView } from '../api/policy';

const policyApi = vi.hoisted(() => ({
  fetchFeatureConsent: vi.fn(),
  recordPolicyConsent: vi.fn(),
}));

vi.mock('../api/policy', () => policyApi);

// 勾选清单会去读条文摘要（hooks/usePolicyDocument 走网络）：换成空实现，
// 让断言只看门禁本身，也避免用例里多打一次条文请求。
vi.mock('../hooks/usePolicyDocument', () => ({
  usePolicyDocument: () => ({ document: null, loading: false, error: null, reload: vi.fn() }),
}));

import FeatureConsentGate from '../components/FeatureConsentGate';

const view = (overrides: Partial<FeatureConsentView> = {}): FeatureConsentView => ({
  key: 'doc-tool',
  label: '文档转换（Markdown → Word）',
  message: '上传到服务端处理前，需要先同意使用政策与服务专项条款。',
  satisfied: false,
  requiredAgreements: ['usage', 'specific-terms'],
  missingAgreements: ['usage', 'specific-terms'],
  policyVersion: '2.2',
  expiresAt: null,
  ...overrides,
});

const satisfiedView = () => view({ satisfied: true, missingAgreements: [] });

const renderGate = () =>
  render(
    <MemoryRouter>
      <FeatureConsentGate feature="doc-tool">
        <div data-testid="doc-panel">文档转换面板</div>
      </FeatureConsentGate>
    </MemoryRouter>,
  );

beforeEach(() => {
  policyApi.fetchFeatureConsent.mockReset();
  policyApi.recordPolicyConsent.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FeatureConsentGate', () => {
  it('未同意时渲染同意清单，不渲染功能面板', async () => {
    policyApi.fetchFeatureConsent.mockResolvedValue({ policyVersion: '2.2', features: [view()] });

    renderGate();

    expect(await screen.findByText(/需要先同意相关条款/)).toBeInTheDocument();
    expect(screen.getByLabelText('我已阅读并同意使用政策')).toBeInTheDocument();
    expect(screen.queryByTestId('doc-panel')).toBeNull();
  });

  it('已同意时直接渲染 children，且只请求一次清单', async () => {
    policyApi.fetchFeatureConsent.mockResolvedValue({ policyVersion: '2.2', features: [satisfiedView()] });

    renderGate();

    expect(await screen.findByTestId('doc-panel')).toBeInTheDocument();
    expect(policyApi.fetchFeatureConsent).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('我已阅读并同意使用政策')).toBeNull();
  });

  it('勾选并提交成功后记录同意并放行 children', async () => {
    policyApi.fetchFeatureConsent
      .mockResolvedValueOnce({ policyVersion: '2.2', features: [view()] })
      .mockResolvedValueOnce({ policyVersion: '2.2', features: [satisfiedView()] });
    policyApi.recordPolicyConsent.mockResolvedValue({
      consentId: 'consent-1',
      version: '2.2',
      expiresAt: '2026-11-09T00:00:00.000Z',
    });

    renderGate();

    await screen.findByText(/需要先同意相关条款/);
    fireEvent.click(screen.getByRole('button', { name: '全部勾选' }));
    fireEvent.click(screen.getByRole('button', { name: '同意并继续' }));

    await waitFor(() => expect(policyApi.recordPolicyConsent).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('doc-panel')).toBeInTheDocument();
    expect(policyApi.fetchFeatureConsent).toHaveBeenCalledTimes(2);
  });

  it('记录同意失败时展示可读原因，仍不放行 children', async () => {
    policyApi.fetchFeatureConsent.mockResolvedValue({ policyVersion: '2.2', features: [view()] });
    policyApi.recordPolicyConsent.mockRejectedValue({ response: { data: { error: '服务端拒绝了这次同意记录' } } });

    renderGate();

    await screen.findByText(/需要先同意相关条款/);
    fireEvent.click(screen.getByRole('button', { name: '全部勾选' }));
    fireEvent.click(screen.getByRole('button', { name: '同意并继续' }));

    expect(await screen.findByText('服务端拒绝了这次同意记录')).toBeInTheDocument();
    expect(screen.queryByTestId('doc-panel')).toBeNull();
  });
});
