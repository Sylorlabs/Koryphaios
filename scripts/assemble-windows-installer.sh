#!/usr/bin/env bash
# Assemble a Windows NSIS installer from a pre-built Tauri shell binary
# and resource files — WITHOUT compiling Rust or running `tauri build`.
#
# This script runs on Linux (uses makensis, which is cross-platform).
# No Windows runner needed for most releases.
#
# Usage:
#   ./assemble-windows-installer.sh \
#     --shell-bin <path-to-prebuilt-Koryphaios.exe> \
#     --frontend <path-to-frontend-build> \
#     --backend <path-to-backend.exe> \
#     --config <path-to-config-dir> \
#     --icons <path-to-icon.ico> \
#     --version <version> \
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
OUTPUT_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --shell-bin)   SHELL_BIN="$2"; shift 2 ;;
    --frontend)    FRONTEND_DIR="$2"; shift 2 ;;
    --backend)     BACKEND_BIN="$2"; shift 2 ;;
    --config)      CONFIG_DIR="$2"; shift 2 ;;
    --icons)       ICON_FILE="$2"; shift 2 ;;
    --version)     VERSION="$2"; shift 2 ;;
    --output-dir)  OUTPUT_DIR="$2"; shift 2 ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

for var in SHELL_BIN FRONTEND_DIR BACKEND_BIN CONFIG_DIR ICON_FILE VERSION OUTPUT_DIR; do
  if [[ -z "${!var}" ]]; then
    echo "ERROR: --$(echo $var | tr '[:upper:]' '[:lower:]' | sed 's/_/-/g') is required"
    exit 1
  fi
done

APP_NAME="Koryphaios"
BUNDLE_ID="com.sylorlabs.koryphaios"
COMPANY="Sylorlabs"

# ─── Prepare staging directory ──────────────────────────────────────────────
STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT

APP_STAGING="$STAGING/app"
mkdir -p "$APP_STAGING/backend"
mkdir -p "$APP_STAGING/frontend"
mkdir -p "$APP_STAGING/config"

# Copy shell binary
cp "$SHELL_BIN" "$APP_STAGING/${APP_NAME}.exe"

# Copy resources
cp -R "$FRONTEND_DIR/." "$APP_STAGING/frontend/"
cp "$BACKEND_BIN" "$APP_STAGING/backend/"
cp -R "$CONFIG_DIR/." "$APP_STAGING/config/"
cp "$ICON_FILE" "$APP_STAGING/icon.ico"

# ─── Generate NSIS installer script ─────────────────────────────────────────
NSI_SCRIPT="$STAGING/installer.nsi"
cat > "$NSI_SCRIPT" <<NSIS
!define APP_NAME "${APP_NAME}"
!define APP_EXE "${APP_NAME}.exe"
!define APP_VERSION "${VERSION}"
!define APP_PUBLISHER "${COMPANY}"
!define APP_URL "https://koryphaios.com"
!define APP_ID "${BUNDLE_ID}"

!include "MUI2.nsh"
!include "LogicLib.nsh"

Name "\${APP_NAME}"
OutFile "\${APP_NAME}-\${APP_VERSION}-x64-setup.exe"
InstallDir "\$LOCALAPPDATA\\\${APP_NAME}"
InstallDirRegKey HKCU "Software\\\${APP_PUBLISHER}\\\${APP_NAME}" "InstallDir"
RequestExecutionLevel user
Unicode True
ShowInstDetails show

; ─── Version info embedded in the .exe ──────────────────────────────────────
VIProductVersion "\${APP_VERSION}.0"
VIAddVersionKey "ProductName" "\${APP_NAME}"
VIAddVersionKey "FileVersion" "\${APP_VERSION}"
VIAddVersionKey "ProductVersion" "\${APP_VERSION}"
VIAddVersionKey "CompanyName" "\${APP_PUBLISHER}"
VIAddVersionKey "FileDescription" "\${APP_NAME} Installer"
VIAddVersionKey "LegalCopyright" "Copyright (c) 2024 \${APP_PUBLISHER}"

; ─── Modern UI settings ─────────────────────────────────────────────────────
!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "\$INSTDIR\\\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Launch \${APP_NAME}"
!define MUI_FINISHPAGE_NOAUTOCLOSE
!define MUI_UNFINISHPAGE_NOAUTOCLOSE

; ─── Pages ──────────────────────────────────────────────────────────────────
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; ─── Languages ──────────────────────────────────────────────────────────────
!insertmacro MUI_LANGUAGE "English"

