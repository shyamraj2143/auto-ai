#!/usr/bin/env sh
set -eu

API_URL="${VITE_API_URL:-https://auto-ai-production-c510.up.railway.app/api/v1}"
OUTPUT_PATH="${APK_OUTPUT_PATH:-public/downloads/auto-ai.apk}"

case "$API_URL" in
  *local*host*|*127.0.0.1*|*0.0.0.0*)
    echo "Production APK builds cannot use a local API URL." >&2
    exit 1
    ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCAL_JDK="$(find "$ROOT/.jdk" -maxdepth 1 -type d -name 'jdk-21*' 2>/dev/null | head -n 1 || true)"
if [ -n "$LOCAL_JDK" ]; then
  export JAVA_HOME="$LOCAL_JDK"
  export PATH="$LOCAL_JDK/bin:$PATH"
fi
SDK_PATH="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [ -z "$SDK_PATH" ] && [ -n "${HOME:-}" ] && [ -d "$HOME/Android/Sdk" ]; then
  SDK_PATH="$HOME/Android/Sdk"
fi
if [ -n "$SDK_PATH" ] && [ -d "$SDK_PATH" ]; then
  export ANDROID_HOME="$SDK_PATH"
  export ANDROID_SDK_ROOT="$SDK_PATH"
  SDK_DIR="$(printf '%s' "$SDK_PATH" | sed 's#\\#/#g; s#:#\\:#')"
fi
LOCAL_PROPERTIES="$ROOT/android/local.properties"
EXISTING_KEYSTORE="$(grep '^AUTO_AI_ANDROID_KEYSTORE=' "$LOCAL_PROPERTIES" 2>/dev/null | sed 's/^[^=]*=//' || true)"
EXISTING_STORE_PASSWORD="$(grep '^AUTO_AI_ANDROID_KEYSTORE_PASSWORD=' "$LOCAL_PROPERTIES" 2>/dev/null | sed 's/^[^=]*=//' || true)"
EXISTING_KEY_ALIAS="$(grep '^AUTO_AI_ANDROID_KEY_ALIAS=' "$LOCAL_PROPERTIES" 2>/dev/null | sed 's/^[^=]*=//' || true)"
EXISTING_KEY_PASSWORD="$(grep '^AUTO_AI_ANDROID_KEY_PASSWORD=' "$LOCAL_PROPERTIES" 2>/dev/null | sed 's/^[^=]*=//' || true)"
EXISTING_GOOGLE_WEB_CLIENT_ID="$(grep '^AUTO_AI_GOOGLE_WEB_CLIENT_ID=' "$LOCAL_PROPERTIES" 2>/dev/null | sed 's/^[^=]*=//' || true)"
if [ -z "$EXISTING_GOOGLE_WEB_CLIENT_ID" ]; then
  EXISTING_GOOGLE_WEB_CLIENT_ID="$(grep '^GOOGLE_WEB_CLIENT_ID=' "$LOCAL_PROPERTIES" 2>/dev/null | sed 's/^[^=]*=//' || true)"
fi
if [ -z "$EXISTING_GOOGLE_WEB_CLIENT_ID" ]; then
  EXISTING_GOOGLE_WEB_CLIENT_ID="$(grep '^VITE_GOOGLE_WEB_CLIENT_ID=' "$LOCAL_PROPERTIES" 2>/dev/null | sed 's/^[^=]*=//' || true)"
fi

KEYSTORE="${AUTO_AI_ANDROID_KEYSTORE:-$EXISTING_KEYSTORE}"
STORE_PASSWORD="${AUTO_AI_ANDROID_KEYSTORE_PASSWORD:-$EXISTING_STORE_PASSWORD}"
KEY_ALIAS="${AUTO_AI_ANDROID_KEY_ALIAS:-$EXISTING_KEY_ALIAS}"
KEY_PASSWORD="${AUTO_AI_ANDROID_KEY_PASSWORD:-$EXISTING_KEY_PASSWORD}"
GOOGLE_WEB_CLIENT_ID="${AUTO_AI_GOOGLE_WEB_CLIENT_ID:-${GOOGLE_WEB_CLIENT_ID:-${VITE_GOOGLE_WEB_CLIENT_ID:-$EXISTING_GOOGLE_WEB_CLIENT_ID}}}"
EXISTING_ANDROID_VERSION_CODE="$(grep '^AUTO_AI_ANDROID_VERSION_CODE=' "$LOCAL_PROPERTIES" 2>/dev/null | sed 's/^[^=]*=//' || true)"
EXISTING_ANDROID_VERSION_NAME="$(grep '^AUTO_AI_ANDROID_VERSION_NAME=' "$LOCAL_PROPERTIES" 2>/dev/null | sed 's/^[^=]*=//' || true)"
ANDROID_VERSION_CODE="${AUTO_AI_ANDROID_VERSION_CODE:-$EXISTING_ANDROID_VERSION_CODE}"
ANDROID_VERSION_NAME="${AUTO_AI_ANDROID_VERSION_NAME:-$EXISTING_ANDROID_VERSION_NAME}"
ANDROID_VERSION_CODE="${ANDROID_VERSION_CODE:-19}"
ANDROID_VERSION_NAME="${ANDROID_VERSION_NAME:-1.0.18}"

