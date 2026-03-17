# Koryphaios — Agent Orientation

## What this is
AI agent orchestration platform with a manager/worker/critic architecture. The manager spawns
specialized worker agents across 40+ LLM providers, coordinates tool execution, and provides
time-travel undo/redo via git shadow logging. Frontend is SvelteKit with real-time WebSocket streaming.

## Package manager
**Always use `bun`**, not npm/yarn. This is a Bun monorepo (`workspaces: [backend, frontend, shared]`).

## Zero-Config Setup (New Collaborators)

```bash
# One-command setup - generates secrets, installs deps, checks ports
bun run setup

# Then just run the app
bun run dev
```

**No manual configuration needed.** The backend:
- Auto-finds an available port if the default (29473) is taken
- Writes the active port to `.koryphaios/.active-port.json`
- Frontend auto-discovers the backend port at startup

## Dev commands
```bash
bun run dev              # starts Tauri desktop app (recommended)
bun run dev:backend      # backend only (:29473 - avoids common dev port conflicts)
bun run dev:desktop      # Tauri dev mode
bun run build            # build all workspaces
bun run build:desktop    # build desktop app for distribution
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
| `providers/dynamic.ts` | **Dynamic OpenAI-compatible providers** — unlimited provider support via presets or custom endpoints |
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
- **New OpenAI-compatible provider** → Add to `DYNAMIC_PROVIDER_PRESETS` in `backend/src/providers/dynamic.ts` (no new class needed)
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
- Config lives in `config.example.json` → copy to `koryphaios.json` (gitignored)

## Dynamic Providers (New)

Koryphaios now supports **unlimited OpenAI-compatible providers** via the dynamic provider system:

### Adding a Preset Provider

10 presets are built-in (Fireworks, Together, Perplexity, etc.). To enable:

```bash
# 1. Add API key to .env
FIREWORKS_API_KEY=fw_xxx

# 2. Or add to koryphaios.json
{
  "dynamicProviders": [
    {
      "name": "fireworks",
      "preset": "fireworks",
      "apiKey": "fw_xxx"
    }
  ]
}
```

### Adding a Custom Provider

For any OpenAI-compatible endpoint:

```typescript
// Via API (see docs/DYNAMIC_PROVIDERS.md)
POST /api/providers/dynamic
{
  "name": "my-custom-llm",
  "preset": "custom",
  "displayName": "My Custom LLM",
  "baseUrl": "https://llm.internal.company.com/v1",
  "apiKey": "internal-key",
  "headers": {
    "X-Department": "engineering"
  }
}
```

### How It Works

- `DynamicOpenAIProvider` reuses `OpenAIProvider` logic with custom base URL/headers
- Full feature parity: cost tracking, circuit breakers, model discovery
- Presets provide defaults (base URL, models, docs links)
- Dynamic providers persist in `koryphaios.json`

### Adding New Presets

Edit `backend/src/providers/dynamic.ts` → `DYNAMIC_PROVIDER_PRESETS`:

```typescript
export const DYNAMIC_PROVIDER_PRESETS = {
  mynewprovider: {
    name: "mynewprovider",
    displayName: "My New Provider",
    baseUrl: "https://api.mynewprovider.com/v1",
    defaultModels: ["model-1", "model-2"],
    envVar: "MYNEWPROVIDER_API_KEY",
    description: "Description for UI",
    docsUrl: "https://docs.mynewprovider.com",
  },
  // ... existing presets
};
```

## Reasoning Mode Configuration (New)

Koryphaios supports **custom reasoning/thinking modes** for compatible models:

### Supported Providers

| Provider | Models | Configuration |
|----------|--------|---------------|
| OpenAI | o1, o3-mini, o4-mini | `reasoning_effort`: `low`/`medium`/`high` |
| Anthropic | Claude 3.7+ | `thinking`: budget tokens |
| Google | Gemini 2.0 | Limited reasoning controls |

### Reasoning Modes

- `disabled` - No reasoning (fastest, cheapest)
- `minimal` - Minimal reasoning
- `low` - Low effort, faster responses
- `medium` - Balanced (default)
- `high` - High effort, thorough reasoning
- `max` - Maximum reasoning (slowest, highest quality)

### Config Example

```json
{
  "dynamicProviders": [
    {
      "name": "fireworks",
      "preset": "fireworks",
      "apiKey": "fw_xxx",
      "reasoning": {
        "mode": "high",
        "includeThoughts": false
      },
      "modelReasoning": {
        "accounts/fireworks/models/llama-v3p1-405b-instruct": {
          "mode": "medium",
          "budgetTokens": 4096
        }
      }
    }
  ]
}
```

### Programmatic Usage

```typescript
import { createProviderFromPreset } from "./providers/dynamic";

const provider = createProviderFromPreset("fireworks", "fw_xxx", {
  reasoning: { mode: "high" }
});

// Per-model override
provider.setModelReasoningConfig("accounts/fireworks/models/llama-v3p1-405b-instruct", {
  mode: "medium",
  budgetTokens: 4096
});
```

**Note:** See `docs/DYNAMIC_PROVIDERS.md` for provider configuration and remaining integration work.

## Architecture docs
| Doc | Topic |
|---|---|
| `docs/ARCHITECTURE.md` | System design overview |
| `docs/SHADOW_LOGGER.md` | Time-travel / git shadow logging |
| `docs/WORKSPACE_MANAGER.md` | Parallel agent isolation via git worktrees |
| `docs/TOOL_DEVELOPMENT.md` | Adding custom tools |
| `docs/AI_PROVIDERS_TAXONOMY.md` | Provider classification and capabilities |
| `docs/DYNAMIC_PROVIDERS.md` | Dynamic providers and reasoning modes |
| `docs/openapi.yaml` | Full REST API spec |
| `docs/REFACTORING_SUMMARY.md` | Architecture refactoring summary |
| `docs/adr/` | Architecture Decision Records |
