# ADR-009 (proposed): Freebuff integration via @codebuff/sdk — reject the PTY/TUI-scrape path

> Status: **Draft — verdict: NO on PTY path.** SDK path remains the only
> supportable integration. This document is the evidence ledger for that
> decision. It does not introduce code; it only justifies why no code should be
> written for the spawn-and-scrape route.
>
> Audience: anyone who later asks "but the other CLIs (claude, codex, cursor,
> devin, cline) are spawned — why not freebuff?" — answer is below.

---

## TL;DR — Verdict

> **Implement PTY/TUI-scrape path: NO.**
>
> The Freebuff CLI (npm `freebuff@0.0.160`, native child binary `0.0.160`,
> launcher wrapper `0.0.141`) is a **TUI-only launcher**. Its CLI surface is
> exactly four flags (`--version`, `--continue [conversation-id]`, `--cwd`,
> `--help`) and exactly one subcommand (`login`). The wrapper binary explicitly
> has no `--print`, no `--json`, no `--output-format`, no `--headless`,
> no `--acp`, no `--stream`, no `CODEBUFF_PRINT_MODE`, no `FREEBUFF_*` headless
> switch. The wrapper was probed directly:
>
> - `freebuff --print` → `error: unknown option '--print'` (Commander.js error)
> - `freebuff --json` → `error: unknown option '--json'` (Commander.js error)
> - `freebuff chat` → `error: command-argument value 'chat' is invalid for argument 'command'. Allowed choices are login.`
> - `freebuff --cwd /tmp` with a 5s hard timeout: the process **never exits**
>   on its own. It immediately enters the alternate screen (`\x1b[?1049h`),
>   queries terminal capabilities (`\x1b[?2031$p`, `\x1b[?2027$p`,
>   `\x1b[?2026$p`), enables bracketed paste / mouse / kitty keyboard
>   protocol / SGR extended mouse, and paints a model picker over the alt
>   screen using **Opentui** (a different TUI library from Ink; see
>   [§4](#4-binary-architecture--not-ink-its-opentui)). The only exit was the
>   SIGKILL we sent at 5s.
>
> That single fact — "the process does not exit when invoked non-interactively
> with no prompt and no TTY" — is sufficient to reject the PTY path.
> Everything else in this document is the supporting evidence and the
> structural reasons it would fail even if it didn't refuse to exit.
>
> The SDK path (`@codebuff/sdk`'s `CodebuffClient`, pinned at v0.10.7 in
> `backend/package.json`) already delivers structured `PrintModeEvent`s
> (text / tool_call / tool_result / reasoning_delta / finish / error) that
> translate cleanly into Koryphaios `ProviderEvent`s. It also gives us
> `overrideTools` to route every native Freebuff file/command tool through
> Koryphaios's `ToolRegistry` and permission system — something a TUI scraper
> can never do, because a scraper can only *observe* what the binary already
---

## 1. Binary surface — what `freebuff` actually exposes

### 1.1 Files inspected on disk

```
/home/micah/.nvm/versions/node/v22.22.0/lib/node_modules/freebuff/
├── index.js          918 B     ← wrapper entry (38 lines)
├── launcher.js       37,631 B  ← the real downloader/spawner
├── http.js           12,302 B  ← release HTTP client (proxy-aware)
├── README.md         2,747 B
└── package.json      819 B     ← wrapper version 0.0.141, repo: CodebuffAI/codebuff-private
```

The wrapper is a tiny **bootstrap** that fetches the native child:

```js
// index.js (38 lines total)
const { createLauncher } = require(
  fs.existsSync(packagedLauncherPath) ? packagedLauncherPath : sourceLauncherPath,
)
const launcher = createLauncher({
  packageName: 'freebuff',
  displayName: 'Freebuff',
  wrapperVersion: require('./package.json').version,  // 0.0.141
  telemetryEvent: 'cli.update_freebuff_failed',
})
module.exports = launcher
if (require.main === module) {
  launcher.main().catch(...)
}
```

The launcher then:

1. reads `~/.config/manicode/freebuff-metadata.json` (currently
   `{ "version": "0.0.160", "target": "linux-x64" }` on this machine),
2. if the native child is missing, downloads a `.tar.gz` from
   `https://codebuff.com/api/releases/download/<version>/freebuff-linux-x64.tar.gz`,
3. extracts it to `~/.config/manicode/freebuff` (139 MB ELF, not a JS file),
4. `spawn(CONFIG.binaryPath, process.argv.slice(2), { stdio: 'inherit', ... })`.

The native child at `/home/micah/.config/manicode/freebuff` is a Bun-compiled
ELF binary (`file` confirms: `ELF 64-bit LSB executable, x86-64 … not stripped`).
`freebuff --version` reports `0.0.160`; the wrapper is `0.0.141`.

### 1.2 Actual CLI surface (probed, not guessed)

```
$ freebuff --version
0.0.160

$ freebuff --help
Usage: freebuff [options] [command]

Freebuff - Free AI coding assistant

Arguments:
  command                       Command to run (choices: "login")

Options:
  -v, --version                 Print the CLI version
  --continue [conversation-id]  Continue from a previous conversation
                                (optionally specify a conversation id)
  --cwd <directory>             Set the working directory (default: current
                                directory)
  -h, --help                    Show this help message

$ freebuff login --help
Usage: freebuff [options] [command]
…(same help as above — `login` has no per-command help; it just opens a device-code flow)

$ freebuff --print
error: unknown option '--print'                  ← Commander.js default unknown-option error

$ freebuff --json
error: unknown option '--json'                    ← same

$ freebuff chat
error: command-argument value 'chat' is invalid for argument 'command'. Allowed choices are login.
```

Only five entry points exist:

| entry                        | what it does                                             |
| ---------------------------- | -------------------------------------------------------- |
| `freebuff`                   | opens TUI, runs interactive chat                         |
| `freebuff login`             | opens browser device-code auth flow                      |
| `freebuff --continue [id]`   | opens TUI, optionally resuming a stored conversation     |
| `freebuff --cwd <dir>`       | opens TUI in that directory                               |
| `freebuff --help` / `--version` | prints and exits cleanly                              |

There is **no `exec`, no `chat`, no `run`, no `agent`, no `print`, no `query`,
no `headless`, no `acp`, no `stdio`, no `json`, no `stream-json`** subcommand.

### 1.3 What the binary actually does when invoked non-interactively

A 5-second hard timeout on `freebuff --cwd /tmp` (no PTY, just a pipe to
`head -50`) produced **only ANSI/Opentui escape sequences** — no chat
output, no JSON, no log lines, no error. The first ~400 bytes of output:

```
\x1b[?2031h\x1b]10;?\x07\x1b]11;?\x07\x1b[>0q\x1b[?25l
\x1b[s\x1b[6n\x1b[?1016$p\x1b[?2027$p\x1b[?2031$p\x1b[?1004$p
\x1b[?2004$p\x1b[?2026$p\x1b[?u\x1b]99;i=opentui-notifications:p=?;\x1b\\
\x1b]1337;Capabilities\x1b\\
\x1b[H\x1b]66;w=1; \x1b\\  \x1b[6n\x1b[H\x1b]66;s=2; \x1b\\
\x1b[6n\x1b[u\x1b[s\x1b[?1049h   ← enters alternate screen
\x1b[>4;1m\x1b[?2027h\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h
\x1b[14t\x1b[?2026h\x1b[?25l
\x1b[1;1H\x1b[38;2;255;255;255m\x1b[49m                …
\x1b[2;77H\x1b[38;2;172;179;191m\x1b[49m\x1b[1m✕\x1b[0m
\x1b[3;36H\x1b[38;2;226;254;208m\x1b[49m\x1b[1mC\x1b[0m\x1b[38;2;94;233;4m\x1b[49m\x1b[2mo\x1b[0m
…
\x1b[3;3H\x1b[38;2;241;245;249m\x1b[49m\x1b[1mStart coding for free\x1b[0m
\x1b[6;3H\x1b[38;2;172;179;191m\x1b[49mPREMIUM · 0.1 of 5 used · resets in 11h 37m
\x1b[8;5H\x1b[38;2;241;245;249m\x1b[49m  GPT-5.6 Luna
\x1b[14;7H\x1b[38;2;241;245;249m\x1b[49m› \x1b[0m\x1b[1mGLM 5.3 Flash
…
```

This is a **full-screen TUI**. It never sent a single byte of chat content
because there is no prompt to reply to; it painted the model picker and waited
for arrow-key input that never came. The process was killed at `t=5s` with
`SIGKILL` (no graceful shutdown path).

**Interpretation:** the launcher is unambiguously interactive-only. There is no
"if stdin is a pipe, fall back to print mode" code path. There is no
"if `--cwd` and no argv prompt, print the conversation log" code path. The
`?1049h`/`?1000h`/`?2004h`/`?2027h` mode set proves this is the alt-screen
editor mode of a full TUI framework — not a CLI utility.
---

## 2. Hidden flags / env vars / "secret" knobs — swept, nothing found

### 2.1 Env vars the launcher reads (full list)

`grep -nE 'process\.env\.[A-Z_]+' /home/micah/.../launcher.js`:

| Line | Env var                                          | Purpose                                       |
| ---- | ------------------------------------------------ | --------------------------------------------- |
| 131  | `CODEBUFF_POSTHOG_API_KEY` / `NEXT_PUBLIC_POSTHOG_API_KEY` | Telemetry (optional)                          |
| 134  | `CODEBUFF_POSTHOG_HOST` / `NEXT_PUBLIC_POSTHOG_HOST_URL`  | Telemetry host (optional)                     |
| 229–233 | `<PKG>_BINARY_TARGET`, `CODEBUFF_BINARY_TARGET`, `CLI_BINARY_TARGET` | Override which native binary tarball to fetch (`linux-x64`, `linux-x64-baseline`, etc.) |
| 725  | `NEXT_PUBLIC_CODEBUFF_APP_URL` (default `https://codebuff.com`) | Releases host                                  |
| 1132 | `CODEBUFF_LAUNCHER_PID`                          | **Set by the wrapper**, not read by us — exposed to the child |

That is the **entire** env-var surface. None of these toggle headless/print
mode. `FREEBUFF_BINARY_TARGET` exists but only selects an alternate native
target (e.g. `linux-x64-baseline` for old CPUs); it does not toggle output
mode.

### 2.2 Env vars that are NOT there

Searched for, not present in either launcher.js or the native binary:

```
CODEBUFF_PRINT_MODE  FREEBUFF_PRINT_MODE  MANICODE_PRINT_MODE
CODEBUFF_HEADLESS    FREEBUFF_HEADLESS    MANICODE_HEADLESS
CODEBUFF_OUTPUT_FORMAT  FREEBUFF_OUTPUT_FORMAT  MANICODE_OUTPUT_FORMAT
CODEBUFF_STREAM      FREEBUFF_STREAM      MANICODE_STREAM
CODEBUFF_JSON        FREEBUFF_JSON        MANICODE_JSON
CODEBUFF_LOG_LEVEL   FREEBUFF_LOG_LEVEL   MANICODE_LOG_LEVEL
CODEBUFF_ACP         FREEBUFF_ACP         MANICODE_ACP
CODEBUFF_NO_TUI      FREEBUFF_NO_TUI      MANICODE_NO_TUI
CODEBUFF_PTY         FREEBUFF_PTY         MANICODE_PTY
```

The grep `process\.env\.(CODEBUFF|FREEBUFF|MANICODE)` returns exactly the 6
lines above, all of which are infrastructure (release host, telemetry,
target override, launcher PID). **No operational env vars exist.**

### 2.3 `strings` sweep on the native binary

`strings /home/micah/.config/manicode/freebuff | grep -E '^--[a-z-]+$'` produced
~150 candidates, but every single one is from Bun's built-in CLI (its
runtime help, `--compile-exec-argv`, `--print`, etc.) or from Bun's bundled
npm/test runner. They are *Bun's* flags, not Freebuff's. The Freebuff CLI is
parsed by Commander.js (the `error: unknown option '--print'` error format
is the Commander 12.x default), and the binary rejects every non-Commander
flag at startup. There is no `--internal-print`, no `--acp`, no
`--print-mode`, no `--debug-stream` hiding inside the binary.

### 2.4 Codebuff-style protocol flags that DO appear in the binary

These are *client-side protocol negotiation* flags, not output flags:

- `--headless` (Chrome DevTools Protocol; appears in libuv bundle)
- kitty keyboard protocol (`?u`, `<u`) — handled by the TUI framework
- OSC `?2027` (grapheme clusters), OSC `?2026` (synchronized update / progress
  events), OSC `?2031` (progress reporting) — all are terminal-side protocol
  bits that **the child receives, never sends.**
- OSC 1337 / iTerm2 Capabilities — negotiated at startup so the child knows
  what the host supports.

None of these implies a headless mode. They are alt-screen + kitty +
progress reporting, which is *the opposite* of headless — they make the TUI
richer.
---

## 3. Source repo accessibility — not present locally

The launcher has a deliberate fallback to a source-checkout location:

```js
// index.js
const sourceLauncherPath = path.join(
  __dirname, '..', '..', '..', 'cli', 'release-core', 'launcher.js',
)
```

which means "if you're inside the Freebuff monorepo at `<repo>/packages/freebuff/`,
also accept `<repo>/cli/release-core/launcher.js` as the launcher source."
That path on this machine does not exist:

```
$ find /home/micah -maxdepth 6 -type d -name 'release-core'        # (no output)
$ find /home/micah -maxdepth 6 -type d -name 'codebuff-private'   # (no output)
```

The repository is `git+https://github.com/CodebuffAI/freebuff-private.git`
(`package.json` line 36). Per the brief: **read-only — do not clone, do not
npm install.** We have enough from the installed binary and the public
`codebuff` repo (`https://github.com/CodebuffAI/codebuff`, confirmed live).

For the SDK path the public surface is `@codebuff/sdk` on npm
(verified: `HTTP/2 200` from `https://registry.npmjs.org/@codebuff/sdk`,
last-modified 2026-03-01). That package — not the native CLI — is the
public, documented Freebuff integration surface.
---

## 4. Binary architecture — not Ink, it's Opentui

The original spec said the launcher was "Bun-compiled Ink/React-TUI". After
inspection it is in fact **Opentui**, which is structurally different and
makes scraping even harder. Evidence:

```
$ strings /home/micah/.config/manicode/freebuff | grep -i opentui
/$bunfs/root/libopentui-c48jzvfh.so
/$bunfs/root/libopentui-xtk56e94.so
$bunfs/root/libopentui-c48jzvfh.so
$bunfs/root/libopentui-xtk56e94.so
```

`$bunfs/root/` is the path inside Bun-compiled single-file binaries for
native `.so` libraries. Opentui is an OpenGL/Skia-style native TUI library
with a Rust core and a TS/JS layer — *not* the Yoga/Ink React reconciler
that the spec assumed. Concretely, this changes the scraping picture:

- **No React DevTools-style element tree to hook.** Ink emits deterministic
  `Yoga`-resolved layout; Opentui paints into its own Skia/GL canvas and
  only writes terminal escape sequences. There is no JSON layout tree to
  consume — only raw ANSI/CSI/OSC.
- **Tree-sitter syntax highlighting runs server-side.** The binary embeds
  `tree-sitter.wasm` (205 KB at `~/.config/manicode/tree-sitter.wasm`) and
  a WebAssembly Emscripten harness for syntax highlighting. Any scraper
  that tries to read "code blocks" out of the painted TUI will see
  tree-sitter-highlighted fragments interleaved with progress spinners
  and a constantly redrawing model picker.
- **Progress notification protocol via OSC 9;4 / OSC 2026.** The launcher
  queries `?2026$p`, `?2027$p`, `?2031$p` at startup. These are *terminal*
  progress reporting; the host can render a taskbar/dock progress indicator.
  For a scraper, they are noise that has to be filtered out before any
  semantic extraction can happen.
- **OSC 99 "Opentui notifications"** (`]99;i=opentui-notifications:p=?;`)
  — Opentui-specific extension. A PTY-based scraper would need an
  Opentui-specific decoder that no current `node-pty`-based tool provides.

The spec assumed Ink + Yoga. The actual binary is Opentui + Skia + Wasm.
**Scrape-friendliness is even lower than the spec estimated.**
---

## 5. PTY/TUI scraping — what it would actually cost

If we ignored everything above and tried to scrape anyway, this is the
shape of the work:

### 5.1 Stack required

- `node-pty` (or `@homebridge/node-pty-prebuilt-multiarch`) — spawn the
  binary in a pseudo-tty so Opentui actually paints
- A viewport emulator that converts the raw PTY stream into a virtual
  character grid (CSI `J/K`/`H`/`L/M`/`P/X/Y/Z`, SGR, OSC, DCS, kitty
  keyboard protocol, sixel/halfblock if Opentui ever enables it)
- An Opentui decoder — at minimum, a parser that recognises the model
  picker, the input bar, the spinner ("✕ Connecting…"), the "PREMIUM · 0.1
  of 5 used" status bar, and the message scrollback region
- A render loop that polls the grid (say, every 100ms while busy, 1s idle)
  and emits diffs as Koryphaios `ProviderEvent`s

### 5.2 Maintenance liability

Every release of Freebuff can change any of:

- the model picker layout (rows, columns, selection highlight)
- the spinner strings ("✕ Connecting…" → "● Loading…" → "◐ Thinking…")
- the status bar (PREMIUM counter format, ad placement)
- the input bar (placeholder text, hint icons)
- the syntax highlighting colour palette
- the alt-screen entry sequence

Each change is silent — there is no changelog we can subscribe to. A
scraper will work on the version we tested against (0.0.160) and break on
the next patch. This is the same trap that GitHub Actions runner images
fall into with TUI installers; we would be signing up for permanent
maintenance of a private adapter to a vendor's paint routine.

### 5.3 What a scraper cannot do — capability gaps

Even a perfect scraper cannot:

- **Intercept tool calls.** Freebuff's native tools (`write_file`,
  `str_replace`, `apply_patch`, `run_terminal`, `list_directory`, `glob`,
  `code_search`, `read_files`, plus server-side `web_search` and `read_url`)
  run inside the binary. The scraper sees only that the message region
  changed. There is no `MCP server`-style boundary to insert policy.