if [ -z "$KEYSTORE" ] || [ -z "$STORE_PASSWORD" ] || [ -z "$KEY_ALIAS" ] || [ -z "$KEY_PASSWORD" ]; then
  SIGNING_DIR="$ROOT/.android-signing"
  mkdir -p "$SIGNING_DIR"
  KEYSTORE="$SIGNING_DIR/auto-ai-release.jks"
  STORE_PASSWORD="$(uuidgen 2>/dev/null | tr -d '-' || date +%s%N)$(uuidgen 2>/dev/null | tr -d '-' || date +%s%N)"
  STORE_PASSWORD="$(printf '%s' "$STORE_PASSWORD" | cut -c1-32)"
  KEY_PASSWORD="$STORE_PASSWORD"
  KEY_ALIAS="auto-ai"
  rm -f "$KEYSTORE"
  keytool -genkeypair -v -keystore "$KEYSTORE" -storepass "$STORE_PASSWORD" -keypass "$KEY_PASSWORD" -alias "$KEY_ALIAS" -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Auto-AI, OU=Android, O=Auto-AI, L=Online, S=Online, C=US"
fi

{
  [ -n "${SDK_DIR:-}" ] && printf 'sdk.dir=%s\n' "$SDK_DIR"
  printf 'AUTO_AI_ANDROID_KEYSTORE=%s\n' "$(printf '%s' "$KEYSTORE" | sed 's#\\#/#g')"
  printf 'AUTO_AI_ANDROID_KEYSTORE_PASSWORD=%s\n' "$STORE_PASSWORD"
  printf 'AUTO_AI_ANDROID_KEY_ALIAS=%s\n' "$KEY_ALIAS"
  printf 'AUTO_AI_ANDROID_KEY_PASSWORD=%s\n' "$KEY_PASSWORD"
  [ -n "$GOOGLE_WEB_CLIENT_ID" ] && printf 'AUTO_AI_GOOGLE_WEB_CLIENT_ID=%s\n' "$GOOGLE_WEB_CLIENT_ID"
  printf 'AUTO_AI_ANDROID_VERSION_CODE=%s\n' "$ANDROID_VERSION_CODE"
  printf 'AUTO_AI_ANDROID_VERSION_NAME=%s\n' "$ANDROID_VERSION_NAME"
} > "$LOCAL_PROPERTIES"

cd "$ROOT/frontend"
VITE_API_URL="$API_URL" VITE_GOOGLE_WEB_CLIENT_ID="$GOOGLE_WEB_CLIENT_ID" npm install
AUTO_AI_SKIP_COMPRESSION=1 VITE_API_URL="$API_URL" VITE_GOOGLE_WEB_CLIENT_ID="$GOOGLE_WEB_CLIENT_ID" AUTO_AI_GOOGLE_WEB_CLIENT_ID="$GOOGLE_WEB_CLIENT_ID" npm run build
find "$ROOT/frontend/dist" -type f \( -name '*.gz' -o -name '*.br' \) -delete

cd "$ROOT"
npx cap sync android

cd "$ROOT/android"
chmod +x ./gradlew
./gradlew assembleRelease

SIGNED="$ROOT/android/app/build/outputs/apk/release/app-release.apk"
UNSIGNED="$ROOT/android/app/build/outputs/apk/release/app-release-unsigned.apk"
if [ -f "$SIGNED" ]; then
  SOURCE="$SIGNED"
elif [ -f "$UNSIGNED" ]; then
  SOURCE="$UNSIGNED"
else
  echo "Release APK was not generated." >&2
  exit 1
fi

mkdir -p "$ROOT/$(dirname "$OUTPUT_PATH")"
cp "$SOURCE" "$ROOT/$OUTPUT_PATH"

if command -v sha256sum >/dev/null 2>&1; then
  HASH="$(sha256sum "$ROOT/$OUTPUT_PATH" | awk '{print $1}')"
else
  HASH="$(shasum -a 256 "$ROOT/$OUTPUT_PATH" | awk '{print $1}')"
fi
SIZE="$(wc -c < "$ROOT/$OUTPUT_PATH" | tr -d ' ')"
echo "APK=$ROOT/$OUTPUT_PATH"
echo "SHA256=$HASH"
echo "SIZE=$SIZE"
echo "VERSION_CODE=$ANDROID_VERSION_CODE"
echo "VERSION_NAME=$ANDROID_VERSION_NAME"
