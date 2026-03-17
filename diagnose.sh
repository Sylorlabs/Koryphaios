#!/bin/bash

# Koryphaios Diagnostic Script
# This will trace exactly what's happening during startup

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
DESKTOP_DIR="$SCRIPT_DIR/desktop"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║         KORYPHAIOS DIAGNOSTIC SCRIPT                   ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════╝${NC}"
echo ""

# Step 1: Clean up existing processes
echo -e "${YELLOW}[1/6] Cleaning up existing processes...${NC}"
pkill -f "koryphaios-desktop" 2>/dev/null || true
pkill -f "bun run src/server.ts" 2>/dev/null || true
sleep 2

# Check for zombie processes
echo "Checking for zombie processes on ports 29450-29500..."
if lsof -i :29450-29500 2>/dev/null | grep -q LISTEN; then
    echo -e "${RED}WARNING: Found processes using target ports:${NC}"
    lsof -i :29450-29500 2>/dev/null | grep LISTEN
    echo "Killing them..."
    lsof -i :29450-29500 2>/dev/null | grep LISTEN | awk '{print $2}' | xargs -r kill -9 2>/dev/null || true
    sleep 1
else
    echo -e "${GREEN}No zombie processes found${NC}"
fi

# Step 2: Check file permissions
echo ""
echo -e "${YELLOW}[2/6] Checking file permissions...${NC}"

DESKTOP_BINARY="$DESKTOP_DIR/src-tauri/target/release/koryphaios-desktop"
if [ ! -f "$DESKTOP_BINARY" ]; then
    echo -e "${RED}ERROR: Desktop binary not found at $DESKTOP_BINARY${NC}"
    echo "Please build first: cd desktop/src-tauri && cargo build --release"
    exit 1
fi
echo -e "${GREEN}Desktop binary found${NC}"

if [ ! -d "$SCRIPT_DIR/frontend/build" ]; then
    echo -e "${RED}ERROR: Frontend build not found${NC}"
    echo "Please build first: cd frontend && bun run build"
    exit 1
fi
echo -e "${GREEN}Frontend build found${NC}"

# Step 3: Find available port
echo ""
echo -e "${YELLOW}[3/6] Finding available port...${NC}"

# Use the same logic as launch-desktop.sh
BASE_PORT=29450
MAX_PORT=29500
BACKEND_PORT=""

for port in $(seq $BASE_PORT $MAX_PORT); do
    if ! nc -z 127.0.0.1 $port 2>/dev/null; then
        BACKEND_PORT=$port
        break
    fi
done

if [ -z "$BACKEND_PORT" ]; then
    echo -e "${RED}ERROR: No available port found!${NC}"
    exit 1
fi

echo -e "${GREEN}Using port: $BACKEND_PORT${NC}"

# Step 4: Export environment variables
echo ""
echo -e "${YELLOW}[4/6] Setting up environment...${NC}"

export KORYPHAIOS_PORT=$BACKEND_PORT
export KORYPHAIOS_HOST="127.0.0.1"
export KORYPHAIOS_BACKEND_URL="http://127.0.0.1:$BACKEND_PORT"
export KORYPHAIOS_WS_URL="ws://127.0.0.1:$BACKEND_PORT/ws"
export JWT_SECRET=$(openssl rand -hex 32)
export SESSION_TOKEN_SECRET=$(openssl rand -hex 32)

echo "Environment variables:"
echo "  KORYPHAIOS_PORT=$KORYPHAIOS_PORT"
echo "  KORYPHAIOS_BACKEND_URL=$KORYPHAIOS_BACKEND_URL"
echo "  KORYPHAIOS_WS_URL=$KORYPHAIOS_WS_URL"

# Step 5: Start backend and verify
echo ""
echo -e "${YELLOW}[5/6] Starting backend server...${NC}"

cd "$BACKEND_DIR"
bun run src/server.ts > /tmp/koryphaios_backend.log 2>&1 &
BACKEND_PID=$!

echo "Backend PID: $BACKEND_PID"
echo "Waiting for backend to be ready..."

# Wait for backend with timeout
MAX_WAIT=30
WAITED=0
while [ $WAITED -lt $MAX_WAIT ]; do
    if curl -s --max-time 1 "http://127.0.0.1:$BACKEND_PORT/api/health" > /dev/null 2>&1; then
        echo -e "${GREEN}Backend is ready!${NC}"
        break
    fi
    
    if ! kill -0 $BACKEND_PID 2>/dev/null; then
        echo -e "${RED}ERROR: Backend process died!${NC}"
        echo "Backend log:"
        cat /tmp/koryphaios_backend.log | tail -50
        exit 1
    fi
    
    sleep 1
    WAITED=$((WAITED + 1))
    echo -n "."
done

if [ $WAITED -ge $MAX_WAIT ]; then
    echo -e "${RED}ERROR: Backend failed to start within timeout${NC}"
    echo "Backend log:"
    cat /tmp/koryphaios_backend.log | tail -50
    kill $BACKEND_PID 2>/dev/null || true
    exit 1
fi

echo ""
echo "Testing backend endpoints..."
echo "  Health check:"
curl -s "http://127.0.0.1:$BACKEND_PORT/api/health" | head -1
echo ""

# Step 6: Launch desktop app
echo ""
echo -e "${YELLOW}[6/6] Launching desktop app...${NC}"
echo ""
echo -e "${GREEN}══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Desktop app is starting...                              ${NC}"
echo -e "${GREEN}  Look for debug output showing the URL being used       ${NC}"
echo -e "${GREEN}══════════════════════════════════════════════════════════${NC}"
echo ""

cd "$DESKTOP_DIR/src-tauri"

# Run the desktop app - capture all output
"$DESKTOP_BINARY" 2>&1 | tee /tmp/koryphaios_desktop.log &
DESKTOP_PID=$!

echo "Desktop PID: $DESKTOP_PID"
echo ""
echo "Logs are being written to:"
echo "  Backend: /tmp/koryphaios_backend.log"
echo "  Desktop: /tmp/koryphaios_desktop.log"
echo ""

# Wait a bit then show initial logs
sleep 3
echo "Initial desktop output:"
echo "---"
cat /tmp/koryphaios_desktop.log | head -30
echo "---"

echo ""
echo -e "${YELLOW}Press Enter to stop the application...${NC}"
read

# Cleanup
echo "Cleaning up..."
kill $DESKTOP_PID 2>/dev/null || true
kill $BACKEND_PID 2>/dev/null || true

echo ""
echo -e "${BLUE}Diagnostic complete!${NC}"
echo ""
echo "Full logs:"
echo "  Backend: /tmp/koryphaios_backend.log"
echo "  Desktop: /tmp/koryphaios_desktop.log"
