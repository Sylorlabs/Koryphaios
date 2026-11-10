#!/usr/bin/env bash
# Install a headless Koryphaios instance for relay-based remote control.
# This script is intended for a fresh Debian/Ubuntu VPS and is normally run by
# deploy-remote-instance.sh over SSH.

set -euo pipefail

if [[ "${KORYPHAIOS_INSTALL_RELAY:-false}" != true ]]; then
  : "${RELAY_URL:?RELAY_URL is required}"
  : "${RELAY_HOST_SECRET:?RELAY_HOST_SECRET is required}"
fi

INSTALL_DIR="${KORYPHAIOS_INSTALL_DIR:-/opt/koryphaios}"
DATA_DIR="${KORYPHAIOS_DATA_DIR:-/var/lib/koryphaios/data}"
WORKSPACE_DIR="${KORYPHAIOS_REMOTE_WORKSPACE:-/var/lib/koryphaios/workspace}"
STATE_FILE="${KORYPHAIOS_REMOTE_CONTROL_STATE_FILE:-/var/lib/koryphaios/data/remote-control.json}"
SERVICE_USER="${KORYPHAIOS_SERVICE_USER:-koryphaios}"
REPO_URL="${KORYPHAIOS_REPO_URL:-https://github.com/Sylorlabs/Koryphaios.git}"
REPO_REF="${KORYPHAIOS_REPO_REF:-}"
PORT="${KORYPHAIOS_PORT:-3001}"
HOST_NAME="${KORYPHAIOS_REMOTE_HOST_NAME:-Remote Koryphaios}"
SESSION_NAME="${KORYPHAIOS_REMOTE_SESSION_NAME:-Remote Koryphaios}"

if [[ "$(id -u)" -ne 0 ]]; then
  printf '%s\n' 'Run this installer as root (or through sudo).' >&2
  exit 1
fi

# Paths also enter systemd directives; keep that configuration unambiguous.
for path in "$INSTALL_DIR" "$DATA_DIR" "$WORKSPACE_DIR" "$STATE_FILE"; do
  if [[ ! "$path" =~ ^/[a-zA-Z0-9_./-]+$ ]]; then
    printf '%s\n' 'Installation paths must be absolute and contain no spaces or control characters.' >&2
    exit 2
  fi
done
if [[ ! "$SERVICE_USER" =~ ^[a-z_][a-z0-9_-]*$ || ! "$PORT" =~ ^[0-9]+$ ]] || \
  (( PORT < 1 || PORT > 65535 )); then
  printf '%s\n' 'Invalid service user or port.' >&2
  exit 2
fi

if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl git openssl unzip bubblewrap
elif command -v pacman >/dev/null; then
  pacman -S --needed --noconfirm ca-certificates curl git openssl unzip bubblewrap
else
  printf '%s\n' 'This installer supports Debian, Ubuntu, and Arch Linux.' >&2
  exit 2
fi

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/var/lib/$SERVICE_USER" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" \
  "$INSTALL_DIR" "$DATA_DIR" "$WORKSPACE_DIR" "$(dirname "$STATE_FILE")"

if [[ ! -e "$INSTALL_DIR/.git" ]]; then
  if [[ -n "$REPO_REF" ]]; then
    git clone --branch "$REPO_REF" --depth 1 "$REPO_URL" "$INSTALL_DIR"
  else
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
  fi
fi
if [[ -n "${KORYPHAIOS_REMOTE_SOURCE_ARCHIVE:-}" ]]; then
  tar -xzf "$KORYPHAIOS_REMOTE_SOURCE_ARCHIVE" -C "$INSTALL_DIR"
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

SERVICE_HOME="/var/lib/$SERVICE_USER"
BUN_VERSION=1.3.14
if [[ ! -x "$SERVICE_HOME/.bun/bin/bun" ]] || \
  [[ "$("$SERVICE_HOME/.bun/bin/bun" --version)" != "$BUN_VERSION" ]]; then
  runuser -u "$SERVICE_USER" -- env HOME="$SERVICE_HOME" bash -c \
    'curl -fsSL https://bun.sh/install | bash -s -- "bun-v$1"' -- "$BUN_VERSION"
fi
BUN="$SERVICE_HOME/.bun/bin/bun"
# The headless runtime uses bun:sqlite and platform-resolved dependencies, not
# the workspace's Node/desktop native-addon install hooks (better-sqlite3).
runuser -u "$SERVICE_USER" -- env HOME="$SERVICE_HOME" PATH="$SERVICE_HOME/.bun/bin:$PATH" \
  bash -c 'cd "$1" && "$2" install --frozen-lockfile --ignore-scripts' -- "$INSTALL_DIR" "$BUN"
if [[ ! -f "$INSTALL_DIR/backend/src/remote-instance.ts" ]]; then
  printf '%s\n' 'This source revision has no remote host support. Deploy from the updated checkout.' >&2
  exit 1
fi
if [[ -f "$INSTALL_DIR/scripts/koryphaios.ts" ]]; then
  # Standalone admin binary; no Bun or source-tree access needed by the operator.
  "$BUN" build --compile "$INSTALL_DIR/scripts/koryphaios.ts" --outfile /usr/local/bin/koryphaios
  chmod 0755 /usr/local/bin/koryphaios
fi

