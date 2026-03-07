#!/bin/bash
# Ensure backend and frontend servers are running (completely silent)

cd "$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p .koryphaios/logs

# Backend check/start - completely detached
if ! curl -s http://localhost:3002/api/health > /dev/null 2>&1; then
    # Use setsid to fully detach from terminal
    setsid bash -c "bun run src/server.ts" > .koryphaios/logs/backend.log 2>&1 &
    # Wait for it
    for i in {1..60}; do
        curl -s http://localhost:3002/api/health > /dev/null 2>&1 && break
        sleep 0.1
    done
fi

# Frontend check/start - completely detached
if ! curl -s http://localhost:5173 > /dev/null 2>&1; then
    cd frontend
    setsid bash -c "bun run vite dev --host" > ../.koryphaios/logs/frontend.log 2>&1 &
    cd ..
    # Wait for it
    for i in {1..60}; do
        curl -s http://localhost:5173 > /dev/null 2>&1 && break
        sleep 0.1
    done
fi
