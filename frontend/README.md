# Koryphaios Frontend

Built with SvelteKit 2, TailwindCSS 4, and TypeScript. The frontend runs inside a Tauri shell in the desktop app, but it talks to the local backend over HTTP and WebSocket.

---

## Overview

The frontend provides a real-time interface designed specifically for developers who want AI to generate, test, and orchestrate their entire codebase. Features include:

- **Live Agent Monitoring** — Watch agents spawn, think, and autonomously execute tools in real-time
- **Session Management** — Create, browse, and manage conversation sessions
- **Provider Configuration** — Configure API keys and manage provider status
- **Cost Analytics** — Track token usage and costs per session
- **Streaming UI** — Real-time content rendering with WebSocket updates

---

## Tech Stack

- **SvelteKit 2** — Modern web framework with file-based routing
- **Svelte 5** — Reactive UI components with runes
- **TailwindCSS 4** — Utility-first styling with Vite plugin
- **TypeScript** — Type-safe development
- **Vite 7** — Fast build tooling
- **Tauri v2** — Native desktop shell

---

## Development

```bash
# Install dependencies
bun install

# Supported workflow: launch the native desktop app from the repo root
bun run dev
```

Notes:

- `bun run dev` launches backend + internal frontend dev server + Tauri shell.
- The frontend dev server exists only to feed the native Tauri WebView during development.
- The frontend discovers the backend URL from Vite env or the Tauri runtime config.

---

## Building

```bash
# From frontend/

# Type check
bun run check

# Strict type checking with warnings as errors
bun run check:strict

# Production build (for Tauri)
bun run build

# Build the desktop shell from repo root
bun run build:desktop
```

---

## Project Structure

```
frontend/
├── src/
│   ├── routes/              # SvelteKit pages
│   │   ├── +page.svelte     # Main chat interface
│   │   └── +layout.svelte   # Root layout
│   ├── lib/                 # Reusable components
│   │   ├── components/      # UI components
│   │   └── stores/          # Svelte stores
│   └── app.html             # HTML template
├── static/                  # Static assets
├── svelte.config.js         # SvelteKit configuration
└── vite.config.ts           # Vite configuration
```

---

## WebSocket Integration

The frontend should not hardcode a port. In development and desktop runtime it resolves the WebSocket URL through `$lib/utils/api-url`:

```typescript
import { getWsUrl } from '$lib/utils/api-url';

const ws = new WebSocket(getWsUrl());

ws.onmessage = (event) => {
  const msg: WSMessage = JSON.parse(event.data);
  // Handle events: agent.spawned, stream.delta, etc.
};
```

By default, the desktop config lives in `config/app.config.json`; the current repo default is `127.0.0.1:3001`.

---

## Key Features

### Real-Time Streaming

Content streams token-by-token with typing indicators, tool execution visualization, and agent status updates.

### Session Persistence

All sessions are saved locally. Frontend auto-reconnects and syncs state on app launch.

### Provider Status

Live authentication status for all configured providers with in-app key management.

### Cost Tracking

Per-message and per-session cost calculation with token accounting.

---

## Desktop Integration

The frontend runs inside a Tauri WebView and also consumes the local backend server:

- **File System** — Native file dialogs and drag-drop
- **Notifications** — System notifications for agent completion
- **System Tray** — Background operation support
- **HTTP API** — `/api/*` routes for auth, sessions, providers, git, mode, memory, and more
- **WebSocket** — `/ws` for streaming agent and session updates

---

## Type Safety

Frontend shares types with backend via `@koryphaios/shared` workspace package. All API calls and WebSocket messages are fully typed.

---

## Notes

- Configured for SvelteKit with static adapter (for Tauri)
- TailwindCSS with Vite plugin (no PostCSS needed)
- Strict TypeScript checking in CI
- The supported runtime target is the native desktop app; localhost dev URLs are internal only