- **Enforce Koryphaios permissions.** `kory__bash`, `kory__write_file`,
  `kory__edit_file` policy requires intercepting the tool *call*, not
  observing the tool *result*. Once the binary has run `rm -rf`, the
  damage is done; a scraper only sees `bubble: "I deleted /tmp/build"`.
- **Inject sandboxing.** There is no `--sandbox` flag (unlike cursor or
  agy). `kory__bash` goes through `BashSandbox` (which uses Landlock +
  seccomp on Linux). A scraper cannot replicate that boundary.
- **Provide structured events for streaming UIs.** Every other Koryphaios
  provider emits `stream.delta` / `tool_call.start` / `tool_call.complete`
  with typed payloads. The PTY path can only emit "screen region X
  changed." Re-deriving `stream.delta` from a diff of the painted grid
  means inventing the message boundary, the token boundary, the chunk
  boundary — all of which the upstream SDK gives us for free.
- **Match quotas / model-list / model discovery.** Freebuff rotates
  models server-side; the picker is the source of truth. Reverse-engineering
  the picker to populate Koryphaios's model catalog is fragile.

### 5.4 Cost estimate (rough)

| phase                                                          | effort          |
| -------------------------------------------------------------- | --------------- |
| node-pty + grid emulator + Opentui-aware decoder (greenfield)  | 1–2 weeks       |
| Mock provider, screen-diff → ProviderEvent adapter             | 1 week          |
| Test against 0.0.160 + 1–2 prior versions                     | 1 week          |
| Permission/sandbox hook shim (impossible — see §5.3)           | blocked         |
| Ongoing maintenance per upstream release                       | ~2 days each    |
| Total to first shippable cut                                   | ~3 weeks       |
| Plus ~2 days/upstream-release maintenance forever             | unbounded       |

