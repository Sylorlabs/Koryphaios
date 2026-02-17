# Shared Package

**Package:** `@koryphaios/shared`
**Purpose:** Type-safe contract between frontend and backend

---

## Overview

The shared package defines all TypeScript types, interfaces, and contracts used across the Koryphaios monorepo. This ensures type safety and consistency between the backend server and frontend UI.

## What's Included

### Provider & Model System
- **ProviderName** — Enum of supported AI providers (Anthropic, OpenAI, Gemini, etc.)
- **ModelDef** — Model metadata (context window, costs, capabilities)
- **ProviderConfig** — Provider authentication and configuration
- **ReasoningConfig** — Provider-specific reasoning parameter mappings

### Agent Types
- **AgentRole** — Manager, coder, task, reviewer, title, summarizer
- **AgentStatus** — Lifecycle states (idle, thinking, tool_calling, streaming, etc.)
- **WorkerDomain** — Domain specialization (ui, backend, general, review, test)
- **AgentIdentity** — Full agent metadata including glow colors for UI

### Tool System
- **ToolName** — Standard tool identifiers + dynamic MCP tools
- **ToolCall** — Tool invocation with parameters
- **ToolResult** — Execution results with timing and error status

### Message & Content
- **Message** — Chat message with role, content blocks, tokens, cost
- **ContentBlock** — Polymorphic content (text, thinking, tool_use, tool_result, image)
- **ContentBlockType** — Type discriminator for content rendering

### Session Management
- **Session** — Conversation container with metadata and analytics
- **PermissionRequest** — Tool permission system for user approval
- **PermissionResponse** — Grant/deny/grant_session

### WebSocket Protocol
- **WSMessage** — Envelope for all real-time events
- **WSEventType** — 20+ event types for streaming, agents, sessions, system
- **Specific Payloads** — Typed payloads for each event type

### Configuration
- **KoryphaiosConfig** — Main application configuration schema
- **MCPServerConfig** — MCP server connection definitions

### REST API
- **APIResponse** — Standard response wrapper
- **SendMessageRequest** — Message sending parameters
- **CreateSessionRequest** — Session creation parameters

### Reasoning Configuration

**Provider-specific reasoning parameters** researched from official API documentation:

| Provider | Parameter | Options | Default |
|----------|-----------|---------|---------|
| Anthropic | `effort` | low, medium, high, max | high |
| OpenAI | `reasoning.effort` | low, medium, high (varies by model) | medium |
| Gemini | `thinkingConfig.thinkingBudget` | 0, 1024, 8192, 24576 tokens | 8192 |
| Groq | `reasoning_effort` | low, medium, high (model-dependent) | medium |
| xAI | `reasoning_effort` | low, high | high |
| Azure | `reasoning.effort` | low, medium, high | medium |

**Model-specific overrides:**
- GPT-5 series: Supports `xhigh` effort level
- o1-mini: No reasoning effort parameter
- Qwen models: Only `none`/`default`
- Gemini 2.5/3: Uses `thinkingLevel` instead of token budget

**Helper functions:**
- `getReasoningConfig(provider, model?)` — Get reasoning config for provider/model combo
- `hasReasoningSupport(provider, model?)` — Check if reasoning is supported
- `getDefaultReasoning(provider, model?)` — Get default value

---

## Usage

### Backend
```typescript
import type { Session, WSMessage, ProviderName } from "@koryphaios/shared";
import { getReasoningConfig } from "@koryphaios/shared";

const config = getReasoningConfig("anthropic", "claude-sonnet-4-20250514");
// { parameter: "effort", options: [...], defaultValue: "high" }
```

### Frontend
```typescript
import type { AgentIdentity, StreamDeltaPayload } from "@koryphaios/shared";

function handleWSMessage(msg: WSMessage<StreamDeltaPayload>) {
  if (msg.type === "stream.delta") {
    console.log(msg.payload.content);
  }
}
```

---

## Type Safety Guarantees

1. **Compile-time validation** — TypeScript ensures frontend/backend stay in sync
2. **Discriminated unions** — ContentBlock and WSMessage use type narrowing
3. **Exhaustive checking** — Switch statements on enums catch missing cases
4. **Shared constants** — ProviderName enum prevents typos

---

## Maintenance

When adding new features:

1. **Define types here first** — Ensure both sides agree on the contract
2. **Update protocol version** — Increment version on breaking changes
3. **Document reasoning configs** — Keep provider mappings up-to-date with API docs
4. **Maintain backward compat** — Use optional fields for non-breaking additions

---

## Architecture Benefits

- **Single source of truth** — One definition, two consumers
- **Refactoring safety** — Changes propagate via TypeScript errors
- **Protocol versioning** — Clear interface between services
- **Zero runtime overhead** — Types erased at compile time
