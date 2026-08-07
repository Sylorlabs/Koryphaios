#!/usr/bin/env bash
# Assemble a macOS .app bundle and DMG from a pre-built Tauri shell binary
# and resource files — WITHOUT compiling Rust or running `tauri build`.
#
# This script runs on macOS only (needs hdiutil + codesign). It takes ~30
# seconds instead of 30+ minutes for a full Tauri build.
#
# Usage:
#   ./assemble-macos-bundle.sh \
#     --shell-bin <path-to-prebuilt-binary> \
#     --frontend <path-to-frontend-build> \
#     --backend <path-to-backend-binary> \
#     --config <path-to-config-dir> \
#     --icons <path-to-icon.icns> \
#     --version <version> \
#     --arch <x86_64|aarch64|universal> \
#     --output-dir <output-directory>
#
set -euo pipefail

# ─── Parse arguments ────────────────────────────────────────────────────────
SHELL_BIN=""
FRONTEND_DIR=""
BACKEND_BIN=""
CONFIG_DIR=""
ICON_FILE=""
VERSION=""
ARCH=""
OUTPUT_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --shell-bin)   SHELL_BIN="$2"; shift 2 ;;
    --frontend)    FRONTEND_DIR="$2"; shift 2 ;;
    --backend)     BACKEND_BIN="$2"; shift 2 ;;
    --config)      CONFIG_DIR="$2"; shift 2 ;;
    --icons)       ICON_FILE="$2"; shift 2 ;;
    --version)     VERSION="$2"; shift 2 ;;
    --arch)        ARCH="$2"; shift 2 ;;
    --output-dir)  OUTPUT_DIR="$2"; shift 2 ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

for var in SHELL_BIN FRONTEND_DIR BACKEND_BIN CONFIG_DIR ICON_FILE VERSION ARCH OUTPUT_DIR; do
  if [[ -z "${!var}" ]]; then
    echo "ERROR: --$(echo $var | tr '[:upper:]' '[:lower:]' | sed 's/_/-/g') is required"
    exit 1
  fi
done

APP_NAME="Koryphaios"
APP_BUNDLE="${OUTPUT_DIR}/${APP_NAME}.app"
BUNDLE_ID="com.sylorlabs.koryphaios"

echo "Assembling ${APP_NAME}.app v${VERSION} (${ARCH})..."

# ─── Clean and create bundle structure ──────────────────────────────────────
rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS"
mkdir -p "$APP_BUNDLE/Contents/Resources"
mkdir -p "$APP_BUNDLE/Contents/Resources/backend"
mkdir -p "$APP_BUNDLE/Contents/Resources/frontend"
mkdir -p "$APP_BUNDLE/Contents/Resources/config"

# ─── Copy shell binary ──────────────────────────────────────────────────────
cp "$SHELL_BIN" "$APP_BUNDLE/Contents/MacOS/${APP_NAME}"
chmod +x "$APP_BUNDLE/Contents/MacOS/${APP_NAME}"

# ─── Copy resources ─────────────────────────────────────────────────────────
cp -R "$FRONTEND_DIR/." "$APP_BUNDLE/Contents/Resources/frontend/"
cp "$BACKEND_BIN" "$APP_BUNDLE/Contents/Resources/backend/"
chmod +x "$APP_BUNDLE/Contents/Resources/backend/"*
cp -R "$CONFIG_DIR/." "$APP_BUNDLE/Contents/Resources/config/"
cp "$ICON_FILE" "$APP_BUNDLE/Contents/Resources/icon.icns"

# ─── Generate Info.plist ────────────────────────────────────────────────────
cat > "$APP_BUNDLE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleExecutable</key>
  <string>${APP_NAME}</string>
  <key>CFBundleIconFile</key>
  <string>icon.icns</string>
  <key>CFBundleIdentifier</key>
  <string>${BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${VERSION}</string>
  <key>CFBundleVersion</key>
  <string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key>
  <string>10.13</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
</dict>
</plist>
PLIST

# ─── PkgInfo (8-byte signature for APPL) ────────────────────────────────────
printf 'APPL????' > "$APP_BUNDLE/Contents/PkgInfo"

echo "Bundle assembled: $APP_BUNDLE"

# ─── Code signing ───────────────────────────────────────────────────────────
# Use ad-hoc signing ("-") by default. A future APPLE_SIGNING_IDENTITY secret
# overrides this for full Developer ID signing.
SIGN_IDENTITY="${APPLE_SIGNING_IDENTITY:--}"
echo "Code signing with identity: ${SIGN_IDENTITY}"

codesign --force --deep --strict --sign "$SIGN_IDENTITY" \
  --options runtime \
  --entitlements - \
  "$APP_BUNDLE" <<'ENTITLEMENTS'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.network.client</key>
  <true/>
  <key>com.apple.security.network.server</key>
  <true/>
</dict>
</plist>
ENTITLEMENTS

codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE"
echo "Code signature verified."

# ─── Create DMG ─────────────────────────────────────────────────────────────
DMG_NAME="${OUTPUT_DIR}/${APP_NAME}-${VERSION}-${ARCH}.dmg"
rm -f "$DMG_NAME"

# Create a temporary DMG directory with the app and a symlink to /Applications
DMG_STAGING=$(mktemp -d)
ln -s /Applications "$DMG_STAGING/Applications"
cp -R "$APP_BUNDLE" "$DMG_STAGING/"

# Create the DMG
hdiutil create \
  -volname "${APP_NAME}" \
  -srcfolder "$DMG_STAGING" \
  -ov -format UDZO \
  "$DMG_NAME"

rm -rf "$DMG_STAGING"

echo "DMG created: $DMG_NAME"
echo "macOS bundle assembly complete."
