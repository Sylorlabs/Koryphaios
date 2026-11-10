#!/usr/bin/env python3
"""Pinned project-local Renode installation and offline STM32 emulator smoke."""

import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import subprocess
import sys
import tarfile
import tempfile


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
LOCK = json.loads((HERE / "artifacts.lock.json").read_text())
VERSION = LOCK["version"]


def host():
    system = platform.system()
    arch = {"aarch64": "arm64", "arm64": "arm64", "x86_64": "x64"}.get(
        platform.machine().lower()
    )
    key = f"{'osx' if system == 'Darwin' else system.lower()}-{arch}"
    if key not in LOCK["runtimes"]:
        raise RuntimeError(f"Unsupported host: {system}/{platform.machine()}")
    return key


def command(args, **kwargs):
    return subprocess.run(
        [str(arg) for arg in args],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=True,
        timeout=kwargs.pop("timeout", 60),
        **kwargs,
    ).stdout


def verify(path, asset):
    data = path.read_bytes()
    if len(data) != asset["size"] or hashlib.sha256(data).hexdigest() != asset["sha256"]:
        raise RuntimeError(f"Size/SHA-256 mismatch: {path}; refusing to use it")
    if "sha1" in asset and hashlib.sha1(data).hexdigest() != asset["sha1"]:
        raise RuntimeError(f"Upstream URL SHA-1 mismatch: {path}")


def assets(key):
    runtime = dict(LOCK["runtimes"][key])
    runtime["url"] = (
        f"https://github.com/renode/renode/releases/download/v{VERSION}/{runtime['name']}"
    )
    return [runtime, *LOCK["smoke_assets"]]


def download(cache, asset):
    path = cache / asset["name"]
    if not path.exists():
        # Only install contacts the network. No shell, installer, or license answers.
        with tempfile.TemporaryDirectory(prefix="download-", dir=cache) as temp:
            partial = Path(temp) / asset["name"]
            command(
                [
                    "curl", "--fail", "--location", "--proto", "=https",
                    "--proto-redir", "=https", "--tlsv1.2", "--silent", "--show-error",
                    "--retry", "2", "--connect-timeout", "20", "--max-time", "300",
                    "--output", partial, asset["url"],
                ],
                timeout=930,
            )
            verify(partial, asset)
            partial.rename(path)
    verify(path, asset)
    print(f"SHA-256 OK: {path.name} ({asset['sha256']})", flush=True)


def extract(cache, key):
    archive = cache / LOCK["runtimes"][key]["name"]
    target = cache / ("Renode.app" if key == "osx-arm64" else "portable")
    if target.exists():
        return
    with tempfile.TemporaryDirectory(prefix="extract-", dir=cache) as temp:
        staging = Path(temp)
        if key == "osx-arm64":
            info = plistlib.loads(command(["hdiutil", "imageinfo", "-plist", archive]))
            if info.get("Properties", {}).get("Software License Agreement", True):
                raise RuntimeError("DMG requires a license decision; stopped before mounting")
            mount = staging / "mount"
            mount.mkdir()
            command(["hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", mount, archive])
            try:
                app = staging / "Renode.app"
                # Preserve the bundle and its attributes; do not change OS trust settings.
                command(["ditto", mount / "Renode.app", app])
            finally:
                command(["hdiutil", "detach", mount])
            app.rename(target)
        else:
            unpacked = staging / "portable"
            unpacked.mkdir()
            with tarfile.open(archive) as package:
                package.extractall(unpacked, filter="data")
            unpacked.rename(target)


def executable(cache, key):
    if key == "osx-arm64":
        candidates = [cache / "Renode.app/Contents/MacOS/renode"]
    else:
        candidates = list((cache / "portable").rglob("renode"))
    candidates = [p for p in candidates if p.is_file() and (p.parent / "platforms").is_dir()]
    if len(candidates) != 1 or not os.access(candidates[0], os.X_OK):
        raise RuntimeError("Renode executable missing/incomplete; run the install command")
    return candidates[0]


def install(cache, key):
    cache.mkdir(parents=True, exist_ok=True)
    for asset in assets(key):
        download(cache, asset)
    extract(cache, key)
    provenance = {
        "verified_at_utc": datetime.now(timezone.utc).isoformat(),
        "host": key,
        "lock": LOCK,
        "verified_downloads": assets(key),
    }
    (cache / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
    print(f"Installed: {executable(cache, key)}")


def run_context(cache):
    runs = cache / "runs"
    runs.mkdir(exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix="smoke-", dir=runs))
    env = os.environ.copy()
    for variable, child in {
        "HOME": "home", "XDG_CONFIG_HOME": "config", "XDG_CACHE_HOME": "cache",
        "XDG_DATA_HOME": "data", "DOTNET_CLI_HOME": "dotnet",
        "DOTNET_BUNDLE_EXTRACT_BASE_DIR": "dotnet-bundle",
        "TMPDIR": "tmp", "TMP": "tmp", "TEMP": "tmp",
    }.items():
        directory = run / child
        directory.mkdir(exist_ok=True)
        env[variable] = str(directory)
    # .NET on macOS can resolve SpecialFolder via the account rather than HOME.
    # Set history-path explicitly so the smoke doesn't use the user's history.
    (run / "renode.config").write_text(
        "[general]\n"
        f"history-path = {run / 'history'}\n"
        "[monitor]\nconsume-exceptions-from-command = True\n"
        "break-script-on-exception = True\n"
    )
    print(f"Run evidence: {run}", flush=True)
    return run, env


