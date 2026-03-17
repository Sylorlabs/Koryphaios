#!/bin/bash

# Koryphaios Launcher - Simplified with automatic port discovery
# The backend automatically finds an available port and writes it to .active-port.json
# The desktop app reads this file to discover the correct port

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
DESKTOP_DIR="$SCRIPT_DIR/desktop"
PORT_FILE="$SCRIPT_DIR/.koryphaios/.active-port.json"

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

# Cleanup function
cleanup() {
    local exit_code=$?
    log_info "Shutting down..."
    
    if [ -n "$BACKEND_PID" ]; then
        if kill -0 $BACKEND_PID 2>/dev/null; then
            log_debug "Stopping backend (PID: $BACKEND_PID)..."
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

# Generate required secrets if not set
if [ -z "$JWT_SECRET" ]; then
    JWT_SECRET=$(openssl rand -hex 32)
    export JWT_SECRET
fi

if [ -z "$SESSION_TOKEN_SECRET" ]; then
    SESSION_TOKEN_SECRET=$(openssl rand -hex 32)
    export SESSION_TOKEN_SECRET
fi

# Remove stale port file if exists
rm -f "$PORT_FILE"

# Start backend - it will auto-find an available port
log_info "Starting backend server..."
cd "$BACKEND_DIR"
bun run src/server.ts &
BACKEND_PID=$!

# Wait for backend to write port file
log_debug "Waiting for backend to start..."
ATTEMPTS=0
MAX_ATTEMPTS=60
while [ ! -f "$PORT_FILE" ] && [ $ATTEMPTS -lt $MAX_ATTEMPTS ]; do
    sleep 0.5
    ((ATTEMPTS++))
    
    # Check if backend is still running
    if ! kill -0 $BACKEND_PID 2>/dev/null; then
        log_error "Backend process died unexpectedly"
        exit 1
    fi
done

if [ ! -f "$PORT_FILE" ]; then
    log_error "Backend failed to write port file within timeout"
    exit 1
fi

# Read the actual port from the file
ACTUAL_PORT=$(cat "$PORT_FILE" | grep -o '"port":[0-9]*' | cut -d':' -f2)
log_info "Backend running on port $ACTUAL_PORT"

# Determine which binary to use
if [ -f "$DESKTOP_DIR/src-tauri/target/release/koryphaios-desktop" ]; then
    DESKTOP_BINARY="$DESKTOP_DIR/src-tauri/target/release/koryphaios-desktop"
elif [ -f "$DESKTOP_DIR/src-tauri/target/debug/koryphaios-desktop" ]; then
    DESKTOP_BINARY="$DESKTOP_DIR/src-tauri/target/debug/koryphaios-desktop"
else
    log_error "Desktop app binary not found. Please build first:"
    log_error "  cd desktop && bun run build"
    exit 1
fi

# Start desktop app - it will read the port from .active-port.json
log_info "Launching Koryphaios Desktop..."
cd "$DESKTOP_DIR/src-tauri"
exec "$DESKTOP_BINARY"
