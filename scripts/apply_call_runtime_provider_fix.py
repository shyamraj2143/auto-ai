from pathlib import Path
import re

path = Path("frontend/src/features/calls/CallProvider.tsx")
text = path.read_text(encoding="utf-8")


def replace_once(old: str, new: str, label: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    text = text.replace(old, new, 1)


replace_once(
    'import { useAuth } from "../../contexts/AuthContext";\n',
    'import { useAuth } from "../../contexts/AuthContext";\nimport { syncNativeAccessToken } from "../../auth/sessionStorage";\n',
    "native token import",
)

refresh_pattern = re.compile(
    r'  const refreshRealtime = useCallback\(async \(\) => \{.*?\n  \}, \[signaling, token\]\);',
    re.DOTALL,
)
refresh_replacement = '''  const refreshRealtime = useCallback(async () => {
    if (!token) throw new Error("Not authenticated");
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const nextConfig = await callApi.config(token);
        setConfig(nextConfig);
        configRef.current = nextConfig;
        if (!nextConfig.enabled) {
          signaling.close();
          return nextConfig;
        }
        if (!nextConfig.realtime_configured) {
          throw new CallSetupError("SIGNALING_TIMEOUT", "Realtime calling is temporarily unavailable.");
        }
        await signaling.retry(token);
        if (!await signaling.waitUntilConnected(6000)) {
          throw new CallSetupError("SIGNALING_TIMEOUT", "Realtime calling could not connect.");
        }
        return nextConfig;
      } catch (refreshError) {
        lastError = refreshError;
        if (attempt < 3) await new Promise((resolve) => window.setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Realtime calling is temporarily unavailable.");
  }, [signaling, token]);

  const verifyCallPreflight = useCallback(async () => {
    if (!token) throw new CallSetupError("SIGNALING_AUTH_FAILED", "Sign in again before starting a call.");
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        if (callNative.isAndroid()) await syncNativeAccessToken(token);
        const [nextConfig, credentials] = await Promise.all([
          callApi.config(token),
          callApi.turnCredentials(token),
        ]);
        setConfig(nextConfig);
        configRef.current = nextConfig;
        const servers = normalizeIceServers(credentials.iceServers ?? credentials.ice_servers);
        const relayConfigured = Boolean(
          credentials.configured ?? credentials.relayConfigured ?? credentials.relay_configured
        );
        if (!nextConfig.enabled) throw new Error("Calling is disabled.");
        if (!nextConfig.realtime_configured) {
          throw new CallSetupError("SIGNALING_TIMEOUT", "Realtime calling is temporarily unavailable.");
        }
        if (!relayConfigured || !servers.length) {
          throw new CallSetupError("TURN_UNREACHABLE", CALL_RELAY_UNAVAILABLE_MESSAGE);
        }
        turnCredentialsRef.current = {
          iceServers: servers,
          relayConfigured,
          warning: credentials.warning,
          expiresAtMs: Date.now() + 5 * 60_000,
        };
        return;
      } catch (preflightError) {
        lastError = preflightError;
        callDebug("call_preflight_retry", {
          attempt: attempt + 1,
          error_code: failureCodeOf(preflightError, "SIGNALING_TIMEOUT"),
        });
        if (attempt < 3) await new Promise((resolve) => window.setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Calling setup is temporarily unavailable.");
  }, [token]);'''
text, count = refresh_pattern.subn(refresh_replacement, text, count=1)
if count != 1:
    raise SystemExit(f"refreshRealtime block: expected one match, found {count}")

replace_once(
    '''    if (configRef.current?.diagnostic === CALL_RELAY_UNAVAILABLE_MESSAGE) {
      setError(CALL_RELAY_UNAVAILABLE_MESSAGE);
      return;
    }
''',
    "",
    "stale relay diagnostic guard",
)

replace_once(
    '    try {      if (callNative.isAndroid()) {\n',
    '    try {\n      await verifyCallPreflight();\n      if (callNative.isAndroid()) {\n        await syncNativeAccessToken(token);\n',
    "outgoing preflight",
)

replace_once(
    '    try {\n      const fresh = await callApi.get(token, currentCall.id);\n',
    '    try {\n      await verifyCallPreflight();\n      const fresh = await callApi.get(token, currentCall.id);\n',
    "incoming preflight",
)

replace_once(
    '          if (callNative.isAndroid()) {\n            const permissions = fresh.call_type === "video" && !audioOnly\n',
    '          if (callNative.isAndroid()) {\n            await syncNativeAccessToken(token);\n            const permissions = fresh.call_type === "video" && !audioOnly\n',
    "incoming native token sync",
)

replace_once(
    '      await ensureNativeCallService(authoritative);\n      await callNative.acknowledgeCallHandoff(callId).catch(() => undefined);\n',
    '      if (callNative.isAndroid()) await syncNativeAccessToken(token);\n      await ensureNativeCallService(authoritative);\n      await callNative.acknowledgeCallHandoff(callId).catch(() => undefined);\n',
    "resume native token sync",
)

replace_once(
    '            await ensureNativeCallService(authoritative);\n            await loadIceConfiguration();\n',
    '            if (callNative.isAndroid()) await syncNativeAccessToken(token);\n            await ensureNativeCallService(authoritative);\n            await loadIceConfiguration();\n',
    "recovery native token sync",
)

replace_once(
    '  }, [cleanup, clearCallTimer, ensureNativeCallService, requestLocalMedia, setCallTimer, signaling, token]);\n',
    '  }, [cleanup, clearCallTimer, ensureNativeCallService, requestLocalMedia, setCallTimer, signaling, token, verifyCallPreflight]);\n',
    "outgoing dependency list",
)

replace_once(
    '  }, [armMediaConnectTimeout, cleanup, clearProgressTimers, closeBrowserNotification, ensureNativeCallService, ensurePeerConnection, loadIceConfiguration, requestLocalMedia, setCallTimer, signaling, stopRingtone, token, transition]);\n',
    '  }, [armMediaConnectTimeout, cleanup, clearProgressTimers, closeBrowserNotification, ensureNativeCallService, ensurePeerConnection, loadIceConfiguration, requestLocalMedia, setCallTimer, signaling, stopRingtone, token, transition, verifyCallPreflight]);\n',
    "incoming dependency list",
)

path.write_text(text, encoding="utf-8")
print("CallProvider runtime patch applied.")
