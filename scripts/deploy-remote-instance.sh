#!/usr/bin/env bash
# Deploy the headless Koryphaios instance to a VPS over an existing SSH key.
# Usage: RELAY_URL=... RELAY_HOST_SECRET=... ./scripts/deploy-remote-instance.sh user@host

set -euo pipefail

TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
  printf 'Usage: RELAY_URL=... RELAY_HOST_SECRET=... %s user@host\n' "$0" >&2
  exit 2
fi
if [[ "${KORYPHAIOS_INSTALL_RELAY:-false}" != true ]]; then
  : "${RELAY_URL:?RELAY_URL is required}"
  : "${RELAY_HOST_SECRET:?RELAY_HOST_SECRET is required}"
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# Send a coherent runtime snapshot: the public branch can be behind this
# checkout's imported modules. The allowlist excludes local config/state,
# credentials, node_modules, and native desktop artifacts.
REMOTE_DIR="$(ssh -T "$TARGET" 'umask 077; mktemp -d /tmp/kory-deploy.XXXXXX')"
if [[ ! "$REMOTE_DIR" =~ ^/tmp/kory-deploy\.[a-zA-Z0-9]+$ ]]; then
  printf '%s\n' 'SSH did not return a valid deployment staging directory.' >&2
  exit 1
fi
trap 'ssh -T "$TARGET" "rm -rf -- $REMOTE_DIR"' EXIT
COPYFILE_DISABLE=1 tar -czf - -C "$ROOT_DIR" \
  backend/src shared/src backend/package.json shared/package.json \
  frontend/package.json desktop/package.json mcp-server/package.json \
  package.json bun.lock skills-v5 docker/freebuff-runtime \
  relay/server.ts relay/devices.ts relay/mobile.ts relay/mobile-client.ts scripts/install-remote-instance.sh scripts/install-antigravity-runtime.ts scripts/link-device.ts scripts/koryphaios.ts scripts/admin-cli.ts | \
  ssh -T "$TARGET" "umask 077; cat > $REMOTE_DIR/runtime.tar.gz && tar -xzf $REMOTE_DIR/runtime.tar.gz -C $REMOTE_DIR scripts/install-remote-instance.sh"

# Send configuration over stdin rather than putting the relay secret in the
# remote process arguments or shell history.
{
  printf 'export RELAY_URL=%q\n' "${RELAY_URL:-}"
  printf 'export RELAY_HOST_SECRET=%q\n' "${RELAY_HOST_SECRET:-}"
  printf 'export KORYPHAIOS_REMOTE_SOURCE_ARCHIVE=%q\n' "$REMOTE_DIR/runtime.tar.gz"
  for name in \
    KORYPHAIOS_INSTALL_DIR KORYPHAIOS_DATA_DIR KORYPHAIOS_REMOTE_WORKSPACE \
    KORYPHAIOS_REMOTE_CONTROL_STATE_FILE KORYPHAIOS_SERVICE_USER KORYPHAIOS_REPO_URL \
    KORYPHAIOS_REPO_REF KORYPHAIOS_PORT KORYPHAIOS_REMOTE_HOST_NAME \
    KORYPHAIOS_REMOTE_SESSION_NAME KORYPHAIOS_INSTALL_RELAY SESSION_TOKEN_SECRET; do
    if [[ -n "${!name:-}" ]]; then
      printf 'export %s=%q\n' "$name" "${!name}"
    fi
  done
  printf 'bash %q\n' "$REMOTE_DIR/scripts/install-remote-instance.sh"
} | ssh -T "$TARGET" 'bash -s'
