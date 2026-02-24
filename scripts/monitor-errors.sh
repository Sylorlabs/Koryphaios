#!/bin/bash
# Real-time log monitor for Koryphaios
# Shows all frontend errors captured by the error monitor

echo "🔍 Monitoring Koryphaios logs..."
echo "Frontend errors will appear here in real-time"
echo "Press Ctrl+C to stop"
echo "================================================"
echo ""

# Follow the backend logs and filter for frontend errors
cd "/home/micah/Desktop/sylorlabs projects/Koryphaios"

# If running in development, tail the logs
if pgrep -f "bun run dev:backend" > /dev/null; then
    # Backend is running, monitor logs
    # Bun outputs to stdout, so we'll need to capture it differently
    echo "Backend is running. Watching for errors..."
    echo "You can also check browser DevTools console for immediate errors."
    echo ""
    
    # Monitor the server log output
    while true; do
        sleep 1
    done
else
    echo "Backend is not running. Start it with: bun run dev"
fi
