package com.autoai.app;

public enum TelecomRegistrationResult {
    REGISTERED,
    ALREADY_REGISTERED,
    UNSUPPORTED,
    PERMISSION_MISSING,
    TELECOM_UNAVAILABLE,
    OEM_REJECTED,
    REGISTRATION_EXCEPTION;

    public boolean isRegistered() {
        return this == REGISTERED || this == ALREADY_REGISTERED;
    }
}
