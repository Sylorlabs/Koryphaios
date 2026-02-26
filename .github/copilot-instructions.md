# Koryphaios — Copilot Instructions

## What this is
AI agent orchestration platform with a manager/worker/critic architecture. The manager spawns
specialized worker agents across 40+ LLM providers, coordinates tool execution, and provides
time-travel undo/redo via git shadow logging. Frontend is SvelteKit with real-time WebSocket streaming.

## Package manager
**Always use `bun`**, not npm/yarn. This is a Bun monorepo (`workspaces: [backend, frontend, shared]`).

## Dev commands
```bash
bun run dev              # starts backend (:3000) + frontend (:5173) concurrently
bun run dev:backend      # backend only
bun run dev:frontend     # frontend only
bun run build            # build all workspaces
bun run check            # typecheck all
bun run test             # backend tests (bun test)
bun run test:all         # full test suite
```

## Module map

### `backend/src/`
| Module | Purpose |
|---|---|
| `kory/` | **Orchestration engine** — manager, worker, critic agent lifecycle; shadow logger; workspace manager; git manager |
| `core/` | Session orchestration entry point (`ManagerSession.ts`), model routing, auth helpers |
| `providers/` | Thin LLM adapters (Anthropic, OpenAI, Gemini, xAI, Copilot, Cline, Codex, Azure, Bedrock, etc.) |
| `tools/` | Tool registry + implementations (bash, file ops, web, shell management, interaction) |
| `mcp/` | Model Context Protocol client — extensible external tool servers |
| `routes/` | REST handlers (thin — delegate to core/kory, no business logic here) |
| `auth/` | JWT + API key auth, rate limiting, encryption |
| `db/` | SQLite via `better-sqlite3` + migrations |
| `stores/` | File-based session/message/task persistence |
| `credit-accountant/` | Token counting + cost tracking per provider |
| `redis/` | Optional distributed state (gracefully absent if not configured) |
| `telegram/` | Optional Telegram bot bridge |
| `monitoring/` | Health checks, metrics, error tracking |
| `middleware/` | Auth, CORS, validation, request logging |

### `frontend/src/`
| Path | Purpose |
|---|---|
| `routes/+page.svelte` | Main dashboard — chat, session list, agent status panels |
| `routes/+layout.svelte` | Global layout — auth gate, WebSocket init, global stores |
| `lib/components/` | Reusable UI components |
| `lib/stores/` | Svelte reactive state (sessions, messages, providers, streaming) |
| `lib/api.ts` | Typed fetch wrappers for the backend REST API |
| `lib/types.ts` | Frontend-local type extensions (imports from `@koryphaios/shared`) |

### `shared/src/`
Single source of truth for all TypeScript types shared between backend and frontend.
**Never duplicate types — always import from `@koryphaios/shared`.**

Key exports: `ProviderName`, `ModelDef`, `AgentRole`, `AgentStatus`, `ToolName`, `ToolCall`,
`ToolResult`, `Message`, `ContentBlock`, `Session`, `WSMessage`, `WSEventType`, `KoryphaiosConfig`

## Key conventions
- **New LLM provider** → `backend/src/providers/`, implement the `BaseProvider` interface, register in `registry.ts`
- **New tool** → `backend/src/tools/`, implement `ToolDefinition`, register in `registry.ts`
- **New shared type** → `shared/src/index.ts` only
- **New REST endpoint** → thin handler in `backend/src/routes/`, logic in `core/` or `kory/`
- Sessions + state live in `.koryphaios/` (gitignored, never commit)
- Worker agents run in isolated git worktrees (see `kory/workspace-manager.ts`)
- Time-travel state is in git notes/shadow commits (see `kory/shadow-logger.ts`)

## Gotchas
- **Bun, not Node** — some Node APIs differ; use Bun-native APIs where possible
- `redis/` is optional — code must handle Redis being absent gracefully
- Provider files are **thin adapters only** — no agent logic, no routing decisions
- `routes/` handlers are **thin** — never put orchestration logic in route handlers
- Frontend uses **Svelte 5** (runes syntax: `$state`, `$derived`, `$effect`) not Svelte 4 stores
- Tailwind v4 (CSS-first config, no `tailwind.config.js`)
- Config lives in `config.example.json` → copy to `config.json` (gitignored)

## Architecture docs
| Doc | Topic |
|---|---|
| `docs/ARCHITECTURE.md` | System design overview |
| `docs/SHADOW_LOGGER.md` | Time-travel / git shadow logging |
| `docs/WORKSPACE_MANAGER.md` | Parallel agent isolation via git worktrees |
| `docs/TOOL_DEVELOPMENT.md` | Adding custom tools |
| `docs/AI_PROVIDERS_TAXONOMY.md` | Provider classification and capabilities |
| `docs/openapi.yaml` | Full REST API spec |
| `docs/adr/` | Architecture Decision Records |
