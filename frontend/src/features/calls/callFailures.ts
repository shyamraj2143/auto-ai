export type CallFailureCode =
  | "MICROPHONE_PERMISSION_DENIED"
  | "CAMERA_PERMISSION_DENIED"
  | "CALL_PERMISSION_REQUIRED"
  | "FOREGROUND_SERVICE_PERMISSION_DENIED"
  | "FOREGROUND_SERVICE_START_NOT_ALLOWED"
  | "FOREGROUND_SERVICE_TYPE_MISSING"
  | "FOREGROUND_NOTIFICATION_FAILED"
  | "FOREGROUND_SERVICE_TIMEOUT"
  | "SERVICE_READY_TIMEOUT"
  | "AUDIO_FOCUS_FAILED"
  | "SIGNALING_AUTH_FAILED"
  | "SIGNALING_TIMEOUT"
  | "OFFER_NOT_RECEIVED"
  | "TURN_AUTH_FAILED"
  | "TURN_UNREACHABLE"
  | "ICE_CONNECTION_FAILED"
  | "MEDIA_CONNECT_TIMEOUT"
  | "NETWORK_LOST"
  | "BACKEND_ACCEPT_FAILED"
  | "CALL_STATE_CONFLICT"
  | "INTERNAL_CALL_ERROR"
  | "FOREGROUND_SERVICE_FAILED";

export type CallFailurePresentation = {
  title: string;
  message: string;
  permissionRelated?: boolean;
            diagnostic?: string;
};

const OFFLINE_MESSAGE = "No internet connection. Turn on mobile data or Wi-Fi, then retry.";

function isOffline() {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function explicitFailureCode(error: unknown): string {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  while (queue.length) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    if (typeof current === "string") {
      const match = current.match(/\b[A-Z][A-Z0-9_]{2,}\b/);
      if (match) return match[0];
      continue;
    }
    if (typeof current !== "object") continue;
    const record = current as Record<string, unknown>;
    for (const key of ["code", "errorCode", "failureCode"]) {
      const value = record[key];
      if (typeof value === "string" && /^[A-Z][A-Z0-9_]{2,}$/.test(value)) return value;
    }
    if (typeof record.message === "string") {
      const match = record.message.match(/\b[A-Z][A-Z0-9_]{2,}\b/);
      if (match) return match[0];
    }
    queue.push(record.cause, record.originalError, record.error);
  }
  return "";
}

function presentationFor(codeOrMessage: string): CallFailurePresentation | null {
  const value = codeOrMessage.toUpperCase();
  if (/MICROPHONE_PERMISSION_DENIED|CALL_PERMISSION_REQUIRED/.test(value)) {
    return { title: "Microphone permission required", message: "Allow microphone access in Android Settings, then retry the call.", permissionRelated: true };
  }
  if (/CAMERA_PERMISSION_DENIED/.test(value)) {
    return { title: "Camera permission required", message: "Allow camera access for video calling, or answer using audio only.", permissionRelated: true };
  }
  if (/FOREGROUND_SERVICE_PERMISSION_DENIED/.test(value)) {
    return { title: "Calling permission blocked", message: "Android blocked a required call permission. Open AutoAI app settings and allow microphone and camera access.", permissionRelated: true };
  }
  if (/FOREGROUND_SERVICE_START_NOT_ALLOWED/.test(value)) {
    return { title: "Android blocked the call service", message: "Keep AutoAI visible and retry. Also allow background activity and call notifications in Android Settings." };
  }
  if (/FOREGROUND_SERVICE_TYPE_MISSING/.test(value)) {
    return { title: "Calling service configuration error", message: "This app build cannot start the required call service. Install the latest AutoAI update." };
  }
  if (/FOREGROUND_NOTIFICATION_FAILED/.test(value)) {
    return { title: "Call notification unavailable", message: "Allow AutoAI call notifications in Android Settings, then retry.", permissionRelated: true };
  }
  if (/SERVICE_READY_TIMEOUT|FOREGROUND_SERVICE_TIMEOUT/.test(value)) {
    return { title: "Calling service timed out", message: "Android did not start the calling service in time. Close the failed call and retry once." };
  }
  if (/AUDIO_FOCUS_FAILED/.test(value)) {
    return { title: "Audio is busy", message: "Another app is using call audio. Close the other call or recorder and retry." };
  }
  if (/SIGNALING_AUTH_FAILED/.test(value)) {
    return { title: "Call session expired", message: "Your secure call session expired. Reopen AutoAI and retry." };
  }
  if (/SIGNALING_TIMEOUT|OFFER_NOT_RECEIVED|SIGNALING UNAVAILABLE/.test(value)) {
    return { title: "Secure signaling unavailable", message: "AutoAI could not establish the secure call channel. Check the connection and retry." };
  }
  if (/TURN_AUTH_FAILED|TURN_UNREACHABLE|RELAY/.test(value)) {
    return { title: "Call relay unavailable", message: "The media relay could not be reached. Retry after changing between Wi-Fi and mobile data." };
  }
  if (/ICE_CONNECTION_FAILED|MEDIA_CONNECT_TIMEOUT/.test(value)) {
    return { title: "Media connection failed", message: "The call reached the other user, but audio or video could not connect. Retry on a stable network." };
  }
  if (/NETWORK_LOST|NETWORK_UNAVAILABLE|NO INTERNET|OFFLINE/.test(value)) {
    return { title: "No internet connection", message: OFFLINE_MESSAGE };
  }
  if (/BACKEND_ACCEPT_FAILED/.test(value)) {
    return { title: "Call could not be accepted", message: "The server could not confirm the answer action. Check the network and retry before the call expires." };
  }
  if (/CALL_STATE_CONFLICT/.test(value)) {
    return { title: "Call is no longer available", message: "This call was already ended, rejected, or answered on another device." };
  }
  return null;
}

export class CallSetupError extends Error {
  readonly code: CallFailureCode;
  readonly cause?: unknown;

  constructor(code: CallFailureCode, message: string, cause?: unknown) {
    const nestedCode = explicitFailureCode(cause);
    const exact = presentationFor(nestedCode || code);
    super(exact?.message ?? message);
    this.name = "CallSetupError";
    this.code = (nestedCode || code) as CallFailureCode;
    this.cause = cause;
  }
}

export function failureCodeOf(error: unknown, fallback: CallFailureCode = "INTERNAL_CALL_ERROR") {
  const nestedCode = explicitFailureCode(error);
  if (nestedCode) return nestedCode as CallFailureCode;
  if (error instanceof CallSetupError) return error.code;
  return fallback;
}

export function callFailurePresentation(error: string, includeDiagnostic = false): CallFailurePresentation {
  const normalized = error.trim();
  if (isOffline()) return { title: "No internet connection", message: OFFLINE_MESSAGE };
  const exact = presentationFor(normalized);
  if (exact) return includeDiagnostic && normalized ? { ...exact, diagnostic: normalized } : exact;
  const fallback: CallFailurePresentation = {
    title: "Calling service could not start",
    message: normalized || "AutoAI could not prepare the call. Please retry.",
  };
  return includeDiagnostic && normalized ? { ...fallback, diagnostic: normalized } : fallback;
}
