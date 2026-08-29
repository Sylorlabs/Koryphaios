# Koryphaios Agent Guidance

## UI controls

- Never introduce native HTML `<select>` controls in Koryphaios product UI.
- Use the shared `KorySelect.svelte` component for dropdowns so styling, keyboard behavior, focus handling, and theming remain consistent.
- Use Koryphaios-native switches and steppers instead of browser-default checkboxes and numeric spinner controls.
- New reusable controls must use theme tokens rather than hard-coded light/dark surfaces.

## Rich responses

- Use standard GitHub-flavored Markdown tables for structured comparisons; never imitate tables with spaces or ASCII art.
- Koryphaios renders fenced `chart` JSON blocks as native charts. Supported types are `bar`, `line`, and `pie`, using `labels` plus Chart.js-style `datasets` containing `label` and numeric `data` arrays.
- Koryphaios renders fenced `color` (or `kory-color`) blocks as themed swatch chips. Accept one color per line (`<value>[ <label>]`) or JSON (`{ "value": ..., "label": ... }`, arrays, or `{ "colors": [...] }`). Supported value forms: `#hex`, `rgb()/rgba()`, `hsl()/hsla()`, and named colors. Values are validated and escaped before entering the `style` attribute.
- Koryphaios renders fenced `html` (or `kory-html` / `html-sandbox`) blocks as sandboxed iframes so agents can show arbitrary HTML + CSS layouts (grids, diagrams, styled cards). The iframe uses `sandbox=""` (no scripts, no same-origin, no forms) and a strict CSP (`default-src 'none'`; `style-src 'unsafe-inline'`; `img-src data: blob:`). Never rely on JavaScript inside these blocks — it will not execute.

## MCP server

- Koryphaios has **two** stdio MCP servers, both on `@modelcontextprotocol/server` v2 (the TypeScript SDK for the MCP `2026-07-28` spec). The retired `@modelcontextprotocol/sdk` v1 package must not be re-added anywhere (root, `mcp-server/`, or `backend/`).
  - `mcp-server/` — the error-detection/debugging server (entry point `mcp-server/dist/index.js`).
  - `backend/src/providers/kory-mcp-bridge.ts` — the control-plane bridge that exposes all `kory__*` tools to CLIs (Devin, Claude, Codex, etc.). Requires a bridge grant file to start.
- Both servers use `serveStdio(() => buildServer())` from `@modelcontextprotocol/server/stdio`, which owns the stdio transport and serves the `2026-07-28` protocol revision by default with `2025-11-25` fallback for legacy clients. Do not revert to `new StdioServerTransport()` + `server.connect()`.
- Both servers use the high-level `McpServer` class (not the low-level `Server`). `buildServer()` returns a `McpServer` instance. Tools, resources, and prompts are registered via `registerTool()` / `registerResource()` / `registerPrompt()`, not via `setRequestHandler('tools/call', …)`. The SDK automatically handles `tools/list`, `tools/call`, `resources/list`, `resources/read`, `prompts/list`, and `prompts/get` dispatch, plus per-call input validation.
  - The error-detection server (`mcp-server/`) uses Zod schemas (`zod/v4`) for tool and prompt input validation. Static schemas are defined in `TOOL_SCHEMAS` and `PROMPT_SCHEMAS` on `KoryphaiosMCPServer`.
  - The bridge server (`kory-mcp-bridge.ts`) uses `fromJsonSchema()` from `@modelcontextprotocol/server` to wrap the dynamic JSON Schemas fetched from the backend catalog at runtime. This provides the same automatic validation that Zod-based tools get, but for JSON Schema objects.
- Errors from `McpServer` use `ProtocolError` / `ProtocolErrorCode` (renamed from `McpError` / `ErrorCode`). Unknown tools throw `ProtocolError(InvalidParams, "Tool <name> not found")`.
- Build the error-detection server before registering it: `bun run --filter @koryphaios/mcp-server build` (entry point is `mcp-server/dist/index.js`).
- The error-detection server is registered in Devin CLI at all three MCP config scopes: project (`.devin/mcp_config.json`), local (`.devin/mcp_config.local.json`), and user (`~/.config/devin/mcp_config.json`).
- Note: `backend/src/validation/schemas.ts` defines Koryphaios's own Zod HTTP API schemas named `*RequestSchema` (e.g. `CreateSessionRequestSchema`). These are NOT MCP SDK schemas and are unrelated to the v1-to-v2 migration.

## Freebuff provider

The Freebuff provider is a thin library wrapper around `CodebuffClient` from `@codebuff/sdk` (pinned at v0.10.7 in `backend/package.json`) — it is NOT a CLI-subprocess provider. The installed `freebuff` binary is a TUI-only Ink launcher with no headless/JSON mode; there is no CLI to shell out to. The provider calls the Codebuff cloud backend exclusively through the SDK. That backend contract is NOT publicly documented: the SDK is the only public surface, and its internal endpoints (session claim, fingerprint handshake, agent templates, run completion, event types) can change across SDK versions. Any `@codebuff/sdk` upgrade must re-validate the session-claim endpoints, the model list (`FREEBUFF_MODEL_MENU`), and the SDK smoke path against the live CLI's picker.

Tool execution is owned by Koryphaios via the SDK's `overrideTools` hook. Every native SDK tool that touches the filesystem or runs commands (`write_file`, `str_replace`, `apply_patch`, `run_terminal_command`, `list_directory`, `glob`, `code_search`, `read_files`) is overridden to route through `ToolRegistry.execute()` and `permission-policy.ts`. Web tools (`web_search`, `read_url`) stay native because they run server-side on Codebuff's backend with no local side effects. All permission, sandbox, approval, change recording, and file-edit streaming for Freebuff runs through the same Kory pipeline as the subprocess CLI providers.

Credentials are read from `~/.config/manicode/credentials.json` (written by `freebuff login`); the SDK requires both `authToken` and `fingerprintId` to construct a `CodebuffClient`. Koryphaios never collects or stores a Freebuff token directly — the local `freebuff login` is the supported way to obtain the credentials. When the provider cannot talk to the backend (missing credentials, SDK load failure, session-claim rejection), `streamResponse` surfaces `FREEBUFF_UNAVAILABLE_ERROR` from `backend/src/providers/freebuff.ts`. The "no CLI login material on disk" path yields a more user-friendly "Freebuff CLI not logged in. Run \"freebuff login\" …" message instead.
