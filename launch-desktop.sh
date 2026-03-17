#!/bin/bash

# Koryphaios Desktop Launcher
# Advanced port management with automatic conflict resolution

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
DESKTOP_DIR="$SCRIPT_DIR/desktop"

# Use a high port range that's unlikely to conflict with common services
# Range: 29450-29500 (well above common development ports, below ephemeral range)
BASE_PORT=29450
MAX_PORT=29500
PORT_FILE="$SCRIPT_DIR/.koryphaios/.current-port"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[KORYPHAIOS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[KORYPHAIOS]${NC} $1"
}

log_error() {
    echo -e "${RED}[KORYPHAIOS]${NC} $1"
}

log_debug() {
    echo -e "${BLUE}[KORYPHAIOS]${NC} $1"
}

# Check if a port is in use
is_port_in_use() {
    local port=$1
    # Try multiple methods for maximum compatibility
    if command -v nc >/dev/null 2>&1; then
        nc -z 127.0.0.1 $port 2>/dev/null && return 0
    fi
    if command -v ss >/dev/null 2>&1; then
        ss -tlnp 2>/dev/null | grep -q ":$port " && return 0
    fi
    if command -v netstat >/dev/null 2>&1; then
        netstat -tlnp 2>/dev/null | grep -q ":$port " && return 0
    fi
    # Fallback: try to connect via /dev/tcp
    (echo >/dev/tcp/127.0.0.1/$port) 2>/dev/null && return 0
    return 1
}

# Find an available port with persistence
find_available_port() {
    local preferred_port=$1
    
    # First, try the preferred port
    if [ -n "$preferred_port" ] && ! is_port_in_use $preferred_port; then
        echo $preferred_port
        return 0
    fi
    
    # Check if we have a previously used port that's still available
    if [ -f "$PORT_FILE" ]; then
        local saved_port=$(cat "$PORT_FILE" 2>/dev/null)
        if [ -n "$saved_port" ] && ! is_port_in_use $saved_port; then
            echo $saved_port
            return 0
        fi
    fi
    
    # Search for an available port in our dedicated range
    local port=$BASE_PORT
    while [ $port -le $MAX_PORT ]; do
        if ! is_port_in_use $port; then
            # Save this port for future use
            mkdir -p "$(dirname "$PORT_FILE")"
            echo $port > "$PORT_FILE"
            echo $port
            return 0
        fi
        ((port++))
    done
    
    # If our range is exhausted, search in ephemeral range
    log_warn "Dedicated port range exhausted, searching ephemeral range..."
    port=49200
    while [ $port -lt 65535 ]; do
        if ! is_port_in_use $port; then
            echo $port
            return 0
        fi
        ((port++))
    done
    
    log_error "No available port found!"
    return 1
}

# Verify backend is actually responding
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

# Cleanup function
cleanup() {
    local exit_code=$?
    log_info "Shutting down Koryphaios..."
    
    if [ -n "$BACKEND_PID" ]; then
        if kill -0 $BACKEND_PID 2>/dev/null; then
            log_debug "Stopping backend (PID: $BACKEND_PID)..."
            kill -TERM $BACKEND_PID 2>/dev/null || true
            sleep 1
            # Force kill if still running
            if kill -0 $BACKEND_PID 2>/dev/null; then
                kill -KILL $BACKEND_PID 2>/dev/null || true
            fi
        fi
    fi
    
    # Kill any orphaned backend processes
    pkill -f "bun run src/server.ts" 2>/dev/null || true
    
    log_info "Shutdown complete"
    exit $exit_code
}

trap cleanup SIGINT SIGTERM EXIT

# Main execution
log_info "Starting Koryphaios Desktop..."

# Generate required secrets if not set
if [ -z "$JWT_SECRET" ]; then
    JWT_SECRET=$(openssl rand -hex 32)
    export JWT_SECRET
    log_debug "Generated JWT_SECRET"
fi

