export const CALL_FAILURE_CODES = [
  "FOREGROUND_SERVICE_FAILED",
  "CALL_PERMISSION_REQUIRED",
  "FOREGROUND_SERVICE_START_NOT_ALLOWED",
  "FOREGROUND_SERVICE_TYPE_MISSING",
  "FOREGROUND_SERVICE_NOTIFICATION_FAILED",
  "FOREGROUND_SERVICE_TIMEOUT",
  "FOREGROUND_SERVICE_INTERNAL_ERROR",
  "BACKEND_ACCEPT_FAILED",
  "SIGNALING_AUTH_FAILED",
  "SIGNALING_TIMEOUT",
  "OFFER_NOT_RECEIVED",
  "REMOTE_OFFER_INVALID",
  "ANSWER_CREATE_FAILED",
  "ANSWER_SEND_FAILED",
  "ICE_CONNECTION_FAILED",
  "ICE_RESTART_FAILED",
  "TURN_AUTH_FAILED",
  "TURN_UNREACHABLE",
  "REMOTE_MEDIA_TIMEOUT",
  "MICROPHONE_PERMISSION_DENIED",
  "CAMERA_PERMISSION_DENIED",
  "CALL_STATE_CONFLICT",
  "NETWORK_LOST",
  "INTERNAL_CALL_ERROR",
] as const;

export type CallFailureCode = typeof CALL_FAILURE_CODES[number];

export class CallSetupError extends Error {
  readonly cause?: unknown;

  constructor(public readonly code: CallFailureCode, message: string, cause?: unknown) {
    super(message);
    this.name = "CallSetupError";
    this.cause = cause;
  }
}

export function failureCodeOf(error: unknown, fallback: CallFailureCode): CallFailureCode {
  return error instanceof CallSetupError ? error.code : fallback;
}

export type CallFailurePresentation = {
  title: string;
  message: string;
  permissionRelated: boolean;
  diagnostic?: string;
};

export function callFailurePresentation(error: string, includeDiagnostic = false): CallFailurePresentation {
  const normalized = error.toLowerCase().replace(/[_-]+/g, " ");
  const diagnostic = includeDiagnostic ? { diagnostic: error } : {};
  const permissionRelated = /\b(permission|microphone|camera|record audio)\b/.test(normalized);

  if (permissionRelated) {
    return {
      title: "Calling permission required",
      message: "Allow microphone and camera access, then retry the call.",
      permissionRelated: true,
      ...diagnostic,
    };
  }

  if (/\b(network|offline|socket|signaling|turn|relay|ice|connection|timeout)\b/.test(normalized)) {
    return {
      title: "Connection interrupted",
      message: "Check your internet connection and retry.",
      permissionRelated: false,
      ...diagnostic,
    };
  }

  return {
    title: "Calling service could not start",
    message: "AutoAI could not prepare the call. Please retry.",
    permissionRelated: false,
    ...diagnostic,
  };
}