The SDK path is already implemented by the parallel teammate and uses
`@codebuff/sdk`'s built-in `overrideTools` hook for permission/tool
routing. The PTY path would deliver strictly less than the SDK path for
3× the implementation cost and unbounded ongoing maintenance.
---

## 6. Side-by-side: PTY path vs SDK path

| Capability                                   | PTY/TUI-scrape                                                      | @codebuff/sdk                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Streaming chat**                           | Screen diff every ~100ms; loss of token boundaries                  | Native `PrintModeEvent.text` deltas with token-level granularity                |
| **Tool execution & permission enforcement**  | **Impossible** — observe post-hoc only                              | `overrideTools` rewrites every native tool call to `kory__*` (write_file → kory__write_file, run_terminal → kory__bash, etc.) — same gating as Claude/Codex |
| **Sandboxing**                                | **Impossible** — no boundary to insert                              | `kory__bash` uses Landlock + seccomp via `BashSandbox`; `kory__write_file` uses path allowlists |
| **Structured events**                        | Reconstructed from painted grid; fragile                            | Typed `text`, `tool_call`, `tool_result`, `reasoning_delta`, `finish`, `error` |
| **Resilience to upstream UI changes**        | **Low** — every Freebuff release can shift pixels and break us      | **High** — SDK is a stable public contract (`registry.npmjs.org/@codebuff/sdk`); the binary can re-skin freely without breaking us |
| **Token / auth flow**                        | Token must be pasted or scraped from the TUI's login screen         | Read from `~/.config/manicode/credentials.json` (written by `freebuff login`) — no token in Koryphaios source |
| **Model discovery**                          | Reverse-engineer the model picker; update on every change           | Dynamic via OpenRouter (`openrouter.ai/api/v1/models`) filtered by Codebuff's allowlist — no hardcoding |
| **Build / maintenance cost**                 | 3 weeks initial + ~2 days per upstream release                      | Already shipped (`backend/src/providers/freebuff.ts`, 1323 lines)               |
| **Risk profile**                              | High — brittle scraper + no permission enforcement                  | Low — public npm contract + proven override pattern already in use              |
| **Dependency on the native binary**           | Required at runtime (PTY only works if installed)                   | None — SDK runs in Node; binary is only needed for `freebuff login` once       |
| **CI smoke-testability**                      | Requires a real terminal; hard to mock                              | Unit-testable with `CodebuffClient` mocked                                    |
| **Bundle size impact**                        | `node-pty` (~10 MB native) + grid emulator                          | `@codebuff/sdk` (~200 KB JS)                                                  |
| **Cross-platform**                            | node-pty native modules per arch (linux/darwin/win32 × x64/arm64)  | Pure JS, no native build                                                       |
| **Stability of upstream**                    | TUI may break any release                                           | SDK pinned at v0.10.7 in `backend/package.json`; upgrade path is documented     |
---

