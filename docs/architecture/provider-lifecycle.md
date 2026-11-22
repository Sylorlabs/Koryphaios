# Provider lifecycle contract

Status: part 1 of B4 (adapters only). The manager does not read these capabilities yet.

## Contract

`backend/src/providers/types.ts` defines:

- `LifecycleCapabilities` (`version: 1`): `interrupt`, `resume`, `resumeAfterRestart`,
  `steerInFlight`, `rollback`, `fork` (booleans) and `terminalStatusQuality`
  (`'strong' | 'weak' | 'none'`).
- `ProviderLifecycle`: `capabilities()` and an optional `resumeHandle(sessionId)`, which
  returns a `ProviderResumeHandle` or `null`.
- `Provider.lifecycle?`: optional. `lifecycleCapabilities(provider)` returns the declared
  capabilities, or the conservative default when none are declared: every flag `false`,
  `terminalStatusQuality: 'weak'`.

Rules for an adapter:

- A flag is `true` only when code in that adapter already implements it. Cite the function
  or line beside the flag.
- An adapter that starts a fresh provider session per turn (`--ephemeral`, `session/new`)
  is `resume: false`.
- `interrupt: true` requires a real cancel path: an ACP `session/cancel`, or a kill plus an
  interrupted status. A kill with no reported status is `false`.
- `resumeHandle()` returns only an id the adapter actually stored. Otherwise it returns `null`.
- `supportsFreshConversation` means the provider receives the complete message list on every
  call and keeps no provider-side history. That is the evidence for `rollback: true`.
  It does not by itself imply `fork`.

The status object from `ProviderRegistry.getStatus()` carries `lifecycle?: LifecycleCapabilities`
(read-only). It is omitted when the provider instance is absent.

**The manager branches on capabilities, never on provider names.**

## Adapters (verified in code, 2026-11)

| Adapter | interrupt | resume | rollback | fork | terminalStatusQuality | Evidence |
|---|---|---|---|---|---|---|
| codex (`codex-cli.ts`) | false | false | false | false | weak | `exec --ephemeral` (argv); the abort kills the child but returns with no status; `complete` is still yielded on exit 0 without `turn.completed`; prompt built from messages but no `supportsFreshConversation` declared |
| claude (`claude-code.ts`) | false | false | false | false | weak | No `--resume`/`--continue`/`--session-id` in argv; `system/init` `session_id` not read; abort kills the child with no status; `complete` yielded on exit 0 without a `result` envelope |
| opencode (`opencode-cli.ts`) | true | false | true | false | strong | Cancel is ACP `session/cancel` (`opencode-acp.ts` `cancel()`), with the stop reason captured. `session/new` runs every turn and `session/load` is never sent. `supportsFreshConversation = true`. The `session/prompt` response is the terminal signal. |

Judgement calls:

- **codex/claude `interrupt: false`.** SIGTERM stops the turn, but nothing reports an
  interrupted outcome. The brief's bar is "kill plus a reported interrupted status, or an ACP
  cancel".
- **opencode `interrupt: true` with a caveat.** The ACP cancel is real, but on abort the
  generator returns without a yield, so the interrupted outcome is observed as a `cancelled`
  stop reason and not as a stream event. The manager must not assume a stream event.
- **codex/claude `rollback: false`.** Both rebuild the prompt from messages each call, but
  neither declares `supportsFreshConversation`. Declaring it changes regeneration gating, and
  that is out of scope for a lifecycle-only change.

No `resumeHandle()` is implemented. None of the three adapters stores a session or thread id,
and resume is false everywhere.

Tests: `backend/src/providers/__tests__/provider-lifecycle.test.ts`. They check the declared
objects, the default, `getStatus()` output, and (with the replay harness) that codex passes
`--ephemeral` and that claude argv carries no resume flag.

## Migration backlog: name-based branches (not changed here)

Found by grepping `backend/src` for `NATIVE_PROVIDERS`, `PROVIDERS_WITHOUT_KORY_TOOL_BRIDGE`
and `provider === '` / `providerName === '` / `provider.name === '` in `backend/src/kory/`.

1. `backend/src/providers/provider-harness.ts:24` `NATIVE_PROVIDERS` (native CLI set).
2. `backend/src/providers/provider-harness.ts:42` `PROVIDERS_WITHOUT_KORY_TOOL_BRIDGE`, read by
   `supportsKoryControlPlaneTools()`.
3. `backend/src/kory/manager.ts:5736`, `:6783`, `:10070`: callers of
   `supportsKoryControlPlaneTools()`. Replace with a tool-bridge capability.
4. `backend/src/kory/manager.ts:9984`: `providerName === 'openai' && reasoningLevel === 'auto'`.
5. `backend/src/kory/manager.ts:10045`: `provider.name === 'openai' || provider.name === 'anthropic'`.
6. `backend/src/kory/manager.ts:3770-3787`: provider display-name table. Cosmetic, but name-based.
7. `backend/src/kory/manager.ts:7983`: `last?.provider === providerName`. Review what it guards.
8. `backend/src/kory/prompts/index.ts:569-577`: provider name to prompt family.

Already capability-based, so not backlog: `backend/src/kory/manager.ts:5334` reads
`provider.supportsFreshConversation === false`.

Still to do (later B4 steps): manager adoption of `interrupt`, `rollback` and `steerInFlight`
through the lifecycle; a `WSPayloads.ProviderInfo` `lifecycle?` field so the frontend sees the
status (not done here, since that file has unrelated in-flight edits).