if [ -z "$SESSION_TOKEN_SECRET" ]; then
    SESSION_TOKEN_SECRET=$(openssl rand -hex 32)
    export SESSION_TOKEN_SECRET
    log_debug "Generated SESSION_TOKEN_SECRET"
fi

# Find available port
log_debug "Finding available port..."
BACKEND_PORT=$(find_available_port)
if [ $? -ne 0 ]; then
    log_error "Failed to find an available port"
    exit 1
fi

log_info "Using port: $BACKEND_PORT"

# Export for backend
export KORYPHAIOS_PORT=$BACKEND_PORT
export KORYPHAIOS_HOST="127.0.0.1"

# Set backend URLs for desktop app
export KORYPHAIOS_BACKEND_URL="http://127.0.0.1:$BACKEND_PORT"
export KORYPHAIOS_WS_URL="ws://127.0.0.1:$BACKEND_PORT/ws"

# Export for desktop app to read (Rust side)
export KORYPHAIOS_DESKTOP_PORT=$BACKEND_PORT

log_debug "Backend URL: $KORYPHAIOS_BACKEND_URL"
log_debug "WebSocket URL: $KORYPHAIOS_WS_URL"

# Start backend
cd "$BACKEND_DIR"
log_info "Starting backend server..."

bun run src/server.ts &
BACKEND_PID=$!

# Wait for backend to be ready
log_debug "Waiting for backend to be ready..."
if ! verify_backend $BACKEND_PORT; then
    log_error "Backend failed to start within timeout"
    # Check if process is still running
    if ! kill -0 $BACKEND_PID 2>/dev/null; then
        log_error "Backend process died unexpectedly"
    fi
    exit 1
fi

log_info "Backend is ready!"

# Start desktop app - IMPORTANT: Must run from src-tauri directory for assets to load
log_info "Starting desktop application..."

# Determine which binary to use
if [ -f "$DESKTOP_DIR/src-tauri/target/release/koryphaios-desktop" ]; then
    DESKTOP_BINARY="$DESKTOP_DIR/src-tauri/target/release/koryphaios-desktop"
elif [ -f "$DESKTOP_DIR/src-tauri/target/debug/koryphaios-desktop" ]; then
    DESKTOP_BINARY="$DESKTOP_DIR/src-tauri/target/debug/koryphaios-desktop"
else
    log_warn "Desktop app binary not found, building now..."
    log_info "This may take a few minutes..."
    
    # Build the desktop app
    cd "$DESKTOP_DIR"
    if ! bun install 2>/dev/null; then
        log_warn "bun install failed, continuing..."
    fi
    
    # Build the Tauri app in release mode with devtools enabled
    cd "$DESKTOP_DIR/src-tauri"
    if ! cargo build --release --features tauri/devtools 2>&1; then
        log_error "Failed to build desktop app"
        exit 1
    fi
    
    if [ -f "$DESKTOP_DIR/src-tauri/target/release/koryphaios-desktop" ]; then
        DESKTOP_BINARY="$DESKTOP_DIR/src-tauri/target/release/koryphaios-desktop"
        log_info "Build successful!"
    else
        log_error "Build completed but binary not found!"
        exit 1
    fi
fi

# Run the desktop app from the src-tauri directory so it can find frontend assets
log_info "Launching Koryphaios..."
log_debug "Working directory: $(pwd)"
log_debug "Desktop binary: $DESKTOP_BINARY"
log_debug "Environment variables:"
log_debug "  KORYPHAIOS_PORT=$KORYPHAIOS_PORT"
log_debug "  KORYPHAIOS_BACKEND_URL=$KORYPHAIOS_BACKEND_URL"
log_debug "  KORYPHAIOS_WS_URL=$KORYPHAIOS_WS_URL"

# Enable DevTools environment variable (backup method)
export TAURI_DEVTOOLS=1

cd "$DESKTOP_DIR/src-tauri"
exec "$DESKTOP_BINARY"
