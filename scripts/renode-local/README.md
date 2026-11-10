# Project-local Renode 1.16.1

Install the official portable Renode and run a real, headless STM32F4 emulator
smoke. Requires Python 3.12+ and `curl`; the portable artifact includes .NET, so
neither Mono nor a separate .NET installation is needed. macOS also uses the
built-in `hdiutil` and `ditto`. All commands below run from the repository root.

## Setup and use

```sh
python3 scripts/renode-local/renode.py install
python3 scripts/renode-local/renode.py version
python3 scripts/renode-local/renode.py path
```

Supported host artifacts: macOS arm64, Linux arm64, and Linux x86-64. Downloads,
the unpacked runtime, provenance, configuration, and smoke logs are kept under:

```text
.koryphaios/eval-tools/renode/1.16.1/<host>/
```

This cache is already ignored by the repository's `.gitignore`. The macOS CLI is
`Renode.app/Contents/MacOS/renode` inside that directory. `path` prints the exact
CLI path on either OS; it does not add anything to the user's PATH. Existing
cached downloads are verified before reuse. A mismatched file stops installation
and must be investigated rather than silently re-pinned.

Renode is [MIT-licensed](https://github.com/renode/renode/blob/v1.16.1/LICENSE);
its bundled libraries retain their own license notices in the distribution.
The setup preserves the bundle, checks the DMG for a software-license gate, and
supplies no interactive answers. If permission, trust, or new license terms block
installation/execution, it stops at that boundary. It performs no global install,
privilege escalation, quarantine removal, re-signing, or hardware attachment.

## Integrity and provenance

`artifacts.lock.json` pins the exact release URLs, asset IDs, sizes, and SHA-256
digests. Runtime digests come from the **official `renode/renode` release's GitHub
API `digest` field**, not a separately signed checksum manifest:

- [Release](https://github.com/renode/renode/releases/tag/v1.16.1)
- [Release metadata](https://api.github.com/repos/renode/renode/releases/tags/v1.16.1)
- [macOS arm64 asset metadata](https://api.github.com/repos/renode/renode/releases/assets/356851416)

The macOS DMG SHA-256 is:

```text
99b8ae5897b8926ef179868d39a504fe5296555dc9c9b973718ddf3ab09175d9
```

The small Zephyr ELF is the binary referenced by Renode 1.16.1's bundled
`tests/platforms/STM32F4_Discovery.robot`, **Run Zephyr Hello World** case. Its
content also matches the SHA-1 in the upstream URL. The SVD is the Antmicro-hosted
register description referenced by the bundled `platforms/cpus/stm32f4.repl`.
Their SHA-256 values are **locally observed pins of HTTPS downloads**, not claimed
to be independently published checksums. Installation records these sources,
the complete lock, and verification time in ignored `provenance.json`.

## Single offline test command

After installation:

```sh
python3 scripts/renode-local/renode.py smoke
```

The smoke command does not download dependencies. It:

1. Rechecks the locked archives and smoke inputs and checks the real CLI version.
2. Starts the real console monitor with XWT and analyzers disabled, executes a
   marker, and exits. Each subprocess has a 60-second wall-clock timeout.
3. Loads a disposable copy of the bundled STM32F4 Discovery kit platform. Only
   the SVD URL and CPU include path are redirected to the pinned local files;
   peripheral/CPU definitions are unchanged. The installed distribution is kept
   intact. This avoids Renode's implicit SVD network fetch and global file cache.
4. Loads the upstream Zephyr ELF, runs **0.1 seconds of virtual time**, and checks
   the actual emulated USART2 file output for both `Booting Zephyr OS` and
   `Hello World! stm32f4_disco`. It also requires the script completion marker and
   rejects monitor errors even when Renode returns exit code zero.

Each invocation prints its evidence directory, under `<host>/runs/smoke-*`, with
`version.log`, `headless.log`, `stm32.log`, `uart.log`, the generated `.resc`,
local platform copies, and private config/history/temp directories. Version-only
invocations have just the version evidence. macOS .NET can resolve application
data through the account instead of `HOME`, so the smoke explicitly sets
Renode's history path as well as its configuration file and temporary roots.

## Clean Linux container reproduction

The focused Dockerfile pins Python 3.12.12 and the base-image digest, installs
the native headless runtime prerequisites inside the image, selects the locked Linux artifact for the image
architecture, and downloads all inputs during build. It runs as an unprivileged
user. From the repository root:

```sh
docker build -t kory-renode-smoke:1.16.1 scripts/renode-local
docker run --rm --network none kory-renode-smoke:1.16.1
```

No device, host network, display, privileged mode, or host filesystem mount is
required. The runtime smoke is offline; initial image/dependency downloads need
network access. This image is a standalone smoke runner, with no service to deploy.

## Recorded checks

Measured on 2026-10-20:

| Host                                 | Real CLI version                              | Bundled runtime | Headless + STM32 UART smoke |
| ------------------------------------ | --------------------------------------------- | --------------- | --------------------------- |
| Native macOS arm64                   | `1.16.1.16858`, build `d66b0c2a-202602160921` | .NET `8.0.21`   | Passed                      |
| Linux arm64 Docker, `--network none` | `1.16.1.17316`, build `d66b0c2a-202602160933` | .NET `8.0.16`   | Passed                      |

Linux x86-64 has an official pinned artifact in the lock but has not been executed
in this setup session. The passing emulator runs still log translation-cache and
unhandled-register-write warnings; the full logs retain those model limitations.
The result asserted here is the observed boot/UART smoke, not warning-free or
cycle-accurate peripheral coverage.

## Evidence scope

This demonstrates native Renode startup and execution of an upstream Zephyr
sample on a bundled emulated Cortex-M4/STM32F4 board. It does not establish that
project-specific MCU firmware builds or behaves correctly, that timing or
electrical behavior matches a physical target, or that real probes, flashing,
sensor/actuator I/O, and hardware-in-the-loop work. Those need the actual firmware,
target-specific assertions, and separately authorized physical hardware evidence.
