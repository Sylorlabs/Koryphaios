# Freebuff CLI provider

Freebuff and Codebuff are different integrations. Freebuff uses the real logged-in
CLI and its own MCP loading; it is not an API-key wrapper around `@codebuff/sdk`.
Codebuff continues to use a separate real API key and its required pinned store
agent.

## macOS setup

The macOS host must have Docker backed by a Linux VM (Docker Desktop or Colima).
Koryphaios does **not** run an unsandboxed Darwin Freebuff process or substitute a
permissive Seatbelt profile.

```sh
# Sign in through the official CLI if not already signed in:
freebuff login

```

Connect Freebuff in the native Koryphaios Settings window. Koryphaios prepares the
pinned credential-free runtime automatically and checks real kernel isolation.
First-time installation can take a few minutes. An existing stopped x64 default
Colima profile can be resumed without changing Docker's global context.

The runtime image pins native Freebuff **0.2.16** and Bun **1.3.14**. The native
version is separate from the npm launcher version (0.0.173 on the inspected
machine). Setup verifies artifact hashes and never includes credentials or the
project in the image/build context. See [runtime security and artifact
provenance](../docker/freebuff-runtime/README.md).

The model picker loads your available models using authenticated read-only
`GET https://www.codebuff.com/api/v1/freebuff/models` with catalog protocol 1.
Locked models and not-yet-issued rows are excluded. Names, image support, context
windows and reasoning levels come from that account response. Catalog reads are
coalesced and cached for up to five minutes; Refresh and explicit turns recheck
access. Failed reads remove explicit account models rather than retaining stale
entitlements. Account catalog verification is reported at **catalog** scope.

Selecting a model writes its stable CLI picker key and supported reasoning effort
only to the private turn HOME. Your original CLI settings stay intact. Root-agent
log evidence must match the account catalog's backend-only opaque handle before
response text is published. Handles are never exposed as public model IDs or
guessed into prices. **Freebuff CLI default** remains available to preserve the
CLI's saved selection; its changing image capabilities are not guessed.

On Linux, the adapter uses locally installed tmux, working bubblewrap, Bun and
native Freebuff 0.2.16. On Linux the installed execution binary must match the
qualified runtime version. On macOS discovery inspects the pinned container
binary, so an independent host launcher update neither changes execution nor
falsely rejects the working runtime. The probe reads actual embedded version and
protocol markers instead of relying on intermittently empty native `--version`
output through Docker exec. Windows uses the same pinned Linux container as
macOS; its host paths are translated to the container's private `/kory/run`
mount, so the Windows host never needs native tmux or bubblewrap. A failed
isolation probe leaves the provider unavailable.
Account setup detection is not remote authentication verification.

The Docker VM must provide a native Linux kernel: running a container under
user-mode emulation cannot provide the required bubblewrap namespaces. Koryphaios
selects the daemon's native `amd64` or `arm64` runtime and never changes Docker's
global context. For another Docker context, set `KORY_FREEBUFF_DOCKER_CONTEXT` in
Koryphaios's environment. Colima host networking is supported through Docker's
`host-gateway` mapping, so the authenticated MCP relay remains reachable on both
Docker Desktop and Colima.

### CLI-owned credentials and Keychain consent

Current macOS Freebuff profiles can contain `default.tokenStore: "keychain"`
instead of a plaintext token. This is recognized as login material, not a missing
login. Koryphaios addresses only the CLI's `freebuff-cli` generic-password service
and the exact source `credentials.json` path used as its account name. The normal
macOS Keychain access prompt still applies; unlock/approve that item when prompted.
A bounded 60-second lookup is cancellable and does not enumerate or dump Keychains.

The resolved CLI token and required metadata are written to a fresh, exclusive
0600 credential file under the disposable HOME. No token is returned to tools or
logs; the original profile and Keychain record are never modified. The copy is
removed after the turn. A denied/locked Keychain fails closed with an actionable
message. Legacy plaintext CLI profiles remain supported; non-Darwin Keychain
references without a supported resolver are not treated as usable credentials.
Freebuff login material is never substituted for a Codebuff SDK API key.

## Billing and hours

Settings → Billing includes each detected Freebuff account even before its first
Kory turn. A read-only account probe uses the same exact CLI-owned credential
resolver and requests `GET https://www.codebuff.com/api/v1/freebuff/session`.
It never admits or takes over a session, claims grants, or submits inference.
The canonical host is intentional: `codebuff.com` redirects, and authenticated
billing requests refuse redirects.

The account endpoint provides the live allowance used by Freebuff, reported in
Freebucks together with its per-model rate table. Koryphaios converts that
allowance into **hours** with the account's own live 1x rate — the cheapest paid
row in that table — and combines the remaining daily allowance with the wallet
reserve into one available-hours value. Neither the hourly allowance nor the 1x
rate is hardcoded: the free tier's 30-hour day is whatever the provider's 150
Freebucks buy at the rate it reports. When the account has not reported a rate
yet, Billing keeps the provider's Freebuck figures rather than inventing hours.
The model picker shows each model's multiple of that same 1x rate as a bare
figure (`1x`, `5x`, `10x`) and nothing else.
Freebucks stay separate from USD totals. Account refreshes are cached for 30
seconds; Billing's Refresh button bypasses the TTL.
Failed probes retain the last balance with a **stale** label, or show **unavailable**
when no balance was reported. A replaced login invalidates its old cached balance.
Koryphaios does not display a countdown for an active Freebuff TUI session: the
account endpoint reports a daily allowance boundary rather than the exact
remaining duration of an already-started session.

