# CLI Provider Deep-Integration Checklist — Pushing CLIs Into the Koryphaios Stack

## Status

Historical planning snapshot, superseded on 2026-08-09. This document preserves the
pre-implementation research and decision sequence; its unchecked boxes and “current state”
statements are not a current capability inventory or verification result.

The current source of truth is `backend/src/providers/devin-bridge.ts`,
`backend/src/providers/devin.ts`, `backend/src/providers/kory-mcp-bridge.ts`,
`backend/src/providers/cli-rules-skills.ts`, and their focused tests. Live account/provider
behavior remains unverified unless a dated evidence manifest explicitly records an opted-in
run. Do not use this checklist to claim a missing or completed integration.

> Goal: replace the CLI providers' internal tool calls, context editing, reasoning, and
> notes/context handling with Koryphaios-owned equivalents as far as the CLIs allow, so
> Koryphaios is the orchestration/context/permission owner and the CLIs are pluggable
> harnesses. Focus provider: **Devin** (richest extensibility surface), then generalize the
> pattern to claude-code, codex, cline, cursor, antigravity, grok, kimicode.

Research basis: local codebase reading + live `devin` binary probing (strict `--agent-config`
parser schema, ATIF `--export` trajectory structure, subcommand help, on-disk docs in
`~/.local/share/devin/cli/_versions/3000.3.22/share/devin/docs`) + ACP protocol web search.

---

## Historical baseline captured before the current bridge

- `backend/src/providers/devin.ts`: spawns `devin -p <prompt> --permission-mode … --export <path>`,
  reads stdout for live text, then drains the export for `reasoning_content` + `tool_calls` +
  `final_metrics`. Injects a `HARNESS_SYSTEM_NOTE` via the prompt body. No use of
  `--agent-config`, rules, skills, hooks, MCP, or ACP. Listed in
  `NATIVE_PROVIDERS_WITHOUT_KORY_TOOL_BRIDGE` (no Kory control-plane tool bridge).
- `backend/src/providers/provider-harness.ts`: `supportsKoryControlPlaneTools()` returns
  `false` for claude, grok, antigravity, gemini-cli, cursor, devin, cline. Only `codex` has a
  real bridge (`<KORY_TOOL_CALL>` envelope in `codex-cli.ts`).
- `backend/src/providers/cli-detection.ts` + `cli-accounts.ts`: auto-detect installed/logged-in
  CLIs and per-profile accounts. Solid foundation; reuse for all new wiring.
- `backend/src/kory/manager.ts`: assembles systemPrompt (skills + user notes + notes-network
  hint + memory + context-status), filters tools per role, gates delegation. Already has the
  injection seams; CLI providers just don't consume them.
- `backend/src/notes/` + `backend/src/tools/notes.ts`: full Obsidian-style note graph with
  agent tools (create/read/update/delete/link/recall/search/list/backlinks). Currently only
  exposed to _managed_ providers via tool defs; native CLI harnesses never see them.
- `backend/src/context/smart-context.ts`: relevance-scored file context detection. Not wired
  into CLI provider prompts.
- `mcp-server/`: a standalone Koryphaios MCP server (error detection / debugging / console
  monitoring). Not currently exposed _to_ the CLI providers as an MCP server they can call.

## Discovered Devin CLI extensibility surface (the levers)

