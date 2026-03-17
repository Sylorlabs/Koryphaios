#!/bin/bash

# Koryphaios App Launcher (using AppImage)
# This ensures assets are properly bundled

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"

# AppImage path
APPIMAGE="$SCRIPT_DIR/desktop/src-tauri/target/release/bundle/appimage/Koryphaios_0.2.0_amd64.AppImage"

# Port configuration
BASE_PORT=29450
MAX_PORT=29500
PORT_FILE="$SCRIPT_DIR/.koryphaios/.current-port"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[KORYPHAIOS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[KORYPHAIOS]${NC} $1"; }
log_error() { echo -e "${RED}[KORYPHAIOS]${NC} $1"; }
log_debug() { echo -e "${BLUE}[KORYPHAIOS]${NC} $1"; }

# Check if AppImage exists
if [ ! -f "$APPIMAGE" ]; then
    log_error "AppImage not found at: $APPIMAGE"
    log_info "Please build first: bun run build:desktop"
    exit 1
fi

# Check if a port is in use
is_port_in_use() {
    local port=$1
    if command -v nc >/dev/null 2>&1; then
        nc -z 127.0.0.1 $port 2>/dev/null && return 0
    fi
    if command -v ss >/dev/null 2>&1; then
        ss -tlnp 2>/dev/null | grep -q ":$port " && return 0
    fi
    (echo >/dev/tcp/127.0.0.1/$port) 2>/dev/null && return 0
    return 1
}

# Find available port
find_available_port() {
    local port=$BASE_PORT
    while [ $port -le $MAX_PORT ]; do
        if ! is_port_in_use $port; then
            echo $port
            return 0
        fi
        ((port++))
    done
    log_error "No available port found!"
    return 1
}

# Verify backend
verify_backend() {
    local port=$1
    local max_attempts=30
    local attempt=0
    while [ $attempt -lt $max_attempts ]; do
        if curl -s --max-time 2 "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
            return 0
        fi
        sleep 0.5
        ((attempt++))
    done
    return 1
}

# Cleanup
cleanup() {
    local exit_code=$?
    log_info "Shutting down..."
    if [ -n "$BACKEND_PID" ]; then
        if kill -0 $BACKEND_PID 2>/dev/null; then
            kill -TERM $BACKEND_PID 2>/dev/null || true
            sleep 1
            if kill -0 $BACKEND_PID 2>/dev/null; then
                kill -KILL $BACKEND_PID 2>/dev/null || true
            fi
        fi
    fi
    exit $exit_code
}

trap cleanup SIGINT SIGTERM EXIT

log_info "Starting Koryphaios..."

# Generate secrets
if [ -z "$JWT_SECRET" ]; then
    JWT_SECRET=$(openssl rand -hex 32)
    export JWT_SECRET
fi
if [ -z "$SESSION_TOKEN_SECRET" ]; then
    SESSION_TOKEN_SECRET=$(openssl rand -hex 32)
    export SESSION_TOKEN_SECRET
fi

# Find port
BACKEND_PORT=$(find_available_port)
log_info "Using port: $BACKEND_PORT"

export KORYPHAIOS_PORT=$BACKEND_PORT
export KORYPHAIOS_HOST="127.0.0.1"
export KORYPHAIOS_BACKEND_URL="http://127.0.0.1:$BACKEND_PORT"
export KORYPHAIOS_WS_URL="ws://127.0.0.1:$BACKEND_PORT/ws"

log_debug "Backend URL: $KORYPHAIOS_BACKEND_URL"

# Start backend
cd "$BACKEND_DIR"
log_info "Starting backend server..."
bun run src/server.ts &
BACKEND_PID=$!

if ! verify_backend $BACKEND_PORT; then
    log_error "Backend failed to start"
    exit 1
fi
log_info "Backend is ready!"

# Launch AppImage
log_info "Launching Koryphaios Desktop..."
cd "$SCRIPT_DIR"
exec "$APPIMAGE"
