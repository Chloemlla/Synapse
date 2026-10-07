import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { RegisterPage } from '../components/RegisterPage';

const { notify } = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('../components/Notification', () => ({ useNotification: () => ({ setNotification: notify }) }));
vi.mock('../components/GoogleAuthButton', () => ({ default: () => null }));
vi.mock('../components/LinuxDoAuthButton', () => ({ default: () => null }));
vi.mock('../components/ManagedCaptcha', () => ({ default: () => null }));
vi.mock('../components/PolicyConsentChecklist', () => ({ default: () => null }));
vi.mock('../api/api', () => ({ api: { post: vi.fn() } }));
vi.mock('../utils/fingerprint', () => ({ getFingerprint: vi.fn(), getClientIP: vi.fn() }));

describe('registration input recovery', () => {
  it('accepts unfinished username input without crashing password strength feedback', () => {
    render(<MemoryRouter><RegisterPage /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('邮箱地址'), { target: { value: 'user@gmail.com' } });
    fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'SafeCredential92!' } });
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: '[' } });
    expect(screen.getByRole('form', { name: '注册表单' })).toBeInTheDocument();
    expect(screen.getByText(/密码强度/)).toBeInTheDocument();
  });
});
