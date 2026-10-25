import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../api', () => ({ default: () => 'https://backend.example' }));
vi.mock('../config/buildInfo', () => ({ buildInfo: { frontendVersion: '26.10.25', backendVersion: '26.10.25', shortSha: 'abc1234' } }));
let backend: { version: string; shortSha: string };
let statusFailed: boolean;
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetModules(); sessionStorage.clear();
  backend = { version: '26.10.25', shortSha: 'fed4321' }; statusFailed = false;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  fetcher = vi.fn(async (url: string) => url.endsWith('/api/status')
    ? new Response(JSON.stringify(backend), { status: statusFailed ? 503 : 200, headers: { 'Content-Type': 'application/json' } })
    : new Response(JSON.stringify({ ip: '203.0.113.1' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const statusCalls = () => fetcher.mock.calls.filter(([url]) => String(url).endsWith('/api/status'));
async function mount() {
  const Footer = (await import('./Footer')).default;
  return render(<Footer />);
}
it('ignores previous-page session cache and revalidates actual backend version', async () => {
  sessionStorage.setItem('synapse.footer.backendBuild', JSON.stringify({ expiresAt: Date.now() + 60000,
    data: { version: '26.10.17', shortSha: '1111111' } }));
  await mount();
  expect(await screen.findByText('后端 v26.10.25 (fed4321)')).toBeInTheDocument();
  expect(screen.getByText('前端 v26.10.25 (abc1234)')).toBeInTheDocument();
  expect(statusCalls()).toEqual([['https://backend.example/api/status', { headers: { Accept: 'application/json' }, cache: 'no-cache' }]]);
});
it('keeps same-document remount caching without duplicate version requests', async () => {
  const first = await mount(); await screen.findByText('后端 v26.10.25 (fed4321)'); first.unmount();
  await mount(); await screen.findByText('后端 v26.10.25 (fed4321)');
  expect(statusCalls()).toHaveLength(1);
});
it('fetches a new backend after reload without masking it with frontend SHA', async () => {
  const first = await mount(); await screen.findByText('后端 v26.10.25 (fed4321)'); first.unmount();
  backend = { version: '26.10.26', shortSha: 'aaaaaaa' }; vi.resetModules();
  await mount();
  expect(await screen.findByText('后端 v26.10.26 (aaaaaaa)')).toBeInTheDocument();
  expect(screen.getByText('前端 v26.10.25 (abc1234)')).toBeInTheDocument();
  expect(statusCalls()).toHaveLength(2);
});
it('retains injected fallback only when runtime lookup fails', async () => {
  statusFailed = true; await mount();
  await waitFor(() => expect(console.warn).toHaveBeenCalled());
  expect(screen.getByText('后端 v26.10.25 (abc1234)')).toBeInTheDocument();
  expect(statusCalls()).toHaveLength(1);
});
