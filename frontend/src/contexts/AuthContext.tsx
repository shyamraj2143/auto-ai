import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { ApiClientError, api } from "../api/client";
import type { User } from "../types";

type AuthContextValue = {
  user: User | null;
  token: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  adminLogin: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);
const TOKEN_STORAGE_KEY = "auto-ai-token";

function readStoredToken() {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch (error) {
    console.warn("[Auto-AI Auth] Unable to read saved session from localStorage.", error);
    return null;
  }
}

function writeStoredToken(token: string) {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch (error) {
    console.warn("[Auto-AI Auth] Login succeeded, but the session could not be saved to localStorage.", error);
  }
}

function removeStoredToken() {
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch (error) {
    console.warn("[Auto-AI Auth] Unable to remove saved session from localStorage.", error);
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(() => readStoredToken());
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    async function loadUser() {
      if (!token) {
        setLoading(false);
        return;
      }
      try {
        const me = await api.me(token);
        if (active) setUser(me);
      } catch (error) {
        console.warn("[Auto-AI Auth] Stored session could not be restored.", error);
        removeStoredToken();
        if (active) {
          setToken(null);
          setUser(null);
        }
      } finally {
        if (active) setLoading(false);
      }
    }
    loadUser();
    return () => {
      active = false;
    };
  }, [token]);

  const persistSession = useCallback((accessToken: string, account: User) => {
    writeStoredToken(accessToken);
    setToken(accessToken);
    setUser(account);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      token,
      loading,
      login: async (email, password) => {
        const session = await api.login({ email: email.trim().toLowerCase(), password });
        persistSession(session.access_token, session.user);
      },
      adminLogin: async (email, password) => {
        const credentials = { email: email.trim().toLowerCase(), password };
        let session: Awaited<ReturnType<typeof api.adminLogin>>;
        try {
          session = await api.adminLogin(credentials);
        } catch (error) {
          if (!(error instanceof ApiClientError) || error.status !== 404) {
            throw error;
          }
          session = await api.login(credentials);
        }
        if (!["admin", "super_admin"].includes(session.user.role)) {
          throw new Error("Only admin accounts can access the admin dashboard.");
        }
        persistSession(session.access_token, session.user);
      },
      register: async (name, email, password) => {
        const session = await api.register({ name: name.trim(), email: email.trim().toLowerCase(), password });
        persistSession(session.access_token, session.user);
      },
      logout: () => {
        removeStoredToken();
        setToken(null);
        setUser(null);
      }
    }),
    [loading, persistSession, token, user]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