def logged(args, run, env, name):
    try:
        output = command(args, cwd=run, env=env)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        output = error.output or b""
        (run / name).write_bytes(output)
        raise
    (run / name).write_bytes(output)
    text = output.decode(errors="replace")
    print(text, end="", flush=True)
    if re.search(r"\[ERROR\]|There was an error|Error while|Unhandled exception", text, re.I):
        raise RuntimeError(f"Renode reported an error; see {run / name}")
    return text


def quoted(path):
    # These paths enter Renode's monitor/REPL, not a shell. Reject control syntax.
    text = str(path)
    if any(char in text for char in '\r\n"\\;'):
        raise RuntimeError(f"Unsupported character in Renode path: {path}")
    return f'"{text}"'


def local_platform(binary, cache, run):
    platforms = binary.parent / "platforms"
    cpu = (platforms / "cpus/stm32f4.repl").read_text()
    original = "@https://dl.antmicro.com/projects/renode/svd/STM32F40x.svd.gz"
    if cpu.count(original) != 1:
        raise RuntimeError("Unexpected bundled STM32 SVD reference")
    svd = run / "STM32F40x.svd"
    svd.write_bytes(gzip.decompress((cache / "STM32F40x.svd.gz").read_bytes()))
    cpu_path = run / "stm32f4.repl"
    cpu_path.write_text(cpu.replace(original, quoted(svd)))
    for name in (
        "stm32f4_discovery-kit.repl", "stm32f4_discovery.repl",
        "stm32f4_discovery-additional_gpios.repl", "stm32f4_discovery-bb.repl",
    ):
        text = (platforms / "boards" / name).read_text()
        if name == "stm32f4_discovery.repl":
            original = '"platforms/cpus/stm32f4.repl"'
            if text.count(original) != 1:
                raise RuntimeError("Unexpected bundled STM32 CPU reference")
            text = text.replace(original, quoted(cpu_path))
        (run / name).write_text(text)
    return run / "stm32f4_discovery-kit.repl"


def smoke(cache, key, version_only=False):
    for asset in assets(key):
        verify(cache / asset["name"], asset)
    binary = executable(cache, key)
    run, env = run_context(cache)
    version = logged([binary, "--version"], run, env, "version.log")
    if not re.search(rf"^Renode v{re.escape(VERSION)}(?:\.|\s|$)", version, re.M):
        raise RuntimeError(f"Executable does not report pinned Renode {VERSION}")
    if version_only:
        return
    flags = [binary, "--console", "--disable-xwt", "--hide-analyzers", "--plain",
             "--config", run / "renode.config"]
    startup = logged(
        [*flags, "--execute", 'echo "RENODE_HEADLESS_OK"; quit'],
        run, env, "headless.log",
    )
    if "RENODE_HEADLESS_OK" not in [line.strip() for line in startup.splitlines()]:
        raise RuntimeError("Headless monitor did not execute the startup marker")
    board = local_platform(binary, cache, run)
    resc = run / "stm32-smoke.resc"
    resc.write_text(
        'mach create "stm32f4-smoke"\n'
        f"machine LoadPlatformDescription {quoted(board)}\n"
        f"sysbus LoadELF {quoted(cache / 'stm32f4-zephyr-hello_world.elf')}\n"
        f"sysbus.usart2 CreateFileBackend {quoted(run / 'uart.log')}\n"
        'emulation RunFor "0.1"\n'
        "emulation GetTimeSourceInfo\n"
        'echo "STM32_SMOKE_COMPLETE"\nquit\n'
    )
    result = logged([*flags, resc], run, env, "stm32.log")
    uart = (run / "uart.log").read_text()
    if "STM32_SMOKE_COMPLETE" not in [line.strip() for line in result.splitlines()]:
        raise RuntimeError("STM32 script did not finish")
    if "Booting Zephyr OS" not in uart or "Hello World! stm32f4_disco" not in uart:
        raise RuntimeError("Expected Zephyr boot and STM32 UART hello were not observed")
    print(f"UART:\n{uart}\nPASS: headless startup and STM32F4 Zephyr UART smoke")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("install", "path", "version", "smoke"))
    args = parser.parse_args()
    key = host()
    cache = ROOT / ".koryphaios/eval-tools/renode" / VERSION / key
    if args.command == "install":
        install(cache, key)
    elif args.command == "path":
        print(executable(cache, key))
    else:
        smoke(cache, key, version_only=args.command == "version")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        if isinstance(error, (subprocess.CalledProcessError, subprocess.TimeoutExpired)):
            print((error.output or b"").decode(errors="replace"), end="", file=sys.stderr)
        print(f"Renode setup/smoke stopped: {error}", file=sys.stderr)
        print("No license answers or OS security overrides are applied by this script.", file=sys.stderr)
        sys.exit(1)