| Lever                                                              | How                                                                                                                                                                                                                                                                                                                        | Koryphaios replacement target                                                                                                                                      |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--agent-config <file>`                                            | Per-invocation declarative JSON; strict parser. Schema: `system_instructions` (string[]), `allowed_tools` (string[]), `permissions` {allow/deny/ask: string[]}, `mcp_servers` (map), `extensions` (free-form map).                                                                                                         | Inject Kory system prompt + tool whitelist + permission scopes per turn instead of prompt-body hacks.                                                              |
| `AGENTS.md` / `~/.config/devin/AGENTS.md` / `AGENTS.local.md`      | Always-on rules injected at session start.                                                                                                                                                                                                                                                                                 | Write a Kory-managed AGENTS.md per session/worktree with the compiled skill instructions.                                                                          |
| `.devin/skills/<name>/SKILL.md`                                    | Agent-invocable skills (slash + autonomous), with `allowed-tools`, `model` override, subagent execution.                                                                                                                                                                                                                   | Mirror Kory skills as Devin skills so the CLI invokes Kory-defined workflows.                                                                                      |
| `.devin/hooks.v1.json`                                             | Lifecycle hooks: `PreToolUse`, `PostToolUse`, `PermissionRequest`, `UserPromptSubmit`, `Stop`, `SessionStart`, `SessionEnd`. Can `block`/`approve`, inject `additionalContext`, rewrite `updatedInput`.                                                                                                                    | The bidirectional bridge: route every CLI tool call through a Kory hook script that enforces Kory permissions, logs to the session feed, and injects Kory context. |
| `devin mcp add` / `mcpServers` config                              | Connect external MCP servers; tools appear as `mcp__<server>__<tool>`.                                                                                                                                                                                                                                                     | Expose Kory tools (notes, context, files, git, goals, interaction) as an MCP server the CLI calls → Kory owns execution.                                           |
| `devin acp` (JSON-RPC over stdio)                                  | Agent Client Protocol: `initialize`, `newSession`, `prompt`, `sessionUpdate`, `requestPermission`, `readTextFile`, `writeTextFile`.                                                                                                                                                                                        | Koryphaios as the ACP _client_ driving `devin acp` — full bidirectional structured protocol instead of stdout scraping.                                            |
| `--export <path>` (ATIF-v1.7)                                      | Trajectory with `schema_version`, `session_id`, `agent` (name/version/model_name/tool_definitions/extra), `steps[]` (source system/user/agent; agent steps carry `message`, `tool_calls`, `metrics`, `model_name`, `generation_model`, `extra.telemetry`), `final_metrics` (prompt/completion/cached tokens, total_steps). | Full reasoning/tool/usage extraction; today devin.ts reads only a subset.                                                                                          |
| `devin rules` / `devin skills` list/show/paths                     | Introspect loaded rules/skills.                                                                                                                                                                                                                                                                                            | Verify Kory-injected rules/skills are active; surface in UI.                                                                                                       |
| `devin models`                                                     | List account-available models.                                                                                                                                                                                                                                                                                             | Replace hardcoded `DEVIN_MODELS` table with live model discovery.                                                                                                  |
| `--permission-mode` + `permissions.{allow,deny,ask}` + `--sandbox` | Tiered permission system with scope-based matchers (`Read(glob)`, `Write(glob)`, `Exec(prefix)`, `Fetch(pattern)`) and OS sandbox.                                                                                                                                                                                         | Translate Kory `SandboxPolicy` into Devin permission scopes per turn.                                                                                              |
| Subagents (`subagent_explore`, `subagent_general`, custom)         | CLI-native delegation with own context windows.                                                                                                                                                                                                                                                                            | Currently blocked by HARNESS_SYSTEM_NOTE; either keep blocking or map to Kory worker dispatch (decision item).                                                     |

---

## Phase 0 — Foundation & verification harness

- [ ] 0.1 Add a `devin` capability probe module (`backend/src/providers/devin-capabilities.ts`)
      that runs `devin --help`, `devin mcp --help`, `devin rules paths`, `devin skills paths`,
      `devin models` once per binary path+mtime and caches: CLI version, supported flags
      (`--agent-config`, `--sandbox`, `--export`, `--permission-mode`), rules/skills dirs, model
      list. Mirror the `claude-code.ts` catalog-extraction pattern.
- [ ] 0.2 Cache probe results per binary `stat().mtimeMs` so a CLI update re-probes.
- [ ] 0.3 Add unit tests for the probe (mock `spawn`), gating every newer integration on a
      capability flag so older Devins keep working via the current stdout+export path.
- [ ] 0.4 Extend `cli-detection.ts` `AgentCliStatus` for devin with `supportsAgentConfig`,
      `supportsHooks`, `supportsAcp`, `rulesDir`, `skillsDir` fields; surface in the CLI detection
      UI so users see what's wired.
- [ ] 0.5 Add a `DEVIN_AGENT_CONFIG_DIR` (under `.koryphaios/devin-home/<sessionId>/`) managed
      by Kory, mirroring `getKoryphaiosClaudeConfigDir()` session isolation (symlinks for
      credentials, isolated rules/skills/hooks per session).

## Phase 1 — Replace prompt-body hacks with `--agent-config`

- [ ] 1.1 Build a `DevinAgentConfig` builder that emits a temp JSON file per turn with:
      `system_instructions: [compiledSystemPrompt]`,
      `allowed_tools: [koryToolNames…]` (only when a bridge exists),
      `permissions: { allow: […], deny: […], ask: […] }` translated from `SandboxPolicy`.
- [ ] 1.2 Replace the `HARNESS_SYSTEM_NOTE` prompt-body injection in `devin.ts` with a
      `system_instructions` entry; stop prepending it to the user prompt.
- [ ] 1.3 Pass `--agent-config <tmpfile>` instead of stuffing the system prompt into the
      `-p` argument; keep the user messages as the prompt body.
- [ ] 1.4 Translate Kory `SandboxPolicy` → Devin permission scopes:
      `allowEdits=false` → `deny: ["Write(**)"]`; `allowShell=false` → `deny: ["Exec(*)"]`;
      `allowWebSearch=false` → `deny: ["Fetch(*)"]`; `allowNetwork` → sandbox domain config.
- [ ] 1.5 Map `harnessRole` → `--permission-mode`: `critic` → `plan` (read-only),
      `worker` → `accept-edits`, `manager` → `accept-edits` (or `auto`). Drop the current
      `dangerous` default for managers; let the permission scopes govern.
- [ ] 1.6 Add a fallback: if the probe says `--agent-config` is unsupported, fall back to the
      current prompt-body + `--permission-mode` path (keep old behavior alive).
- [ ] 1.7 Test: strict parser rejects unknown fields — add a schema-validation unit test that
      asserts the builder never emits an unknown key (regression guard against CLI schema drift).
- [ ] 1.8 Verify the `extensions` free-form map can carry Kory session metadata
      (`kory_session_id`, `kory_prompt_manifest_hash`, `kory_task_contract_hash`) and read it back
      from the ATIF export `agent.extra` for provenance correlation.

## Phase 2 — Full ATIF trajectory parsing (reasoning + tools + usage)

- [ ] 2.1 Replace the `DevinExportStep`/`DevinExport` interfaces in `devin.ts` with the
      verified ATIF-v1.7 shape: `schema_version`, `session_id`, `agent.{name,version,
model_name,tool_definitions,extra}`, `steps[].{step_id,timestamp,source,message,
tool_calls,metrics,model_name,generation_model,extra.telemetry}`, `final_metrics`.
- [ ] 2.2 Emit `thinking_delta` from agent-step `message` when `source==='agent'` and the step
      has reasoning markers (probe the real reasoning field name from a live reasoning run).
- [ ] 2.3 Emit `tool_executed` for every `tool_calls[]` entry with `function_name`,
      `arguments`, and the matching observation/`tool_result` from the next step.
- [ ] 2.4 Emit `usage_update` from `final_metrics` (prompt/completion/cached) — keep the
      current "count cached once" logic; add `tokensCache` separately if ATIF distinguishes.
- [ ] 2.5 Emit a new `model_resolved` event (extend `ProviderEvent`) carrying
      `agent.model_name` + per-step `generation_model` so the UI shows the real model the CLI
      routed to (Devin's Adaptive router picks the model; today Koryphaios doesn't see it).
- [ ] 2.6 Surface `agent.tool_definitions` as a `tools_available` diagnostic event so the
      manager knows which native tools the CLI exposed (informs the bridge-vs-passthrough
      decision per turn).
- [ ] 2.7 Stream `extra.telemetry` latency into the session feed as a debug event
      (behind a setting).
- [ ] 2.8 Add a live-tail parser that drains the export file as it grows (current code polls
      every 250ms then reads once at exit) — emit tool/thinking events as steps land instead of
      all at the end.
- [ ] 2.9 Add tests with a captured ATIF fixture (redact PII) for each event mapping.

## Phase 3 — Hooks bridge: route CLI tool calls through Koryphaios

- [ ] 3.1 Generate `.devin/hooks.v1.json` in the per-session devin home with a single
      `command` hook for `PreToolUse` (matcher: `""` = all tools) pointing at a Kory helper
      script (`backend/src/providers/devin-hook-bridge.ts` compiled to a small CLI, or a
      `bun`-invoked script).
- [ ] 3.2 The hook script receives `{hook_event_name, tool_name, tool_input, session_id,
prompt_id}` on stdin and calls the Kory backend HTTP API
      (`POST /api/v1/devin-hook/pre-tool`) with the session id mapped to a Kory session.
- [ ] 3.3 Kory evaluates the tool call against the Kory tool registry + permission policy
      and returns `{decision: "approve"|"block", reason}` or `{hookSpecificOutput:
{hookEventName:"PreToolUse", updatedInput: {...}}}` to rewrite the call (e.g. redirect
      shell commands through Kory's sandboxed bash, rewrite file paths into the worktree).
- [ ] 3.4 Add `PostToolUse` hook → `POST /api/v1/devin-hook/post-tool` so Kory records every
      CLI tool execution in the session feed as a `tool_executed` ProviderEvent (today the
      manager only sees the export's tool_calls after the fact; this makes it live).
- [ ] 3.5 Add `UserPromptSubmit` hook → inject Kory's compiled context (notes-network hint,
      memory, smart-context files) as `additionalContext` so the CLI's prompt is enriched by
      Kory without prompt-body hacks.
- [ ] 3.6 Add `SessionStart` hook → register the CLI session with Kory's session store and
      emit a session-bound event; `SessionEnd` hook → flush.
- [ ] 3.7 Add `PermissionRequest` hook → route to Kory's permission and approval boundary so
      approvals surface in the Kory UI instead of the CLI's terminal. The historical
      `HumanInTheLoopService` named by the original draft was removed.
- [ ] 3.8 Add `Stop` hook → let Kory's critic gate decide whether the CLI may stop (return
      `block` with a reason to force the CLI to continue if the critic says fail).
- [ ] 3.9 Make hooks opt-in per session (setting `devinHooksBridge`) with a clean fallback
      to the export-only path if the Kory backend is unreachable.
- [ ] 3.10 Tests: simulate hook stdin payloads and assert Kory decisions for allow/block/
      rewrite cases; assert `updatedInput` merge semantics.

## Phase 4 — MCP bridge: expose Kory tools to the CLI

- [ ] 4.1 Add a "Kory control-plane" MCP server transport in `mcp-server/` (or a new
      `mcp-server/src/kory-bridge.ts`) that exposes the Kory tool registry (notes, files, git,
      goals, interaction, context, web) as MCP tools named `kory__<tool>`.
- [ ] 4.2 The MCP server talks to the Kory backend over the existing HTTP API
      (`/api/v1/tools/execute`) using the session id, so every `kory__*` call runs through
      Kory's permission + role + sandbox policy — Kory stays the execution owner.
- [ ] 4.3 Inject this MCP server into the per-session devin config (`.devin/config.json`
      `mcpServers` or `--agent-config` `mcp_servers`) so Devin sees `kory__create_note`,
      `kory__recall_notes`, `kory__read_file`, `kory__delegate_to_worker`, etc.
- [ ] 4.4 Resolve the `mcp_servers` McpServer enum shape (the strict agent-config parser
      rejected the documented shape — probe the exact discriminator, likely needs a specific
      field; fall back to `.devin/config.json` which uses the documented shape).
- [ ] 4.5 Map `kory__delegate_to_worker` to the existing Kory worker pipeline so Devin can
      delegate through Kory instead of its native subagents — flips
      `supportsKoryControlPlaneTools('devin')` to `true`.
- [ ] 4.6 Add a `kory__fetch_context` / `kory__prune_context` MCP tool mirroring the managed
      tools so Devin can manage its own context window through Kory.
- [ ] 4.7 Add a `kory__notes_*` family mirroring `backend/src/tools/notes.ts` so the CLI
      agent reads/writes the Kory notes graph (replaces any CLI-native note-taking).
- [ ] 4.8 Verify tool-call results round-trip: Devin `tool_calls` → MCP → Kory → result →
      ATIF `tool_calls` observation; assert in tests.
- [ ] 4.9 Document the MCP bridge in `mcp-server/README.md` and add an integration test that
      spawns `devin --agent-config … -p "create a note titled X"` and asserts the note exists.

## Phase 5 — ACP bridge: structured protocol instead of stdout scraping

- [ ] 5.1 Evaluate `devin acp` as a Kory-managed subprocess: Koryphaios becomes the ACP
      client (JSON-RPC over stdio), sending `initialize` → `newSession` → `prompt` and
      receiving `sessionUpdate` notifications + `requestPermission` requests.
- [ ] 5.2 Implement an `AcpClient` in `backend/src/providers/devin-acp.ts` using the
      `@agent-client-protocol/sdk` (verify availability; the web search confirmed a TS SDK
      exists) or a minimal hand-rolled JSON-RPC client.
- [ ] 5.3 Translate ACP `sessionUpdate` messages into `ProviderEvent` streams
      (`content_delta`, `tool_executed`, `thinking_delta`) — richer and live vs. stdout polling.
- [ ] 5.4 Handle `requestPermission` by routing to Kory's permission/HITL service; handle
      `readTextFile`/`writeTextFile` by routing through Kory's file tools (so the CLI's file
      ops go through Kory's worktree + sandbox).
- [ ] 5.5 Gate ACP behind the capability probe; fall back to `--agent-config` + hooks +
      export for CLIs without ACP.
- [ ] 5.6 Add a setting `devinTransport: 'acp' | 'agent-config-hooks' | 'legacy'` so users
      pick the integration depth.
- [ ] 5.7 Test the ACP client against a recorded transcript; assert event mapping.

## Phase 6 — Rules & skills mirroring

- [ ] 6.1 Write a Kory-managed `AGENTS.md` into the per-session devin home (or project root
      when working in a worktree) containing the compiled skill instructions from
      `backend/src/kory/prompts/` — replaces the system-prompt injection for rules.
- [ ] 6.2 Mirror Kory skills (`backend/src/kory/skills.ts` + `professional-skill-definitions.ts`)
      as `.devin/skills/<kory-skill>/SKILL.md` files with `allowed-tools` mapped from Kory role
      tool defs, so Devin can invoke `/kory-<skill>` natively.
- [ ] 6.3 Add a `devin rules list` / `devin skills list` sync step after writing to verify
      the CLI picked them up; log mismatches.
- [ ] 6.4 Keep `AGENTS.local.md` for per-session Kory overrides (e.g. the context-status
      block, the current model, the task contract hash) — gitignored, ephemeral.
- [ ] 6.5 When Kory skills change mid-session, rewrite the files and send a `UserPromptSubmit`
      hook `additionalContext` refresh so the CLI re-reads them.
- [ ] 6.6 Tests: assert generated SKILL.md frontmatter parses with `devin skills show
<name>`; assert `AGENTS.md` content matches the compiled Kory prompt manifest hash.

## Phase 7 — Context window fetching & data updating (the "context editing" goal)

- [ ] 7.1 Implement `kory__fetch_context` MCP tool (and ACP-equivalent) that returns the
      CLI's current context composition by reading the live ATIF export `steps` (system steps
      = system prompt, user/agent steps = chat) → token estimate per segment.
- [ ] 7.2 Implement `kory__prune_context` that rewrites the per-session `AGENTS.local.md` /
      sends a `UserPromptSubmit` hook `additionalContext` telling Devin which prior tool outputs
      to drop, and verifies via the next ATIF export that the step count dropped.
- [ ] 7.3 Wire `smart-context.ts` relevance scoring into the `UserPromptSubmit` hook so
      Kory's detected relevant files are injected as `additionalContext` automatically.
- [ ] 7.4 Wire the notes-network (`buildNotesNetworkPrompt`) into the same hook so
      `includeInContext` notes reach Devin as context, not prompt body.
- [ ] 7.5 Add a `kory__update_note` round-trip: when Devin writes a note via `kory__create_note`,
      the Kory notes DB updates and the next `UserPromptSubmit` hook reflects the new graph.
- [ ] 7.6 Surface the real context window from `devin models` (per-model `context_window`)
      in `ModelDef.contextWindow` so the context-status bar is accurate (today devin.ts returns
      `[]` from `listModels()` and the UI falls back to guesses).
- [ ] 7.7 Add a context-drift detector: compare the ATIF `agent.tool_definitions` against the
      Kory-expected tool set and warn if the CLI silently dropped a tool.

## Phase 8 — Reasoning info extraction

- [ ] 8.1 Probe the real reasoning field in ATIF agent steps (run a reasoning model with
      `--model opus` and inspect `steps[].message` / `extra` for thinking content; the current
      `reasoning_content` field name is unverified).
- [ ] 8.2 Map Devin's reasoning tier (Devin has no `--reasoning-effort` flag — tier is part
      of the model name: `swe-1.6-fast` vs `swe-1.6-slow`) to Kory's `reasoningLevel` so the
      composer pill controls it via model selection.
- [ ] 8.3 Emit `thinking_delta` with the real thinking text; if redacted, emit
      `thinkingTokens` estimate from `metrics` (extend `ProviderEvent` if needed).
- [ ] 8.4 Surface per-step `metrics` (token counts, latency) as a `reasoning_metrics` event
      for the UI's reasoning inspector.
- [ ] 8.5 Pass the resolved reasoning tier back to the model via `--agent-config`
      `system_instructions` ("Your reasoning effort for this request is set to X") — mirrors the
      claude-code `effortNote` pattern since Devin doesn't expose a flag.

## Phase 9 — Notes system injection (the "test notes system injection" goal)

- [ ] 9.1 Verify the `kory__create_note` MCP tool is callable from a real Devin turn
      (end-to-end test: `devin --agent-config … -p "create a note titled 'Test' with body 'hi'"`
      → assert row in Kory notes DB + `broadcastNotesNetworkUpdate` fired).
- [ ] 9.2 Verify `kory__recall_notes` returns Kory notes to Devin and Devin can act on them.
- [ ] 9.3 Verify `kory__search_notes` / `kory__list_notes` work through the bridge.
- [ ] 9.4 Verify `kory__link_notes` / `kory__unlink_notes` update the graph and the
      `additionalContext` next turn reflects new backlinks.
- [ ] 9.5 Verify `includeInContext: true` notes are auto-injected via the `UserPromptSubmit`
      hook `additionalContext` (the standing-guidance path) — separate from on-demand recall.
- [ ] 9.6 Verify project-document sync (`syncProjectDocuments`) runs so Devin sees project
      `.md`/`.html` files as notes.
- [ ] 9.7 Add a notes-permissions gate: honor `notesAgentPermissions` from `koryphaios.json`
      (currently `allow_all`) by filtering which `kory__*` note tools are exposed to Devin per
      session.
- [ ] 9.8 Test the full injection cycle: Kory note created → Devin reads it via
      `kory__recall_notes` → Devin updates it via `kory__update_note` → Kory UI shows the update.

## Phase 10 — Generalize the bridge to the other CLI providers

- [ ] 10.1 Extract a `CliBridge` interface (`buildAgentConfig`, `buildHooks`,
      `buildMcpConfig`, `parseTrajectory`, `transport`) in `provider-harness.ts` so each native
      provider implements the same deep-integration surface.
- [ ] 10.2 **claude-code**: it already has `--append-system-prompt`, `--allowedTools`,
      `--disallowedTools`, `--effort`, `CLAUDE_CONFIG_DIR` isolation, and a binary-embedded
      catalog. Add: (a) a `PreToolUse`-equivalent via Claude Code's own hooks (`.claude/hooks`
      if supported — verify), (b) expose Kory tools as an MCP server in `~/.claude.json`
      `mcpServers`, (c) flip `supportsKoryControlPlaneTools('claude')` to `true` once the MCP
      bridge lands.
- [ ] 10.3 **codex**: already has the `<KORY_TOOL_CALL>` envelope bridge. Upgrade it to the
      MCP bridge (cleaner than text envelopes), keep the envelope as fallback.
- [ ] 10.4 **cline**: has `--json` NDJSON events and `--reasoning-effort`. Add `--agent-config`-
      equivalent if Cline supports it (probe); else use the hooks bridge if Cline has lifecycle
      hooks (probe `cline --help` for hooks). Expose Kory tools via MCP.
- [ ] 10.5 **cursor**: has `--output-format stream-json`. Probe for hooks/MCP/agent-config;
      cursor-agent supports MCP servers — wire the Kory MCP bridge.
- [ ] 10.6 **antigravity** (`agy`): probe `agy --help` for hooks/MCP/config; wire the same
      bridge pattern.
- [ ] 10.7 **grok**: probe `grok --help`; wire the bridge.
- [ ] 10.8 **kimicode**: already calls the Kimi API directly (no subprocess). Add the Kory
      MCP bridge so Kimi can call Kory tools, and inject Kory context directly into the API
      system prompt (no CLI needed).
- [ ] 10.9 Per provider, document the discovered levers in
      `backend/src/providers/<provider>.md` (or AGENTS.md) so the integration is maintainable.

## Phase 11 — Orchestration & permission ownership

- [ ] 11.1 Make Kory the single permission owner: every CLI tool call (native or Kory-bridged)
      flows through the `PreToolUse` hook → Kory permission service → decision. The CLI's own
      `--permission-mode` becomes a coarse fallback only.
- [ ] 11.2 Map Kory's `harnessRole` (manager/worker/critic) to each CLI's role modes
      (claude `plan`/`acceptEdits`, devin `plan`/`accept-edits`, codex `read-only`/`workspace-