; ─── Install sections ───────────────────────────────────────────────────────
Section "Install"
  SetOutPath "\$INSTDIR"

  ; Main executable
  File "\${APP_EXE}"
  File "icon.ico"

  ; Resources
  SetOutPath "\$INSTDIR\\backend"
  File /r "backend\\*.*"

  SetOutPath "\$INSTDIR\\frontend"
  File /r "frontend\\*.*"

  SetOutPath "\$INSTDIR\\config"
  File /r "config\\*.*"

  ; Start menu shortcuts
  CreateDirectory "\$SMPROGRAMS\\\${APP_NAME}"
  CreateShortcut "\$SMPROGRAMS\\\${APP_NAME}\\\${APP_NAME}.lnk" "\$INSTDIR\\\${APP_EXE}" "" "\$INSTDIR\\icon.ico"
  CreateShortcut "\$SMPROGRAMS\\\${APP_NAME}\\Uninstall \${APP_NAME}.lnk" "\$INSTDIR\\uninstall.exe"

  ; Desktop shortcut (optional, user can uncheck)
  CreateShortcut "\$DESKTOP\\\${APP_NAME}.lnk" "\$INSTDIR\\\${APP_EXE}" "" "\$INSTDIR\\icon.ico"

  ; Registry entries for uninstall + file associations
  WriteRegStr HKCU "Software\\\${APP_PUBLISHER}\\\${APP_NAME}" "InstallDir" "\$INSTDIR"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\\${APP_NAME}" "DisplayName" "\${APP_NAME}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\\${APP_NAME}" "UninstallString" "\$INSTDIR\\uninstall.exe"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\\${APP_NAME}" "DisplayVersion" "\${APP_VERSION}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\\${APP_NAME}" "Publisher" "\${APP_PUBLISHER}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\\${APP_NAME}" "DisplayIcon" "\$INSTDIR\\icon.ico"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\\${APP_NAME}" "InstallLocation" "\$INSTDIR"

  ; Estimate install size for Add/Remove Programs
  \${GetSize} "\$INSTDIR" "/S=0K" \$0 \$1 \$2
  IntFmt \$0 "0x%08X" \$0
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\\${APP_NAME}" "EstimatedSize" "\$0"

  ; Uninstaller
  WriteUninstaller "\$INSTDIR\\uninstall.exe"
SectionEnd

; ─── Uninstall section ──────────────────────────────────────────────────────
Section "Uninstall"
  ; Kill the app if running
  nsExec::ExecToLog 'taskkill /IM "\${APP_EXE}" /F 2>nul'
  nsExec::ExecToLog 'taskkill /IM "koryphaios-backend-*.exe" /F 2>nul'

  ; Remove files
  Delete "\$INSTDIR\\\${APP_EXE}"
  Delete "\$INSTDIR\\icon.ico"
  Delete "\$INSTDIR\\uninstall.exe"
  RMDir /r "\$INSTDIR\\backend"
  RMDir /r "\$INSTDIR\\frontend"
  RMDir /r "\$INSTDIR\\config"

  ; Remove shortcuts
  Delete "\$SMPROGRAMS\\\${APP_NAME}\\\${APP_NAME}.lnk"
  Delete "\$SMPROGRAMS\\\${APP_NAME}\\Uninstall \${APP_NAME}.lnk"
  RMDir "\$SMPROGRAMS\\\${APP_NAME}"
  Delete "\$DESKTOP\\\${APP_NAME}.lnk"

  ; Remove registry entries
  DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\\${APP_NAME}"
  DeleteRegKey HKCU "Software\\\${APP_PUBLISHER}\\\${APP_NAME}"
SectionEnd
NSIS

# ─── Run makensis ───────────────────────────────────────────────────────────
mkdir -p "$OUTPUT_DIR"

echo "Building NSIS installer with makensis..."
makensis -V2 "$NSI_SCRIPT"

# makensis outputs to the current directory or OutFile path
# The OutFile is relative, so it lands in $STAGING
INSTALLER="${STAGING}/${APP_NAME}-${VERSION}-x64-setup.exe"
if [[ -f "$INSTALLER" ]]; then
  mv "$INSTALLER" "$OUTPUT_DIR/"
  echo "Installer created: ${OUTPUT_DIR}/${APP_NAME}-${VERSION}-x64-setup.exe"
else
  echo "ERROR: makensis did not produce the expected installer"
  exit 1
fi

echo "Windows installer assembly complete."
