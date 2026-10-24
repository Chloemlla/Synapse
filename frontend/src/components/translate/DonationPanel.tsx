import { useEffect, useRef, useState, type FormEvent } from 'react';
import { claimCDictDonation, fetchCDictDonation, fetchCDictDonationImage, type DonationInfo } from '../../api/cdict';
import { studioFieldClassName, studioPanelClassName, studioPrimaryButtonClassName, studioSecondaryButtonClassName } from '../studioTheme';
import { StudioEmptyState, StudioErrorNote, StudioErrorState, StudioLoadingState, StudioSuccessNote } from '../studioFeedback';

function DonationImage({ channel, name }: { channel: string; name: string }) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const request = new AbortController();
    let objectUrl = '';
    setUrl(''); setError(''); setLoading(true);
    void fetchCDictDonationImage(channel, request.signal).then(source => {
      if (request.signal.aborted) return;
      if (source.kind === 'blob') { objectUrl = URL.createObjectURL(source.blob); setUrl(objectUrl); }
      else setUrl(source.url);
    }).catch(() => {
      if (!request.signal.aborted) setError('收款码暂时无法显示，请重试。');
    }).finally(() => { if (!request.signal.aborted) setLoading(false); });
    return () => { request.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [channel, attempt]);
  return <div className="mt-4">
    {loading && <StudioLoadingState text="正在读取收款码…" minHeightClassName="min-h-32" />}
    {error && <StudioErrorState message={error} onRetry={() => setAttempt(value => value + 1)} />}
    {url && !error && <img src={url} referrerPolicy="no-referrer" alt={`${name}收款码`} className="mx-auto max-h-80 max-w-full rounded-2xl object-contain"
      onError={() => setError('收款码暂时无法显示，请重试。')} />}
  </div>;
}

function DonationContent() {
  const [info, setInfo] = useState<DonationInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [channelId, setChannelId] = useState('');
  const [transactionId, setTransactionId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [claimError, setClaimError] = useState('');
  const [claimMessage, setClaimMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const claimController = useRef<AbortController | null>(null);
  useEffect(() => {
    const request = new AbortController();
    setLoading(true); setError(''); setInfo(null);
    void fetchCDictDonation(request.signal).then(value => {
      if (request.signal.aborted) return;
      setInfo(value);
      setChannelId(value?.channels[0]?.id || '');
    }).catch(() => {
      if (!request.signal.aborted) setError('暂时无法读取赞赏信息。');
    }).finally(() => { if (!request.signal.aborted) setLoading(false); });
    return () => request.abort();
  }, [attempt]);
  useEffect(() => () => claimController.current?.abort(), []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (claimController.current) return;
    setClaimError(''); setClaimMessage('');
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(transactionId.trim())) {
      setClaimError('交易号需为 6–64 位字母、数字、连字符或下划线。'); return;
    }
    if (!displayName.trim() || displayName.trim().length > 32) {
      setClaimError('请填写希望展示的称呼，最多 32 个字。'); return;
    }
    const request = new AbortController();
    claimController.current = request; setSubmitting(true);
    try {
      const result = await claimCDictDonation({ transactionId, displayName }, request.signal);
      if (!request.signal.aborted) {
        setClaimMessage(result.duplicated ? '这个交易号已提交，请等待核实。' : result.message);
        setTransactionId(''); setDisplayName('');
      }
    } catch { if (!request.signal.aborted) setClaimError('申请未能提交，请稍后重试。'); }
    finally {
      if (!request.signal.aborted) { claimController.current = null; setSubmitting(false); }
    }
  };
  if (loading) return <StudioLoadingState text="正在读取赞赏信息…" minHeightClassName="min-h-32" />;
  if (error) return <StudioErrorState message={error} onRetry={() => setAttempt(value => value + 1)} />;
  if (!info || !info.channels.length) return <p className="mt-4 text-sm text-slate-500">赞赏当前未开放，不影响翻译与朗读。</p>;
  const channel = info.channels.find(item => item.id === channelId);
  return <div className="mt-4 space-y-5">
    <p className="text-sm leading-7 text-slate-600">{info.notice || '赞赏完全自愿，不解锁任何功能。'}</p>
    <div className="flex flex-wrap gap-2" aria-label="赞赏方式">
      {info.channels.map(item => <button type="button" key={item.id} aria-pressed={item.id === channelId}
        className={studioSecondaryButtonClassName} onClick={() => setChannelId(item.id)}>{item.name}</button>)}
    </div>
    {channel && <div><p className="text-sm text-slate-500">{channel.hint}</p><DonationImage key={channel.id} channel={channel.id} name={channel.name} /></div>}
    <section aria-label="鸣谢名单">
      <h3 className="font-semibold text-slate-900">感谢支持</h3>
      {info.supporters.length ? <ul className="mt-2 flex flex-wrap gap-3 text-sm text-slate-600">
        {info.supporters.map((name, index) => <li key={`${name}:${index}`}>{name}</li>)}
      </ul> : <StudioEmptyState message="鸣谢名单会在核实后更新。" className="mt-3" />}
    </section>
    <form onSubmit={event => void submit(event)} className="space-y-3" aria-label="署名申请">
      <h3 className="font-semibold text-slate-900">申请加入鸣谢名单</h3>
      <p className="text-sm text-slate-500">仅填写交易号与希望公开的称呼，不要填写密码或付款账户信息。</p>
      <label className="block text-sm text-slate-600">交易号
        <input className={studioFieldClassName} value={transactionId} onChange={event => setTransactionId(event.target.value)}
          disabled={submitting} maxLength={64} required autoComplete="off" />
      </label>
      <label className="block text-sm text-slate-600">希望展示的称呼
        <input className={studioFieldClassName} value={displayName} onChange={event => setDisplayName(event.target.value)}
          disabled={submitting} maxLength={32} required autoComplete="off" />
      </label>
      {claimError && <StudioErrorNote>{claimError}</StudioErrorNote>}
      {claimMessage && <StudioSuccessNote>{claimMessage}</StudioSuccessNote>}
      {submitting && <StudioLoadingState text="正在提交申请…" minHeightClassName="min-h-12" />}
      <button type="submit" disabled={submitting} className={studioPrimaryButtonClassName}>提交署名申请</button>
    </form>
  </div>;
}
export function DonationPanel() {
  const [open, setOpen] = useState(false);
  return <section className={studioPanelClassName}>
    <button type="button" className={studioSecondaryButtonClassName} aria-expanded={open} aria-controls="translate-donation"
      onClick={() => setOpen(value => !value)}>{open ? '收起自愿赞赏' : '自愿赞赏与鸣谢'}</button>
    {open && <div id="translate-donation"><DonationContent /></div>}
  </section>;
}
