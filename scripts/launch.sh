#!/bin/bash
# Koryphaios Launcher - True instant, zero terminal

cd "$(cd "$(dirname "$0")/.." && pwd)"

# If already running, just focus it
if pgrep -x "koryphaios-desktop" > /dev/null 2>&1; then
    wmctrl -x -R "koryphaios-desktop" 2>/dev/null || true
    exit 0
fi

# Ensure servers are running (completely silent background)
./scripts/ensure-servers.sh > /dev/null 2>&1

# Launch Tauri - fully detached, no terminal output
source ~/.cargo/env 2>/dev/null
cd desktop/src-tauri
# Use setsid to completely detach from parent terminal
setsid cargo run --quiet 2>/dev/null &
