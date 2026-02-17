# Koryphaios

> **AI Agent Orchestration Dashboard** — A sophisticated platform for managing multi-agent AI workflows with real-time monitoring and control.

[![License](https://img.shields.io/badge/license-Private-red.svg)]()
[![Bun](https://img.shields.io/badge/runtime-Bun-orange.svg)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/language-TypeScript-blue.svg)](https://www.typescriptlang.org/)

---

## Overview

Koryphaios is a full-stack application that orchestrates AI agents across multiple providers (Anthropic, OpenAI, Google, and more) with intelligent routing, task delegation, and real-time streaming. The system features a manager-worker architecture where a central "Kory" coordinator delegates tasks to specialized agents based on domain expertise.

### Key Features

- **Multi-Provider Support** — 6 native provider integrations (Anthropic, OpenAI, Gemini, Copilot, Codex, GeminiCLI) plus 80+ models via OpenAI-compatible adapters (Groq, xAI, Ollama, and more)
- **Intelligent Agent Routing** — Automatic model selection based on task domain and provider availability
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
└────────────────────┬────────────────────────────────────────────┘
                     │ WebSocket / REST API
┌────────────────────┴────────────────────────────────────────────┐
│                      Backend (Bun Server)                        │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Kory Manager (Orchestrator)                             │  │
│  │  • Analyzes tasks and routes to specialized agents       │  │
│  │  • Manages worker lifecycle and verification             │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐    │
│  │  Provider   │  │    Tool     │  │   MCP Manager       │    │
│  │  Registry   │  │  Registry   │  │   (External Tools)  │    │
│  │  (API Auth) │  │  (Built-in) │  │                     │    │
│  └─────────────┘  └─────────────┘  └─────────────────────┘    │
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
   - Provider abstraction layer (6 native + 80+ via OpenAI-compatible adapters)
   - Tool execution system
   - File-based session persistence

3. **Shared** (`/shared`)
   - TypeScript type definitions shared between frontend/backend
   - Provider configurations and reasoning parameters
   - WebSocket protocol definitions
   - API contracts

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

```bash
# Start both backend and frontend in development mode
bun run dev

# Or start individually
bun run dev:backend   # Backend on http://localhost:3000
bun run dev:frontend  # Frontend on http://localhost:5173
```

### Production Build

```bash
# Build all workspaces
bun run build

# Type checking
bun run typecheck

# Strict validation
bun run check
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
- `GET /api/health` — Health check with system metrics

### WebSocket Protocol

Connect to `ws://localhost:3000/ws` for real-time updates.

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

### Built-in Tools

- **bash** — Execute shell commands
- **read_file** — Read file contents
- **write_file** — Create/overwrite files
- **edit_file** — Surgical file edits
- **grep** — Search file contents
- **glob** — Find files by pattern
- **ls** — List directory contents
- **web_search** — Search the web
- **web_fetch** — Fetch URL content

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

### API Key Management

- Keys are encrypted before persistence in `.env`
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

For more help, see `docs/TROUBLESHOOTING.md` (coming soon).

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

**Version:** 0.1.0  
**Status:** Active Development
