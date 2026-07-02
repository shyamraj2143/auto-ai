param(
  [string]$ApiUrl = "https://auto-ai-production-c510.up.railway.app/api/v1",
  [string]$OutputPath = "public/downloads/auto-ai.apk"
)

$ErrorActionPreference = "Stop"

if ($ApiUrl -match "local\s*host|127\.0\.0\.1|0\.0\.0\.0") {
  throw "Production APK builds cannot use a local API URL."
}

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$frontend = Join-Path $root "frontend"
$android = Join-Path $root "android"
$output = Join-Path $root $OutputPath
$buildVersion = (& git -C $root rev-parse --short HEAD).Trim()

$androidAssets = Join-Path $android "app/src/main/assets/public"
if (Test-Path $androidAssets) {
  Remove-Item -Recurse -Force $androidAssets
}

$androidConfig = Join-Path $android "app/src/main/assets/capacitor.config.json"
if (Test-Path $androidConfig) {
  Remove-Item -Force $androidConfig
}
$localJdk = Get-ChildItem -Path (Join-Path $root ".jdk") -Directory -Filter "jdk-21*" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($localJdk) {
  $env:JAVA_HOME = $localJdk.FullName
  $env:PATH = (Join-Path $localJdk.FullName "bin") + [IO.Path]::PathSeparator + $env:PATH
}
$sdkPath = $env:ANDROID_HOME
if (-not $sdkPath) { $sdkPath = $env:ANDROID_SDK_ROOT }
if (-not $sdkPath) {
  $candidate = Join-Path $env:LOCALAPPDATA "Android\Sdk"
  if (Test-Path $candidate) { $sdkPath = $candidate }
}
if ($sdkPath -and (Test-Path $sdkPath)) {
  $env:ANDROID_HOME = $sdkPath
  $env:ANDROID_SDK_ROOT = $sdkPath
  $sdkDir = ($sdkPath -replace "\\", "/")
  $sdkDir = $sdkDir -replace ":", "\:"
}

$localPropertiesPath = Join-Path $android "local.properties"
$localProperties = @{}
if (Test-Path $localPropertiesPath) {
  Get-Content $localPropertiesPath | ForEach-Object {
    if ($_ -match "^\s*([^#][^=]+?)\s*=\s*(.*)\s*$") {
      $localProperties[$matches[1].Trim()] = $matches[2].Trim()
    }
  }
}

$keystore = $env:AUTO_AI_ANDROID_KEYSTORE
$storePassword = $env:AUTO_AI_ANDROID_KEYSTORE_PASSWORD
$keyAlias = $env:AUTO_AI_ANDROID_KEY_ALIAS
$keyPassword = $env:AUTO_AI_ANDROID_KEY_PASSWORD

if (-not ($keystore -and $storePassword -and $keyAlias -and $keyPassword)) {
  $keystore = $localProperties["AUTO_AI_ANDROID_KEYSTORE"]
  $storePassword = $localProperties["AUTO_AI_ANDROID_KEYSTORE_PASSWORD"]
  $keyAlias = $localProperties["AUTO_AI_ANDROID_KEY_ALIAS"]
  $keyPassword = $localProperties["AUTO_AI_ANDROID_KEY_PASSWORD"]
}

if (-not ($keystore -and $storePassword -and $keyAlias -and $keyPassword)) {
  $signingDir = Join-Path $root ".android-signing"
  New-Item -ItemType Directory -Force -Path $signingDir | Out-Null
  $keystore = Join-Path $signingDir "auto-ai-release.jks"
  $storePassword = ([guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")).Substring(0, 32)
  $keyPassword = $storePassword
  $keyAlias = "auto-ai"
  if (Test-Path $keystore) {
    Remove-Item -Force $keystore
  }
  $keytool = if ($localJdk) { Join-Path $localJdk.FullName "bin\keytool.exe" } else { "keytool.exe" }
  & $keytool -genkeypair -v -keystore $keystore -storepass $storePassword -keypass $keyPassword -alias $keyAlias -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Auto-AI, OU=Android, O=Auto-AI, L=Online, S=Online, C=US"
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to generate Android release signing keystore."
  }
}

$localPropertyLines = @()
if ($sdkDir) {
  $localPropertyLines += "sdk.dir=$sdkDir"
}
$localPropertyLines += "AUTO_AI_ANDROID_KEYSTORE=$($keystore -replace "\\", "/")"
$localPropertyLines += "AUTO_AI_ANDROID_KEYSTORE_PASSWORD=$storePassword"
$localPropertyLines += "AUTO_AI_ANDROID_KEY_ALIAS=$keyAlias"
$localPropertyLines += "AUTO_AI_ANDROID_KEY_PASSWORD=$keyPassword"
Set-Content -Path $localPropertiesPath -Value $localPropertyLines -Encoding ASCII

Push-Location $frontend
try {
  $env:VITE_API_URL = $ApiUrl
  $env:VITE_BUILD_VERSION = $buildVersion
  npm install
  npm run build
}
finally {
  Pop-Location
}

Push-Location $root
try {
  npx cap sync android
}
finally {
  Pop-Location
}

Push-Location $android
try {
  .\gradlew.bat assembleRelease
}
finally {
  Pop-Location
}

$signedRelease = Join-Path $android "app/build/outputs/apk/release/app-release.apk"
$unsignedRelease = Join-Path $android "app/build/outputs/apk/release/app-release-unsigned.apk"
$apkSource = if (Test-Path $signedRelease) { $signedRelease } elseif (Test-Path $unsignedRelease) { $unsignedRelease } else { throw "Release APK was not generated." }

New-Item -ItemType Directory -Force -Path (Split-Path $output) | Out-Null
Copy-Item -Force $apkSource $output

$hash = (Get-FileHash -Algorithm SHA256 $output).Hash.ToLowerInvariant()
$size = (Get-Item $output).Length
Write-Output "APK=$output"
Write-Output "SHA256=$hash"
Write-Output "SIZE=$size"
