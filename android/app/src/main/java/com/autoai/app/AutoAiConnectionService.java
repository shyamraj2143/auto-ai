package com.autoai.app;

import android.os.Bundle;
import android.telecom.Connection;
import android.telecom.ConnectionRequest;
import android.telecom.ConnectionService;
import android.telecom.PhoneAccountHandle;
import android.util.Log;

public class AutoAiConnectionService extends ConnectionService {
    private static final String TAG = "AutoAiConnectionSvc";

    @Override
    public Connection onCreateIncomingConnection(PhoneAccountHandle connectionManagerPhoneAccount, ConnectionRequest request) {
        Bundle extras = request == null ? new Bundle() : request.getExtras();
        AutoAiCallConnection connection = AutoAiTelecomBridge.createConnection(this, extras, true);
        connection.setRinging();
        Log.i(TAG, "Incoming Telecom connection created callId=" + connection.callId());
        return connection;
    }

    @Override
    public Connection onCreateOutgoingConnection(PhoneAccountHandle connectionManagerPhoneAccount, ConnectionRequest request) {
        Bundle extras = request == null ? new Bundle() : request.getExtras();
        AutoAiCallConnection connection = AutoAiTelecomBridge.createConnection(this, extras, false);
        connection.setDialing();
        Log.i(TAG, "Outgoing Telecom connection created callId=" + connection.callId());
        return connection;
    }

    @Override
    public void onCreateIncomingConnectionFailed(PhoneAccountHandle connectionManagerPhoneAccount, ConnectionRequest request) {
        Log.w(TAG, "Incoming Telecom connection failed.");
    }

    @Override
    public void onCreateOutgoingConnectionFailed(PhoneAccountHandle connectionManagerPhoneAccount, ConnectionRequest request) {
        Log.w(TAG, "Outgoing Telecom connection failed.");
    }
}