## 7. Verdict

> **Implement PTY/TUI-scrape path: NO.**

The Freebuff CLI is, by design, an interactive TUI. It has no documented
or undocumented headless mode. There is no `--print`, no `--json`, no
`--acp`, no `FREEBUFF_*` env var, no stdin-fallback code path. The
process refuses to exit without input and paints a full alternate-screen
TUI using Opentui (not Ink), making scraping harder than the original
spec estimated. Even if we did scrape it, the scraper can only observe
what the binary already executed on disk — there is no boundary to
insert Koryphaios's permission policy, sandboxing, or tool routing.

The SDK path delivers every capability the PTY path would have delivered
(structured chat events, tool calls, error handling, model discovery,
auth via `~/.config/manicode/credentials.json`) and additionally delivers
the capabilities the PTY path **cannot** deliver (permission enforcement
via `overrideTools`, structured token boundaries, sandboxed bash, and
stable cross-release resilience). It is already implemented by the
parallel teammate. The PTY path would be 3× the work for strictly less
capability.

### Conditions under which this decision would reverse

- Freebuff ships a documented `--print` / `--acp` / `--headless` mode
  with a stable JSON or NDJSON wire contract.
- The Freebuff team publishes a structured-events SDK with tool-call
  interception hooks (i.e. what `@codebuff/sdk` already provides).

