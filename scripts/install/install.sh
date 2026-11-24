#!/bin/sh
set -eu

download_base="https://koryphaios.com/api/download"
operating_system="$(uname -s)"
machine="$(uname -m)"

case "$operating_system:$machine" in
  Darwin:arm64|Darwin:aarch64)
    platform="macos-arm64"
    ;;
  Darwin:x86_64|Darwin:amd64)
    platform="macos-x64"
    ;;
  Linux:x86_64|Linux:amd64)
    platform="linux-x64"
    ;;
  *)
    echo "Koryphaios does not have a build for $operating_system $machine yet." >&2
    echo "Build from source: https://koryphaios.com/docs" >&2
    exit 1
    ;;
esac

if [ "$operating_system" = "Darwin" ]; then
  downloads_dir="${XDG_DOWNLOAD_DIR:-$HOME/Downloads}"
  mkdir -p "$downloads_dir"
  destination="$downloads_dir/Koryphaios.dmg"
  echo "Downloading Koryphaios for macOS..."
  if ! curl --proto '=https' --tlsv1.2 -fL "$download_base/$platform" -o "$destination"; then
    echo "No compatible release is available right now. See https://koryphaios.com/docs" >&2
    exit 1
  fi
  echo "Downloaded $destination"
  open "$destination"
  echo "Drag Koryphaios into Applications in the window that opens."
  exit 0
fi

install_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
destination="$install_dir/koryphaios"
temporary_file="$(mktemp "${TMPDIR:-/tmp}/koryphaios.XXXXXX")"
trap 'rm -f "$temporary_file"' EXIT HUP INT TERM

echo "Downloading Koryphaios for Linux..."
if ! curl --proto '=https' --tlsv1.2 -fL "$download_base/$platform" -o "$temporary_file"; then
  echo "No compatible release is available right now. See https://koryphaios.com/docs" >&2
  exit 1
fi
chmod 755 "$temporary_file"
mkdir -p "$install_dir"
mv "$temporary_file" "$destination"
trap - EXIT HUP INT TERM

echo "Installed Koryphaios at $destination"
echo "Run it with: $destination"
