# CLI adapter compatibility evidence

This is an offline inventory of local adapter contracts and existing tests. **Supported CLI versions are unknown for every entry. No live support is established by this inventory.** A parser fixture, local login signal, successful version probe, or skipped live test does not prove authentication, model entitlement, quota, service availability, or end-to-end generation.

The machine-readable catalog is [cli-compatibility.ts](../backend/src/providers/cli-compatibility.ts). Each evidence item records its level, repository path, stable text anchor, and limited scope. It is passive metadata: it does not probe installations, enable providers, enforce a version gate, or change registry behavior.

Consumers can retain `CLI_ADAPTER_COMPATIBILITY` and `getCliAdapterCompatibility` for report rows and evidence lookup. `CLI_ADAPTER_PROVIDER_NAMES`, `CliAdapterProviderName`, and `CLI_ADAPTER_COMPATIBILITY_BY_PROVIDER` also expose derived typed names and a map without maintaining another provider list.

## Evidence levels

- **Source contract:** behavior or assumptions found in the adapter; not execution evidence.
- **Synthetic fixture:** deterministic canned input exercises a parser or helper; not proof that any released CLI emits that input.
- **Plumbing test:** local or mocked wiring, account state, availability, or cache behavior; not a remote authentication or generation test.

These levels describe individual claims, not a whole-provider certification. The catalog cites existing tests; the new inventory test checks coverage and evidence references, and does not rerun those adapter tests automatically. No release-qualified or live evidence level is assigned.

## Adapter matrix

| Provider            | Binary / transport                                                                                   | Cited local coverage                                                                                                        | Version boundary                                            | Supported versions                          |
| ------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------- |
| `claude`            | `claude`, print / stream-json                                                                        | Availability plumbing; private system-prompt file in source                                                                 | Unknown                                                     | Unknown                                     |
| `codex`             | `codex exec --json`; app-server model discovery                                                      | Synthetic native-event display and retry/auth classification                                                                | Unknown                                                     | Unknown                                     |
| `codex-auth`        | Managed Codex app-server account/model state and CLI execution                                       | Mocked account/model activation                                                                                             | Unknown                                                     | Unknown                                     |
| `grok`              | `grok`, headless JSON plus session telemetry                                                         | Final-output parser and research capability restrictions                                                                    | Unknown                                                     | Unknown                                     |
| `codebuddy`         | `codebuddy`, Claude Code-style print mode NDJSON plus the CLI's product catalog                      | Product-catalog plumbing and availability gating; live login not attested                                                   | Unknown                                                     | Unknown                                     |
| `workbuddy-desktop` | WorkBuddy AI desktop app's host runtime: bundled CLI `--serve`, ACP over HTTP SSE                    | Product-catalog plumbing, reasoning-ladder derivation, kory MCP bridge wiring; live desktop turns not attested              | Unknown                                                     | Unknown                                     |
| `antigravity`       | `agy`, stream-json input/output                                                                      | Malformed-line rejection and synthetic final usage; private-input gate in source                                            | Unknown                                                     | Unknown                                     |
| `cursor`            | `cursor-agent`, print / stream-json                                                                  | Model-list parser and mocked cache lifecycle; streaming is source evidence only                                             | Unknown                                                     | Unknown                                     |
| `devin`             | `devin`, prompt-file / export                                                                        | Export preference, stdout fallback and model-list parsing                                                                   | Unknown                                                     | Unknown                                     |
| `omnirush`          | `omnirush`, current `--print` engine; CLI-owned `model-catalog.json` (legacy JSON RPC fallback)      | Synthetic current-catalog parser, legacy RPC fixtures, and CLI-owned auth/model transport                                   | Unknown                                                     | Unknown                                     |
| `opencode`          | `opencode`, ACP (protocolVersion 1) over stdio; authenticated `opencode api model.list` live catalog | ACP/model-catalog synthetic fixtures; host actions route through the session-scoped Kory MCP bridge passed per ACP session  | Unknown                                                     | Unknown                                     |
| `freebuff`          | Real OpenTUI via private tmux, root log.jsonl, mandatory Linux bubblewrap (native or Docker/Colima)  | Native 0.2.16 confined runtime plus live signed MCP Notes reads, long-prompt transport and account-attributed billing usage | Source reference: pinned native 0.2.16; separate live probe | Unknown beyond the qualified 0.2.16 runtime |

The registry's standard and managed CLI harness sets define this inventory's scope. Managed `codex-auth` is included despite using a different account lifecycle. Kimi Code consumes CLI-owned credentials through its API adapter; Kilo's `kilo-cli.ts` implements an HTTP gateway adapter; Codebuff uses its separate API-key SDK. Those are not subprocess CLI adapters in this catalog. The provider conformance suite derives its CLI external-suite classification from this manifest and reports concrete evidence paths/levels plus version and live-verification status. Its dedicated Chatbase request, stream, and error coverage is documented below.