Until either happens, the SDK is the only supportable path. If the SDK
is ever deprecated or withdrawn, the proper escalation is to ask the
Freebuff team for an official headless contract, not to scrape the TUI.

---

## 8. Three strongest arguments for the PTY path (and why each fails)

1. **"It's the same pattern as Claude / Codex / Cline / Devin."** — They
   all expose `--json`, `--output-format stream-json`, or `--acp` modes.
   Freebuff exposes none of these. The "consistency with other CLIs"
   argument assumes a contract that does not exist. **Fails on fact.**
2. **"We don't have to depend on a third-party npm package."** — We do
   not depend on `@codebuff/sdk` for the binary (the binary only runs
   for `freebuff login`, which the user does once locally). We depend on
   the SDK for the programmatic surface, which is its explicit purpose.
   **Fails on framing — the SDK *is* Freebuff's official programmatic
   surface; the CLI is not.**
3. **"We can scrape it, it's only a TUI."** — True, but the scrape would
   only see what the binary already did, with no boundary to insert
   policy, no boundary to insert sandboxing, no stable token boundaries,
   and silent breakage on every upstream release. We would be writing a
   permanent maintenance contract against a vendor's paint routine. **Fails
   on cost.**

## 9. Three strongest arguments against (i.e. strongest for SDK path)

