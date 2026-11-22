# Compute delegation across linked computers

Status: verified end to end against a live Linux VPS on 2026-11-16, including a
remote chat, a returned report, and manager fan-out of two remote chats whose
files were collected locally without a commit. See **Verified** for the exact
evidence and **Known gaps** for what is still open.

## Placement

The same encrypted link supports two different user intents. They are not
interchangeable.

| Placement | Meaning | Default for | Return behavior |
| --------- | ------- | ----------- | --------------- |
| `stay` | The work lives on the target computer. | A chat created on that computer from the device chooser. | Nothing is copied back unless the user asks. |
| `return` | The target is used for its compute, and the changes come back to the origin. | "Use my compute on my VPS", or moving a heavy job off a busy machine. | A read-only patch bundle is written under `.koryphaios/incoming/<transferId>/`. |

A `stay` chat cannot be collected. That is enforced in the manager tool, not
only in the prompt.

## Ownership and disconnects

A chat is owned by the backend that hosts it. A `stay` chat created on a linked
computer runs its manager and workers inside that computer's Koryphaios
process. The origin only displays a linked view. If the origin quits, sleeps,
loses Wi-Fi, or is unplugged, the target keeps working. Reopening the chat later
replays the durable history.

The origin's exit prompt only warns about work that actually depends on the
origin process: local managers and local workers, including a local manager
controlling a remote run. A linked chat's run state is ignored, so closing a
laptop while a cloud chat is streaming does not ask whether to keep it alive.

The manager contract defaults one task to one computer. When the user asks for
work on another machine, `delegate` creates one target chat and that chat's
manager fans out its own workers there. The origin does not keep a parallel
local copy. Splitting one task across machines requires independent
workstreams, an explicit user request, or a concrete resource constraint.

A provider grant transferred for a remote run is scoped to that target chat and
released when the run becomes quiet. It is not cancelled by the origin
disconnecting, and the lease timer cannot kill a still-active turn.

## Committing and pushing

Neither placement implies publishing. `DelegationCommitPolicy` is `none` by
default and `local` is honored only for `return`. No value authorizes a push.
The target export is strictly read-only: it runs `git rev-parse`, `git diff
--binary HEAD`, and `git status --porcelain`, and never `add`, `commit`,
`stash`, `checkout`, `tag`, or `push`.

Returned work is materialized for review, never applied. The origin checkout is
untouched until the user runs `git apply` themselves. `.env` files (except
templates), private keys, `node_modules`, `.git`, build output and nested
`incoming` folders are excluded before anything is read.

## Credential sharing

A linked chat can run on the target using the origin's provider login. The
credential path is:

1. The origin builds a bounded provider bundle. Without an explicit model it
   contains only portable families (Antigravity and `custom:*`). With a selected
   model it contains that provider alone.
2. The bundle is sealed a second time to the **target device identity** with
   ECDH/HKDF/AES-GCM (`sealDeviceMessage`) before it enters the RPC body. This is
   in addition to the device channel's own sealing.
3. The target opens the grant with its own private key, in memory, only for that
   chat. The staged provider scope rejects other chat IDs and a revoked link, and
   is discarded when the run lease ends.
4. The grant is not written to target config, `linked-devices.json`, chat rows,
   tool output, or logs. Only ciphertext crosses the link.

The target process must hold the key in memory to call the provider. "Untouchable"
therefore means unreadable at rest, unreadable to agents and tools, scoped to one
chat, and revoked with the link. It is not a claim that a fully compromised target
OS cannot read its own process memory.

## Agent contract

`backend/src/kory/prompts/index.ts` adds a manager-only section that requires the
agent to:

- state the machine, workspace and placement in one sentence before starting, so
  the user can stop it,
- keep work on a chat whose selected device is another computer,
- use `return` only for compute offload or an explicit request,
- never commit, push, or open a pull request on a linked machine,
- use `delegate`, `snapshot`, and `collect_work` rather than inventing transport,
- keep one task on one computer, and let the target chat own remote fan-out.

## Tools

| Tool | Role | Behavior |
| ---- | ---- | -------- |
| `list_linked_devices` | manager | Lists peers with user-granted agent routing. |
| `control_linked_device` | manager | Workspace/chat discovery, create, prompt, cancel, `delegate`, `collect_work`. |
| `delegate` | manager | Creates a target chat with a placement and submits the task in one call. Returns the announcement text. |
| `collect_work` | manager | Exports a `return` chat and writes the bundle to the origin workspace. |

Workers and critics cannot use these tools.

## CLI

`scripts/kory-cli.ts` drives the same API:

```sh
koryphaios targets
koryphaios run --device "Build server" --policy return \
  --prompt-file task.md --model logfare/deepseek-v4.1-flash-1017
koryphaios collect <target-session-id> --device "Build server" --out ./returned
```

`--use-local-providers` opts into staging this machine's login for one remote
run. `collect` refuses a `stay` chat unless `--force` is explicit.

## Manager coordination contract

- `manage_agents list` returns every manager, worker, and critic in the chat with
  its model, provider, reasoning level, fallback chain, permission posture,
  worktree preference, status, and busy state. Workers can be messaged,
  cancelled, controlled, or pruned. The manager row accepts `set_controls`; the
  control is keyed by manager agent id in the chat's durable agent overrides, is
  hydrated on the next turn or `manage_agents` call, and never overrides a model
  the user explicitly pinned on a request.