write`, cline `--plan`) consistently via the bridge.
- [ ] 11.3 Route delegation: when a native CLI tries to spawn a subagent, the `PreToolUse`
      hook on `run_subagent` (Devin) / `Task`/`Agent` (Claude) blocks it and returns a
      `additionalContext` telling the CLI to emit a `kory__delegate_to_worker` call instead.
- [ ] 11.4 Keep the critic gate: `Stop` hook returns `block` when the critic says fail,
      forcing the CLI to continue; on pass, the CLI exits and Kory emits the final summary.
- [ ] 11.5 YOLO/`dangerous` mode: only enable when Kory's `agentExecutionMode==='auto'` and
      the sandbox is active; otherwise enforce `accept-edits` + scope denies.

## Phase 12 — Observability & cost tracking

- [ ] 12.1 Parse `final_metrics` for every CLI and emit `usage_update` with
      `tokensIn`/`tokensOut`/`tokensCache` so the cost tracker works for all CLI providers.
- [ ] 12.2 Record per-step `extra.telemetry` latency in the session metrics.
- [ ] 12.3 Surface the real resolved model (`generation_model` / `model_name`) in the
      session UI and cost ledger (Devin Adaptive routes invisibly today).
- [ ] 12.4 Add a "CLI harness overhead" segment to the context-usage bar (the gap between
      Kory's estimate and the CLI's reported usage) for native-passthrough providers.
- [ ] 12.5 Log every hook decision (allow/block/rewrite) to the session feed for audit.

## Phase 13 — Tests, docs, settings

- [ ] 13.1 Unit tests for: agent-config builder, permission-scope translator, ATIF parser,
      hook bridge (stdin→Kory API→decision), MCP bridge tool dispatch.
- [ ] 13.2 Integration test: spawn real `devin` with a Kory agent-config + hooks + MCP and
      assert a note is created end-to-end (gated on `devin` being installed in CI).
- [ ] 13.3 Add `devinIntegrationDepth` setting (`legacy` | `agent-config` | `hooks` |
      `mcp` | `acp`) to `koryphaios.json` `agentSettings` so users opt into depth.
- [ ] 13.4 Update `AGENTS.md` with the CLI-bridge architecture and the rule that new CLI
      providers must implement the `CliBridge` interface.
- [ ] 13.5 Update `README.md` "Known rough edges" — the CLI integrations are no longer the
      least settled part once the bridge lands.
- [ ] 13.6 Add a frontend settings panel (using `KorySelect.svelte`, not native `<select>`)
      for `devinIntegrationDepth` per CLI provider.

## Open questions / decisions

- [ ] D1 Should native CLI subagents be blocked (current) or mapped to Kory worker dispatch?
      Recommendation: map via `kory__delegate_to_worker` MCP tool, keep block as fallback.
- [ ] D2 ACP vs hooks+MCP for Devin: ACP is the cleanest but adds a protocol dependency;
      hooks+MCP reuses existing Kory HTTP. Recommendation: ship hooks+MCP first, ACP as a
      higher-depth option.
- [x] D3 RESOLVED: the `--agent-config` `mcp_servers` field rejects **every** stdio shape
      in devin 3000.3.22 (probed ~25 combinations: command/args/env/transport/type/disabled/
      cwd/timeout/name/url+sse+streamable-http — all "data did not match any variant of
      untagged enum McpServer"). The documented `{command, args, transport: "stdio"}` shape is
      accepted by `.devin/config.json` (project config — what `devin mcp add -s project` writes
      to `.devin/config.json`, user scope writes to `~/.config/devin/mcp_config.json`). So:
      **agent-config omits mcp_servers; MCP servers go in the per-session `.devin/config.json`.**
- [ ] D4 Should Kory write `AGENTS.md` to the user's project root (shared, committed) or
      only to the per-session isolated home? Recommendation: per-session home for ephemeral
      context; project root only when the user explicitly enables "Kory rules" sharing.
- [ ] D5 Reasoning tier for Devin is model-name-encoded (`swe-1.6-fast`/`slow`); confirm
      whether `--model` accepts a reasoning-effort suffix or only the tier-in-name models.

---

## Verified `--agent-config` schema (from strict-parser probing)

```jsonc
{
  // string[] — injected as system instructions (replaces HARNESS_SYSTEM_NOTE prompt hack)
  "system_instructions": ["…", "…"],            // alias: system-instructions
  // string[] — tool-name whitelist
  "allowed_tools": ["read", "exec", "kory__create_note"],  // alias: allowed-tools
  "permissions": {
    "allow": ["Read(**)", "Exec(git)", "Write(src/**)"],
    "deny":  ["Exec(rm)", "Write(.env*)"],
    "ask":   ["Write(**/.env*)"]
  },
  "mcp_servers": { "<name>": <McpServer> },      // alias: mcp-servers; McpServer enum TBD (D3)
  "extensions": { "<key>": <any> }               // free-form; carries kory provenance metadata
}
```

Not in agent-config (live elsewhere): `model` (CLI flag / user config), `hooks`
(`.devin/hooks.v1.json`), `agent`/`theme`/`sandbox` (user config only).

## Verified ATIF-v1.7 export shape (from `--export` probing)

```jsonc
{
  "schema_version": "ATIF-v1.7",
  "session_id": "crawling-caravel",
  "agent": {
    "name": "devin",
    "version": "3000.3.22",
    "model_name": "GLM-5.2", // real resolved model (Adaptive router output)
    "tool_definitions": [], // tools the CLI exposed this turn
    "extra": { "backend": "Windsurf", "permission_mode": "Bypass" },
  },
  "steps": [
    {
      "step_id": 1,
      "timestamp": "…",
      "source": "system",
      "message": "…",
      "extra": { "telemetry": {} },
    },
    // … more system steps (harness instrs, subagent profiles, model id, env info, rules, skills)
    { "step_id": 6, "source": "user", "message": "Reply with exactly: KORY_TEST_OK" },
    {
      "step_id": 8,
      "source": "agent",
      "message": "KORY_TEST_OK",
      "model_name": "GLM-5.2",
      "generation_model": "…",
      "tool_calls": [],
      "metrics": {},
      "extra": { "generation_model": "…", "telemetry": {} },
    },
  ],
  "final_metrics": {
    "total_prompt_tokens": 13782,
    "total_completion_tokens": 6,
    "total_cached_tokens": 12288,
    "total_steps": 8,
  },
}
```

## Verified hooks (`.devin/hooks.v1.json`) events & control

| Event               | stdin fields                                                     | stdout control                                                                                  |
| ------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `PreToolUse`        | `tool_name`, `tool_input`                                        | `decision: approve/block` + `reason`; `hookSpecificOutput.updatedInput` (merged into tool args) |
| `PostToolUse`       | `tool_name`, `tool_input`, `tool_response{success,output,error}` | `additionalContext` injection                                                                   |
| `PermissionRequest` | `tool_name`, `tool_input`                                        | `decision: approve/block`                                                                       |
| `UserPromptSubmit`  | (prompt)                                                         | `hookSpecificOutput.additionalContext` (inject Kory context)                                    |
| `Stop`              | —                                                                | `decision: block` + `reason` to force continue                                                  |
| `SessionStart`      | —                                                                | `additionalContext`                                                                             |
| `SessionEnd`        | —                                                                | —                                                                                               |

Every event payload also carries `session_id` (stable) + `prompt_id` (per-turn) for
correlation; `DEVIN_PROJECT_DIR` env is set to the project root.