## Runtime diagnostic integration

[provider-diagnostics.ts](../backend/src/providers/provider-diagnostics.ts) attaches a `cliCompatibility` object to `safeProviderDiagnostic()` output for exact CLI provider IDs. Existing structured logging callers in Claude Code, Codex, managed Codex, Grok, Antigravity, Cursor, and Devin now carry the catalog's evidence scopes, version boundary, and revalidation checklist. This makes the inventory available when investigating real adapter failures without changing provider activation or registry behavior.

The context explicitly marks installed and supported versions as unknown and live verification as not established. It comes from the local catalog, never from upstream error claims, credentials, or a new executable probe. It does not diagnose incompatibility as the cause of a failure. HTTP/SDK providers and unknown IDs receive no CLI context. Existing error classification, redaction, and user-facing failure messages remain in place. The provider lookup export uses a typed `ReadonlyMap`, avoiding an unchecked `Object.fromEntries` record assertion.

[provider-diagnostics-cli-compatibility.test.ts](../backend/src/providers/__tests__/provider-diagnostics-cli-compatibility.test.ts) exercises serialization, exact provider matching, untrusted claim exclusion, existing diagnostic behavior, and detached metadata. These are deterministic helper tests, not live CLI execution evidence.

## Cline (API-key provider, not a CLI harness)

Cline is an **API-key** provider and is deliberately absent from the matrix
above. [cline.ts](../backend/src/providers/cline.ts) calls Cline's hosted
OpenAI-compatible endpoint (`https://api.cline.bot/api/v1`) directly with a
Cline API key. No `cline` CLI is spawned, no local Cline installation is read,
and no Cline-owned credential is stored; the old CLI-harness adapter and its
`~/.cline` model scraping have been removed. The retired adapter's
`clineRequiresArgvPrompt` implementation branch no longer exists, so the
corresponding version-boundary entry is gone with it.

Discovery reads three documented endpoints, none of which is a superset of the
others. Note that Cline answers `/api/v1/models` **publicly** (HTTP 200 with or
without a credential), so that list is a deployment inventory and never a
per-key entitlement claim; the credential is validated by `verifyConnection()`
and by the first real completion instead:

| Read               | Auth   | Endpoint                              | Supplies                                                                                                      |
| ------------------ | ------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Served models      | public | `/api/v1/models`                      | the model ids this deployment serves (gates the picker)                                                       |
| Capability catalog | public | `/api/v1/ai/cline/models`             | `context_length`, `top_provider.max_completion_tokens`, USD pricing, input modalities, `supported_parameters` |
| Curated sets       | public | `/api/v1/ai/cline/recommended-models` | recommended and promotional free model ids used to order the picker                                           |

Per-model reasoning _values_ are reported by no endpoint, so they are resolved
from three real sources, in precedence order, and the first one that speaks for
a model wins:

| Order | Source                                                                                                                                                                     | Covers                                                                  |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1     | Cline's own live catalog `supported_parameters`                                                                                                                            | whether a model accepts `reasoning_effort` / `include_reasoning` at all |
| 2     | Cline's published catalog, generated into [cline-catalog.generated.ts](../backend/src/providers/cline-catalog.generated.ts) by `bun run scripts/generate-cline-catalog.ts` | the exact tier list for Cline-specific and vendor-specific models       |
| 3     | the shared models.dev enrichment chain ([models-dev.ts](../backend/src/providers/models-dev.ts))                                                                           | the upstream lab's own entry for anything 1 and 2 miss                  |

Step 3 is what keeps this from being hardcoded per provider: Cline is
registered in the same `GATEWAY_FALLBACK_PROVIDERS` set as the other multi-lab
gateways, so a newly-launched model resolves against the lab that serves it with
no code change and no regeneration. Enrichment is fill-only, so Cline's own
numbers always win where it reports them.

Models whose only reasoning control is the boolean `include_reasoning` are
offered exactly `off`/`on`; tiered models are offered only the `reasoning_effort`
values that source declares. A model no source describes gets no reasoning
picker rather than a guessed one, matching the data-driven rule in
[ReasoningConfig.ts](../shared/src/reasoning/ReasoningConfig.ts). Reasoning
deltas arrive as `reasoning` (the OpenRouter shape Cline documents) as well as
`reasoning_content`.

### What was verified live

Verified against `api.cline.bot` with a real key. Discovery returned 458 models
through the registry, all carrying a real context window and max output tokens,
432 priced, 292 vision, and 259 with a real reasoning ladder.

