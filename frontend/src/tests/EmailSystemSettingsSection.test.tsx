import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import EmailSystemSettingsSection from '../components/env-manager/EmailSystemSettingsSection';

const config = {
  enabled: true,
  resendDomain: 'example.com',
  resendApiKey: 're_a****xyz',
  quotaTotal: 100,
  outemailEnabled: true,
  outemailDomain: 'example.com',
  outemailApiKey: 're_b****xyz',
  outemailCode: 'abcd****wxyz',
  outemailQuotaTotal: 200,
};

function props() {
  return {
    isOpen: true, onToggle: vi.fn(), loading: false, saving: false, deleting: false,
    config, onRefresh: vi.fn(), onSave: vi.fn(), onDelete: vi.fn(),
  };
}

describe('EmailSystemSettingsSection', () => {
  it('never resubmits masked secrets when only the quota changes', () => {
    const input = props();
    render(<EmailSystemSettingsSection {...input} />);
    fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '321' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(input.onSave).toHaveBeenCalledWith(expect.objectContaining({ quotaTotal: 321 }));
    const payload = input.onSave.mock.calls[0][0];
    expect(payload).not.toHaveProperty('resendApiKey');
    expect(payload).not.toHaveProperty('outemailApiKey');
    expect(payload).not.toHaveProperty('outemailCode');
  });

  it('sends only the newly entered secret and clears it after refresh', () => {
    const input = props();
    const { rerender } = render(<EmailSystemSettingsSection {...input} />);
    const field = screen.getByPlaceholderText(/已配置 re_a/);
    expect(field).toHaveValue('');
    fireEvent.change(field, { target: { value: 're_new_secret_123' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(input.onSave.mock.calls[0][0]).toMatchObject({ resendApiKey: 're_new_secret_123' });
    expect(input.onSave.mock.calls[0][0]).not.toHaveProperty('outemailApiKey');
    rerender(<EmailSystemSettingsSection {...input} config={{ ...config, quotaTotal: 321 }} />);
    expect(field).toHaveValue('');
  });

  it('blocks competing edits and reset while saving', () => {
    const input = props();
    render(<EmailSystemSettingsSection {...input} saving />);
    expect(screen.getAllByRole('spinbutton')[0]).toBeDisabled();
    expect(screen.getByRole('button', { name: /刷新/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /重置/ })).toBeDisabled();
  });
});
