#!/bin/bash
# Koryphaios Launcher - Completely silent, zero output

cd "$(cd "$(dirname "$0")/.." && pwd)" || exit 1

# Redirect ALL output to /dev/null from the start
exec >/dev/null 2>&1

# If already running, focus it
if pgrep -x "koryphaios-desktop" > /dev/null 2>&1; then
    wmctrl -x -R "koryphaios-desktop" 2>/dev/null &
    exit 0
fi

# Ensure servers are running (silent)
./scripts/ensure-servers.sh

# Launch Tauri - completely detached
source ~/.cargo/env 2>/dev/null
cd desktop/src-tauri || exit 1
setsid cargo run --quiet &
