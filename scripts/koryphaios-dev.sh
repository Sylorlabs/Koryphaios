#!/bin/bash
# Koryphaios Dev Launcher - Instant startup, background servers
# Logs: .koryphaios/logs/

cd "$(cd "$(dirname "$0")/.." && pwd)"

# Check if already running
if pgrep -f "koryphaios-desktop" > /dev/null; then
    echo "[Koryphaios] Already running!"
    exit 0
fi

# Start servers in background, launch app instantly
exec bun run scripts/dev-desktop-bg.ts
