#!/bin/bash
# Ensure backend server is running (completely silent)
# For Tauri desktop app - only backend needed

cd "$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p .koryphaios/logs

# Backend check/start - completely detached
if ! curl -s http://localhost:3000/api/health > /dev/null 2>&1; then
    # Use setsid to fully detach from terminal
    setsid bash -c "bun run src/server.ts" > .koryphaios/logs/backend.log 2>&1 &
    # Wait for it
    for i in {1..60}; do
        curl -s http://localhost:3000/api/health > /dev/null 2>&1 && break
        sleep 0.1
    done
fi
