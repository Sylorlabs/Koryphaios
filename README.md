# Koryphaios

> Native desktop AI workspace built with Tauri, Bun, and SvelteKit.

[![License](https://img.shields.io/badge/license-Private-red.svg)]()
[![Bun](https://img.shields.io/badge/runtime-Bun-orange.svg)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/language-TypeScript-blue.svg)](https://www.typescriptlang.org/)

---

## Overview

Koryphaios is a desktop application with a local backend server and a Tauri shell. The backend handles orchestration, tools, sessions, HTTP APIs, and WebSocket streaming; the frontend provides the UI and runs inside Tauri.

### Key Features

- **Native Desktop Experience** — Custom frameless window, system tray integration, and native file system access via Tauri.
- **Multi-Provider Support** — 11 native LLM provider integrations (Anthropic, OpenAI, Google Gemini, GitHub Copilot, xAI Grok, Azure OpenAI, AWS Bedrock, Groq, OpenRouter, Cline, Codex) plus OpenAI-compatible endpoint support.
- **Intelligent Agent Routing** — Automatic model selection based on task domain and provider availability.
- **Time Travel (Undo/Redo)** — Shadow Logger creates ghost commits for every AI change, allowing instant recovery to any previous state.
- **Parallel Agent Isolation** — Git worktrees enable concurrent agents without file clobbering.
- **Real-Time Communication** — WebSocket-based streaming for live updates directly to the desktop UI.
- **MCP Integration** — Model Context Protocol support for extensible tool systems.
- **Session Management** — Persistent conversation history with cost tracking and token accounting.
- **Telegram Bridge** — Optional bot interface for remote access.

---

## Architecture

```
┌───────────────────────────────┐
│ Tauri Desktop Shell           │
│ • Native window + OS APIs     │
└──────────────┬────────────────┘
               │ loads local UI
┌──────────────▼────────────────┐
│ Frontend (SvelteKit build)    │
│ • Chat UI                     │
│ • Session / provider views    │
│ • Uses HTTP + WebSocket       │
└──────────────┬────────────────┘
               │ /api/* and /ws
┌──────────────▼────────────────────────────────────────────────┐
│ Backend (Bun / Elysia / Bun.serve)                           │
│ • Kory manager and worker orchestration                      │
│ • Tool registry, provider registry, session persistence      │
│ • Serves REST-like API routes, WebSocket updates, static UI  │
│ • Loads local plugins and MCP-backed tools                   │
└───────────────────────────────────────────────────────────────┘
```

---

## Agent Roles and Permissions

- **Manager (Kory)** — Full access: can use all tools (bash, read/write files, web search, etc.) **unsandboxed** for simple tasks. Still asks the user for confirmation before executing delegated work unless YOLO mode is on. Sees everything: the critic’s review and sub-agent (worker) activity; synthesizes the final summary for the user.
- **Workers (builders)** — Sandboxed: only have access to files and paths the manager granted via the plan. Use tools to implement the task; no direct user confirmation (manager handles that before delegating).
- **Critic** — Read-only: may only use **read_file**, **grep**, **glob**, and **ls** to inspect the codebase. Sees the **full worker transcript** (thinking, tool calls, results) and outputs PASS or FAIL with feedback.

---

## Getting Started

### Installation

```bash
# Clone the repository
git clone <repository-url>
cd Koryphaios

# Install dependencies for all workspaces
bun install

# Copy environment template
cp .env.example .env

# Edit .env and add your API keys
```

### Development & Launching

Koryphaios is a native Tauri app. The supported development entrypoint is:

```bash
# Install workspace dependencies
bun install

# Launch the native desktop app
bun run dev
```

`bun run dev` is an alias for `bun run dev:desktop`. The launcher in [`scripts/launch-desktop.ts`](./scripts/launch-desktop.ts):

- starts the local backend on the configured app port
- starts the internal frontend dev server on a separate port for the Tauri WebView
- waits for both services to be healthy
- launches the native Tauri shell

The localhost dev server is an implementation detail of Tauri development, not the supported user-facing runtime.

---

## Runtime Model

Koryphaios is a native desktop application.

- **User-facing runtime** — The app is launched as a Tauri window, not as a browser tab.
- **Local transport** — The desktop UI talks to the local backend over HTTP and WebSocket inside the machine.
- **Backend binding** — The canonical backend host and port come from [`config/app.config.json`](./config/app.config.json), currently `127.0.0.1:3001`.
- **Dev shell behavior** — During development, Tauri loads the UI from an internal Vite dev server. That localhost URL exists only to feed the native WebView.

For local tooling, the backend writes the active runtime address to `.koryphaios/.active-port.json` after startup.

---

## Project Structure

```
Koryphaios/
├── desktop/           # Tauri Desktop Shell
│   └── src-tauri/     # Rust backend & Native config
├── backend/           # Bun server, orchestration, APIs, WebSocket
│   ├── src/kory/      # Manager logic
│   └── src/providers/ # LLM integrations
├── frontend/          # SvelteKit UI
│   └── src/lib/       # Components, stores, utilities
├── shared/            # Shared types & contracts
├── config/            # Runtime app config (host/port/window)
└── koryphaios.json    # Additional app configuration
```

---

## Troubleshooting

### Window Dragging

If you cannot drag the window:

- **Title Bar**: Drag from the main menu area at the top.
- **Sidebar**: Drag from the logo/project area in the sidebar header.
- **Zen Mode**: A 16px drag region is active at the very top edge of the window.

### Integrated Launch Issues

- Check `config/app.config.json` for the expected backend host and port.
- After startup, inspect `.koryphaios/.active-port.json` to confirm the active backend URL.
- Use `bun run dev` for the supported integrated native desktop workflow.

---

**Version:** 1.0.0
**Status:** Desktop Native