if [[ "${KORYPHAIOS_INSTALL_RELAY:-false}" == true ]]; then
  if [[ ! -f /etc/koryphaios-test-relay.env ]]; then
    umask 077
    printf 'HOST=127.0.0.1\nPORT=8080\nHOST_SECRET=%s\nJWT_SECRET=%s\n' \
      "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > /etc/koryphaios-test-relay.env
  fi
  # Generated locally with shell-safe hex values; never print these secrets.
  RELAY_URL=http://127.0.0.1:8080
  RELAY_HOST_SECRET="$(source /etc/koryphaios-test-relay.env; printf '%s' "$HOST_SECRET")"
  cat > /etc/systemd/system/koryphaios-test-relay.service <<EOF
[Unit]
Description=Koryphaios SSH-tunneled test relay
After=network-online.target

[Service]
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR/relay
EnvironmentFile=/etc/koryphaios-test-relay.env
Environment=HOME=$SERVICE_HOME
ExecStart=$BUN run server.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable koryphaios-test-relay.service
  systemctl restart koryphaios-test-relay.service
fi

if [[ ! -e "$WORKSPACE_DIR/.git" ]]; then
  runuser -u "$SERVICE_USER" -- env HOME="$SERVICE_HOME" bash -c \
    'cd "$1" && git init -q && git -c user.name="Koryphaios Remote" -c user.email=remote@localhost commit --allow-empty -qm "Initialize remote workspace"' -- "$WORKSPACE_DIR"
fi

umask 077
if [[ -f /etc/koryphaios-remote.env ]]; then
  printf '%s\n' 'Preserving existing /etc/koryphaios-remote.env; edit it to change provider or relay settings.'
else
  SESSION_TOKEN_SECRET="${SESSION_TOKEN_SECRET:-$(openssl rand -hex 32)}"
  write_environment() {
    local name="$1" value="$2"
    if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
      printf 'Multiline environment setting: %s\n' "$name" >&2
      exit 2
    fi
    value="${value//\\/\\\\}"
    value="${value//\"/\\\"}"
    value="${value//\$/\\\$}"
    value="${value//\`/\\\`}"
    printf '%s="%s"\n' "$name" "$value"
  }
  {
    write_environment KORYPHAIOS_DATA_DIR "$DATA_DIR"
    write_environment KORYPHAIOS_HOST 127.0.0.1
    write_environment KORYPHAIOS_PORT "$PORT"
    write_environment KORYPHAIOS_REMOTE_CONTROL true
    write_environment KORYPHAIOS_REMOTE_WORKSPACE "$WORKSPACE_DIR"
    write_environment KORYPHAIOS_REMOTE_CONTROL_STATE_FILE "$STATE_FILE"
    write_environment KORYPHAIOS_REMOTE_HOST_NAME "$HOST_NAME"
    write_environment KORYPHAIOS_REMOTE_SESSION_NAME "$SESSION_NAME"
    write_environment RELAY_URL "$RELAY_URL"
    write_environment RELAY_HOST_SECRET "$RELAY_HOST_SECRET"
    write_environment SESSION_TOKEN_SECRET "$SESSION_TOKEN_SECRET"
  } > /etc/koryphaios-remote.env
  chmod 0600 /etc/koryphaios-remote.env
fi
# Preserve a stable per-install passphrase so the existing local KMS contract
# can initialize on a fresh headless machine without an interactive desktop.
if ! grep -q '^KORYPHAIOS_KMS_PASSPHRASE=' /etc/koryphaios-remote.env; then
  printf 'KORYPHAIOS_KMS_PASSPHRASE="%s"\n' "$(openssl rand -hex 32)" >> /etc/koryphaios-remote.env
fi

cat > /etc/systemd/system/koryphaios-remote.service <<EOF
[Unit]
Description=Koryphaios headless remote instance
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=/etc/koryphaios-remote.env
Environment=HOME=$SERVICE_HOME
Environment=PATH=$SERVICE_HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$BUN run backend/src/server.ts
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable koryphaios-remote.service
STARTED_AT="$(date +%s)"
systemctl restart koryphaios-remote.service
READY=false
for attempt in $(seq 1 60); do
  if systemctl is-active --quiet koryphaios-remote.service && \
    runuser -u "$SERVICE_USER" -- "$BUN" -e '
      const state = await Bun.file(process.argv[1]).json();
      if (!/^[A-HJ-NP-Z2-9]{8}$/.test(state.joinCode ?? "") ||
          !Number.isFinite(Date.parse(state.updatedAt)) ||
          Date.parse(state.updatedAt) < Number(process.argv[2]) * 1000) process.exit(1);
      const response = await fetch(`http://127.0.0.1:${process.argv[3]}/api/health`,
        { signal: AbortSignal.timeout(2000) });
      const health = await response.json();
      if (!response.ok || health.data?.id !== "koryphaios") process.exit(1);
    ' "$STATE_FILE" "$STARTED_AT" "$PORT" >/dev/null 2>&1; then
    READY=true
    break
  fi
  sleep 2
done
if [[ "$READY" != true ]]; then
  systemctl stop koryphaios-remote.service
  printf '%s\n' 'Remote hosting did not become ready. Inspect journalctl -u koryphaios-remote.' >&2
  exit 1
fi

printf '\n%s\n' 'Remote Koryphaios installed.'
printf '%s\n' "Read the join code with: cat '$STATE_FILE'"
printf '%s\n' 'The backend listens on loopback only; remote traffic uses the configured relay.'
printf '%s\n' "Admin CLI: koryphaios --port $PORT devices list"
