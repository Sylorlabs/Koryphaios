# Koryphaios Agent Guidance

## Platform separation

Linux, macOS and Windows differences live in exactly one module per side. Never
branch on the OS inline, and never spell a keyboard shortcut literally.

**Frontend — `frontend/src/lib/utils/platform.ts`** is the only module allowed to
read `navigator`/`userAgentData` for OS detection. It exposes `getPlatform()`,
`isMac()` / `isWindows()` / `isLinux()`, and the label formatters `formatKey`,
`formatChord` and `formatShortcut`.

- **Never write `Ctrl+Shift+V`, `Cmd+K`, or `Ctrl/⌘ S` into the UI.** A literal
  `Ctrl` label is wrong on macOS and a literal `⌘` label is wrong everywhere
  else. Write the abstract chord and let the formatter render it:
  `title="Paste image ({formatShortcut('Mod+Shift+V')})"` → `⌘⇧V` on macOS,
  `Ctrl+Shift+V` on Windows and Linux. `Mod` maps to Meta on macOS and Ctrl
  elsewhere; `Meta` renders as ⌘ / Win / Super, and a bare `Ctrl` renders as ⌃ on
  macOS so it never reads as the primary modifier.
- Handler *behavior* may keep the idiomatic `(e.ctrlKey || e.metaKey)` OR, but
  the label next to it must come from the formatter. A chord that works
  everywhere but is labelled for one OS is the bug this rule exists to prevent.
- Bindings stored in `shortcutStore` use the abstract `Mod` token. The recorder in
  `SettingsDrawer.svelte` normalizes a lone platform modifier to `Mod` so a
  binding recorded on a Mac still means Ctrl elsewhere.
- Library keymaps must use the platform-abstract prefix. ProseMirror only
  rewrites `Mod-z`; a literal `Shift-Ctrl-2` stays Ctrl on every OS and is dead
  on macOS. The same applies to any `Ctrl-`-prefixed binding in a vendored
  keymap.
- A test that asserts a rendered chord name must compose it, not hard-code it:
  `e2e/helpers/shortcut-labels.ts` mirrors `formatChord` for Playwright, and
  `setPlatformForTesting()` pins the platform in unit tests. A hard-coded
  `Ctrl + Alt + O` assertion passes on Linux and fails on a macOS runner.

**Backend — `backend/src/runtime/platform.ts`** is the only module allowed to ask
which OS the server is on. It exposes `hostOS()`, `isMac()` / `isLinux()` /
`isWindows()` / `isUnix()`, `hasPosixPermissionBits()`, `executableSuffixes()`,
`looksLikePath()`, `findOnPath()`, `findExecutableOnPath()`, `isContainedBy()`,
`canonicalizePath()`, `isDirectoryLinkType()`, and the `hasUnexpectedOwner()` /
`hasHardLinks()` / `hasUnexpectedMode()` predicates.

- Every helper reads `process.platform` **at call time**, never into a
  module-level constant, so a test can stub the platform and exercise a foreign
  branch.
- `isContainedBy` is the one path-containment check. A hand-rolled
  `startsWith('..\\\\')` will pick the wrong separator on one OS and silently
  admit or reject a traversal on the other. `canonicalizePath` is the one
  canonicalisation: `realpathSync.native` is required on Windows (8.3 names,
  junctions) and the JS path is required elsewhere, and macOS rewrites `/var` to
  `/private/var`, so sandbox binds and Seatbelt rules must compare canonical
  paths on every platform.
- `findOnPath` and `findExecutableOnPath` are deliberately different. The sandbox
  engine lookup must use the executable variant: a PATH entry that exists but
  cannot be executed is not an enforceable jail, and accepting one would report
  confinement the host cannot provide.
- `hasUnexpectedOwner` / `hasHardLinks` / `hasUnexpectedMode` are vacuously
  false on Windows, which has no `uid`, `nlink` or `mode`. Do not rewrite them as
  inline `process.platform !== 'win32' && …` guards; the point of the predicate is
  that the skip is in one place.
- A function parameter that *defaults* to `process.platform` (an injection seam
  for tests) and a `String.raw` fixture blob that generates standalone source are
  the two places a raw read is still correct.
- `process.platform` appearing anywhere else in `backend/src` is a finding. Fix
  it by routing through `runtime/platform.ts`.

