import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, type AuthSession } from "../api/client";
import { nativeGoogleAuth, readStoredSession, removeStoredSession, writeStoredSession } from "../auth/sessionStorage";
import { callApi } from "../features/calls/services/callApi";
import { callNative } from "../features/calls/services/callNative";
import type { User } from "../types";

type AuthContextValue = {
  user: User | null;
  token: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  googleLogin: (idToken: string) => Promise<void>;
  adminLogin: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  updateUser: (user: User) => void;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const persistSession = useCallback(async (session: AuthSession) => {
    await writeStoredSession(session.access_token, session.refresh_token);
    setToken(session.access_token);
    setRefreshToken(session.refresh_token ?? null);
    setUser(session.user);
  }, []);

  useEffect(() => {
    let active = true;

    async function restoreSession() {
      try {
        const stored = await readStoredSession();
        if (stored.accessToken) {
          try {
            const account = await api.me(stored.accessToken);
            if (active) {
              setToken(stored.accessToken);
              setRefreshToken(stored.refreshToken);
              setUser(account);
            }
            return;
          } catch (error) {
            console.warn("[Auto-AI Auth] Stored access token could not be restored.", error);
          }
        }

        if (stored.refreshToken) {
          const refreshed = await api.refreshSession(stored.refreshToken);
          if (active) await persistSession(refreshed);
        }
      } catch (error) {
        await removeStoredSession();
        if (active) {
          setToken(null);
          setRefreshToken(null);
          setUser(null);
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    void restoreSession();
    return () => {
      active = false;
    };
  }, [persistSession]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      token,
      loading,
      login: async (email, password) => {
        const session = await api.login({ email: email.trim().toLowerCase(), password });
        await persistSession(session);
      },
      googleLogin: async (idToken) => {
        const session = await api.googleLogin({ id_token: idToken });
        await persistSession(session);
      },
      adminLogin: async (email, password) => {
        const credentials = { email: email.trim().toLowerCase(), password };
        const session = await api.login(credentials);
        if (!["admin", "super_admin"].includes(session.user.role)) {
          throw new Error("Only admin accounts can access the admin dashboard.");
        }
        await persistSession(session);
      },
      register: async (name, email, password) => {
        const session = await api.register({ name: name.trim(), email: email.trim().toLowerCase(), password });
        await persistSession(session);
      },
      updateUser: (nextUser) => setUser(nextUser),
      logout: async () => {
        const activeToken = token;
        const activeRefreshToken = refreshToken;
        const registration = activeToken ? await callNative.registration().catch(() => null) : null;
        if (activeToken && registration?.device_id) {
          await callApi.removeDevice(activeToken, registration.device_id).catch((error) => {
            console.warn("[Auto-AI Auth] Call device token cleanup failed during logout.", error);
          });
        }
        await removeStoredSession();
        setToken(null);
        setRefreshToken(null);
        setUser(null);
        try {
          await api.logout(activeToken, activeRefreshToken);
          await nativeGoogleAuth()?.signOut?.();
        } catch (error) {
          console.warn("[Auto-AI Auth] Logout completed locally, but the server session could not be revoked.", error);
        }
      }
    }),
    [loading, persistSession, refreshToken, token, user]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
