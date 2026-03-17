#!/bin/bash
# Test script to verify environment variable propagation

echo "=== Environment Variable Test ==="
echo "KORYPHAIOS_PORT: $KORYPHAIOS_PORT"
echo "KORYPHAIOS_BACKEND_URL: $KORYPHAIOS_BACKEND_URL"
echo "KORYPHAIOS_WS_URL: $KORYPHAIOS_WS_URL"
echo ""

# Test the desktop binary with env vars
DESKTOP_DIR="/home/micah/Desktop/sylorlabs projects/Koryphaios/desktop"
DESKTOP_BINARY="$DESKTOP_DIR/src-tauri/target/release/koryphaios-desktop"

echo "=== Testing Desktop Binary ==="
echo "Binary exists: $(test -f "$DESKTOP_BINARY" && echo "YES" || echo "NO")"
echo ""

# Run the binary with test env vars
echo "=== Running Desktop Binary (will show debug output) ==="
echo "Press Ctrl+C to exit after seeing the debug output..."
sleep 2

KORYPHAIOS_PORT=29455 \
KORYPHAIOS_BACKEND_URL="http://127.0.0.1:29455" \
KORYPHAIOS_WS_URL="ws://127.0.0.1:29455/ws" \
"$DESKTOP_BINARY" 2>&1 | head -20 &

PID=$!
sleep 3
kill $PID 2>/dev/null

echo ""
echo "=== Test Complete ==="