| Behavior                  | Result                                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Served-model route        | `/api/v1/models` is public; HTTP 200 with or without a credential                                                                             |
| Capability route          | `/api/v1/ai/cline/models` is public and returns 460 rows of real metadata                                                                     |
| Content streaming         | `content_delta` works                                                                                                                         |
| Tool calling              | `tool_use_start` / `tool_use_stop` with parsed arguments, `finish_reason: tool_use`                                                           |
| Reasoning deltas          | `delta.reasoning` streams real reasoning text (OpenRouter shape), as does `delta.reasoning_content`                                           |
| Reasoning control         | `reasoning_effort` reaches the wire only for a tier the model declares; an undeclared tier is dropped without a 400                           |
| Usage accounting          | arrives on the **same chunk as `finish_reason`**, with `prompt_tokens_details.cached_tokens` and `completion_tokens_details.reasoning_tokens` |
| Insufficient credit (402) | surfaces as a provider error, never a successful empty completion                                                                             |
| Credential check          | `verifyConnection` succeeds against the served-model route for a valid key                                                                    |

Two provider behaviors were found only by that live run and fixed:

1. **Usage on the finish chunk.** Cline attaches `usage` to the chunk that
   carries `finish_reason` rather than sending a trailing usage-only chunk. The
   shared reader only looked at usage on choice-less chunks, so _every_ Cline
   turn reported zero tokens — silently breaking the context meter and billing.
   [openai.ts](../backend/src/providers/openai.ts) now reads `usage` whenever it
   is present, independent of `choices`, and emits `complete` only once even
   when a provider repeats `finish_reason`.
2. **Reasoning control depended on async discovery.** The reasoning hook
   originally resolved the model from the live model list, which populates
   asynchronously, so on a cold adapter the user's reasoning selection was
   dropped. The hook now also receives the request's own model id, so a
   committed ladder is sufficient evidence and works immediately.

A third bug was generic rather than Cline-specific: the registry resolved a
configured base URL with `??`, so a stored-but-blank `baseUrl` (what the
Settings UI and the shipped `koryphaios.json` both write) shadowed the
provider's own default and produced `Unsupported provider`. It now falls back
when the configured value is blank.

A provider-side quirk worth knowing: `reasoning_effort: "high"` on the
zero-priced `stealth/space-bunny-alpha` returned `Provider returned an empty
response`. The adapter surfaces that as an error instead of a silent success;
the cause is upstream, not the adapter.

Cline's `cline-free/*` models are refused with HTTP 403
("only available via Cline product surfaces"), so they are unreachable through
this API adapter. The promotional `stealth/*` models do work.

### Known gap

A model that Cline's own catalog does not describe can still be covered by the
lab that serves it. `anthropic/claude-sonnet-5.5` is absent from Cline's
published catalog (`@cline/llms` 0.0.86, the newest release) but present in
models.dev's `anthropic` entry, so it resolves to
`low, medium, high, xhigh, max` at a 1M context window without any Cline-side
regeneration. Adding the cross-lab step took live coverage from 259 to 316 of
458 models with a reasoning picker (56.6% → 69.0%).

142 models still get no picker: neither Cline nor any upstream lab publishes
reasoning tiers for them, so there is no honest answer. That is a coverage gap
in the public data, not something to paper over with a guessed ladder.

The zero-priced models that were executed do not certify paid-model turns, so
this entry stays `preview`.

## Related Chatbase HTTP conformance

[chatbase-conformance.test.ts](../backend/src/providers/__tests__/chatbase-conformance.test.ts) verifies the v2 agent URL and scalar `message`, fragmented UIMessage text including UTF-8, server-issued conversation ID reuse/retry, and structured HTTP errors using synthetic responses. [provider-conformance.test.ts](../backend/src/providers/__tests__/provider-conformance.test.ts) now categorizes Chatbase as a dedicated request shape. Primary protocol references are Chatbase's [streaming](https://www.chatbase.co/docs/api-v2/streaming) and [error handling](https://www.chatbase.co/docs/api-v2/error-handling) documentation. [chatbase.ts](../backend/src/providers/chatbase.ts) now treats streamed `type: "error"` and error finish reasons as terminal failures, with bounded/redacted upstream details and no successful completion. Partial text already emitted remains visible; buffered text-protocol and native tool calls are not dispatched after failure. Completion waits for the stream terminator or a finish event followed by EOF. Empty responses, interrupted streams without completion evidence, and reader failures produce errors. Readers are cancelled and unlocked on exit. Regression fixtures cover these cases, fragmented UTF-8, and final frames without a newline; successful text and tool flows retain deterministic coverage. No live calls were made for this inventory; these synthetic checks do not establish live Chatbase support.

