import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type User } from "./client";

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (b: { username: string; password: string; email?: string; invite?: string }) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    // Auth lives in an httpOnly cookie. Always probe /me; if the cookie is
    // missing or invalid, the server returns 401 and we treat it as logged out.
    try {
      const r = await api.me();
      setUser(r.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  const value: AuthState = {
    user,
    loading,
    async login(username, password) {
      const r = await api.login({ username, password });
      setUser(r.user);
    },
    async register(b) {
      const r = await api.register(b);
      setUser(r.user);
    },
    async logout() {
      try { await api.logout(); } catch {}
      setUser(null);
    },
    refresh,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}
