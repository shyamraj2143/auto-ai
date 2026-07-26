export const CALL_FAILURE_CODES = [
  "FOREGROUND_SERVICE_FAILED",
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