## Notion Agent APIs

[notion.ts](../backend/src/providers/notion.ts) implements the Notion Agent APIs (`2026-03-11`) with a Personal Access Token: `POST /v1/agents/query` discovers Custom Agents live from the server (models map to agent IDs), and `POST /v1/sessions {agent_id|session_id, message}` runs a turn, preferring `Accept: text/event-stream` and falling back to `GET /v1/sessions/{id}` polling plus `POST /v1/sessions/{id}/events/query`. Stale session references are restarted fresh; agent.message events supply the text. Agentic tool use uses the shared text protocol in [text-tool-protocol.ts](../backend/src/providers/text-tool-protocol.ts) (also delegated from [chatbase.ts](../backend/src/providers/chatbase.ts)). [provider-conformance.test.ts](../backend/src/providers/__tests__/provider-conformance.test.ts) categorizes Notion as a dedicated request shape and verifies the session URL, PAT Bearer + `Notion-Version` headers, flattened message body, and session-SSE parsing synthetically; these checks establish no live account, workspace, or Custom Agent entitlement.

## Version boundaries and gaps

Freebuff's current runtime pins native 0.2.16 (distinct from the independently updated host launcher). Connect prepares the credential-free image automatically and probes actual embedded execution version/protocol markers. Authenticated protocol-1 account catalog reads supply open model rows and their real vision/context/reasoning metadata; selection stages stable CLI picker keys, while opaque handles stay backend-only for root verification. `freebuff/cli-default` preserves CLI-owned selection. Real Docker/Colima probes exercise bubblewrap confinement, private tmux and credential-free TUI startup. Separate live account probes verified signed MCP Notes reads, short and long prompt submission, root completion and account-attributed input-only billing usage. Billing also reads current Freebuck daily allowance, wallet and reset data without submitting inference. Keychain-backed CLI logins use only the precisely addressed Freebuff-owned item through normal OS consent. Execution-runtime upgrades require revalidating actual model selection, private-workspace `--trust-agents`, composer readiness, `.agents/mcp.json` and root completion/error log shapes. Native tools remain enabled only in a disposable Linux bubblewrap workspace; authoritative work uses scoped Kory MCP. See [setup and explicit live Notes probe](freebuff-cli.md).

For all other entries, the cited evidence establishes no numeric CLI release boundary. Model IDs, MCP protocol revisions, SDK package versions, and arbitrary version-looking fixture strings must not be substituted for a CLI version. Unknown must remain explicit until attributable release evidence exists.

## Maintenance and deterministic validation

When an adapter changes, update its evidence scope and upgrade checklist in the catalog, then update this matrix. Add or revise a deterministic fixture for the changed protocol or capability branch. Evidence anchors should identify meaningful behavior; do not replace a failing anchor with an unrelated string merely to pass validation. Adding a registry CLI harness requires an explicit inventory row; the coverage test reads those declarations without importing the registry.

The inventory suite checks registry coverage, duplicate IDs, evidence files/anchors, unknown-version honesty, exact lookup exclusions, and matrix coverage. It imports no adapters and invokes no provider CLI or network transport. Run it with the same environment builder and database preload as `scripts/test-backend-isolated.ts`. From the repository root, this focused invocation creates and removes a disposable home/database and explicitly disables live mode even if the parent environment opted in:

```sh
bun --no-env-file -e '
import { createIsolatedTestEnvironment } from "./scripts/test-backend-isolated.ts";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const dir = mkdtempSync(join(tmpdir(), "kory-cli-compat-"));
try {
  const testHome = join(dir, "home");
  mkdirSync(join(testHome, "tmp"), { recursive: true });
  mkdirSync(join(testHome, "project"), { recursive: true });
  const env = createIsolatedTestEnvironment(
    { ...process.env, KORY_RUN_LIVE_PROVIDER_TESTS: "0" }, testHome);
  const result = spawnSync(process.execPath, [
    "--no-env-file", "test", "--timeout", "60000",
    "--preload", "./backend/src/__tests__/setup-db.ts",
    "./backend/src/providers/__tests__/cli-compatibility.test.ts"
  ], { env: { ...env, DATABASE_URL: `sqlite:${join(dir, "db", "test.db")}` }, stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally { rmSync(dir, { recursive: true, force: true }); }
'
```

Passing this suite validates inventory consistency only. It does not upgrade the cited evidence level or establish live support. Review each existing adapter suite's transport isolation before running it separately; a suite name or a disabled autodetection flag alone is not a guarantee against provider invocation.
