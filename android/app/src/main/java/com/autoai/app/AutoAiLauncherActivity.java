package com.autoai.app;

/**
 * Stable launcher component kept for Android home-screen compatibility.
 *
 * Older APKs exposed this Activity as the launcher. Some Android launchers keep
 * an explicit component shortcut after an update, so removing or hiding this
 * class can make tapping the app icon look like an immediate app close. The
 * implementation intentionally inherits the full production MainActivity so
 * login, updates, calls, alarms, WebView insets, and deep links all run through
 * the same startup-safe path.
 */
public final class AutoAiLauncherActivity extends MainActivity {
}
