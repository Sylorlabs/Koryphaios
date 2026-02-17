# Koryphaios Frontend

**Real-time AI Agent Orchestration Dashboard**

Built with SvelteKit 2, TailwindCSS 4, and TypeScript.

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
- **Bun Adapter** — Production deployment with Bun

---

## Development

```bash
# Install dependencies (from project root)
bun install

# Start dev server
bun run dev:frontend

# Access at http://localhost:5173
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

# Production build
bun run build

# Preview production build
bun run preview
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
├── vite.config.ts           # Vite configuration
└── tailwind.config.js       # TailwindCSS configuration
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
All sessions are saved server-side. Frontend auto-reconnects and syncs state on page load.

### Provider Status
Live authentication status for all configured providers with in-app key management.

### Cost Tracking
Per-message and per-session cost calculation with token accounting.

---

## Deployment

The production build uses `svelte-adapter-bun` for efficient Bun runtime deployment:

```bash
# Build for production
bun run build

# Deploy the build/ directory with Bun
cd build && bun run index.js
```

---

## Type Safety

Frontend shares types with backend via `@koryphaios/shared` workspace package. All API calls and WebSocket messages are fully typed.

---

## Notes

- Configured for SvelteKit SSR with client-side hydration
- TailwindCSS with Vite plugin (no PostCSS needed)
- Strict TypeScript checking in CI
- Development server proxies API to avoid CORS issues
