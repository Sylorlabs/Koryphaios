# Koryphaios Agent Guidance

## UI controls

- Never introduce native HTML `<select>` controls in Koryphaios product UI.
- Use the shared `KorySelect.svelte` component for dropdowns so styling, keyboard behavior, focus handling, and theming remain consistent.
- Use Koryphaios-native switches and steppers instead of browser-default checkboxes and numeric spinner controls.
- New reusable controls must use theme tokens rather than hard-coded light/dark surfaces.

## Rich responses

- Use standard GitHub-flavored Markdown tables for structured comparisons; never imitate tables with spaces or ASCII art.
- Chat and composer previews render inline TeX (`$...$` or `\(...\)`), display TeX (`$$...$$` or `\[...\]`), and fenced `math` / `latex` / `tex` blocks with KaTeX. Keep equations as source TeX, not screenshots or HTML glyph trees. Rich browser paste recovers headings, lists, simple tables, and equations when source TeX annotations are present; screenshots remain image attachments, not editable math.
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
- The error-detection server is registered in Devin CLI at the machine-local scopes: project-local (`.devin/mcp_config.local.json`) and user (`~/.config/devin/mcp_config.json`). These are local-only and never committed.
- Note: `backend/src/validation/schemas.ts` defines Koryphaios's own Zod HTTP API schemas named `*RequestSchema` (e.g. `CreateSessionRequestSchema`). These are NOT MCP SDK schemas and are unrelated to the v1-to-v2 migration.

## Dedicated capability providers

Eight built-ins have no chat-completions contract: `lmnt`, `voyageai`, `mem0`, `letta`, `prodia`, `luma`, `klingai`, `replicate`. They are reached through dedicated adapters in `backend/src/providers/capabilities/`, and `docs/capability-providers.md` is the reference.

- They stay in `UNSUPPORTED_CHAT_PROVIDER_NAMES`. `createProvider()` must keep returning `null` for them and they must never appear in the chat model picker. Faking an OpenAI-compatible chat adapter would let a user select a model that cannot answer a message.
- They are also in `DEDICATED_CAPABILITY_PROVIDER_NAMES`, so a credential verifies against the adapter's own endpoint and `configurationBlocked` stays false.
- `shared/src/provider-support.ts` records them at tier `preview` with evidence `capability-adapter-contract`. Never mark a capability provider `certified`.
- An adapter may implement only the capabilities it actually supports. A test asserts every adapter's declared capability set matches its implemented methods, so an adapter must never advertise audio without a `synthesize` implementation.
- `ResolvedCapabilityConfig` is passed per call, never held in adapter module state.
- Model lists describe how to call a provider's models, never entitlement. Return `[]` rather than inventing a catalog when a provider publishes no enumeration endpoint.
- Async generation goes through `capabilities/poll.ts`. Provider media must be downloaded and persisted, not linked: Kling clears generated assets after 30 days.
- Adding a `video` or `embedding` usage kind requires the CHECK constraints in migration `0049` and `ensureSchema` to agree.

## Freebuff and Codebuff providers

Freebuff runs through its real TUI (OpenTUI in the qualified native 0.2.12 build) in `backend/src/providers/freebuff-cli.ts`. The adapter uses a private tmux server as a PTY, stages the CLI-owned login and selected model settings in a per-turn private HOME, installs `.agents/mcp.json`, and reads structured completion/tool evidence from Freebuff's own `log.jsonl` inside isolation. It has no headless mode or general native-tool deny hook, so Linux bubblewrap isolation is mandatory, either on native Linux or inside the pinned Docker/Colima Linux runtime on macOS: native Freebuff tools can affect only a disposable checkout. The real session workspace is available only through `backend/src/providers/kory-mcp-bridge.ts`, whose grant is scoped to the Kory session and role and whose executions flow through `ToolRegistry.execute()` and `permission-policy.ts`. Never weaken this to an unsandboxed fallback or claim the native tools are disabled.