`AGENTS.md` records the reasoning; the modules are the contract.

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
- Chat supports agent inline styling with accent priority: `[text]{color, size, flags}` (e.g. `[alert]{red, large, bold}`, `[note]{color=accent, size=xl}`; colors accept `#hex`, `rgb()/hsl()`, CSS names, or the `accent` keyword that resolves to the user's theme accent), plus `==highlight==`, `++underline++`, and a validated `<span style="...">` subset (color, background-color, font-size, font-weight, font-style, text-decoration). Validators live in `frontend/src/lib/utils/kory-inline-style.ts`; unrecognized input stays literal. Default link/highlight styling uses `var(--color-accent)` so the user's chosen accent stays the default voice — custom colors are for emphasis only.
- Chat `[label](https://...)` links render with the destination site's favicon and open externally (`frontend/src/lib/utils/kory-link-favicon.ts`). Only `http(s)` links get icons; `javascript:`/`data:` URLs render as inert text.

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

Freebuff runs through its real TUI (OpenTUI in the qualified native 0.2.16 build) in `backend/src/providers/freebuff-cli.ts`. The adapter uses a private tmux server as a PTY, stages the CLI-owned login and selected model settings in a per-turn private HOME, installs `.agents/mcp.json`, and reads structured completion/tool evidence from Freebuff's own `log.jsonl` inside isolation. It has no headless mode or general native-tool deny hook, so Linux bubblewrap isolation is mandatory, either on native Linux or inside the pinned Docker/Colima Linux runtime on macOS: native Freebuff tools can affect only a disposable checkout. The real session workspace is available only through `backend/src/providers/kory-mcp-bridge.ts`, whose grant is scoped to the Kory session and role and whose executions flow through `ToolRegistry.execute()` and `permission-policy.ts`. Never weaken this to an unsandboxed fallback or claim the native tools are disabled.

Credentials remain owned by `freebuff login` in `~/.config/manicode/credentials.json` or the Freebuff-owned Keychain item it references. Koryphaios resolves only that exact referenced item through the normal OS permission gate, stages a private 0600 per-turn copy, and deletes it afterward; never dump Keychains, log tokens, alter the original login, or reuse the token as a Codebuff SDK key. Modern account models come only from authenticated read-only `GET https://www.codebuff.com/api/v1/freebuff/models` (protocol 1) in `freebuff-model-catalog.ts`. Only open, issued rows are selectable; vision, windows and reasoning levels come from those rows. Kory wraps stable picker keys as `freebuff/catalog-<key>` and writes `freebuffModelKey`/`freebuffCatalogReasoningEfforts` into the private turn settings. Opaque handles stay backend-only for root-model verification; never publish them as upstream IDs or guess prices. `freebuff/cli-default` preserves CLI-owned selection. Docker discovery inspects the actual pinned execution binary, not the independently auto-updating host launcher. Native Linux still requires the installed execution version to match qualification. Connect prepares the pinned image automatically using its embedded credential-free recipe and then proves isolation; do not make users run setup scripts. Any execution-runtime upgrade must revalidate the actual model selection, `.agents/mcp.json` loading, private-workspace `--trust-agents`, startup keystrokes, and root `log.jsonl` completion/error shapes. See `docs/freebuff-cli.md` and `docker/freebuff-runtime/README.md`.

The 0.2.16 Docker/Colima qualification includes actual signed MCP Notes reads with short and long prompts, root completion, and account-attributed input-only billing samples. Use explicit bracketed paste frames and wait for the bordered composer's receipt (or a native long-text attachment's character count) before Enter. Freebuck billing lives in `freebuff-account.ts`: read-only GET on the canonical `www.codebuff.com` host, the same narrowly scoped credential resolver, per-profile cached balances with stale/unavailable states, and no USD conversion. The runtime requires a native x64 Docker kernel, not an x64 container emulated by an ARM daemon; context selection is local to Freebuff and never changes Docker's global context.

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
- **The window is shared with agy's own prompt.** agy's native system prompt, tool surface, MCP registration and `AGENTS.md` are in context before Kory's first turn, and Kory can neither see nor shrink that prefix. Budgeting against the raw model window therefore overstates what the CLI accepts and the turn dies on overflow. `antigravityPromptBudget()` reserves a quarter of the window (8k floor, 48k ceiling) plus an output reserve, and `fitAntigravityPrompt()` keeps the instruction header and the newest turns, marking how many older ones it dropped. The header is instructions, never history: it is never trimmed. agy's usage receipt is a turn total (`estimated`), so it is never used for accounting or compaction — only, above 95% of the window, as the signal to drop the cached `--conversation` and replay Kory's authority next turn.

