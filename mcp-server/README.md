# Koryphaios MCP server

This private workspace package exposes Koryphaios error detection and browser-control helpers over the Model Context Protocol (MCP). It is one of Koryphaios's two local stdio servers; the other is the control-plane bridge in `backend/src/providers/kory-mcp-bridge.ts`.

Both servers use `@modelcontextprotocol/server` v2 and `serveStdio(() => buildServer())`. The current wire revision is `2026-07-28`, with `2025-11-25` accepted as the legacy negotiation fallback. Production code does not construct `StdioServerTransport` or call `server.connect()`; the in-memory transport used by protocol tests is test-only.

Both servers use the high-level `McpServer` class with `registerTool()` / `registerResource()` / `registerPrompt()` for tool/resource/prompt registration. The error-detection server uses Zod schemas (`zod/v4`) for automatic input validation; the bridge server uses `fromJsonSchema()` to wrap dynamic JSON Schemas from the backend catalog. The SDK handles `tools/list`, `tools/call`, `resources/list`, `resources/read`, `prompts/list`, and `prompts/get` dispatch automatically — no manual `setRequestHandler` calls.

The server reports only capabilities backed by an implementation. In particular, it does not publish demo resources, claim active debugger sessions, or return synthetic performance and variable data.

## Implemented surface

### Tools

| Tool            | Current contract                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| `detect-errors` | Runs the configured error detectors, or a language handler for supplied files.                       |
| `analyze-error` | Returns analysis for an error ID already known to the detector manager. Unknown IDs fail explicitly. |
| `navigate`      | Opens a URL in a managed Playwright browser session.                                                 |
| `screenshot`    | Captures the current Playwright page as PNG data.                                                    |
| `click`         | Clicks a selector in the current Playwright page.                                                    |
| `fill`          | Fills a selector in the current Playwright page.                                                     |
| `evaluate`      | Evaluates JavaScript in the current Playwright page.                                                 |
| `get_logs`      | Returns console output captured for the Playwright session.                                          |
| `clear_logs`    | Clears captured console output for the Playwright session.                                           |

### Prompts

The server publishes instruction templates for error explanation, fix suggestions, performance analysis, debugging guidance, code review, and error prevention. These are prompt templates; they do not themselves call a model or prove that a proposed fix works.

### Resources

No built-in resources are currently published. A resource appears only after code registers both its descriptor and a real readable provider. This prevents clients from mistaking sample logs, metrics, or debugger state for live product data.

## Explicit limits

- Transport is stdio only. HTTP and SSE startup requests fail explicitly.
- Language handlers detect and analyze source problems. Debugger capabilities are reported as unavailable until a real language debugger adapter is installed; session creation fails explicitly instead of advertising placeholder support.
- Breakpoint, variable-inspection, profiling, and memory-tracking tools are not registered.
- The Playwright tools control a managed browser. They are not proof of Tauri/native-window behavior.
- Detector quality depends on the configured local compilers, linters, test runners, and files. Missing tools can reduce the available evidence.
- Automated tests prove repository behavior in their fixtures; they do not certify every IDE, operating system, or external tool installation.

## Build and verify

From the repository root:

```bash
bun install
bun run --filter @koryphaios/mcp-server typecheck
bun run --filter @koryphaios/mcp-server build
bun run --filter @koryphaios/mcp-server test -- --run

# The explicit protocol-wire suite
bun run --filter @koryphaios/mcp-server test:mcp
```

For the narrow capability-truth regressions:

```bash
cd mcp-server
bunx vitest run \
  tests/unit/server/resource-manager.test.ts \
  tests/unit/server/tool-registry-truth.test.ts \
  tests/protocol/mcp-server-protocol.test.ts
```

## Run locally

Build the package, then configure an MCP client to start the compiled stdio entrypoint:

```json
{
  "mcpServers": {
    "koryphaios-debugging": {
      "command": "node",
      "args": ["/absolute/path/to/Koryphaios/mcp-server/dist/index.js"]
    }
  }
}
```

The server writes protocol messages to stdout. Normal console logging is disabled in MCP mode so logs cannot corrupt that stream.

The bundled debugging server is registered in Devin at all three supported
scopes: the project `.devin/mcp_config.json`, the project-local
`.devin/mcp_config.local.json`, and the user
`~/.config/devin/mcp_config.json`. Each points at the built `dist/index.js`
entrypoint and uses stdio; build the package before starting a fresh client.

## Configuration

By default, the package reads `error-debugging-config.json` from its working directory. If the file is absent, `ConfigManager` uses its validated defaults and attempts to create it. Invalid, malformed, or unreadable existing files fail explicitly and remain untouched. Use an isolated writable working directory when a client should not modify the project checkout.

The configuration schema groups:

- server identity and log level;
- enabled detector sources, filters, polling, and buffer limits;
- analysis options;
- debugger and performance options used by the internal development environment;
- optional build, test, linter, IDE, VCS, container, and security integrations.

Configuration flags do not create capabilities by themselves. The retained analysis, debugger, performance, IDE, build-system, container, and security groups are backward-readable compatibility fields and default unavailable unless a real runtime consumes them. Enabling debugging does not make the unimplemented language debugger-session methods available through MCP, and the package does not install or impersonate an IDE extension.

## Error detection examples

General detector request:

```json
{
  "name": "detect-errors",
  "arguments": {
    "source": "build",
    "projectRoot": "/absolute/path/to/project",
    "includeWarnings": true
  }
}
```

Language-specific file request:

```json
{
  "name": "detect-errors",
  "arguments": {
    "source": "all",
    "language": "typescript",
    "files": ["/absolute/path/to/project/src/example.ts"],
    "includeWarnings": true
  }
}
```

Paths and source content are supplied to local tools. Callers are responsible for selecting the intended project and for not disclosing sensitive files to an untrusted MCP client or model.

## Development notes

- Add a tool only with a real handler and a regression for failure behavior.
- Add a resource only with a real provider; descriptor-only resources are rejected by the registry API.
- Treat returned detector findings as evidence to investigate, not an automatic diagnosis.
- Keep protocol output free of banners and ordinary application logs.

The package is private and licensed under the repository's `mcp-server/LICENSE` terms.
