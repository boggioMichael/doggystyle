import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, api } from './api';
import type { AppConfig, ViewerDto } from './types';

export interface SignupFields {
  email: string;
  password: string;
  displayName?: string;
  city?: string;
  ageConfirmed: true;
  acceptTerms: true;
}

interface AuthValue {
  viewer: ViewerDto | null;
  config: AppConfig | null;
  loading: boolean;
  refresh: () => Promise<void>;
  signup: (fields: SignupFields) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  magicRequest: (email: string) => Promise<{ devLink?: string }>;
  magicConsume: (token: string) => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [viewer, setViewer] = useState<ViewerDto | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);

  const loadViewer = useCallback(async () => {
    try {
      setViewer(await api.get<ViewerDto>('/me'));
    } catch (err) {
      // 401 simply means "signed out" — not an error worth surfacing.
      if (err instanceof ApiError && err.status === 401) setViewer(null);
      else throw err;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [cfg] = await Promise.allSettled([api.get<AppConfig>('/config'), loadViewer()]);
      if (cancelled) return;
      if (cfg.status === 'fulfilled') setConfig(cfg.value);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadViewer]);

  const value = useMemo<AuthValue>(
    () => ({
      viewer,
      config,
      loading,
      refresh: loadViewer,
      async signup(fields) {
        const res = await api.post<{ viewer: ViewerDto }>('/auth/signup', fields);
        setViewer(res.viewer);
      },
      async login(email, password) {
        const res = await api.post<{ viewer: ViewerDto }>('/auth/login', { email, password });
        setViewer(res.viewer);
      },
      async logout() {
        await api.post('/auth/logout');
        setViewer(null);
      },
      async magicRequest(email) {
        return api.post<{ sent: true; devLink?: string }>('/auth/magic-link', { email });
      },
      async magicConsume(token) {
        const res = await api.post<{ viewer: ViewerDto }>('/auth/magic-link/consume', { token });
        setViewer(res.viewer);
      },
    }),
    [viewer, config, loading, loadViewer],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
