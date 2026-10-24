import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ donation: vi.fn(), image: vi.fn(), claim: vi.fn() }));
vi.mock('../../api/cdict', () => ({ fetchCDictDonation: mocks.donation, fetchCDictDonationImage: mocks.image, claimCDictDonation: mocks.claim }));
import { DonationPanel } from './DonationPanel';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.donation.mockResolvedValue({ notice: '完全自愿', channels: [{ id: 'wechat', name: '微信', hint: '扫一扫' }, { id: 'alipay', name: '支付宝', hint: '打开支付宝' }], supporters: ['同学甲'] });
  mocks.image.mockResolvedValue({ kind: 'blob', blob: new Blob(['png'], { type: 'image/png' }) });
  mocks.claim.mockResolvedValue({ duplicated: false, message: '已提交，请等待核实。' });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:donation') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});
afterEach(cleanup);
async function open() {
  const view = render(<DonationPanel />);
  expect(mocks.donation).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '自愿赞赏与鸣谢' }));
  await screen.findByText('完全自愿');
  return view;
}
describe('optional donation interface', () => {
  it('shows live channels and supporters and releases bundled images on switch and close', async () => {
    await open();
    await screen.findByAltText('微信收款码');
    expect(screen.getByText('同学甲')).toBeInTheDocument();
    expect(mocks.image).toHaveBeenCalledWith('wechat', expect.any(AbortSignal));
    fireEvent.click(screen.getByRole('button', { name: '支付宝' }));
    await screen.findByAltText('支付宝收款码');
    expect(mocks.image).toHaveBeenLastCalledWith('alipay', expect.any(AbortSignal));
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '收起自愿赞赏' }));
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });
  it('displays validated remote metadata without forwarding API headers or referrers', async () => {
    mocks.image.mockResolvedValue({ kind: 'remote', url: 'https://images.example.org/receipt.png' });
    await open();
    const image = await screen.findByAltText('微信收款码');
    expect(image).toHaveAttribute('src', 'https://images.example.org/receipt.png');
    expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(image).not.toHaveAttribute('crossorigin');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '收起自愿赞赏' }));
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });
  it('keeps unavailable donation quiet and does not fetch images', async () => {
    mocks.donation.mockResolvedValue(null);
    render(<DonationPanel />);
    fireEvent.click(screen.getByRole('button', { name: '自愿赞赏与鸣谢' }));
    await screen.findByText(/赞赏当前未开放/);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mocks.image).not.toHaveBeenCalled();
  });
  it('validates claims and preserves duplicate acknowledgement without duplicate submits', async () => {
    mocks.claim.mockResolvedValue({ duplicated: true, message: '正在核实' });
    await open();
    fireEvent.change(screen.getByRole('textbox', { name: '交易号' }), { target: { value: 'bad' } });
    fireEvent.change(screen.getByRole('textbox', { name: '希望展示的称呼' }), { target: { value: '同学乙' } });
    fireEvent.submit(screen.getByRole('form', { name: '署名申请' }));
    expect(screen.getByRole('alert')).toHaveTextContent('6–64');
    expect(mocks.claim).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: '交易号' }), { target: { value: '123456' } });
    fireEvent.submit(screen.getByRole('form', { name: '署名申请' }));
    fireEvent.submit(screen.getByRole('form', { name: '署名申请' }));
    await screen.findByText('这个交易号已提交，请等待核实。');
    expect(mocks.claim).toHaveBeenCalledOnce();
    expect(mocks.claim).toHaveBeenCalledWith({ transactionId: '123456', displayName: '同学乙' }, expect.any(AbortSignal));
  });
  it('aborts pending image and claim requests when collapsing and ignores late image bytes', async () => {
    let resolveImage!: (value: { kind: 'blob'; blob: Blob }) => void;
    mocks.image.mockReturnValue(new Promise(done => { resolveImage = done; }));
    mocks.claim.mockReturnValue(new Promise(() => {}));
    await open();
    await waitFor(() => expect(mocks.image).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByRole('textbox', { name: '交易号' }), { target: { value: '123456' } });
    fireEvent.change(screen.getByRole('textbox', { name: '希望展示的称呼' }), { target: { value: '同学乙' } });
    fireEvent.submit(screen.getByRole('form', { name: '署名申请' }));
    const imageSignal = mocks.image.mock.calls[0][1] as AbortSignal;
    const claimSignal = mocks.claim.mock.calls[0][1] as AbortSignal;
    fireEvent.click(screen.getByRole('button', { name: '收起自愿赞赏' }));
    expect(imageSignal.aborted).toBe(true); expect(claimSignal.aborted).toBe(true);
    await act(async () => resolveImage({ kind: 'blob', blob: new Blob(['png'], { type: 'image/png' }) }));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('shows retry for list and image failures instead of disguising them as empty donation', async () => {
    mocks.donation.mockRejectedValueOnce(new Error('offline'));
    render(<DonationPanel />);
    fireEvent.click(screen.getByRole('button', { name: '自愿赞赏与鸣谢' }));
    await screen.findByText('暂时无法读取赞赏信息。');
    mocks.image.mockRejectedValueOnce(new Error('image offline'));
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByText('收款码暂时无法显示，请重试。');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByAltText('微信收款码');
  });
});
