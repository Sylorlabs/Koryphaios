# Koryphaios

> **AI Agent Orchestration Dashboard** — A local-first desktop application for managing multi-agent AI workflows with real-time monitoring and control.

[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)]()
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)]()
[![Bun](https://img.shields.io/badge/runtime-Bun-orange.svg)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/language-TypeScript-blue.svg)](https://www.typescriptlang.org/)

---

## Overview

Koryphaios is a **local-first, single-user desktop application** that orchestrates AI agents across multiple providers (Anthropic, OpenAI, Google, and more) with intelligent routing, task delegation, and real-time streaming. The system features a manager-worker architecture where a central "Kory" coordinator delegates tasks to specialized agents based on domain expertise.

### Key Features

- **Multi-Provider Support** — 11 native LLM provider integrations (Anthropic, OpenAI, Google Gemini, GitHub Copilot, xAI Grok, Azure OpenAI, AWS Bedrock, Groq, OpenRouter, Cline, Codex) plus OpenAI-compatible endpoint support for any additional provider
- **Intelligent Agent Routing** — Automatic model selection based on task domain and provider availability
- **Time Travel (Undo/Redo)** — Shadow Logger creates ghost commits for every AI change, allowing instant recovery to any previous state
- **Parallel Agent Isolation** — Git worktrees enable concurrent agents without file clobbering
- **Real-Time Communication** — WebSocket-based streaming with SSE fallback for live updates
- **MCP Integration** — Model Context Protocol support for extensible tool systems
- **Session Management** — Persistent conversation history with cost tracking and token accounting
- **Telegram Bridge** — Optional bot interface for remote access
- **Tool Ecosystem** — Built-in tools for bash execution, file operations, web search, and more

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Frontend (SvelteKit)                      │
│  • Real-time UI with WebSocket streaming                        │
│  • Session management, cost tracking, agent monitoring          │
│  • Time Travel UI (undo/redo via ghost commits)                 │
└────────────────────┬────────────────────────────────────────────┘
                     │ WebSocket / REST API (localhost only)
┌────────────────────┴────────────────────────────────────────────┐
│                      Backend (Bun Server)                        │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Kory Manager (Orchestrator)                             │  │
│  │  • Full tool access (unsandboxed); asks user unless YOLO  │  │
│  │  • Routes to workers; sees critic + workers; summarizes │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐    │
│  │  Provider   │  │    Tool     │  │   MCP Manager       │    │
│  │  Registry   │  │  Registry   │  │   (External Tools)  │    │
│  │  (API Auth) │  │  (Built-in) │  │                     │    │
│  └─────────────┘  └─────────────┘  └─────────────────────┘    │
│                                                                  │
│  ┌─────────────────────┐  ┌────────────────────────────────┐  │
│  │  Workspace Manager  │  │  Shadow Logger                 │  │
│  │  (Git Worktrees)    │  │  (Ghost Commits / Time Travel) │  │
│  │  • Parallel agent   │  │  • Undo/redo via reflog        │  │
│  │    isolation        │  │  • Metadata via git notes      │  │
│  └─────────────────────┘  └────────────────────────────────┘  │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Session Store (SQLite)                                  │  │
│  │  • Local SQLite database in .koryphaios/                 │  │
│  │  • No external database required                         │  │
│  │  • WAL mode for concurrency                              │  │
│  └──────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### Core Components

1. **Frontend** (`/frontend`)
   - SvelteKit 2 with Vite and TailwindCSS
   - Real-time agent status visualization
   - Session history and cost analytics
   - Provider configuration UI

2. **Backend** (`/backend`)
   - Bun HTTP/WebSocket server
   - Kory orchestration engine
   - Provider abstraction layer (11 native + OpenAI-compatible adapter support)
   - Tool execution system
   - **SQLite database** (local file, no external DB needed)

3. **Shared** (`/shared`)
   - TypeScript type definitions shared between frontend/backend
   - Provider configurations and reasoning parameters
   - WebSocket protocol definitions
   - API contracts

### Agent Roles and Permissions

- **Manager (Kory)** — Full access: can use all tools (bash, read/write files, web search, etc.) **unsandboxed** for simple tasks. Still asks the user for confirmation before executing delegated work unless YOLO mode is on. Sees everything: the critic's review and sub-agent (worker) activity; synthesizes the final summary for the user.
- **Workers (builders)** — Sandboxed: only have access to files and paths the manager granted via the plan. Use tools to implement the task; no direct user confirmation (manager handles that before delegating).
- **Critic** — Read-only: may only use **read_file**, **grep**, **glob**, and **ls** to inspect the codebase. Sees the **full worker transcript** (thinking, tool calls, results) and outputs PASS or FAIL with feedback. The manager sees the critic's feedback and uses it in the final summary.

---

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) 1.0+ (runtime and package manager)
- Node.js 18+ (for compatibility)
- At least one AI provider API key (Anthropic, OpenAI, etc.)

### Installation

**Zero-Config Setup (Recommended):**
```bash
# Clone the repository
git clone <repository-url>
cd Koryphaios

# One-command setup: installs deps, generates secrets, checks ports
bun run setup

# Add your API keys to .env, then start the app
bun run dev
```

**Manual Setup:**
```bash
# Install dependencies for all workspaces
bun install

# Copy environment template and config
cp .env.example .env
cp config.example.json koryphaios.json

# Generate required secrets (REQUIRED for security)
bun run scripts/generate-secret.ts

# Edit .env and add your API keys
```

### Configuration

Create or edit `koryphaios.json` in the project root:

```json
{
  "providers": {
    "anthropic": {
      "name": "anthropic",
      "disabled": false
    },
    "openai": {
      "name": "openai",
      "disabled": false
    }
  },
  "agents": {
    "manager": {
      "model": "claude-3-7-sonnet",
      "reasoningEffort": "high"
    },
    "coder": {
      "model": "claude-3-7-sonnet",
      "maxTokens": 16384
    },
    "task": {
      "model": "gpt-4o-mini",
      "maxTokens": 8192
    }
  },
  "server": {
    "port": 29473,
    "host": "127.0.0.1"
  },
  "dataDirectory": ".koryphaios"
}
```

See `config.example.json` for all available options.

### Development

**Koryphaios is a DESKTOP application only.** 

The app runs as a native Tauri application for maximum performance and native API access:

```bash
# Start Tauri desktop app
bun run dev

# Or build and run the production desktop app
bun run build:desktop
```

**Why Desktop?**
- Lightweight desktop wrapper via Tauri (~10MB vs ~150MB+ for Electron)
- Uses the OS native WebView (WebKit/Blink) instead of bundled Chromium
- Platform-native APIs (menus, system tray, file drop)
- **Local-first architecture — all data stays on your machine in SQLite**
- Enhanced security with CSP policies
- Cross-platform: Windows, macOS, Linux

**Development commands:**
```bash
bun run dev:backend   # Backend only on http://127.0.0.1:29473
bun run dev:desktop   # Tauri dev window with hot reload
```

### Production Build

```bash
# Build all workspaces
bun run build

# Type checking
bun run typecheck

# Strict validation (typecheck + frontend checks)
bun run check

# Run tests (backend unit and integration)
bun run test

# Full pre-deploy validation (check + tests)
bun run check:full
```

---

## Data Storage: Local SQLite

Koryphaios uses **SQLite** for all data persistence—no external database required:

```
.koryphaios/
├── koryphaios.db          # Main SQLite database (sessions, messages, tasks)
├── koryphaios.db-shm      # Shared memory file (WAL mode)
├── koryphaios.db-wal      # Write-ahead log
├── memory/                # Session memory files
└── .root-token            # Authentication token (mode 600)
```

**Features:**
- **WAL Mode**: Write-Ahead Logging for better concurrency
- **Busy Timeout**: 5-second timeout for lock contention
- **Optimistic Locking**: Prevents lost updates during concurrent access
- **Transactions**: Multi-step operations are atomic
- **Automatic Migrations**: Schema updates on startup

**Backup:** Simply copy the `.koryphaios/` directory.

---

## API Documentation

### REST Endpoints

#### Sessions
- `GET /api/sessions` — List all sessions
- `POST /api/sessions` — Create new session
- `GET /api/sessions/:id` — Get session details
- `PATCH /api/sessions/:id` — Update session title
- `DELETE /api/sessions/:id` — Delete session
- `GET /api/sessions/:id/messages` — Get message history
- `POST /api/sessions/:id/auto-title` — Generate title from first message

#### Messages
- `POST /api/messages` — Send message (triggers Kory processing)

#### Providers
- `GET /api/providers` — Get provider status
- `PUT /api/providers/:name` — Set provider credentials (API key, auth token, and/or base URL depending on provider)
- `DELETE /api/providers/:name` — Remove stored provider credentials

#### Agents
- `GET /api/agents/status` — Get active agent status
- `POST /api/agents/cancel` — Cancel all running agents

#### System
- `GET /api/health` — Health check
- `GET /api/events` — SSE stream (same as WebSocket)
- `GET /metrics` — Prometheus metrics (optional; requires `ENABLE_METRICS=true`)

### WebSocket Protocol

Connect to `ws://localhost:29473/ws` for real-time updates. No authentication required by default.

**Message Format:**
```typescript
interface WSMessage<T> {
  type: WSEventType;
  payload: T;
  timestamp: number;
  sessionId?: string;
  agentId?: string;
}
```

**Event Types:**
- `agent.spawned` — New agent created
- `agent.status` — Agent status update
- `stream.delta` — Streaming content chunk
- `stream.tool_call` — Tool execution started
- `stream.tool_result` — Tool execution result
- `session.updated` — Session metadata changed
- `provider.status` — Provider authentication status
- `kory.thought` — Manager reasoning updates

See `/shared/src/index.ts` for complete protocol definitions.

---

## Tool System

Tools are restricted by role: **manager** (full), **worker** (build tools, sandboxed), **critic** (read-only: read_file, grep, glob, ls only). See [Agent roles](#agent-roles-and-permissions) above.

### Built-in Tools

- **bash** — Execute shell commands (manager, worker)
- **read_file** — Read file contents (all roles)
- **write_file** — Create/overwrite files (manager, worker)
- **edit_file** — Surgical file edits (manager, worker)
- **delete_file**, **move_file**, **diff**, **patch** — File ops (manager, worker)
- **grep** — Search file contents (all roles)
- **glob** — Find files by pattern (all roles)
- **ls** — List directory contents (all roles)
- **web_search**, **web_fetch** — Web (manager, worker)
- **ask_user** — Manager asks the user (manager only)
- **ask_manager** — Worker asks the manager (worker only)

### MCP (Model Context Protocol)

Koryphaios supports MCP servers for extensible tools. Configure in `koryphaios.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
    }
  }
}
```

---

## Security

### Authentication

Koryphaios operates **without user accounts**. The system is designed for single-tenant usage where all functionality is available without requiring user registration or login.

For details on encryption, secrets management, and security best practices, see [SECURITY.md](SECURITY.md).

### API Key Management

- Provider API keys are encrypted using envelope encryption (AES-256-GCM)
- Encryption keys derived from `KORYPHAIOS_MASTER_KEY` or enterprise KMS
- Runtime keys stored in memory only
- Rate limiting: 120 requests/minute per IP
- CORS enforced with origin allowlist

### Best Practices

- Never commit `.env` to version control
- Rotate API keys regularly
- Use environment-specific configurations
- Review `SECURITY.md` for detailed guidelines

---

## Telegram Bridge (Optional)

Enable Telegram bot access:

```bash
# Set in .env
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_ADMIN_ID=your_user_id
TELEGRAM_POLLING=true

# Or configure in koryphaios.json
{
  "telegram": {
    "botToken": "...",
    "adminId": 123456789,
    "webhookUrl": "https://your-domain.com/api/telegram/webhook"
  }
}
```

---

## Project Structure

```
Koryphaios/
├── backend/
│   ├── src/
│   │   ├── server.ts          # Main HTTP/WebSocket server
│   │   ├── kory/              # Orchestration engine
│   │   ├── providers/         # AI provider integrations
│   │   ├── tools/             # Built-in tool implementations
│   │   ├── mcp/               # MCP client
│   │   ├── telegram/          # Telegram bot bridge
│   │   ├── db/                # SQLite database utilities
│   │   ├── security.ts        # Auth, validation, encryption
│   │   └── logger.ts          # Structured logging
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── routes/            # SvelteKit pages
│   │   └── lib/               # Components and utilities
│   └── package.json
├── shared/
│   └── src/
│       └── index.ts           # Shared types and contracts
├── koryphaios.json            # Main configuration
├── .env                       # Environment variables (gitignored)
└── package.json               # Root workspace config
```

---

## Contributing

Koryphaios welcomes both human developers and AI coding agents as collaborators.

### Quick Start for AI Agents

Read AGENTS.md first. It contains the module map, key conventions, and gotchas specific to this codebase. The project uses Bun as the package manager, Svelte 5 with runes syntax, and Tailwind v4. Always import shared types from @koryphaios/shared rather than duplicating them.

### Quick Start for Human Developers

**Zero-config for new collaborators:** Run `bun run setup` to auto-configure everything, then `bun run dev` to start. The backend auto-finds an available port (default 29473) and the frontend auto-discovers it. No manual port configuration needed.

**Standard workflow:** Fork the repository and create a feature branch. Install dependencies with `bun install`. Copy `.env.example` to `.env` and add your API keys. Run `bun run dev` to start the development server. Before submitting changes, run `bun run check` to ensure type safety and pass all tests with `bun run test`.

### Development Workflow

Create a feature branch from main. Make your changes with appropriate test coverage. Run the full validation suite with bun run check. Submit a pull request with a clear description of the changes and any testing instructions. All contributions go through code review before merging.

---

## Troubleshooting

### Backend won't start
- Check `.env` has required secrets (`JWT_SECRET`, `KORYPHAIOS_MASTER_KEY`)
- Port 29473 not available? The backend auto-finds an available port in range 29450-29500
- Review `koryphaios.json` syntax
- Check server logs for validation errors

### WebSocket connection fails
- Verify the backend is running
- Check firewall settings
- Try SSE fallback at `/api/events`

### Provider authentication fails
- Verify API key format
- Check provider status at `/api/providers`
- Review logs for detailed errors

### Database locked errors
- SQLite uses WAL mode with 5-second busy timeout
- Heavy concurrent access may cause temporary locks
- Operations retry automatically

For more help, see `docs/TROUBLESHOOTING.md`.

---

## License

Apache License 2.0 — See [LICENSE](LICENSE) for details.

---

## Acknowledgments

Built with:
- [Bun](https://bun.sh) — Fast all-in-one JavaScript runtime
- [SvelteKit](https://kit.svelte.dev) — Modern web framework
- [Anthropic Claude](https://anthropic.com) — AI assistance
- [Model Context Protocol](https://modelcontextprotocol.io) — Tool integration standard
- [Tauri](https://tauri.app) — Desktop application framework

---

**Version:** 1.0.0
**Status:** Production Ready
