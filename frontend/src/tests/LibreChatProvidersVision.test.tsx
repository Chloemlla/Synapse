import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  notify: vi.fn(),
  confirm: vi.fn(),
  role: 'superadmin',
  providers: [] as Record<string, unknown>[],
}));

vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { role: h.role } }) }));
vi.mock('../components/Notification', () => ({ useNotification: () => ({ setNotification: h.notify }) }));
vi.mock('../components/confirm/ConfirmDialogProvider', () => ({ useConfirm: () => h.confirm }));
vi.mock('../components/env-manager/api', () => ({
  LIBRECHAT_PROVIDERS_API: '/api/librechat/admin/providers',
  getAuthHeaders: () => ({}),
  authFetch: h.fetch,
}));

import SelfContainedLibreChatProvidersSection from '../components/env-manager/SelfContainedLibreChatProvidersSection';

const VISION_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const TEXT_ONLY_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';

/** 后端列表里那条「老文档」刻意不带 vision 字段：读回来必须归一成 false。 */
const VISION_ROW = {
  id: VISION_ID, baseUrl: 'https://vision.example.test', model: 'gpt-4o',
  wire: 'openai-chat', vision: true, group: '', enabled: true, weight: 1, apiKey: 'sk***last',
  updatedAt: '2026-11-26T00:00:00.000Z',
};
const TEXT_ONLY_ROW = {
  id: TEXT_ONLY_ID, baseUrl: 'https://text-only.example.test', model: 'gpt-oss-120b',
  wire: 'openai-chat', group: '', enabled: true, weight: 1, apiKey: 'sk***last',
  updatedAt: '2026-11-26T00:00:00.000Z',
};

function response(data: unknown, ok = true): Response {
  return { ok, json: async () => data } as Response;
}

/** 面板只有 authFetch 一个出口，按 method 分派，省掉每个用例重排 mock 顺序。 */
function routeFetch(_url: string, init?: RequestInit) {
  const method = init?.method ?? 'GET';
  return Promise.resolve(
    response(method === 'GET' ? { success: true, providers: h.providers } : { success: true, id: VISION_ID }),
  );
}

async function openLoaded() {
  fireEvent.click(screen.getByRole('button', { name: /展开/ }));
  await waitFor(() => expect(screen.getByRole('button', { name: /刷新/ })).toBeEnabled());
}

const visionCheckbox = () => screen.getByLabelText(/支持识图/);
const baseUrlField = () => screen.getByPlaceholderText('https://your-openai-compatible.example');
const apiKeyField = () => screen.getByPlaceholderText('re_xxx 或 sk-xxx');
const modelField = () => screen.getByPlaceholderText(/gpt-4o-mini/);

function fillRequiredFields() {
  fireEvent.change(baseUrlField(), { target: { value: 'https://vision.example.test' } });
  fireEvent.change(apiKeyField(), { target: { value: 'sk-abcdef123456' } });
  fireEvent.change(modelField(), { target: { value: 'gpt-4o' } });
}

function lastPostPayload(): Record<string, unknown> {
  const post = [...h.fetch.mock.calls].reverse()
    .find((call) => (call[1] as RequestInit | undefined)?.method === 'POST');
  return JSON.parse(String((post?.[1] as RequestInit)?.body ?? '{}')) as Record<string, unknown>;
}

function methods(): string[] {
  return h.fetch.mock.calls.map((call) => (call[1] as RequestInit | undefined)?.method ?? 'GET');
}

/** 「是/否」在 Enabled 与识图两列都会出现，只能按表头定位，别用全文匹配。 */
function cellOf(baseUrl: string, header: string): string {
  const headers = screen.getAllByRole('columnheader').map((th) => th.textContent?.trim());
  const index = headers.indexOf(header);
  expect(index).toBeGreaterThan(-1);
  const row = screen.getByText(baseUrl).closest('tr');
  return Array.from(row?.querySelectorAll('td') ?? [])[index]?.textContent?.trim() ?? '';
}

function editButtonOf(baseUrl: string): HTMLButtonElement {
  const row = screen.getByText(baseUrl).closest('tr');
  return Array.from(row?.querySelectorAll('button') ?? []).find(
    (button) => button.textContent?.trim() === '编辑',
  ) as HTMLButtonElement;
}

beforeEach(() => {
  h.fetch.mockReset();
  h.notify.mockReset();
  h.confirm.mockReset();
  h.role = 'superadmin';
  h.providers = [VISION_ROW, TEXT_ONLY_ROW];
  h.fetch.mockImplementation(routeFetch);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('LibreChat 提供者的识图能力位', () => {
  it('starts unchecked and still sends vision:false on save, so the flag is never omitted', async () => {
    render(<SelfContainedLibreChatProvidersSection />);
    await openLoaded();
    expect(visionCheckbox()).not.toBeChecked();
    fillRequiredFields();
    fireEvent.click(screen.getByRole('button', { name: '新增' }));
    await waitFor(() => expect(methods()).toContain('POST'));
    expect(lastPostPayload()).toMatchObject({ vision: false, wire: 'openai-chat' });
  });

  it('sends vision:true once the checkbox is ticked', async () => {
    render(<SelfContainedLibreChatProvidersSection />);
    await openLoaded();
    fireEvent.click(visionCheckbox());
    expect(visionCheckbox()).toBeChecked();
    fillRequiredFields();
    fireEvent.click(screen.getByRole('button', { name: '新增' }));
    await waitFor(() => expect(methods()).toContain('POST'));
    expect(lastPostPayload()).toHaveProperty('vision', true);
  });

  it('renders the stored flag in the list and refills the form on edit', async () => {
    render(<SelfContainedLibreChatProvidersSection />);
    await openLoaded();
    await waitFor(() => expect(screen.getByText(TEXT_ONLY_ROW.baseUrl)).toBeInTheDocument());
    expect(cellOf(VISION_ROW.baseUrl, '识图')).toBe('是');
    expect(cellOf(TEXT_ONLY_ROW.baseUrl, '识图')).toBe('否');

    fireEvent.click(editButtonOf(VISION_ROW.baseUrl));
    await waitFor(() => expect(baseUrlField()).toHaveValue(VISION_ROW.baseUrl));
    expect(visionCheckbox()).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '更新' }));
    await waitFor(() => expect(lastPostPayload()).toHaveProperty('id', VISION_ID));
    expect(lastPostPayload()).toMatchObject({ vision: true, model: VISION_ROW.model });

    // 保存后会重拉一次列表，表格短暂换成「加载中...」；等行回来再点下一条的编辑。
    await waitFor(() => expect(screen.getByText(TEXT_ONLY_ROW.baseUrl)).toBeInTheDocument());
    fireEvent.click(editButtonOf(TEXT_ONLY_ROW.baseUrl));
    await waitFor(() => expect(baseUrlField()).toHaveValue(TEXT_ONLY_ROW.baseUrl));
    expect(visionCheckbox()).not.toBeChecked();
  });
});
