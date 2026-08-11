# Native reliability hardening — 2026-08-09

This document records the behavior and recovery contracts established by the
2026-08-09 local hardening run. The run began from `fb40ddc58c85` on `master`.
Raw before/after artifacts live under the ignored evidence root
`.koryphaios/evidence/20260809-025000/`; credentials, full prompts, and
unbounded tool output are deliberately excluded.

## Recovery guarantees

### Checkpoints and Time Travel

- Shadow repository initialization is serialized across processes and is
  idempotent across interrupted initialization, linked worktrees, legacy ref
  migration, pruning, and garbage collection.
- A checkpoint is acknowledged only after its self-contained snapshot closure,
  bounded allowlisted metadata, manifest entry, and cursor are published as one
  ref transaction. Main-repository Git refs, logs, mirrors, object enumeration,
  and `fsck` do not expose private checkpoint objects.
- Git subprocess stdout and stderr have independent hard byte ceilings. Readers
  continue draining pipes, but overflow or an incomplete read fails the
  operation instead of parsing partial structured output; logs keep only
  redacted structural metadata.
- Session ref namespaces use collision-resistant identities. A corrupt
  manifest is reconciled from validated authoritative refs; storage or
  publication failures are surfaced instead of becoming an empty timeline.
- Recovery is project- and session-scoped. It accepts only the recorded owned
  paths, rejects reserved or symlink-traversing paths, preserves the user's Git
  index, and revalidates the cursor and worktree inside the operation lock.
- Workspace and conversation recovery use a durable recovery journal. A crash
  is either acknowledged after both participants committed or compensated from
  the guarded backup; an arbitrary newer edit causes recovery to fail closed.
- Undo and redo move a retained conversation lineage head. They do not delete
  future messages, and they survive backend restart. A new message after rewind
  creates a branch in that lineage.

### Process lifecycle and cancellation

- Process provenance is assigned at the server creation boundary. The shared
  `isAgentBackgroundProcess` predicate is the sole definition used by waiting,
  wake-up, Monitoring, cancellation, and Time Travel barriers.
- Owned background processes remain active until bounded TERM/KILL escalation
  and OS-group reap are verified. A normal shell-leader exit does not publish a
  terminal event, wake the agent, or release the Time Travel barrier while any
  detached descendant remains. Once the original group is observed gone, that
  numeric PGID is never signalled again even if the OS reuses it. Spawn failure,
  crash, kill, exit, restart, detached work, and restart recovery have explicit
  status and terminal reason.
- Startup recovery fails closed if active-process persistence cannot be read.
  A live process whose identity or death cannot be verified remains degraded
  and blocks recovery; it is never reported as exited or silently forgotten.
- Persisted process commands, log tails, errors, health records, and event
  metadata are bounded and redacted. A redacted or legacy command is not
  replayed on restart.
- Backend, watchdog, and native diagnostic directories and files are healed to
  owner-only permissions on Unix. Native log opens are descriptor-bound,
  reject symlink or non-regular targets, and preserve existing content.
- Agent subprocesses and repository-configured Git helpers receive an
  allowlisted environment without backend/provider secrets. Sandbox-required
  work needs an actual OS confinement mechanism; otherwise it is rejected
  before spawn. YOLO and allowlists cannot waive the catastrophic-command
  per-call approval floor.

### Goal Mode

- Producer evidence and verifier verdict are separate persisted records.
  Independent verification requires distinct, recorded provider/model
  identities; skipped, unavailable, same-identity, legacy, or missing review is
  unverified and cannot complete a checklist item.
- Goal creation and public update paths cannot import caller-authored completed
  checklist state. Start, evidence append, review, reopen, and completion use
  guarded store transitions.
- Pause and stop are checked at safe points, periodic checkpoints cannot
  overlap, missing checkpoint acknowledgements remain visible, and a resumed
  goal receives a new persisted attempt epoch so historical blocker streaks do
  not immediately block the new attempt.
- Workflow drafts remain inactive until a user explicitly activates them.

## Product truth contracts

### Providers

Catalog presence, executable discovery, credential-file discovery, and a
successful authenticated runtime probe are distinct states. Provider/model and
account claims come only from authenticated metadata or an explicit
unavailable/unknown result. Protocol- or product-specific adapters do not fall
through to a generic OpenAI chat route. Remote mutation paths that cannot
preserve Koryphaios approvals are disabled rather than auto-approved.

CLI MCP metadata is fetched from the authenticated bootstrap ToolRegistry. The
advertised catalog, manager/worker/critic/coder role filters, and execute
authorization are exhaustively parity-tested; unknown roles fail closed.
Critics retain read-only Notes/context/resource access but cannot mutate Notes,
prune context, or create checkpoints. A provider Stop hook ends a harness turn
only and never acts as a Goal verifier verdict.

No paid-provider entitlement or unavailable external platform is treated as a
passing local test. See the provider matrix in the evidence manifest for the
synthetic protocol gates and the live-provider rows that remain unverified.

### Notes and Memory

Notes, long-form Memory documents, attachments, search, and pinned context are
scoped by the authenticated project root. Writes use optimistic revisions and
surface conflicts instead of silently replacing a newer editor or agent save.
Persistence boundaries enforce configurable note, Memory, context, and
attachment budgets; attachment names, storage paths, MIME types, and response
headers are bounded and validated.

Editor autosave is serialized, preserves a failed or conflicting draft, and
does not report clean until the exact queued revision is durable. Context
injection distinguishes pinned content from automatic inclusion and records
per-source omissions/errors rather than silently exceeding the budget.

### Settings and skills

Settings displays only implemented controls and uses Koryphaios-native selects,
switches, steppers, color controls, focus behavior, and theme tokens. Spending
caps are enforced in the manager path against authoritative rolling usage, not
just displayed.

