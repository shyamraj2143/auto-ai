package com.autoai.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.Intent;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

@RunWith(AndroidJUnit4.class)
public class NotificationDeepLinkInstrumentedTest {
    private Context context;

    @Before
    public void clearDestinationState() {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        context.getSharedPreferences("auto_ai_notification_destinations", Context.MODE_PRIVATE)
            .edit().clear().commit();
    }

    @Test
    public void coldLaunchPersistsAndDispatchesMessageDestinationWhenWebViewIsReady() throws Exception {
        Intent intent = NotificationDeepLink.activityIntent(
            context,
            NotificationDeepLink.Destination.MESSAGE_THREAD,
            "cold-thread-41",
            null,
            "cold-event-41",
            System.currentTimeMillis() + 60_000L
        );

        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(intent)) {
            long deadline = System.currentTimeMillis() + 30_000L;
            AtomicReference<String> stored = new AtomicReference<>("null");
            while (System.currentTimeMillis() < deadline && !stored.get().contains("cold-event-41")) {
                CountDownLatch evaluated = new CountDownLatch(1);
                scenario.onActivity(activity -> activity.getBridge().getWebView().evaluateJavascript(
                    "localStorage.getItem('auto-ai-pending-destination')",
                    value -> {
                        stored.set(value == null ? "null" : value);
                        evaluated.countDown();
                    }
                ));
                evaluated.await(2, TimeUnit.SECONDS);
                if (!stored.get().contains("cold-event-41")) Thread.sleep(250L);
            }

            assertTrue(stored.get(), stored.get().contains("cold-event-41"));
            assertTrue(stored.get(), stored.get().contains("cold-thread-41"));
            assertFalse(NotificationDeepLink.hasPending(context));
        }
    }

    @Test
    public void invalidDestinationIsRejectedWithoutPendingState() {
        Intent intent = new Intent(context, MainActivity.class)
            .putExtra(NotificationDeepLink.EXTRA_DESTINATION, "UNKNOWN")
            .putExtra(NotificationDeepLink.EXTRA_EVENT_ID, "invalid-event");

        assertFalse(NotificationDeepLink.capture(context, intent));
        assertFalse(NotificationDeepLink.hasPending(context));
    }
}
