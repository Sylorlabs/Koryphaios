#!/bin/bash
# Koryphaios Development Launcher
# Starts backend and Tauri desktop app with live reload

cd "$(cd "$(dirname "$0")/.." && pwd)"
source ~/.cargo/env

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  KORYPHAIOS - Desktop Development Mode                       ║"
echo "║  Backend: http://localhost:3000                              ║"
echo "║                                                              ║"
echo "║  Features:                                                   ║"
echo "║  • Hot reload on file changes                                ║"
echo "║  • Edit frontend/src → Instant UI update                     ║"
echo "║  • Edit backend/src → Auto-restart server                    ║"
echo "║  • Edit desktop/src-tauri → Auto-rebuild Rust                ║"
echo "║                                                              ║"
echo "║  Press Ctrl+C to stop all servers                            ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

bun run dev:desktop
