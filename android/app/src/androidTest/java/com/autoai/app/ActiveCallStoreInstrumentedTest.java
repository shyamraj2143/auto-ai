package com.autoai.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

import android.content.Context;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class ActiveCallStoreInstrumentedTest {
    private Context context;

    @Before public void reset() {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        context.getSharedPreferences("auto_ai_native_active_call", Context.MODE_PRIVATE).edit().clear().commit();
    }

    @Test public void acceptedCallSurvivesUiAndServiceStateTransitionsUntilTerminal() {
        ActiveCallStore.presentIncoming(context, "call-locked", "audio", "peer-1", "Private caller", null,
            "valid-action-token-12345", 7L, System.currentTimeMillis() + 60_000L);
        assertEquals(ActiveCallStore.State.INCOMING_PRESENTED, ActiveCallStore.get(context).state);
        ActiveCallStore.beginAccept(context, "call-locked", "audio", "Private caller", "valid-action-token-12345",
            System.currentTimeMillis() + 60_000L, 7L);
        ActiveCallStore.commitAccept(context, "call-locked", 8L);
        ActiveCallStore.update(context, "call-locked", ActiveCallStore.State.SERVICE_READY);
        ActiveCallStore.update(context, "call-locked", ActiveCallStore.State.ACTIVE_UI_READY);
        ActiveCallStore.update(context, "call-locked", ActiveCallStore.State.RECONNECTING);
        ActiveCallStore.Snapshot restored = ActiveCallStore.get(context, "call-locked");
        assertNotNull(restored);
        assertEquals(8L, restored.revision);
        assertEquals(ActiveCallStore.State.RECONNECTING, restored.state);
        ActiveCallStore.clearTerminal(context, "call-locked");
        assertNotNull(ActiveCallStore.get(context));
        ActiveCallStore.update(context, "call-locked", ActiveCallStore.State.TERMINAL);
        ActiveCallStore.clearTerminal(context, "call-locked");
        assertNull(ActiveCallStore.get(context));
    }
}
