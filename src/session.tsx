import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { DevConfig, MeResponse } from "../shared/schemas";
import { ApiError, api, setCsrfToken } from "./api/client";

interface SessionState {
  loading: boolean;
  me: MeResponse | null;
  /** 개발 모드에서만 존재. 운영에서는 /api/dev/config가 404이므로 null. */
  dev: DevConfig | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

async function fetchMe(): Promise<MeResponse | null> {
  try {
    return await api<MeResponse>("/api/me");
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

async function fetchDev(): Promise<DevConfig | null> {
  try {
    return await api<DevConfig>("/api/dev/config");
  } catch {
    return null;
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [dev, setDev] = useState<DevConfig | null>(null);

  const refresh = useCallback(async () => {
    const next = await fetchMe().catch(() => null);
    setCsrfToken(next?.csrfToken ?? null);
    setMe(next);
  }, []);

  useEffect(() => {
    void Promise.all([refresh(), fetchDev().then(setDev)]).finally(() => setLoading(false));
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await api("/auth/logout", { method: "POST" });
    } finally {
      setCsrfToken(null);
      setMe(null);
    }
  }, []);

  return (
    <SessionContext.Provider value={{ loading, me, dev, refresh, logout }}>{children}</SessionContext.Provider>
  );
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("SessionProvider 밖에서 useSession을 호출했습니다");
  return ctx;
}
