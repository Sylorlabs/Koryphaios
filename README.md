# Koryphaios

> **AI Agent Orchestration Dashboard** — A sophisticated platform for managing multi-agent AI workflows with real-time monitoring and control.

[![License](https://img.shields.io/badge/license-Private-red.svg)]()
[![Bun](https://img.shields.io/badge/runtime-Bun-orange.svg)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/language-TypeScript-blue.svg)](https://www.typescriptlang.org/)

---

## Overview

Koryphaios is a full-stack application that orchestrates AI agents across multiple providers (Anthropic, OpenAI, Google, and more) with intelligent routing, task delegation, and real-time streaming. The system features a manager-worker architecture where a central "Kory" coordinator delegates tasks to specialized agents based on domain expertise.

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
                     │ WebSocket / REST API
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
│  │  Session Store (File-based persistence)                  │  │
│  │  • Sessions, messages, conversation history              │  │
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
   - File-based session persistence

3. **Shared** (`/shared`)
   - TypeScript type definitions shared between frontend/backend
   - Provider configurations and reasoning parameters
   - WebSocket protocol definitions
   - API contracts

### Agent Roles and Permissions

- **Manager (Kory)** — Full access: can use all tools (bash, read/write files, web search, etc.) **unsandboxed** for simple tasks. Still asks the user for confirmation before executing delegated work unless YOLO mode is on. Sees everything: the critic’s review and sub-agent (worker) activity; synthesizes the final summary for the user.
- **Workers (builders)** — Sandboxed: only have access to files and paths the manager granted via the plan. Use tools to implement the task; no direct user confirmation (manager handles that before delegating).
- **Critic** — Read-only: may only use **read_file**, **grep**, **glob**, and **ls** to inspect the codebase. Sees the **full worker transcript** (thinking, tool calls, results) and outputs PASS or FAIL with feedback. The manager sees the critic’s feedback and uses it in the final summary.

---

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) 1.0+ (runtime and package manager)
- Node.js 18+ (for compatibility)
- At least one AI provider API key (Anthropic, OpenAI, etc.)

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
# ANTHROPIC_API_KEY=sk-ant-...
# OPENAI_API_KEY=sk-...
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
      "model": "claude-sonnet-4-5",
      "reasoningEffort": "high"
    },
    "coder": {
      "model": "claude-sonnet-4-5",
      "maxTokens": 16384
    },
    "task": {
      "model": "o4-mini",
      "maxTokens": 8192
    }
  },
  "server": {
    "port": 3000,
    "host": "localhost"
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
- Local-first architecture — all data stays on your machine
- Enhanced security with CSP policies
- Cross-platform: Windows, macOS, Linux

**Architecture Note:** The app uses Tauri's WebView to render the SvelteKit frontend, with the backend running as a local HTTP server. For local-only communication, Tauri's `invoke()` API could be used instead of HTTP/WebSocket — this is a future optimization.

**Development commands:**
```bash
bun run dev:backend   # Backend only on http://127.0.0.1:3000
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

Connect to `ws://localhost:3000/ws` for real-time updates. No authentication required by default.

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

For **multi-user deployment** or to restrict API access:

- Set `KORYPHAIOS_AUTH_MODE=token` to enable JWT-based API authentication
- Configure `JWT_SECRET` (min 32 characters) for secure token generation
- Set `CORS_ORIGINS` to a comma-separated list of allowed frontend origins (e.g., `https://app.example.com`)

**Note**: User registration is **disabled by default**. Koryphaios does not include account management features.

### API Key Management

- Provider API keys are encrypted before storage in `.env`
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
│   │   ├── db/                # Database utilities
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

This is a private project. Contributions are managed internally.

### Development Workflow

1. Create feature branch
2. Make changes with tests
3. Run `bun run check` for type safety
4. Submit PR with description

---

## Troubleshooting

### Backend won't start
- Check `.env` has at least one valid API key
- Ensure port 3000 is available
- Review `koryphaios.json` syntax

### WebSocket connection fails
- Verify CORS origin configuration
- Check firewall settings
- Try SSE fallback at `/api/events`

### Provider authentication fails
- Verify API key format
- Check provider status at `/api/providers`
- Review logs for detailed errors

For more help, see `docs/TROUBLESHOOTING.md`.

---

## License

Private — All rights reserved.

---

## Acknowledgments

Built with:
- [Bun](https://bun.sh) — Fast all-in-one JavaScript runtime
- [SvelteKit](https://kit.svelte.dev) — Modern web framework
- [Anthropic Claude](https://anthropic.com) — AI assistance
- [Model Context Protocol](https://modelcontextprotocol.io) — Tool integration standard

---

**Version:** 1.0.0
**Status:** Production Ready
