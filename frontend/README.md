# Koryphaios Frontend

**Desktop AI Agent Orchestration Dashboard**

Built with SvelteKit 2, TailwindCSS 4, and TypeScript. Runs inside a Tauri desktop shell.

---

## Overview

The frontend provides a real-time interface for managing AI agent workflows, monitoring execution, and reviewing results. Features include:

- **Live Agent Monitoring** — Watch agents spawn, think, and execute tools in real-time
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
# From project root

# Install dependencies
bun install

# Start desktop app (recommended)
bun run dev

# Or start just the backend + frontend dev server
bun run dev:backend  # Backend on :3000
```

The dev server supports:
- Hot module replacement (HMR)
- TypeScript checking
- Instant updates

---

## Building

```bash
# Type check
bun run check

# Strict type checking with warnings as errors
bun run check:strict

# Production build (for Tauri)
bun run build

# Build desktop app
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

The frontend connects to `ws://localhost:3000/ws` for real-time updates:

```typescript
const ws = new WebSocket('ws://localhost:3000/ws');

ws.onmessage = (event) => {
  const msg: WSMessage = JSON.parse(event.data);
  // Handle events: agent.spawned, stream.delta, etc.
};
```

See `@koryphaios/shared` for WebSocket protocol types.

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

The frontend runs inside a Tauri WebView with access to native APIs:

- **File System** — Native file dialogs and drag-drop
- **Notifications** — System notifications for agent completion
- **System Tray** — Background operation support

---

## Type Safety

Frontend shares types with backend via `@koryphaios/shared` workspace package. All API calls and WebSocket messages are fully typed.

---

## Notes

- Configured for SvelteKit with static adapter (for Tauri)
- TailwindCSS with Vite plugin (no PostCSS needed)
- Strict TypeScript checking in CI
- Desktop-only: No browser deployment support