- Worker controls cover model, provider-qualified model, reasoning level, and an
  ordered fallback chain. Permission posture stays user-owned and is reported,
  never mutated by the manager. A manager should change controls only when the
  user asks or the task genuinely requires it.
- `get_resource_budget` is the manager's billing view. It combines key-based API
  balances, subscription quota windows, live `x-ratelimit-*`/`retry-after`
  observations from real provider responses, and this chat's recorded spend.
  Missing data is reported as unknown, never as zero or an invented limit.
- `delegate_to_worker` accepts up to 20 ordered fallback steps. A step is
  consumed only when the primary route fails because its provider is unavailable
  or rate limited; ordinary critic rejection retries the same route. Each step
  may set its own reasoning level.
- Manager controls are id-addressed and durable, not a single `SessionRuntime`
  field. The live chat still has one active manager; the control record shape is
  ready for a peer manager to carry its own route, and `manage_agents` addresses
  it by the same manager id contract. Spawning an additional live manager is a
  separate orchestration feature, not a second chat-wide control field.

## Verified

- `backend/src/devices/delegated-work.test.ts`: tracked + untracked export,
  secret exclusion, no commit/index change, review-only materialization.
- `backend/src/devices/provider-bundle.test.ts`: named provider staging,
  identity-sealed grant opens only on the target.
- Backend and frontend typechecks pass.
- **Updated build deployed to the VPS.** The archive must include
  `backend/src`, `shared/src`, `scripts/`, `relay/` and the manifests — the first
  attempt omitted `scripts/` and the service failed on
  `scripts/reviewer-json`. `bun install` (not `--frozen-lockfile`) then
  `systemctl restart koryphaios-remote`; `/api/health` returned `ok` and the
  previous tree remains at `/opt/koryphaios.bak-<epoch>`.
- **Remote chat with returned work.** Policy `return` on chat
  `D975Dp31loet` produced `delegation-probe/REPORT.md` on the VPS with the real
  kernel (`Linux 7.2.8-arch1-2`), git HEAD and workspace state. `collect`
  materialized one file locally; the bundle reports `placement: return`,
  `commit: none`, and nothing was applied, committed or pushed.
- **Manager fan-out + return.** After pinning the target's `general` assignment
  to a chat-capable Logfare model, the manager created `Fanout A`
  (`xu6Lil7kzxCC`) and `Fanout B` (`xKpd0MUuL8hw`) on the VPS. The children wrote
  `fanout/a.md` (remote kernel + UTC timestamp) and `fanout/b.md` (Xeon CPU
  model + `df -h` output). Both chats were collected (three files each) and the
  origin repository stayed at its single `init` commit with no applied changes.
- **CLI custom-provider routing fixed.** `normalizeModel` returned early for any
  string containing `:`, so `custom:<slug>/<model>` was sent with a slash and
  parsed as provider `custom`; every such turn ended
  `terminal/provider_unavailable`. It now converts the slash after the provider
  head, and the VPS turn above ran with `custom:logfare-shared:<model>`.
- **Target auto-routing gap reproduced.** With no pinned assignment, a
  delegated child selected `phoenix-1.0` (an image model) from the custom
  catalog and failed with `404 … does not support the chat/completions
  endpoint`. Pinning `assignments.general` fixed this host; the routing gap is
  recorded below rather than papered over.
- **Virtual display available on the VPS.** `Xvfb :99` runs at 1280x800 after
  installing `xorg-server-xvfb`, `xorg-xdpyinfo`, `xterm` and `xdotool` with
  `pacman`; `xdpyinfo` confirms the display. A synthetic-input probe with
  `xterm` and `xdotool` returned no text, so the Kory computer-use loop itself
  is not yet verified.
- Chat history timing on the live desktop: 56 sessions, `GET /api/messages`
  took 24 to 250 ms for 0.1 to 2.1 MB responses. The read path is not the slow
  part. The feed store reveals the transcript only after a bounded 3 s
  enrichment wait (`ENRICHMENT_TIMEOUT_MS`), which is the next thing to profile.

## Known gaps

- **Disconnect survival is proven by ownership and the exit-prompt guard, not a
  live unplug run.** The target's turn is entirely local to the target backend,
  and the linked-session filter is unit-tested. A real cable-pull/Sleep test on
  both ends is still worth adding.
- **The manager does not reliably finish the fan-out turn.** It delegated both
  children correctly, but the host turn timed out after 540 s (and an earlier
  attempt ended with a withheld response) even though both children completed.
  Collection then had to be run separately. The manager should return child ids
  promptly and resume on their completion instead of holding one turn open.
- **Custom-only targets can auto-route to a non-chat model.** The capability
  registry ignores catalog-discovered custom models, and the fallback takes the
  first entry (`phoenix-1.0`). Filtering the fallback to chat-capable models is
  the durable fix; this host currently relies on a pinned assignment.
- **Headless intent interview still asks questions** even when the throwaway
  workspace sets `agentSettings.intentInterview: "off"`; the second fan-out run
  recorded four answers. Headless runs should not block on an interview.
- **Computer use is only display-ready.** Xvfb and input tools are installed,
  but Kory's computer-use loop was not exercised against the virtual display.
- Returning binary files is metadata-only; text and the git patch are carried.
- The temporary Logfare provider used for the test was removed from both hosts
  after collection.
