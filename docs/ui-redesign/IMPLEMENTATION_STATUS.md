# AutoAI Simple UI and Size Optimization — Implementation Status

## Repository state

- Branch: `main`.
- Existing uncommitted backend, Seva, form-service, sitemap, Android CSV, and Playwright artifacts were preserved.
- No branch, commit, reset, merge, database migration, API-contract rewrite, or remote deployment was performed.

## Implemented design system

- The default interface is a light, neutral service portal using centralized page, surface, border, text, primary, status, focus, spacing, radius, safe-area, and control-size tokens.
- System fonts are used with Hindi/Devanagari fallbacks; the eager bundled Inter face was removed from runtime CSS.
- Buttons, cards, fields, selects, autofill, disabled/read-only states, dialogs, headers, sidebars, bottom navigation, loading, empty, error, and status surfaces share the same token system.
- Mobile controls have touch-safe sizing, wrapping, `100dvh`, safe-area support, and reduced-motion behavior.
- Decorative motion, cinematic mode, advanced motion, and crystal UI are opt-in and disabled in the example production configuration.
- Legacy crystal, Action Hub theme, branding override CSS, and the 3D hero SVG were removed.

## Screens and routes

Source and route inventory covered public/CMS pages, login, registration, authentication callbacks, Action Hub, AI Chat, AutoAI Seva, applications and service forms, Agent Portal, Admin, calling, messaging, screen sharing, activity, notifications, alarms, profile, settings, subscription, payments, AI usage, backup/restore, APK update, help, loading, empty, unavailable, and error states.

Automated rendered-browser coverage directly exercised public/auth/payment routes plus Call Hub, AI Chat, and Messages at mobile, tablet, desktop, landscape, and scaled-font states. Captured evidence is in `output/playwright/`.

## Modular loading and reliability

- Public landing and CMS routes now load on demand; existing Admin, Agent, screen-share, settings, payment, backup, update, help, and other feature boundaries remain route-lazy.
- Markdown, syntax highlighting, icons, Capacitor, and React runtime are isolated into stable dependency chunks.
- Syntax-highlighting CSS is loaded with Chat instead of application startup.
- Deployment mismatch recovery compares the current and deployed module entry before one guarded reload; genuine chunk failures retain retry/error UI without a reload loop.
- Build budgets enforce entry JS <= 470,000 bytes, global CSS <= 400,000 bytes, and total uncompressed assets <= 21,000,000 bytes.

## Feature classification

| Classification | Features | Decision |
| --- | --- | --- |
| Base/critical | boot, authentication restoration, router shell, deep links, update enforcement, FCM/notification handling, incoming/background calls, error recovery, security settings | Remain in the base app; not deferred |
| Lazy web | public CMS/landing, Admin, Agent, analytics, backup/restore UI, document/service tools, payment/subscription UI, advanced settings/help, screen sharing, Chat markdown/syntax | Loaded at route/feature boundaries |
| Optional native modules | None | Not introduced: WebRTC, notifications, ML Kit alarm verification, plugins, and update infrastructure participate in critical or offline-capable flows. Play Feature Delivery would add lifecycle risk without a proven safe boundary |

Google Play should use the AAB so Play can apply ABI/resource delivery. The direct updater continues to use the signed universal APK; package ID `com.autoai.app`, version code `41`, and version name `1.0.41` remain unchanged. No remote executable-code loading or production `server.url` architecture was introduced.

## Size evidence

| Metric | Before | After | Difference |
| --- | ---: | ---: | ---: |
| Frontend entry JS | 423,980 B | 138,386 B | -285,594 B (-67.36%) |
| Total initial JS | 423,980 B | 408,152 B | -15,828 B (-3.73%) |
| Largest route-specific JS chunk | Not recorded | Chat 147,343 B | Not comparable |
| Total CSS | 573,628 B | 566,614 B | -7,014 B (-1.22%) |
| Total uncompressed static assets | 19,847,692 B | 18,466,225 B | -1,381,467 B (-6.96%) |
| Debug APK | 107,100,088 B | 107,095,774 B | -4,314 B |
| Release/universal APK | 100,541,895 B | 96,351,625 B | -4,190,270 B (-4.17%) |
| AAB | No prior artifact | 52,667,159 B | New measured artifact |
| Installed size | Not measured | Not measured | Requires an Android device/emulator installation |
| Startup time | Not measured | Not measured | Requires repeatable device profiling |

The dominant web asset remains the 11,756,954-byte vision WASM used by alarm verification. The dominant APK contributors remain WebRTC native libraries (approximately 6.83–16.06 MB per ABI), ML Kit face JNI (approximately 5.39–9.68 MB per ABI), the vision WASM, and the 3.76 MB face-landmark model. JavaScript splitting improves startup boundaries but does not remove bundled Capacitor assets; the measured APK reduction comes from R8/resource shrinking and asset/CSS cleanup.

## Android release configuration

- Release builds enable R8 minification, resource shrinking, and the optimized default ProGuard configuration.
- Release APK signature verification passed with APK Signature Scheme v2 and one RSA signer.
- APK SHA-256: `94214E47A2EA04D7281562250C49BD2154BCA802F3C237223B69EFE145C3F612`.
- AAB SHA-256: `2F2553F77C8AF96E0A93161B04863383DF75E8DADABEB81EF258C6A5C07DB903`.

## Verification

- Frontend production build and build budgets: passed.
- Frontend Vitest: 277 passed, 0 failed across 54 files.
- Backend Pytest: 350 passed, 0 failed; 10,460 pre-existing deprecation warnings.
- Playwright: 53 passed, 0 failed across 320–1366 px, portrait/landscape, route, overflow, interaction, and font-scale cases.
- Android release unit tests: 76 passed, 0 failed.
- Capacitor sync: passed.
- Android `assembleRelease`, `bundleRelease`, and `assembleDebug`: passed with the repository JDK 21.
- `apksigner verify --verbose --print-certs`: passed.
- `git diff --check`: passed; Git reported only line-ending conversion warnings.

## Environment variables

- `VITE_ENABLE_CINEMATIC_WEBSITE`
- `VITE_ENABLE_ADVANCED_MOTION`
- `VITE_CRYSTAL_UI_ENABLED`
- `ANDROID_SIGNING_STORE_FILE`
- `ANDROID_SIGNING_KEY_ALIAS`
- `ANDROID_SIGNING_STORE_PASSWORD`
- `ANDROID_SIGNING_KEY_PASSWORD`

## Verification limits

- Physical-device startup, installed size, locked-screen incoming calls, FCM terminated-state delivery, Google authentication, payment-provider completion, WebRTC peers, camera/microphone denial paths, 200% OS font scaling, screen-reader output, and in-place upgrade/data retention require real devices and configured external credentials/services. They were not falsely marked as verified.
- Screenshot inspection supports layout and visible contrast findings, not full WCAG 2.1 AA certification; keyboard/semantic assertions and source review provide additional coverage.
