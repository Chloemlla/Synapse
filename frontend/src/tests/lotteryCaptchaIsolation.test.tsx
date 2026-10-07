import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LotteryRound } from '../types/lottery';

vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'user' } }) }));
vi.mock('../hooks/useLottery', () => ({ useLottery: vi.fn() }));
vi.mock('../api', () => ({ default: () => 'https://synapse.example', getApiBaseUrl: () => 'https://synapse.example' }));
vi.mock('../components/Notification', () => ({ useNotification: () => ({ setNotification: vi.fn() }) }));
vi.mock('../components/ManagedCaptcha', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return { default: React.forwardRef<any, any>((props, ref) => {
    const [solved, setSolved] = React.useState(false);
    React.useImperativeHandle(ref, () => ({ reset: () => { setSolved(false); props.onCleared(); } }));
    React.useEffect(() => {
      props.onStatusChange({ required: true, loading: false, error: null, provider: 'turnstile', solved: false });
    }, [props.onStatusChange]);
    return <button type="button" onClick={() => { setSolved(true); props.onSolved({ token: 'token', provider: 'turnstile' }); }}>{solved ? 'solved' : 'solve'}</button>;
  }) };
});

import { LotteryRoundCard } from '../components/LotteryPage';

afterEach(() => cleanup());

function round(id: string): LotteryRound {
  return {
    id, name: id, description: '', participants: [], winners: [], prizes: [],
    isActive: true, startTime: Date.now() - 1000, endTime: Date.now() + 60000,
    blockchainHeight: 1, seed: `seed-${id}`,
  };
}

describe('lottery card challenge isolation', () => {
  it('only enables the solved card and resets only the card that sent its token', async () => {
    const participate = vi.fn(async () => true);
    render(<><section data-testid="first"><LotteryRoundCard round={round('first')} loading={false} onParticipate={participate} /></section><section data-testid="second"><LotteryRoundCard round={round('second')} loading={false} onParticipate={participate} /></section></>);
    const first = within(screen.getByTestId('first'));
    const second = within(screen.getByTestId('second'));
    fireEvent.click(first.getByRole('button', { name: 'solve' }));
    expect(first.getByRole('button', { name: '立即参与' })).toBeEnabled();
    expect(second.getByRole('button', { name: '立即参与' })).toBeDisabled();
    fireEvent.click(second.getByRole('button', { name: 'solve' }));
    fireEvent.click(first.getByRole('button', { name: '立即参与' }));
    await waitFor(() => expect(first.getByRole('button', { name: '立即参与' })).toBeDisabled());
    expect(second.getByRole('button', { name: '立即参与' })).toBeEnabled();
    expect(second.getByRole('button', { name: 'solved' })).toBeInTheDocument();
    expect(participate).toHaveBeenCalledWith('first', { token: 'token', provider: 'turnstile' });
  });

  it('keeps an unused token when the parent rejects a concurrent participation', async () => {
    const participate = vi.fn(async () => false);
    render(<LotteryRoundCard round={round('round')} loading={false} onParticipate={participate} />);
    fireEvent.click(screen.getByRole('button', { name: 'solve' }));
    fireEvent.click(screen.getByRole('button', { name: '立即参与' }));
    await waitFor(() => expect(participate).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'solved' })).toBeInTheDocument();
  });
});