The bundled professional skill system contains 79 stable definitions in a
validated polyhierarchy. `broader`, `facets`, `requires`, and `conflicts` have
separate semantics; target-medium negation is authoritative; live prompt cost
includes the heading, manifest, hash, item blocks, and separators. Mandatory
skill boundaries and evidence contracts are lossless under compression, and a
budget that cannot fit them fails closed. Live turns require a provider-verified
context window, reserve the exact manager/worker or critic output limit, and
apply a final UTF-8 upper bound to the complete provider-rendered prompt.
Settings labels its default-budget preview as planning-only. Same-scope draft
creation uses an atomic no-replace publication boundary across processes. See
[ADR-008](./adr/008-skill-polyhierarchy-and-facets.md).

## Data migrations

- `0026` retains message parent lineage and the active session message while
  separating provider transcript invalidation from the active context revision.
- `0027` adds project ownership and optimistic revision numbers to Notes.
- Process-supervisor startup performs additive, idempotent migration for
  provenance, supervision, background ownership, terminal outcomes, bounded
  evidence, and command replayability. Legacy rows remain explicitly unknown;
  mutable command text is never used to infer ownership.

## Verification protocol

Focused suites are evidence for their stated contract only. Completion also
requires fresh runs of:

```sh
bun install --frozen-lockfile
bun audit
bun run typecheck:ci
bun run test:core
bun run test:e2e
bun run build:ci
bun run build:desktop
bun run format:changed
git diff --check
```

`bun run test:core` is closed-transport by default. Its isolated backend
harness passes only a minimal OS execution/locale environment allowlist,
replaces home/temp/config/data/skills/workflows/project/log roots, disables CLI
autodetection and cloud metadata, and starts every Bun child with
`--no-env-file`. Ambient provider credentials, endpoints, account locations,
state paths, executable preload options, and live flags therefore do not cross
the boundary. Live provider tests require the separate explicit boundary
`KORY_RUN_LIVE_PROVIDER_TESTS=1`; they are not part of the core completion gate
and must be reported provider-by-provider as external evidence.

The native gate uses `bun run dev:desktop` so the launcher owns the backend,
frontend, and Tauri window. The same startup, chat/composer, provider, Goal,
Time Travel, Monitoring, Settings, Notes, and Memory journeys are exercised at
matching viewport sizes with console/network capture. Browser-only proof does
not substitute for the native window, and unavailable providers or platform
targets remain marked unverified. The Vite dev server pre-optimizes every
Tauri WebView module before the native window mounts, preventing a lazy
dependency re-optimization from invalidating the first WebKit module load.

Packaged WebViews keep their application-owned Tauri origin. The bundled
launcher injects an explicit, non-wildcard allowlist for `http://tauri.localhost`,
`https://tauri.localhost`, and `tauri://localhost`; development loopback
origins remain separate. Release tests cover both GET and OPTIONS CORS paths
for every packaged origin.

Release compatibility identity is content-addressed over the source worktree
and records the exact commit and dirty state. `build:desktop` invokes the hash
writer in strict release mode, which refuses modified, deleted, or untracked
non-ignored source inputs. A packaged health hash is therefore attributable to
the committed source used to build that artifact rather than merely to a stale
HEAD abbreviation.

## Environment-dependent limits

- Provider calls require the user's own authenticated accounts, quota, and
  network. Synthetic protocol tests do not certify entitlement or production
  service availability.
- OS sandbox proof is host-specific. Linux uses `bwrap`; unsupported or missing
  confinement fails closed for sandbox-required work. Resource limits are
  best-effort per-user limits, not a cgroup or VM boundary.
- The deterministic core runner detects hosts that deny loopback listeners,
  interactive Bun child-stdin pipes, or operational `bwrap` user namespaces.
  Tests requiring those OS boundaries are reported as explicit skips in that
  environment; they run normally on a host that grants the capability. A skip
  is not provider, network, native-window, or entitlement evidence.
- This Linux run does not certify macOS/Windows packaging, code signing,
  installer upgrade, or rollback. Each target needs its own build/install gate.
- The Linux AppImage path now ships the Bun backend as an opaque gzip resource
  (`backend/koryphaios-backend-*.gz`). The native shell streams it into a
  private executable cache, enforces a 512 MiB decompressed ceiling, and uses
  an atomic replacement plus source stamp; linuxdeploy therefore never rewrites
  the Bun ELF. The build removes stale generated `AppDir`, `appimage_deb`, and
  Debian staging trees before packaging so an old raw sidecar cannot return.
  On offline hosts where appimagetool cannot download its type-2 runtime, the
  script only falls back after validating that AppDir contains exactly one
  gzip backend and extracts the runtime prefix from the cached appimagetool;
  CI retains the normal network-backed plugin path. This host produced and
  validated `Koryphaios_0.2.0_amd64.AppImage` (`--appimage-version` passed).
- Notes filesystem coordination is process-local; concurrent independent
  backend processes are not presented as a supported multi-writer deployment.
- Provider-specific tokenizers are not bundled. Live skill budgeting therefore
  uses a deliberately strict UTF-8 byte upper bound, which may block earlier
  than a provider tokenizer would. A missing live-verified model window blocks
  the turn rather than falling back to a guessed capacity.
- New-skill publication relies on same-directory hard-link no-replace semantics.
  Unsupported or non-local filesystems surface the publication error and remain
  unverified; Kory does not fall back to a replacing rename.
- POSIX process groups do not provide a pidfd-style atomic identity-and-signal
  primitive. Kory permanently retires a PGID after an observed disappearance,
  but the final liveness-check-to-signal syscall interval remains an operating
  system limitation; stronger isolation needs cgroups or platform pidfds.
