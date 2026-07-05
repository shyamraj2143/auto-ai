import { useEffect, useRef, useState } from "react";
import { Chrome } from "lucide-react";
import { API_BASE_URL, api } from "../../api/client";
import { nativeGoogleAuth } from "../../auth/sessionStorage";
import { authErrorMessage } from "../../utils/apiErrors";
import { isLocalPageWithRemoteApi, isMobileAppRuntime } from "../../utils/runtime";

type GoogleSignInButtonProps = {
  disabled?: boolean;
  onCredential: (idToken: string) => Promise<void>;
  onError: (message: string) => void;
};

type GoogleCredentialResponse = {
  credential?: string;
};

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (options: {
            client_id: string;
            callback: (response: GoogleCredentialResponse) => void;
            auto_select?: boolean;
            cancel_on_tap_outside?: boolean;
          }) => void;
          renderButton: (
            element: HTMLElement,
            options: {
              theme: "outline" | "filled_blue" | "filled_black";
              size: "large" | "medium" | "small";
              shape: "rectangular" | "pill" | "circle" | "square";
              text: "continue_with" | "signin_with" | "signup_with";
              width?: number;
            }
          ) => void;
        };
      };
    };
  }
}

const GIS_SCRIPT_ID = "google-identity-services";
const DEFAULT_GOOGLE_WEB_CLIENT_ID = "776507506876-vjrrc9m5eer82k6digta7ie2phd4l1f8.apps.googleusercontent.com";
const ENV_GOOGLE_CLIENT_ID = (
  import.meta.env.VITE_GOOGLE_WEB_CLIENT_ID ||
  import.meta.env.VITE_GOOGLE_CLIENT_ID ||
  DEFAULT_GOOGLE_WEB_CLIENT_ID
).trim();

function loadGoogleIdentityScript() {
  return new Promise<void>((resolve, reject) => {
    if (window.google?.accounts?.id) {
      resolve();
      return;
    }
    const existing = document.getElementById(GIS_SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Google Sign-In script failed to load.")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.id = GIS_SCRIPT_ID;
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Google Sign-In script failed to load."));
    document.head.appendChild(script);
  });
}

export function GoogleSignInButton({ disabled = false, onCredential, onError }: GoogleSignInButtonProps) {
  const buttonRef = useRef<HTMLDivElement | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const nativeAuth = nativeGoogleAuth();

  useEffect(() => {
    let active = true;
    async function loadConfig() {
      if (ENV_GOOGLE_CLIENT_ID) {
        setClientId(ENV_GOOGLE_CLIENT_ID);
        setLoading(false);
        return;
      }
      if (isLocalPageWithRemoteApi(API_BASE_URL)) {
        setLoading(false);
        return;
      }
      try {
        const config = await api.googleConfig();
        if (active) setClientId(config.enabled ? config.client_id ?? null : null);
      } catch (error) {
        console.warn("[Auto-AI Auth] Google Sign-In config could not be loaded.", error);
      } finally {
        if (active) setLoading(false);
      }
    }
    void loadConfig();
    return () => {
      active = false;
    };
  }, [onError]);

  useEffect(() => {
    if (!clientId || nativeAuth || !buttonRef.current) return;
    let active = true;
    void loadGoogleIdentityScript()
      .then(() => {
        if (!active || !buttonRef.current || !window.google?.accounts?.id) return;
        buttonRef.current.innerHTML = "";
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: (response) => {
            if (!response.credential) {
              onError("Google did not return a valid ID token.");
              return;
            }
            setBusy(true);
            void onCredential(response.credential).finally(() => setBusy(false));
          },
          auto_select: false,
          cancel_on_tap_outside: true
        });
        window.google.accounts.id.renderButton(buttonRef.current, {
          theme: "outline",
          size: "large",
          shape: "rectangular",
          text: "continue_with",
          width: buttonRef.current.offsetWidth || 320
        });
      })
      .catch((error) => onError(error instanceof Error ? error.message : "Google Sign-In is unavailable."));
    return () => {
      active = false;
    };
  }, [clientId, nativeAuth, onCredential, onError]);

  async function signInWithNativeGoogle() {
    if (!clientId || !nativeAuth) return;
    setBusy(true);
    try {
      const result = await nativeAuth.signIn({ clientId });
      if (!result.idToken) throw new Error("Google did not return a valid ID token.");
      await onCredential(result.idToken);
    } catch (error) {
      onError(authErrorMessage(error, "Google Sign-In failed."));
    } finally {
      setBusy(false);
    }
  }

  if (!clientId && !loading) {
    return null;
  }

  if (nativeAuth || isMobileAppRuntime()) {
    return (
      <button className="google-auth-button" disabled={disabled || loading || busy || !clientId} onClick={signInWithNativeGoogle} type="button">
        <Chrome size={18} />
        {busy ? "Connecting Google" : "Continue with Google"}
      </button>
    );
  }

  return (
    <div className="google-auth-shell" aria-busy={busy || loading || disabled}>
      <div ref={buttonRef} className="google-auth-rendered" />
    </div>
  );
}
