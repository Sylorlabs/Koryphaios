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
- Handler registration uses method strings (`server.setRequestHandler('tools/call', …)`), not the v1 `*RequestSchema` constants. Errors use `ProtocolError` / `ProtocolErrorCode` (renamed from `McpError` / `ErrorCode`).
- Build the error-detection server before registering it: `bun run --filter @koryphaios/mcp-server build` (entry point is `mcp-server/dist/index.js`).
- The error-detection server is registered in Devin CLI at all three MCP config scopes: project (`.devin/mcp_config.json`), local (`.devin/mcp_config.local.json`), and user (`~/.config/devin/mcp_config.json`).
- Note: `backend/src/validation/schemas.ts` defines Koryphaios's own Zod HTTP API schemas named `*RequestSchema` (e.g. `CreateSessionRequestSchema`). These are NOT MCP SDK schemas and are unrelated to the v1-to-v2 migration.
