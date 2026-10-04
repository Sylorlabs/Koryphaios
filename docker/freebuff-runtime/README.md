# Freebuff real-TUI Linux runtime

Build on macOS with a running Linux/amd64 Docker daemon (Colima works):

```sh
bun scripts/setup-freebuff-runtime.ts
bun scripts/setup-freebuff-runtime.ts --probe-only
KORY_FREEBUFF_RUNTIME_SMOKE=1 bun test --timeout 60000 backend/src/providers/__tests__/freebuff-runtime.test.ts
```

Linux uses local `bwrap`, `tmux`, Bun, and the native CLI installed by Freebuff. It refuses to run if real kernel isolation fails. macOS uses the pinned Linux image; no Darwin executable is copied into it. Setup never reads credentials, logs in, runs inference, or invokes the auto-updating npm launcher. Only `docker/freebuff-runtime/` is sent as build context.

## Release provenance

The installed npm launcher **freebuff 0.0.173** uses `stageBinary(version, targetKey)` in `launcher.js` to download `${appURL}/api/releases/download/${version}/${fileName}`. We use the official default `https://codebuff.com` and native CLI **0.2.12**, not the npm wrapper version. The x64 baseline build avoids an AVX2 requirement. Archive hashes were calculated from the official HTTPS downloads and are enforced during every build:

| Artifact                                                                                  | SHA-256                                                            |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `https://codebuff.com/api/releases/download/0.2.12/freebuff-linux-x64-baseline.tar.gz`    | `878e5a7ce680ef760b98cfa0018a6c6d8b8491fd07ce24f2bb22ba7238cd728f` |
| `https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64-baseline.zip` | `a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7` |

The Debian base is digest-pinned. Debian runtime packages use signed Debian repositories and current Bookworm security updates rather than frozen vulnerable package versions. Consequently the image is not byte-for-byte reproducible across Debian updates; the native CLI and Bun artifacts are byte-pinned. The shipped tree-sitter WASM remains alongside Freebuff.

## Isolation boundaries

- **Docker is not the native-tool sandbox. Every CLI and staged bridge execution uses mandatory bubblewrap.** Only the disposable `runRoot` is host-mounted, at the same absolute path. No project, HOME, Docker socket, device, or host namespace mount is permitted.
- Private HOME/settings/credentials supplied by the provider remain owned by the turn and are deleted by the provider afterward. Host environment and provider keys are never forwarded. The runtime image contains none of them.
- bubblewrap constructs a fresh mount tree with read-only system binaries/certificates, writable disposable `runRoot`, private `/tmp`, fresh `/proc`/`/dev`, and separate PID/IPC/UTS namespaces. Native Linux also uses an unprivileged user namespace. `allowNetwork:false` uses a private network namespace on native Linux and Docker `--network none` on macOS.
- Each tmux server uses an explicit random private socket and `/dev/null` config. Its socket is outside the bubblewrap-visible tree. The sandbox cannot reach the privileged controller through its socket or `/proc`. Cleanup removes only that turn's server/container; no default tmux server is touched.
- The Docker root filesystem is read-only, with bounded PID/memory/CPU resources and `no-new-privileges`. The CLI is explicitly dropped to the host's nonzero UID/GID before execution, with **zero effective, permitted, inheritable, and ambient capabilities**. The remaining bounding-set bits cannot be reacquired with no-new-privileges. Every turn probes this before running anything.

### Why the trusted Docker controller has capabilities

This Colima VM has `kernel.apparmor_restrict_unprivileged_userns=1`. Actual nonroot `unshare -Ur` and bwrap probes fail on UID mapping, even with container AppArmor unconfined. Do not change global VM policy or silently fall back to an unsandboxed CLI.

The disposable container's trusted tmux/bwrap controller therefore starts as root with **only**:

- `SYS_ADMIN`: mandatory mount/PID/IPC/UTS namespace setup;
- `SETUID` / `SETGID`: drop the CLI to the runRoot owner's identity;
- `DAC_OVERRIDE`: tmux must load private 0600 host-owned prompt files.

bubblewrap drops SYS_ADMIN and DAC_OVERRIDE before launching `setpriv`; `setpriv` drops UID/GID and all inheritable/ambient capabilities, which clears effective/permitted capabilities before any Freebuff or bridge code executes. `--privileged` is never used.

Docker's normal AppArmor profile denies bwrap mounts, so this disposable container uses `apparmor=unconfined`. **Seccomp is not unconfined**: `seccomp.json` is Moby's default-deny profile at commit `6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef`, with only `pivot_root` added. Its existing capability-conditioned mount/namespace rules remain, as do all other syscall restrictions. Upstream Apache-2.0 license is in `SECCOMP-LICENSE`. Source: <https://github.com/moby/profiles/blob/6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef/seccomp/default.json>.

No `systempaths=unconfined`, host network, Docker socket, or global Docker/AppArmor changes are needed. Unsupported kernels fail the readiness probe and remain unavailable.

## Evidence and limitations

The opt-in test executes the real pinned native binary with a credential-free HOME and disabled network in a private tmux PTY. It proves a host-outside-root sentinel cannot be read or written, system directories are read-only, disposable writes reach the host runRoot, the real tmux socket is inaccessible/unwritable from bwrap, sensitive supplied environment variables are absent, CLI capabilities are zero, no-new-privileges is set, and cleanup is idempotent. It does not submit a prompt or authenticate.

The synchronous status API is a defensive cached snapshot. Refresh is async, deduplicated, and cached for 60 seconds; each new turn still probes bwrap. Docker readiness checks require a shared directory: Darwin `/private/var/folders` is not shared by default Colima, so probes use a new private subdirectory under `~/.koryphaios/freebuff-runs` and mount only its `run` child.
