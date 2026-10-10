import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWebSocket } from '../hooks/useWebSocket';
import { useWsNotifications } from '../hooks/useWsNotifications';
import { useAuthStore } from '../stores/authStore';
import type { User } from '../types/auth';

const mocks = vi.hoisted(() => ({ notify: vi.fn(), broadcast: vi.fn() }));
vi.mock('../api/api', () => ({ getApiBaseUrl: () => 'https://example.com', api: {}, markFingerprintHashProcessed: vi.fn() }));
vi.mock('../utils/fingerprint', () => ({ getFingerprint: vi.fn(), reportFingerprintOnce: vi.fn() }));
vi.mock('../components/Notification', () => ({ useNotification: () => ({ setNotification: mocks.notify }) }));
vi.mock('../components/BroadcastModal', () => ({ useBroadcastModal: () => ({ showBroadcastModal: mocks.broadcast }) }));

class Socket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: Socket[] = [];
  readyState = Socket.CONNECTING;
  onopen: ((event: any) => void) | null = null;
  onclose: ((event: any) => void) | null = null;
  onmessage: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => { this.readyState = Socket.CLOSED; });
  constructor(public url: string) { Socket.instances.push(this); }
  open() { this.readyState = Socket.OPEN; this.onopen?.({}); }
}

describe('WebSocket connection lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    Socket.instances = [];
    vi.stubGlobal('WebSocket', Socket);
    useAuthStore.getState().reset();
  });
  afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('reuses a connecting/open socket for repeated manual connect calls', () => {
    const { result } = renderHook(() => useWebSocket());
    act(() => { result.current.connect(); result.current.connect(); });
    expect(Socket.instances).toHaveLength(1);
    act(() => { Socket.instances[0].open(); result.current.connect(); });
    expect(Socket.instances).toHaveLength(1);
    expect(result.current.connected).toBe(true);
  });

  it('reauthenticates after login and ignores stale close/message callbacks', () => {
    const { result } = renderHook(() => useWsNotifications());
    const anonymous = Socket.instances[0];
    act(() => anonymous.open());
    const staleClose = anonymous.onclose!;
    const staleMessage = anonymous.onmessage!;
    act(() => { useAuthStore.getState().setUser({ id: 'user', role: 'user' } as User); });
    expect(Socket.instances).toHaveLength(2);
    expect(anonymous.close).toHaveBeenCalledOnce();
    const authenticated = Socket.instances[1];
    act(() => authenticated.open());
    act(() => {
      staleClose({});
      staleMessage({ data: JSON.stringify({ type: 'tts:complete' }) });
      vi.advanceTimersByTime(25_000);
    });
    expect(result.current.connected).toBe(true);
    expect(Socket.instances).toHaveLength(2);
    expect(authenticated.send).toHaveBeenCalledOnce();
    expect(anonymous.send).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });
});
