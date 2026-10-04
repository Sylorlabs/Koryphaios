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

# Build the pinned credential-free Linux runtime, then prove kernel isolation:
bun scripts/setup-freebuff-runtime.ts
bun scripts/setup-freebuff-runtime.ts --probe-only
```

The runtime image pins native Freebuff **0.2.12** and Bun **1.3.14**. The native
version is separate from the npm launcher version (0.0.173 on the inspected
machine). Setup verifies artifact hashes and never includes credentials or the
project in the image/build context. See [runtime security and artifact
provenance](../docker/freebuff-runtime/README.md).

Reconnect Freebuff in Koryphaios Settings and select **Freebuff CLI default**.
The CLI owns the actual account-aware model catalog and its saved selection.
Koryphaios no longer tries to scrape a removed static picker from the modern
binary or fabricate a list of models your account can access. Change the saved
selection through the real Freebuff CLI. A completed turn must provide root-agent
model evidence; an opaque catalog handle is not advertised as a public model ID.
Image support is not claimed for the dynamic default without capability evidence.

On Linux, the adapter uses locally installed tmux, working bubblewrap, Bun and
native Freebuff 0.2.12. The installed account binary must match the qualified
runtime version; an automatic host CLI upgrade does not silently change the
container's behavior. A failed isolation probe leaves the provider unavailable.
Account setup detection is not remote authentication verification.

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
and returns that code. It prints only verification booleans/counters and sanitized
failure information, never credentials or complete model output. It refuses a
saved BYOK or automatic paid-credit configuration. CLI login, entitlement and
provider availability can still prevent this live check from succeeding.

## Upgrade boundary

There is no documented headless or general native-tool-deny mode in the inspected
Freebuff 0.2.12 parser. Requalify the actual CLI version, model settings, trust
prompt, composer readiness, `.agents/mcp.json`, MCP invocation, image handling and
root `log.jsonl` shapes for each upgrade. Do not use internal inference endpoints
or treat passing synthetic tests as evidence of a successful account turn.
