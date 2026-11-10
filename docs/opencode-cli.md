# OpenCode CLI provider

Koryphaios can drive the official [OpenCode](https://opencode.ai) CLI as a first-class CLI provider. Chat turns run through the CLI itself (never through a fake API adapter); the CLI owns its login, provider routing, and model entitlement, and Koryphaios owns the tool loop.

## Requirements

- `opencode` on your PATH (verified against 2.0.32).
- A login: `opencode auth login` — Koryphaios detects `~/.local/share/opencode/auth.json` and never sees or stores the credential.
- Click **Auth** in Settings → Providers → OpenCode (or let auto-detect enable it when the CLI and login material are both present). The connect flow runs the standard CLI-login strategy; nothing is entered in Koryphaios.

## How it works

Every turn spawns `opencode acp` — a standard [Agent Client Protocol](https://agentclientprotocol.com) server (JSON-RPC 2.0 over stdio, `protocolVersion: 1`) — and:

1. `initialize` → capability handshake (image input is supported natively).
2. `session/new` with the working directory and the session-scoped Kory MCP server (`mcpServers`), with a per-session bridge grant scoped to `mcp:catalog`/`mcp:execute` for the Kory session and role.
3. `session/set_config_option` selects the model, reasoning effort (only if the model's catalog ladder supports it), and — for research-only turns — the read-only `plan` agent.
4. `session/prompt` streams the turn as `session/update` notifications:
   - `agent_message_chunk` / `agent_thought_chunk` → streamed text / reasoning,
   - `tool_call` / `tool_call_update` → file edits (`file_edit` events) and tool executions (`tool_executed` events),
   - `usage_update` → live context occupancy (`used` vs the model's window `size`).
5. The final `session/prompt` receipt reports `inputTokens`/`outputTokens` for billing.

The Kory MCP bridge is passed per ACP session — nothing is ever written into your workspace, `opencode.json`, `.opencode/`, or any other OpenCode configuration. kory__* tool calls are executed by the bridge through Kory's ToolRegistry → permission policy → sandbox, exactly as for every other managed CLI harness.

OpenCode dispatches MCP calls through its code-execution namespace (`tools.kory.*`); those calls are reported by the Kory bridge itself and are not duplicated in the feed. Native tool calls OpenCode makes itself (e.g. `write`, `shell`) surface as regular feed entries, and `file_edit` previews appear when a native write tool creates or edits a file. Reasoning streams as thinking output; live context occupancy is shown from the ACP usage receipt.

## Models and context windows

The picker is fed from the CLI's own authenticated catalog:

```
opencode api model.list          # fast path via the background service
opencode api --standalone ...    # same catalog with no service running
opencode models                  # names only, last resort
```

Models appear with real `limit.context` (marked context-verified), real `limit.output`, per-1M-token pricing (context-tiered pricing keeps its base tier), and reasoning-effort ladders read from the catalog's `variants`. This is exactly the catalog your interactive opencode session uses — no bundled approximation.

## Tool boundary and permissions

- **Host actions** (files, shell, orchestration) flow through the kory MCP bridge and are permission-gated by Kory (including plan mode, autonomy presets, and worker/critic role scoping).
- **OpenCode's native tools** remain governed by *your* OpenCode permission configuration (`permissions` in `opencode.json`), exactly as when you run opencode yourself. Whatever that configuration *asks* about is vetoed at the ACP layer: read-like kinds (read/search/fetch/think/other) are allowed, native mutating kinds (edit/delete/move/execute) are rejected with instructions to use the kory tools. Rejection is by design — native writes would bypass Kory's approval UX.
- Research-only turns run `mode: "plan"` with no Kory bridge and no writes.
- Sandboxed turns (remote delegation) run under the OS jail with only opencode's own config/state/cache roots writable.

## Troubleshooting

- `opencode not found on PATH` — install it, then click Connect again.
- `No OpenCode login material was detected` — run `opencode auth login` in a terminal.
- `opencode acp did not start` — run `opencode acp` yourself and check the output; reconnect.
- Empty model picker — `opencode api model.list` is the discovery path; if the background service is down, Koryphaios automatically retries with `--standalone`. `opencode service restart` fixes a wedged service.

## Verification status

`opencode` is a Preview (`cli-contract`) provider in the [CLI adapter compatibility matrix](provider-compatibility.md). Live turns are attested only by explicit probes; the offline inventory records synthetic fixtures, never a support claim.