Any `agy` upgrade must revalidate settings.json key names, hook schema and decision vocabulary, MCP config location, the credential filename, and the headless soft-deny behavior. Each of these has changed before and each failure is silent.

## Model catalog refresh

`backend/src/providers/catalog-refresh.ts` is the only timer that polls model catalogs. Tiers are decided by `catalogRefreshTier()`, and the tier must reflect what discovery actually costs:

- **cheap** (10 min, ±10% jitter, ×4 when idle) — one HTTP GET. Includes every `custom:*` provider: a user-defined OpenAI-compatible endpoint costs exactly what `local`/`ollama`/`lmstudio` cost. Do not move `custom:*` back to `hourly`; that is what made a newly added model take up to an hour to appear on the cheapest possible source.
- **cli** (60 min, suspended entirely after 2 h idle) — any adapter that spawns a subprocess. `MAX_REFRESHES_PER_TICK = 3` bounds the scheduler.
- **hourly** (60 min) — metered catalogs and the shared models.dev / OpenRouter registries.

An activity catch-up tick may refresh a **cheap** catalog once it is older than `ACTIVITY_REFRESH_INTERVAL_MS` (5 min, matching the adapters' own model-list TTL), so a model added to a custom endpoint appears when the user returns rather than on the next tick. Never extend that bar to the cli tier: `noteActivity()` fires from `getStatus()`, so a cli provider would otherwise spawn on every status render. For the same reason, the manual/connect path in `registry.ts` refreshes cli-backed providers **serially** — fanning them out launched every installed CLI at once.

Every adapter must advance its freshness timestamp on a failed probe. Otherwise `listModels()` — which `getStatus()` calls per provider — retries forever: `antigravity` did a blocking `spawnSync` (up to 8 s on the server event loop) per status render, and `grok` re-spawned two processes per render. Both now negative-cache a failure. `cursor.ts` already documents this failure mode and is the reference implementation.

Every provider row also has a per-provider Refresh button (`POST /api/providers/:name/refresh`, `registry.ts refreshProviderAndVerify()`). It re-probes that one provider and reloads only its catalog, then pushes `provider.status`. Two properties are load-bearing: the work is **coalesced per provider with a 10 s cooldown** using a single clock for both the check and the recorded timestamp, because a CLI-backed refresh spawns a subprocess and a double-click must not queue two probes; and it calls `noteManualRefresh()` so the background scheduler does not immediately repeat it. `runtimeCheck` (a real, token-spending generation) is opt-in — the default probe already contacts the provider.

Delivery needs no frontend work: the scheduler diffs a catalog signature and broadcasts `provider.status` over the WebSocket, which `providers.svelte.ts` applies directly. There is no frontend polling for provider status, and `?refreshModels=1` bypasses all TTLs.

## CLI provider config surfaces

Every native CLI provider writes configuration that the CLI only honours if it reads the exact path and schema. Getting this wrong is silent: no error, the turn still completes, and the enforcement layer simply never runs. Treat every config path below as load-bearing.

Verified against the real CLIs:

- **codex** — `CODEX_HOME/<name>.config.toml` layered by `codex exec --profile <name>` is correct and documented in `codex --help`.
- **devin** — `<DEVIN_CONFIG_DIR>/devin/config.json` with a top-level `hooks` key keyed by event name is correct; confirmed by running `devin doctor`. The `hooks.v1.json` comments in `devin-bridge.ts` are stale, not the writer. Devin parses Claude Code's hook output contract (`ClaudeHookSpecificOutput`, `permissionDecision`), so the shared hook bridge vocabulary is correct for it.
- **claude** — hooks come from the `hooks` key of a settings file (or plugin `hooks/hooks.json`, or skill/subagent frontmatter). There is no sibling `hooks.json`. Because this provider symlinks the user's real `settings.json` to share auth, per-turn hooks are injected with `--settings <json>`, which layers rather than replaces. See `buildClaudePerTurnSettings()`.

Hook decision output is **per-event** and is not interchangeable. Claude Code and Devin read a top-level `{decision, reason}` for `Stop`/`UserPromptSubmit`/`PostToolUse`, but require `hookSpecificOutput.permissionDecision` for `PreToolUse` and `hookSpecificOutput.decision.behavior` for `PermissionRequest`. `kory-hook-bridge.ts` encodes per event; adding an event without a case there silently degrades to "no decision", which means the tool call proceeds.

- **`buildSoftJail` breaks `$HOME`-relative CLIs.** The soft jail replaces `HOME` with an empty temp dir and puts `XDG_*` beneath it. A CLI that resolves config from `$HOME` then finds nothing, even when its `*_CONFIG_DIR`/`*_HOME` variable still points at the staged home. Antigravity failed exactly this way: linking `agyHome` produced `<jailHome>/antigravity-home`, which agy never reads, so it had no OAuth token and every turn failed auth — surfacing as `Antigravity ended with status ERROR` plus a browser sign-in. Pass the **dot-directory** the CLI resolves (`join(home, '.gemini')`, `join(home, '.cursor')`) so `$HOME/<dot-dir>` lands on the staged home; `buildSoftJail` symlinks by `basename`, so that basename must be the dot-dir — and for a _nested_ path the shorthand cannot work at all: `<staged>/.local/share` links as `<jailHome>/share`. That is how Devin reported `Not logged in` on every turn, since the jail moves `XDG_DATA_HOME` inside itself. Use the `homeLinks` argument for those (`{ '.local/share': <staged>/.local/share }`), which takes an explicit jail-relative path. Verify any fix with `devin auth status`, which prints the credentials path it resolved. `codex` and `claude` escape this because `CODEX_HOME`/`CLAUDE_CONFIG_DIR` are explicit and the jail does not override them. When a spawned CLI suddenly reports auth failure or `status ERROR`, check the jail HOME before suspecting credentials.
- **opencode** (verified live against `opencode` 2.0.32, ACP `protocolVersion: 1`) — resolves everything from `HOME`: `~/.config/opencode/opencode.json` (providers/permissions/plugins), `~/.local/share/opencode/auth.json` (credentials) and `opencode.db`, `~/.local/state/opencode/service.json`, `~/.cache/opencode`. Env layering is **not** honored in 2.0.32: `OPENCODE_CONFIG_CONTENT` is ignored entirely, `OPENCODE_CONFIG_DIR` rewrites `debug paths` output but the loaded config documents still come from the default locations, and `OPENCODE_CONFIG` is ignored. Never gate enforcement on a variable that layering-style caching ignores — it fails silently. The provider therefore runs **local turns with the user's real `HOME`** (like the user's own terminal — this is deliberate; a managed home would strip the providers, plugins and login the user configured), and **sandboxed turns** bind only `.config/opencode`, `.local/share/opencode`, `.local/state/opencode` and `.cache/opencode` into a `buildSoftJail` home via `homeLinks` plus `configDirs` (read-write; the CLI owns those paths), with `inferenceSandboxPolicy` keeping the child's inference network up. Kory's MCP bridge is **never written to disk**: it is passed per ACP session as `session/new.mcpServers` with a session-scoped grant, so there is no config drift and no cross-contamination with the user's other opencode sessions. Model discovery reads the CLI's authenticated live catalog (`opencode api model.list`, `--standalone` fallback) for real `limit.context`/`limit.output` and reasoning-effort variants — no static tables. Native-tool permissions stay with the user's OpenCode config; anything the config *asks* about is vetoed at the ACP layer (`session/request_permission`): read-like kinds (read/search/fetch/think/other) are allowed, native edit/delete/move/execute are rejected (they belong on the kory__* bridge, which is permission-enforced by Kory). Research-only and `nativeToolsDisabled` turns run ACP `mode: "plan"`; the latter in a private temp workspace. Context occupancy uses the ACP `usage_update` `used`/`size` receipt; the final `session/prompt` usage is billing evidence only (cumulative across internal requests, marked `estimated`).

`cursor` and `grok` are **unverified** — neither CLI is installed on the authoring host, and both write `mcp.json` relative to a config root whose environment variable semantics are unconfirmed. Rather than guess one path, `cli-config-paths.ts` writes and links at every candidate resolution point, so a turn cannot silently end up with no `kory__*` tools or an unauthenticated child. When either CLI becomes measurable, replace the hedge with the single verified path and record it here. Note also that `cursor.ts` passes `--trust` unconditionally and `grok-build.ts` leaves its built-in tools enabled, so neither provider's native surface is denied by a list.
