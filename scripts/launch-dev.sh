#!/bin/bash
# Koryphaios Development Launcher
# Starts backend, frontend, and Tauri with live reload

cd "$(cd "$(dirname "$0")/.." && pwd)"
source ~/.cargo/env

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  KORYPHAIOS - Development Mode                               ║"
echo "║  Backend: http://localhost:3002                              ║"
echo "║  Frontend: http://localhost:5173                             ║"
echo "║                                                              ║"
echo "║  Features:                                                   ║"
echo "║  • Hot reload on file changes                                ║"
echo "║  • Edit frontend/src → Instant browser update                ║"
echo "║  • Edit backend/src → Auto-restart server                    ║"
echo "║  • Edit desktop/src-tauri → Auto-rebuild Rust                ║"
echo "║                                                              ║"
echo "║  Press Ctrl+C to stop all servers                            ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

bun run dev:desktop
