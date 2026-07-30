package com.autoai.app;

public enum TelecomCallResult {
    REPORTED,
    ALREADY_ACTIVE,
    INVALID_METADATA,
    REGISTRATION_UNAVAILABLE,
    SECURITY_EXCEPTION,
    ILLEGAL_ARGUMENT,
    UNSUPPORTED_OPERATION,
    TELECOM_EXCEPTION;

    public boolean isReported() {
        return this == REPORTED || this == ALREADY_ACTIVE;
    }
}