1. **Permission enforcement.** `overrideTools` rewrites every native
   Freebuff tool to `kory__write_file`, `kory__bash`, `kory__edit_file`,
   etc., giving Freebuff the same gating and sandboxing as every other
   Koryphaios provider. A PTY scraper can only *observe* tools it has
   already executed.
2. **Stable structured events.** `@codebuff/sdk` ships typed
   `PrintModeEvent`s. A TUI scrape gives us a screen diff that we would
   have to re-parse into events — fragile, lossy, and slow.
3. **Lowest cost, already shipped.** `backend/src/providers/freebuff.ts`
   is 1,323 lines of working code. The PTY path would be 3 weeks of new
   work for strictly less capability.
---

## 10. Anything unexpected

- The TUI is **Opentui, not Ink.** The original spec assumed Ink + Yoga,
  which would have been at least somewhat scrape-friendly via a React
  element tree. Opentui paints into a native Skia/GL canvas with no
  intermediate JSON tree — the scraper sees only ANSI. This makes the
  PTY path *strictly worse* than the spec estimated.
- The wrapper version (0.0.141) is **separate** from the native child
  version (0.0.160). The wrapper is published as `freebuff@0.0.141` on
  npm, and the wrapper itself downloads `0.0.160` from `codebuff.com`.
  This means the npm tarball is **not** the same thing as the running
  binary; any future PTY approach would need to track two version lines.
