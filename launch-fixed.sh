#!/bin/bash

# Koryphaios Launcher - Fixed version with window visibility
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Kill any existing instances
pkill -f "koryphaios-desktop" 2>/dev/null || true
pkill -f "bun run src/server.ts" 2>/dev/null || true
sleep 2

# Port configuration - using high range to avoid common dev port conflicts
PORT=29473

echo "[KORYPHAIOS] Starting..."

# Export for backend
export KORYPHAIOS_PORT=$PORT
export KORYPHAIOS_HOST="127.0.0.1"
export KORYPHAIOS_BACKEND_URL="http://127.0.0.1:$PORT"
export KORYPHAIOS_WS_URL="ws://127.0.0.1:$PORT/ws"

# Generate secrets
export JWT_SECRET=$(openssl rand -hex 32)
export SESSION_TOKEN_SECRET=$(openssl rand -hex 32)

# Start backend
echo "[KORYPHAIOS] Starting backend on port $PORT..."
cd "$SCRIPT_DIR/backend"
bun run src/server.ts &
BACKEND_PID=$!

# Wait for backend
echo "[KORYPHAIOS] Waiting for backend..."
for i in {1..30}; do
    if curl -s "http://127.0.0.1:$PORT/api/health" > /dev/null 2>&1; then
        echo "[KORYPHAIOS] Backend ready!"
        break
    fi
    sleep 0.5
done

# Start desktop app with software rendering (more compatible)
echo "[KORYPHAIOS] Starting desktop app..."
cd "$SCRIPT_DIR/desktop/src-tauri"
export LIBGL_ALWAYS_SOFTWARE=1
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export DISPLAY=:2

./target/release/koryphaios-desktop &
DESKTOP_PID=$!

echo "[KORYPHAIOS] Desktop PID: $DESKTOP_PID"
echo "[KORYPHAIOS] Waiting for window..."

# Wait for window to appear
for i in {1..20}; do
    WINDOW_ID=$(wmctrl -l 2>/dev/null | grep "Koryphaios" | awk '{print $1}' | head -1)
    if [ -n "$WINDOW_ID" ]; then
        echo "[KORYPHAIOS] Window found: $WINDOW_ID"
        sleep 1
        
        # Force window to be visible and focused
        wmctrl -i -r "$WINDOW_ID" -b remove,hidden
        wmctrl -i -r "$WINDOW_ID" -b remove,minimized
        wmctrl -i -a "$WINDOW_ID" 2>/dev/null || true
        
        echo "[KORYPHAIOS] Window should now be visible!"
        break
    fi
    sleep 0.5
done

echo ""
echo "[KORYPHAIOS] App is running. Press Ctrl+C to stop."
echo ""

# Wait for interrupt
trap "echo '[KORYPHAIOS] Shutting down...'; kill $DESKTOP_PID 2>/dev/null; kill $BACKEND_PID 2>/dev/null; exit 0" INT TERM
wait