Credentials remain owned by `freebuff login` in `~/.config/manicode/credentials.json` or the Freebuff-owned Keychain item it references. Koryphaios resolves only that exact referenced item through the normal OS permission gate, stages a private 0600 per-turn copy, and deletes it afterward; never dump Keychains, log tokens, alter the original login, or reuse the token as a Codebuff SDK key. Modern account-aware model selection stays CLI-owned (`freebuff/cli-default`); do not fabricate a static available-model or vision catalog. Any Freebuff upgrade must revalidate the actual model selection, `.agents/mcp.json` loading, private-workspace `--trust-agents`, startup keystrokes, and root `log.jsonl` completion/error shapes. See `docs/freebuff-cli.md` and `docker/freebuff-runtime/README.md`.

Codebuff is a separate API-key provider in `backend/src/providers/codebuff.ts`, using `@codebuff/sdk` v0.10.7 and the documented `codebuff/base@0.0.16` store agent. It must use a real `CODEBUFF_API_KEY`; Freebuff CLI credentials are never reused as an SDK key. Supported SDK filesystem and command tools are overridden through Kory's tool pipeline, while SDK-local artifacts are confined to a disposable workspace with native reads blocked. `RunState.output.type === "error"` is a provider error and must never be converted into an empty successful completion.

## Antigravity provider

The Antigravity CLI (`agy`) has a real declarative permission engine, and Koryphaios drives it directly. The contract below was measured against a live `agy` 1.2.16 turn; treat it as verified fact, not documentation to re-derive.

- Tool authority lives in the managed home's `$GEMINI_DIR/antigravity-cli/settings.json` (`backend/src/providers/antigravity-permissions.ts` owns the payload). `permissions.deny` blocks `command(*)`, `unsandboxed(*)`, `write_file(*)`, `read_url(*)`, and `execute_url(*)`; `permissions.allow` contains exactly `mcp(kory/*)` plus `read_file(<workspace>)`. Rules evaluate **Deny > Ask > Allow**.
- `permissions.allow` must contain `mcp(kory/*)`. `call_mcp_tool` defaults to Ask, and a headless turn auto-denies Ask, so without that entry the `kory__*` bridge is unreachable and every real action is refused. Verified in both directions.
- The workspace must also appear in `trustedWorkspaces`, matched against its **canonical** path. An untrusted workspace makes even reads require approval, which headless cannot grant. agy resolves symlinks before matching rules, so `/var/...` style paths never match (the same trap applies to Seatbelt rules).
- `toolPermission` must stay `request-review`. `always-proceed` is `--dangerously-skip-permissions`; `strict` additionally auto-denies workspace reads headlessly, leaving the agent unable to read its own checkout.
- **`--mode plan|accept-edits` is not a control.** agy logs "Print mode: --mode <x> is not supported headless" and continues in the default mode. Never reintroduce it as a permission lever; plan posture comes from the permission rules plus the session policy on bridge calls.
- MCP servers are registered in `$GEMINI_DIR/config/mcp_config.json`. agy reads neither `.claude.json` nor `.agents/mcp.json`, and it surfaces MCP through the single built-in `call_mcp_tool` rather than one tool per server.
- Lifecycle hooks live at `$GEMINI_DIR/config/hooks.json` (global) or `<workspace>/.agents/hooks.json`; use the global path so a turn never writes into the user's checkout. agy keys hooks by **name**, matches tools by **regex**, sends camelCase `{ toolCall: { name, args } }`, and accepts only `allow` / `deny` / `ask` / `force_ask`. `CliHookConfig` encodes Claude Code's shape and is not reusable here, so `AntigravityCliBridge.buildHooks()` intentionally returns null. agy's tool names are lowercased step types (`run_command`, `view_file`, `write_to_file`), not `Bash`/`Write`.
- The OAuth credential is `$GEMINI_DIR/antigravity-cli/antigravity-oauth-token`. The staged home links it; if that link is missing the CLI silently falls into the browser OAuth flow. Credential filenames are discovered, not hardcoded, because a stale name links nothing.
- Set `GEMINI_DIR` explicitly to the managed home's `.gemini` and keep the child `HOME`/`USERPROFILE` on that managed home after soft-jail environment construction. The macOS keyring login still fails with a temporary `HOME` even when `GEMINI_DIR` is correct. Keep the soft jail's private temp/XDG roots mounted along with the managed home; a live OS-sandboxed turn verified this layout.
- Enforcement is fail-closed: if the settings or hooks cannot be written, the turn is refused rather than spawned ungated.

