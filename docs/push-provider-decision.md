# Android incoming-call push decision

AutoAI keeps its current WebRTC calling stack and uses a pluggable delivery boundary. Version 1.0.34 enables the supported Firebase Installation ID registration path for GMS devices. Huawei Push Kit and Xiaomi Mi Push are not enabled until production credentials and physical devices are available; the client must report those devices as unsupported/degraded rather than READY.

Required Huawei credentials: AppGallery Connect app ID, client ID, client secret, package SHA-256 certificate, and `agconnect-services.json` for `com.autoai.app`.

Required Xiaomi credentials: Mi Push AppID, AppKey, AppSecret, package registration for `com.autoai.app`, and server-side regional endpoint selection.

An end-to-end migration to Stream Video is intentionally not mixed into this fix because it would replace signaling, call state, WebRTC sessions, authentication, and server APIs. That migration requires a separate compatibility and data-migration project.
