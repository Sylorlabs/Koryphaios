#!/bin/bash
# Repair the bun sidecar inside a built AppImage.
#
# linuxdeploy runs its bundled patchelf over every ELF in the AppDir to set
# rpaths. bun-compiled binaries store their JS blob at an offset from the end
# of the file, so patchelf's section rewrite corrupts them (the shipped
# backend core-dumps on launch). There is no way to exclude a file from
# linuxdeploy's scan, so we rebuild the AppImage afterwards with the pristine
# sidecar swapped back in.
#
# Usage: fix-appimage-sidecar.sh <app.AppImage> <pristine-sidecar-binary>
set -euo pipefail

APPIMAGE="$(realpath "$1")"
SIDECAR="$(realpath "$2")"
TOOL_DIR="${HOME}/.cache/tauri"
APPIMAGETOOL="${TOOL_DIR}/appimagetool-x86_64.AppImage"

if [ ! -x "$APPIMAGETOOL" ]; then
  mkdir -p "$TOOL_DIR"
  curl -sL -o "$APPIMAGETOOL" \
    "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage"
  chmod +x "$APPIMAGETOOL"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

"$APPIMAGE" --appimage-extract >/dev/null
cp "$SIDECAR" squashfs-root/usr/bin/koryphaios-backend
chmod +x squashfs-root/usr/bin/koryphaios-backend

# Sanity check: the binary must load without an instant crash. The backend
# ignores argv and starts SERVING, so cap it hard — a healthy binary survives
# 2s (timeout kills it: exit 124/137); a patchelf-corrupted one dies instantly
# with SIGSEGV/SIGABRT (139/134).
set +e
KORYPHAIOS_PORT=0 timeout -k 1 2 squashfs-root/usr/bin/koryphaios-backend >/dev/null 2>&1
code=$?
set -e
if [ "$code" = 139 ] || [ "$code" = 134 ]; then
  echo "ERROR: replacement sidecar crashes (exit $code) — aborting" >&2
  exit 1
fi

ARCH=x86_64 "$APPIMAGETOOL" -n squashfs-root "$APPIMAGE" >/dev/null 2>&1
echo "Repacked $APPIMAGE with pristine sidecar"
