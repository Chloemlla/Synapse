import { create } from "zustand";
import getApiBaseUrl from "../api";
import { fetchWithTimeout } from '../utils/fetchWithTimeout';

interface GoogleAuthConfig {
  enabled: boolean;
  clientId: string;
}

interface LinuxDoAuthConfig {
  enabled: boolean;
}

interface AuthProviderState {
  google: GoogleAuthConfig;
  linuxdo: LinuxDoAuthConfig;
  /** true until the initial fetch settles */
  loading: boolean;
  /** true if the initial fetch completed (even on error) */
  initialized: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

interface AuthProvidersPublicConfigResponse {
  google: {
    enabled: boolean;
    clientIdConfigured: boolean;
    clientId: string;
  };
  linuxdo: {
    enabled: boolean;
    clientIdConfigured: boolean;
    callbackUrl: string;
    discoveryUrl: string;
    scopes: string[];
  };
}

export const useAuthProviderStore = create<AuthProviderState>()((set) => {
  let inflight: Promise<void> | null = null;
  let attempts = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  // Fire pre-fetch immediately on store creation (app startup)
  const load = async (): Promise<void> => {
    set({ loading: true, error: null });
    try {
      const res = await fetchWithTimeout(`${getApiBaseUrl()}/api/auth/providers/public-config`, { credentials: 'include' }, 5000);
      if (!res.ok) throw new Error('登录方式暂时无法加载');
      const data = (await res.json().catch(() => null)) as AuthProvidersPublicConfigResponse | null;

      if (data?.google && data?.linuxdo) {
        attempts = 0;
        set({
          google: {
            enabled: Boolean(data.google.enabled && data.google.clientId),
            clientId: data.google.clientId || "",
          },
          linuxdo: {
            enabled: Boolean(data.linuxdo.enabled),
          },
          loading: false,
          initialized: true,
          error: null,
        });
      } else {
        throw new Error('登录方式暂时无法加载');
      }
    } catch {
      set({ loading: false, initialized: true, error: '登录方式暂时无法加载' });
      attempts += 1;
      if (attempts < 3) retryTimer = setTimeout(() => { void refresh(false); }, 2000 * 2 ** (attempts - 1));
    }
  };

  const refresh = (manual = true): Promise<void> => {
    if (inflight) return inflight;
    if (retryTimer) clearTimeout(retryTimer);
    if (manual) attempts = 0;
    inflight = load().finally(() => { inflight = null; });
    return inflight;
  };

  // Fire and forget — don't block render
  void Promise.resolve().then(() => refresh());

  return {
    google: { enabled: false, clientId: "" },
    linuxdo: { enabled: false },
    loading: true,
    initialized: false,
    error: null,
    refresh: () => refresh(),
  };
});
