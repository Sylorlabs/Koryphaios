#!/bin/sh
# Koryphaios installer.
#
# Served as https://koryphaios.com/install (macOS and Linux). This file is the
# source of truth; scripts/install/README.md explains how it is deployed.
#
#   curl -fsSL https://koryphaios.com/install | sh
#
# macOS: downloads the DMG for this CPU, verifies it when a checksum is
#        published, copies Koryphaios.app into /Applications (or ~/Applications),
#        clears the quarantine flag on that installed copy only, and opens it.
# Linux: installs the AppImage as ~/.local/bin/koryphaios and writes a desktop
#        launcher entry.
#
# Nothing is sent anywhere: the only network traffic is the release download
# (and an optional .sha256 sidecar next to it).
#
# Overrides (mainly for tests; normal installs need none of them):
#   KORYPHAIOS_DOWNLOAD_BASE         default https://koryphaios.com/api/download
#   KORYPHAIOS_APPLICATIONS_DIR      default /Applications
#   KORYPHAIOS_INSTALL_TTY           default /dev/tty (where consent is asked)
#   KORYPHAIOS_INSTALL_ASSUME_YES=1  accept the "quit running app" prompt

set -eu
# pipefail is not POSIX; enable it where the shell has it (macOS /bin/sh, bash).
if (set -o pipefail) 2>/dev/null; then set -o pipefail; fi

download_base="${KORYPHAIOS_DOWNLOAD_BASE:-https://koryphaios.com/api/download}"
applications_dir="${KORYPHAIOS_APPLICATIONS_DIR:-/Applications}"
consent_tty="${KORYPHAIOS_INSTALL_TTY:-/dev/tty}"
bundle_id="com.sylorlabs.koryphaios"
app_name="Koryphaios.app"
release_help="See https://koryphaios.com/docs"

TMP_DIR=""
MOUNT_POINT=""

die() {
  echo "Koryphaios install failed: $*" >&2
  exit 1
}

cleanup() {
  status=$?
  if [ -n "$MOUNT_POINT" ] && [ -d "$MOUNT_POINT" ]; then
    if ! hdiutil detach -quiet "$MOUNT_POINT" >/dev/null 2>&1; then
      hdiutil detach -force -quiet "$MOUNT_POINT" >/dev/null 2>&1 ||
        echo "Warning: could not detach $MOUNT_POINT. Eject the Koryphaios disk image in Finder." >&2
    fi
  fi
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

make_temp_dir() {
  TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/koryphaios-install.XXXXXX")" ||
    die "could not create a temporary directory in ${TMPDIR:-/tmp}."
}

# download URL DESTINATION -> prints the final (redirect-resolved) URL.
download() {
  if ! effective_url="$(curl --proto '=https' --tlsv1.2 -fSL -w '%{url_effective}' -o "$2" "$1")"; then
    die "no compatible release is available right now. $release_help"
  fi
  if [ ! -s "$2" ]; then
    die "the download was empty. Try again. $release_help"
  fi
  printf '%s' "$effective_url"
}

# verify_checksum FILE RELEASE_URL
# Verifies FILE against RELEASE_URL.sha256 when the release publishes one.
# A missing or unreadable sidecar is a warning, not a failure; a readable
# checksum that does not match is always a hard stop.
verify_checksum() {
  expected_file="$TMP_DIR/expected.sha256"
  if ! curl --proto '=https' --tlsv1.2 -fsSL -o "$expected_file" "$2.sha256" 2>/dev/null; then
    echo "No published checksum for this release; skipping SHA-256 verification."
    return 0
  fi
  expected="$(awk 'NR == 1 { print $1 }' "$expected_file" 2>/dev/null || true)"
  expected="$(printf '%s' "$expected" | tr 'A-F' 'a-f')"
  if ! printf '%s' "$expected" | grep -Eq '^[0-9a-f]{64}$'; then
    echo "Warning: the published checksum file is not a SHA-256 value; skipping verification."
    return 0
  fi
  if command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$1" | awk '{ print $1 }')"
  elif command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$1" | awk '{ print $1 }')"
  else
    die "no SHA-256 tool found (shasum or sha256sum) to verify the download."
  fi
  if [ "$actual" != "$expected" ]; then
    die "checksum mismatch for the download (expected $expected, got $actual). Nothing was installed. $release_help"
  fi
  echo "SHA-256 verified."
}

# ask QUESTION -> returns 0 only on an explicit yes, read from the consent tty.
ask() {
  if ! ( : <"$consent_tty" ) 2>/dev/null; then
    return 1
  fi
  printf '%s [y/N] ' "$1" >&2
  reply=""
  read -r reply <"$consent_tty" || reply=""
  case "$reply" in
    y|Y|yes|YES|Yes) return 0 ;;
    *) return 1 ;;
  esac
}

app_is_running() {
  [ "$(osascript -e "application id \"$bundle_id\" is running" 2>/dev/null || echo false)" = "true" ]
}