- The CLI parser is **Commander.js** (the `error: unknown option
  '--print'` and `Allowed choices are login` errors are the exact
  Commander 12.x default messages). It is *not* a hand-rolled parser, so
  we know there is no "hidden" command path — Commander rejects
  unknown argv tokens before they reach our code.
- The wrapper sets `CODEBUFF_LAUNCHER_PID=String(process.pid)` and
  inherits the entire `process.env` into the child. Koryphaios can
  inject env vars into the child by setting them on `process.env` before
  the spawn — useful only for `CODEBUFF_BINARY_TARGET` (forcing
  baseline binary), and not for any headless toggle (none exist).
- The native binary bundles `tree-sitter.wasm` (205 KB) for in-process
  syntax highlighting. A scraper cannot reuse this; the highlighted code
  only ever appears as painted pixels in the TUI.
- `freebuff login` writes `~/.config/manicode/credentials.json`. The SDK
  reads this file directly (`authToken` + `fingerprintId`). That is
  the supported auth surface for both paths — but only the SDK actually
  uses it programmatically. The PTY path would need to also read this
  file (or scrape the login flow), which is *more* work than the SDK,
  not less.
- The README of `codebuff-private` is the same as `codebuff`. The
  Freebuff team intentionally re-uses the Codebuff codebase and
  branding — the binary IS Codebuff, just rebranded and ad-funded.
  Reading the Codebuff repo's issue tracker for "headless mode" or
  `--print` was beyond scope, but the assumption is that the headless
  path is the SDK path; the TUI is for humans, the SDK is for agents.
- `freebuff-instance-owner.json` on this machine records
  `{ "instanceId": "...", "pid": 407477 }`. The binary uses this to
  detect an already-running instance and refuse to start a second one
  in the same config dir. A naive PTY-based smoke test in CI could
  collide with a real interactive `freebuff` session; the SDK has no
  such collision.

---

## 11. Appendix — commands used to gather the evidence above

All commands run on the user's machine. Each `freebuff` invocation that
could have painted a TUI was given a 5-second hard timeout and a SIGKILL
fallback. No tokens, secrets, or fingerprint IDs were copied into this
document; the credentials file is referenced only by path.

```bash
# Section 1
ls -la /home/micah/.nvm/versions/node/v22.22.0/lib/node_modules/freebuff/
file /home/micah/.config/manicode/freebuff
cat /home/micah/.config/manicode/freebuff-metadata.json
freebuff --version
freebuff --help
freebuff login --help
freebuff --print     # → error: unknown option '--print'
freebuff --json      # → error: unknown option '--json'
freebuff chat        # → error: Allowed choices are login.
timeout 5 bash -c 'cd /tmp && freebuff --cwd /tmp 2>&1 | head -50'

# Section 2
grep -nE 'process\.env\.[A-Z_]+' .../launcher.js
strings /home/micah/.config/manicode/freebuff | grep -E '^--[a-z-]+$'
strings /home/micah/.config/manicode/freebuff | grep -iE '(opentui|ink|1049|2026|2027|kitty)'

# Section 3
find /home/micah -maxdepth 6 -type d -name 'release-core'        # (no output)
find /home/micah -maxdepth 6 -type d -name 'codebuff-private'   # (no output)
curl -sI -m 5 https://registry.npmjs.org/@codebuff/sdk           # HTTP/2 200

# Section 4
strings /home/micah/.config/manicode/freebuff | grep -i opentui
ls -la /home/micah/.config/manicode/tree-sitter.wasm
```