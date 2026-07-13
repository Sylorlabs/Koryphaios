# Koryphaios

> A free native desktop AI workspace that makes your life easier. Built with Tauri, Bun, and SvelteKit.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-orange.svg)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/language-TypeScript-blue.svg)](https://www.typescriptlang.org/)

---

## What Koryphaios is

Koryphaios is a native desktop application that puts a fast local AI workspace on your machine. It runs a local backend server inside a Tauri shell and gives you a clean SvelteKit interface for talking to language models, running agents, and getting real work done without leaving your computer. There is no subscription, no account wall, and no usage limit baked into the tool. It exists to save you friction and it is completely free.

The backend handles orchestration, tools, sessions, HTTP APIs, and WebSocket streaming. The frontend provides the interface and runs inside the Tauri webview. Everything stays on your machine and talks to your own provider keys over a local connection.

## Features

**Native desktop experience.** Koryphaios is a real desktop app with a custom frameless window, system tray integration, and direct native file system access through Tauri. It is not a website wearing a desktop costume.

**Broad multi provider support.** Koryphaios speaks to more than twenty AI providers out of the box including Anthropic, OpenAI, Google Gemini, GitHub Copilot, xAI Grok, Azure OpenAI, AWS Bedrock, Groq, OpenRouter, Cline, Codex, Cursor, Devin, Jules, Kimi, and several more. It also supports any OpenAI compatible endpoint through the custom and remote provider options so you are never locked to one vendor.

**Intelligent agent routing.** A built in smart router picks models based on the task domain and which providers are available to you. You describe what you want and Koryphaios routes the work to a sensible model instead of making you babysit dropdowns.

**Time travel with ghost commits.** The Time Travel service records undo and redo points as lightweight ghost commits for every meaningful change. If an agent goes down a bad path you can step back to any earlier state instantly instead of manually untangling the damage.

**Parallel agent isolation.** Git worktrees let multiple agents work at the same time without clobbering each other's files. The workspace manager, worker pipeline, and conflict resolution services keep concurrent work separated and reconciled.

**Real time streaming.** WebSocket streaming pushes live updates straight to the desktop interface so you watch agents think, act, and report as it happens.

**MCP and editor integrations.** Model Context Protocol support extends the tool system, and native integrations exist for VS Code, Cursor, Windsurf, and Augment so the workspace fits into the editor you already use.

**Sub agent teams.** A manager agent plans and synthesizes while sandboxed worker agents execute the plan and a read only critic reviews the work. Workers only touch the files the manager granted them, which keeps delegated work contained.

**Notes, feedback, and cost tracking.** Built in notes let you capture context alongside your sessions. An in app feedback reporter sends anonymized diagnostics so issues get seen. Session history tracks token usage and cost per provider so you always know what a task spent.

**Self updating desktop builds.** The desktop app ships on Windows, macOS Intel, macOS Apple Silicon, and Linux x64 with a working self updater that downloads, verifies, and restarts into new releases.

**A marketing demo that runs offline.** A dedicated demo mode powers the public website embed with a realistic sample workspace and performs zero backend requests during its guided tour, so anyone can see the product without installing it.

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

## Agent roles and permissions

**Manager (Kory).** The manager has full access and can use all tools including bash, file read and write, and web search without a sandbox for simple tasks. It still asks you for confirmation before running delegated work unless YOLO mode is on. The manager sees the critic's review and the worker activity and writes the final summary you read.

**Workers (builders).** Workers run sandboxed and only reach the files and paths the manager granted through the plan. They implement the task with tools and do not prompt you directly because the manager already confirmed the work before handing it off.

**Critic.** The critic is read only and may only use read_file, grep, glob, and ls to inspect the codebase. It reads the full worker transcript including thinking, tool calls, and results and returns a pass or fail verdict with feedback.

## Known rough edges

Koryphaios is free, open, and genuinely useful, and it is also still growing. The honest weak spots are:

**CLI integrations and workflows can be buggy.** Several providers are driven through their command line tools and those integrations are the least settled part of the app. Account linking, auth handshakes, and multi step workflows through those CLIs may break or behave inconsistently depending on the provider and your environment.

**The UI can have weird quirks.** As with any active desktop interface, you may run into odd visual states, a control that does not behave the way you expect, or a transition that looks off. Most are cosmetic and most get fixed quickly, but they are real and we would rather name them than hide them.

None of these block normal use and all of them are fair game for the in app feedback reporter. The fastest way to make the rough edges smaller is for people to actually use the tool and tell us what they hit.

## Getting started

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

### Development and launching

Koryphaios is a native Tauri app. The supported development entrypoint is:

```bash
# Install workspace dependencies
bun install

# Launch the native desktop app
bun run dev
```

`bun run dev` is an alias for `bun run dev:desktop`. The launcher in `scripts/launch-desktop.ts` starts the local backend on the configured app port, starts the internal frontend dev server on a separate port for the Tauri webview, waits for both services to be healthy, and launches the native Tauri shell.

The localhost dev server is an implementation detail of Tauri development, not the supported user facing runtime.

## Runtime model

Koryphaios is a native desktop application.

**User facing runtime.** The app launches as a Tauri window, not as a browser tab.

**Local transport.** The desktop UI talks to the local backend over HTTP and WebSocket inside your machine.

**Backend binding.** The canonical backend host and port come from `config/app.config.json`, currently `127.0.0.1:3001`.

**Dev shell behavior.** During development Tauri loads the UI from an internal Vite dev server. That localhost URL exists only to feed the native webview.

For local tooling the backend writes the active runtime address to `.koryphaios/.active-port.json` after startup.

## Project structure

```
Koryphaios/
├── desktop/           # Tauri Desktop Shell
│   └── src-tauri/     # Rust backend & native config
├── backend/           # Bun server, orchestration, APIs, WebSocket
│   ├── src/kory/      # Manager logic
│   └── src/providers/ # LLM integrations
├── frontend/          # SvelteKit UI
│   └── src/lib/       # Components, stores, utilities
├── shared/            # Shared types & contracts
├── config/            # Runtime app config (host/port/window)
└── koryphaios.json    # Additional app configuration
```

## Troubleshooting

### Window dragging

If you cannot drag the window:

**Title bar.** Drag from the main menu area at the top.

**Sidebar.** Drag from the logo or project area in the sidebar header.

**Zen mode.** A 16px drag region is active at the very top edge of the window.

### Integrated launch issues

Check `config/app.config.json` for the expected backend host and port. After startup inspect `.koryphaios/.active-port.json` to confirm the active backend URL. Use `bun run dev` for the supported integrated native desktop workflow.

---

**Version:** 1.0.23
**License:** Apache 2.0
**Cost:** Free, forever