Any `agy` upgrade must revalidate settings.json key names, hook schema and decision vocabulary, MCP config location, the credential filename, and the headless soft-deny behavior. Each of these has changed before and each failure is silent.

## CLI provider config surfaces

Every native CLI provider writes configuration that the CLI only honours if it reads the exact path and schema. Getting this wrong is silent: no error, the turn still completes, and the enforcement layer simply never runs. Treat every config path below as load-bearing.

Verified against the real CLIs:

- **codex** — `CODEX_HOME/<name>.config.toml` layered by `codex exec --profile <name>` is correct and documented in `codex --help`.
- **devin** — `<DEVIN_CONFIG_DIR>/devin/config.json` with a top-level `hooks` key keyed by event name is correct; confirmed by running `devin doctor`. The `hooks.v1.json` comments in `devin-bridge.ts` are stale, not the writer. Devin parses Claude Code's hook output contract (`ClaudeHookSpecificOutput`, `permissionDecision`), so the shared hook bridge vocabulary is correct for it.
- **claude** — hooks come from the `hooks` key of a settings file (or plugin `hooks/hooks.json`, or skill/subagent frontmatter). There is no sibling `hooks.json`. Because this provider symlinks the user's real `settings.json` to share auth, per-turn hooks are injected with `--settings <json>`, which layers rather than replaces. See `buildClaudePerTurnSettings()`.

Hook decision output is **per-event** and is not interchangeable. Claude Code and Devin read a top-level `{decision, reason}` for `Stop`/`UserPromptSubmit`/`PostToolUse`, but require `hookSpecificOutput.permissionDecision` for `PreToolUse` and `hookSpecificOutput.decision.behavior` for `PermissionRequest`. `kory-hook-bridge.ts` encodes per event; adding an event without a case there silently degrades to "no decision", which means the tool call proceeds.

- **`buildSoftJail` breaks `$HOME`-relative CLIs.** The soft jail replaces `HOME` with an empty temp dir and puts `XDG_*` beneath it. A CLI that resolves config from `$HOME` then finds nothing, even when its `*_CONFIG_DIR`/`*_HOME` variable still points at the staged home. Antigravity failed exactly this way: linking `agyHome` produced `<jailHome>/antigravity-home`, which agy never reads, so it had no OAuth token and every turn failed auth — surfacing as `Antigravity ended with status ERROR` plus a browser sign-in. Pass the **dot-directory** the CLI resolves (`join(home, '.gemini')`, `join(home, '.cursor')`) so `$HOME/<dot-dir>` lands on the staged home; `buildSoftJail` symlinks by `basename`, so that basename must be the dot-dir — and for a *nested* path the shorthand cannot work at all: `<staged>/.local/share` links as `<jailHome>/share`. That is how Devin reported `Not logged in` on every turn, since the jail moves `XDG_DATA_HOME` inside itself. Use the `homeLinks` argument for those (`{ '.local/share': <staged>/.local/share }`), which takes an explicit jail-relative path. Verify any fix with `devin auth status`, which prints the credentials path it resolved. `codex` and `claude` escape this because `CODEX_HOME`/`CLAUDE_CONFIG_DIR` are explicit and the jail does not override them. When a spawned CLI suddenly reports auth failure or `status ERROR`, check the jail HOME before suspecting credentials.

`cursor` and `grok` are **unverified** — neither CLI is installed on the authoring host, and both write `mcp.json` relative to a config root whose environment variable semantics are unconfirmed. Rather than guess one path, `cli-config-paths.ts` writes and links at every candidate resolution point, so a turn cannot silently end up with no `kory__*` tools or an unauthenticated child. When either CLI becomes measurable, replace the hedge with the single verified path and record it here. Note also that `cursor.ts` passes `--trust` unconditionally and `grok-build.ts` leaves its built-in tools enabled, so neither provider's native surface is denied by a list.