Token activity comes from Kory-recorded Freebuff request logs and is attributed
to the CLI account that performed the turn. The CLI exposes input context counts,
not upstream output-token usage; Billing labels those totals as input-only and
does not estimate output or convert them into Freebuck charges. Opaque CLI model
handles are not guessed into public OpenRouter model IDs or prices.

## Execution and Notes

Each turn creates a private HOME, workspace, tmp directory, and tmux server. The
Linux runtime exposes only that disposable root. Native Freebuff tools remain
enabled there; they cannot directly read or modify the real Kory workspace.

Kory bundles the MCP bridge and its dependencies into the private root rather
than mounting the application's checkout. A signed per-turn grant limits the
bridge to the session and role. On macOS, a short-lived random-token relay exposes
only the signed catalog and execute routes to the Linux container; the entire
backend is not exposed. Backend role, project, tool and Notes permissions remain
authoritative.

The CLI launches with `--trust-agents` **only for Kory's generated private
workspace**, allowing its `.agents/mcp.json` to load. This is not a blanket trust
of the user's repository. The authoritative MCP catalog—not a static prompt
whitelist—determines available tools, including `read_note`,
`retrieve_note_context`, and permitted Notes write/proposal tools. Critics remain
read-only. Relationship review retains separate human approval.

Startup checks both a signed bridge probe and evidence that Freebuff actually
started the MCP server. Catalog/network/authentication failures cannot masquerade
as an empty healthy server. Catalog requests have a short startup deadline;
executions allow a bounded five-minute window so human approvals are not cut off
by a thirty-second catalog timeout. Cancellation revokes the turn and tears down
its private runtime and relay.

Structured completion is read from Freebuff's own `log.jsonl` **inside the
sandbox**. Nested `shouldEndTurn` events do not complete the parent turn. Main
prompt errors, missing model evidence and empty completions fail explicitly.
Credentials, prompts, raw terminal output and account tokens are not emitted as
failure diagnostics.

## Verification

Closed-transport tests use synthetic credentials, catalogs and logs. Optional
kernel/transport tests run actual bubblewrap, tmux, and the pinned CLI without
submitting an authenticated prompt:

```sh
KORY_FREEBUFF_RUNTIME_SMOKE=1 KORY_TEST_DOCKER_BRIDGE=1 \
  bun test --timeout 60000 backend/src/providers/__tests__/freebuff-runtime.test.ts \
           backend/src/providers/__tests__/freebuff-bridge-runtime.test.ts
```

An explicitly authorized live end-to-end check is separate:

```sh
KORY_RUN_LIVE_PROVIDER_TESTS=1 bun --no-env-file scripts/probe-freebuff-notes.ts
```

It uses a disposable database and a synthetic note with an unpredictable code,
then verifies that the real Freebuff turn calls the signed MCP `read_note` tool
and returns that code with account-attributed billing input samples. Set
`KORY_FREEBUFF_PROBE_LONG_PROMPT=1` to also exercise native long-text attachments.
`KORY_FREEBUFF_PROBE_DIAGNOSTICS=1` emits fixed readiness classifications and
counts while debugging transport. It prints only verification booleans/counters and sanitized
failure information, never credentials or complete model output. It refuses a
saved BYOK or automatic paid-credit configuration. CLI login, entitlement and
provider availability can still prevent this live check from succeeding.

For explicit model-selection qualification, set `KORY_FREEBUFF_PROBE_MODEL` to
an account catalog routing ID (`freebuff/catalog-<key>`) and optionally set
`KORY_FREEBUFF_PROBE_REASONING` to a reported effort. Developer-only runtime
diagnostics remain available via `bun scripts/setup-freebuff-runtime.ts --probe-only`;
normal connection prepares the runtime inside the app.

The 0.2.16 macOS/x64-Colima qualification passed both short- and long-prompt
signed Notes reads. The long-prompt check reported 17,860 final context tokens
and 41,625 processed input tokens across two billing samples, attributed to the
actual CLI account. The live Freebuck account read and real confined runtime
checks also passed. These are measured checks of this version and host layout,
not claims about every account, model, or future release.

## Upgrade boundary

There is no documented headless or general native-tool-deny mode in the inspected
Freebuff 0.2.16 parser. Requalify the actual CLI version, model settings, trust
prompt, composer readiness, `.agents/mcp.json`, MCP invocation, image handling and
root `log.jsonl` shapes for each upgrade. Do not use internal inference endpoints
or treat passing synthetic tests as evidence of a successful account turn.