quit_running_app() {
  if ! app_is_running; then
    return 0
  fi
  echo "Koryphaios is running. It has to quit before the new version can be installed."
  echo "Quitting asks the app to close normally, so it can prompt you about anything unsaved."
  if [ "${KORYPHAIOS_INSTALL_ASSUME_YES:-}" != "1" ]; then
    if ! ask "Quit Koryphaios now?"; then
      if ( : <"$consent_tty" ) 2>/dev/null; then
        die "installation cancelled. Koryphaios is still running and nothing was changed."
      fi
      die "Koryphaios is running and no terminal is available to confirm quitting it. Quit it, then run the installer again."
    fi
  fi
  osascript -e "tell application id \"$bundle_id\" to quit" >/dev/null 2>&1 ||
    die "could not ask Koryphaios to quit. Quit it yourself, then run the installer again."
  waited=0
  while app_is_running; do
    waited=$((waited + 1))
    if [ "$waited" -gt 60 ]; then
      die "Koryphaios did not quit within 30 seconds. Quit it yourself, then run the installer again."
    fi
    sleep 0.5
  done
}

# Choose where Koryphaios.app goes. Sets target_dir and PRIV ("" or "sudo").
choose_target() {
  PRIV=""
  if [ -d "$applications_dir" ] && [ -w "$applications_dir" ]; then
    target_dir="$applications_dir"
    return 0
  fi
  if [ -d "$applications_dir" ] && ask "$applications_dir needs administrator rights. Install Koryphaios there with sudo?"; then
    PRIV="sudo"
    target_dir="$applications_dir"
    return 0
  fi
  target_dir="$HOME/Applications"
  echo "Installing to $target_dir instead, because $applications_dir is not writable without administrator rights."
  mkdir -p "$target_dir" || die "could not create $target_dir."
}

install_macos() {
  case "$machine" in
    arm64|aarch64) platform="macos-arm64" ;;
    *) platform="macos-x64" ;;
  esac

  make_temp_dir
  dmg="$TMP_DIR/Koryphaios-$platform.dmg"
  echo "Downloading Koryphaios for macOS..."
  release_url="$(download "$download_base/$platform" "$dmg")"
  verify_checksum "$dmg" "$release_url"

  mount_dir="$TMP_DIR/mount"
  mkdir "$mount_dir"
  echo "Opening the disk image..."
  hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mount_dir" "$dmg" >/dev/null ||
    die "could not open the disk image. $release_help"
  MOUNT_POINT="$mount_dir"

  source_app="$mount_dir/$app_name"
  if [ ! -d "$source_app" ]; then
    die "the disk image does not contain $app_name. $release_help"
  fi

  quit_running_app
  choose_target

  destination="$target_dir/$app_name"
  staged="$target_dir/.Koryphaios.app.installing"
  $PRIV rm -rf "$staged"
  if ! $PRIV ditto "$source_app" "$staged"; then
    $PRIV rm -rf "$staged" 2>/dev/null || true
    die "copying Koryphaios into $target_dir failed. The existing app was left as it was."
  fi
  $PRIV rm -rf "$destination" || die "could not replace the existing $destination."
  $PRIV mv "$staged" "$destination" || die "could not put Koryphaios into $target_dir."
  echo "Installed Koryphaios at $destination"

  if hdiutil detach -quiet "$mount_dir" >/dev/null 2>&1; then
    MOUNT_POINT=""
  else
    echo "Warning: could not detach the disk image; it will be cleaned up when this script exits." >&2
  fi

  # Only the installed copy is touched. The downloaded DMG and its mounted
  # contents are never modified.
  if ! $PRIV xattr -dr com.apple.quarantine "$destination" 2>/dev/null; then
    echo "Warning: could not clear the quarantine flag on $destination." >&2
    echo "If macOS blocks the first launch, run: xattr -dr com.apple.quarantine \"$destination\"" >&2
  fi

  echo "Opening Koryphaios..."
  if ! open "$destination"; then
    echo "Warning: Koryphaios is installed but did not open. Open it from $target_dir." >&2
  fi
}

install_linux() {
  case "$machine" in
    x86_64|amd64) platform="linux-x64" ;;
    *) die "Koryphaios does not have a Linux $machine build yet. Build from source: https://koryphaios.com/docs" ;;
  esac

  install_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
  destination="$install_dir/koryphaios"
  make_temp_dir
  binary="$TMP_DIR/koryphaios"
  echo "Downloading Koryphaios for Linux..."
  release_url="$(download "$download_base/$platform" "$binary")"
  verify_checksum "$binary" "$release_url"
  chmod 755 "$binary"
  mkdir -p "$install_dir" || die "could not create $install_dir."
  mv -f "$binary" "$destination" || die "could not install to $destination."
  echo "Installed Koryphaios at $destination"

  apps_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  if mkdir -p "$apps_dir" 2>/dev/null; then
    launcher="$apps_dir/koryphaios.desktop"
    cat >"$launcher.tmp" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Koryphaios
Comment=Coordinate AI coding agents in one workspace
Exec="$destination"
Terminal=false
Categories=Development;
DESKTOP
    mv -f "$launcher.tmp" "$launcher"
    if command -v update-desktop-database >/dev/null 2>&1; then
      update-desktop-database "$apps_dir" >/dev/null 2>&1 || true
    fi
    echo "Added a launcher entry at $launcher"
  else
    echo "Warning: could not create $apps_dir, so no launcher entry was added." >&2
  fi

  echo "Run it with: $destination"
}

operating_system="$(uname -s)"
machine="$(uname -m)"

case "$operating_system" in
  Darwin) install_macos ;;
  Linux) install_linux ;;
  *)
    echo "Koryphaios does not have a build for $operating_system $machine yet." >&2
    echo "Build from source: https://koryphaios.com/docs" >&2
    exit 1
    ;;
esac
