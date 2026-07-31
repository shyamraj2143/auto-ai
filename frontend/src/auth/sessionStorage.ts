import { Capacitor, registerPlugin } from "@capacitor/core";

const ACCESS_TOKEN_KEY = "auto-ai-access-token";
const REFRESH_TOKEN_KEY = "auto-ai-refresh-token";
const LEGACY_TOKEN_KEY = "auto-ai-token";

type NativeSecureStorage = {
  get: (options: { key: string }) => Promise<{ value?: string | null }>;
  set: (options: { key: string; value: string }) => Promise<void>;
  remove: (options: { key: string }) => Promise<void>;
};

const RegisteredNativeSecureStorage = registerPlugin<NativeSecureStorage>("AutoAiSecureStorage");

declare global {
  interface Window {
    Capacitor?: {
      getPlatform?: () => string;
      Plugins?: {
        AutoAiSecureStorage?: NativeSecureStorage;
        AutoAiGoogleAuth?: {
          signIn: (options?: { clientId?: string | null }) => Promise<{ idToken?: string; email?: string; name?: string; picture?: string }>;
          signOut?: () => Promise<void>;
        };
      };
    };
  }
}

export type StoredAuthSession = {
  accessToken: string | null;
  refreshToken: string | null;
};

function isAndroidNativeRuntime() {
  return typeof window !== "undefined" && Capacitor.getPlatform() === "android";
}

export function nativeSecureStorage() {
  if (!isAndroidNativeRuntime()) return undefined;
  return RegisteredNativeSecureStorage;
}

export function nativeGoogleAuth() {
  return typeof window !== "undefined" ? window.Capacitor?.Plugins?.AutoAiGoogleAuth : undefined;
}

function readLocalStorage(key: string) {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    console.warn("[Auto-AI Auth] Unable to read saved browser session.", error);
    return null;
  }
}

function writeLocalStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    console.warn("[Auto-AI Auth] Unable to save browser session.", error);
  }
}

function removeLocalStorage(key: string) {
  try {
    localStorage.removeItem(key);
  } catch (error) {
    console.warn("[Auto-AI Auth] Unable to remove saved browser session.", error);
  }
}

function localSession(): StoredAuthSession {
  return {
    accessToken: readLocalStorage(ACCESS_TOKEN_KEY) || readLocalStorage(LEGACY_TOKEN_KEY),
    refreshToken: readLocalStorage(REFRESH_TOKEN_KEY)
  };
}

export async function syncNativeAccessToken(accessToken: string) {
  const secureStorage = nativeSecureStorage();
  if (!secureStorage || !accessToken) return;
  await secureStorage.set({ key: ACCESS_TOKEN_KEY, value: accessToken });
  const verified = await secureStorage.get({ key: ACCESS_TOKEN_KEY });
  if (verified.value !== accessToken) {
    throw new Error("Android secure call session could not be synchronized.");
  }
}

export async function readStoredSession(): Promise<StoredAuthSession> {
  const fallback = localSession();
  const secureStorage = nativeSecureStorage();
  if (!secureStorage) return fallback;

  try {
    const [access, refresh] = await Promise.all([
      secureStorage.get({ key: ACCESS_TOKEN_KEY }),
      secureStorage.get({ key: REFRESH_TOKEN_KEY })
    ]);
    const accessToken = access.value ?? fallback.accessToken;
    const refreshToken = refresh.value ?? fallback.refreshToken;

    // Migrate sessions saved by older APKs into native encrypted storage so
    // foreground call services can authenticate even when the WebView is closed.
    const migrations: Promise<void>[] = [];
    if (!access.value && accessToken) migrations.push(secureStorage.set({ key: ACCESS_TOKEN_KEY, value: accessToken }));
    if (!refresh.value && refreshToken) migrations.push(secureStorage.set({ key: REFRESH_TOKEN_KEY, value: refreshToken }));
    if (migrations.length) await Promise.all(migrations);

    return { accessToken: accessToken ?? null, refreshToken: refreshToken ?? null };
  } catch (error) {
    console.warn("[Auto-AI Auth] Native secure session read failed; using the WebView session mirror.", error);
    return fallback;
  }
}

export async function writeStoredSession(accessToken: string, refreshToken?: string | null) {
  // Keep a WebView mirror for startup recovery while native encrypted storage
  // remains the source used by Android foreground calling services.
  writeLocalStorage(ACCESS_TOKEN_KEY, accessToken);
  writeLocalStorage(LEGACY_TOKEN_KEY, accessToken);
  if (refreshToken) writeLocalStorage(REFRESH_TOKEN_KEY, refreshToken);
  else removeLocalStorage(REFRESH_TOKEN_KEY);

  const secureStorage = nativeSecureStorage();
  if (!secureStorage) return;

  const writes = [secureStorage.set({ key: ACCESS_TOKEN_KEY, value: accessToken })];
  writes.push(
    refreshToken
      ? secureStorage.set({ key: REFRESH_TOKEN_KEY, value: refreshToken })
      : secureStorage.remove({ key: REFRESH_TOKEN_KEY })
  );
  await Promise.all(writes);

  const verified = await secureStorage.get({ key: ACCESS_TOKEN_KEY });
  if (verified.value !== accessToken) {
    throw new Error("Unable to persist the Android secure session.");
  }
}

export async function removeStoredSession() {
  const secureStorage = nativeSecureStorage();
  if (secureStorage) {
    try {
      await Promise.all([
        secureStorage.remove({ key: ACCESS_TOKEN_KEY }),
        secureStorage.remove({ key: REFRESH_TOKEN_KEY })
      ]);
    } catch (error) {
      console.warn("[Auto-AI Auth] Unable to clear the native secure session.", error);
    }
  }
  removeLocalStorage(ACCESS_TOKEN_KEY);
  removeLocalStorage(REFRESH_TOKEN_KEY);
  removeLocalStorage(LEGACY_TOKEN_KEY);
}
