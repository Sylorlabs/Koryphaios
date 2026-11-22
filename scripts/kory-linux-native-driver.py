#!/usr/bin/env python3
"""Native window driver for a Linux evaluation runtime.

The macOS driver observes the app through Accessibility. Inside a Linux container there is no
accessibility bus for the webview, so this driver observes the two channels the fixture already
publishes on purpose: the status mirror it writes (`.kory-status`), and the control file it watches
(`.kory-control.json`). Both are the application's own state, not a proxy for it, and the pixel
capture comes from a real X window server (Xvfb) rather than a headless renderer.

Nothing here touches the operator's desktop: the display is created for this process alone.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import struct
import subprocess
import sys
import time
from pathlib import Path

CHECKS = [
    "tauri-packaged-runtime",
    "native-renderer-and-capture",
    "native-folder-dialog-opened",
    "native-dialog-cancel-is-none",
    "native-folder-selection",
    "allowed-command-inside-root",
    "symlink-swap-at-use-denied",
    "unexposed-command-denied",
    "native-window-lifecycle",
    "restart-restores-canonical-state",
]

WINDOW_TITLE = "Native Workspace Fixture"


class Driver:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.checks: list[dict] = []
        self.errors: list[str] = []
        self.events: list[str] = []
        self.display = os.environ.get("DISPLAY", ":99")
        self.xvfb: subprocess.Popen | None = None
        self.app: subprocess.Popen | None = None
        self.build_log = ""

    # MARK: - plumbing

    def record(self, check_id: str, passed: bool, detail: str) -> None:
        self.checks.append({"id": check_id, "passed": bool(passed), "detail": detail})

    def event(self, name: str) -> None:
        self.events.append(name)

    def run(self, command: list[str], timeout: float = 120.0) -> tuple[int, str]:
        try:
            done = subprocess.run(
                command, capture_output=True, text=True, timeout=timeout, check=False
            )
            return done.returncode, (done.stdout or "") + (done.stderr or "")
        except subprocess.TimeoutExpired:
            return 124, "timeout"

    # MARK: - display and application

    def start_display(self) -> bool:
        if os.environ.get("DISPLAY") and self.run(["/usr/bin/xdpyinfo"], 15)[0] == 0:
            return True
        self.xvfb = subprocess.Popen(
            ["/usr/bin/Xvfb", self.display, "-screen", "0", "1280x840x24", "-nolisten", "tcp"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        os.environ["DISPLAY"] = self.display
        deadline = time.time() + 20
        while time.time() < deadline:
            if self.run(["/usr/bin/xdpyinfo"], 10)[0] == 0:
                self.event("display:xvfb")
                return True
            time.sleep(0.2)
        return False

    def build(self) -> str | None:
        manifest = self.args.fixture / "src-tauri" / "Cargo.toml"
        if not manifest.exists():
            self.errors.append("the fixture has no src-tauri/Cargo.toml")
            return None
        env = dict(os.environ)
        env.setdefault("CARGO_HOME", "/usr/local/cargo")
        env.setdefault("RUSTUP_HOME", "/usr/local/rustup")
        done = subprocess.run(
            ["/usr/local/cargo/bin/cargo", "build", "--release", "--manifest-path", str(manifest)],
            capture_output=True,
            text=True,
            env=env,
            timeout=3600,
            check=False,
        )
        self.build_log = (done.stdout or "")[-4000:] + (done.stderr or "")[-4000:]
        if done.returncode != 0:
            self.errors.append("Real Tauri package build failed")
            return None
        binary = self.args.fixture / "src-tauri" / "target" / "release" / "kory-desktop-native-fixture"
        return str(binary) if binary.exists() else None

    def launch(self, binary: str) -> bool:
        env = dict(os.environ)
        env["KORY_FIXTURE_ROOT"] = str(self.args.fixture)
        env["KORY_FIXTURE_POSITION"] = "150,150"
        env["DISPLAY"] = self.display
        env.setdefault("WEBKIT_DISABLE_COMPOSITING_MODE", "1")
        env.setdefault("LIBGL_ALWAYS_SOFTWARE", "1")
        self.app = subprocess.Popen(
            [binary], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, cwd=str(self.args.fixture)
        )
        return self.wait_for_window(60)

    def window_ids(self) -> list[str]:
        if not self.app:
            return []
        code, out = self.run(["/usr/bin/xdotool", "search", "--pid", str(self.app.pid), "--name", "."], 20)
        if code != 0:
            return []
        return [line.strip() for line in out.splitlines() if line.strip().isdigit()]

    def dialog_ids(self) -> list[str]:
        code, out = self.run(["/usr/bin/xdotool", "search", "--name", "."], 20)
        ids = [line.strip() for line in out.splitlines() if line.strip().isdigit()]
        main = set(self.window_ids())
        return [wid for wid in ids if wid not in main]

    def wait_for_window(self, seconds: float) -> bool:
        deadline = time.time() + seconds
        while time.time() < deadline:
            if self.window_ids():
                return True
            if self.app and self.app.poll() is not None:
                tail = b""
                try:
                    tail = (self.app.stderr.read() or b"")[-1500:]
                except Exception:  # pragma: no cover - diagnostics only
                    pass
                self.errors.append("the packaged app exited before presenting a window: " + tail.decode("utf-8", "replace"))
                return False
            time.sleep(0.25)
        return False

    def wait_for_dialog(self, seconds: float) -> str | None:
        deadline = time.time() + seconds
        while time.time() < deadline:
            for wid in self.dialog_ids():
                code, _ = self.run(["/usr/bin/xdotool", "getwindowname", wid], 10)
                if code == 0:
                    return wid
            time.sleep(0.25)
        return None

    def wait_for_dialog_close(self, wid: str, seconds: float) -> bool:
        deadline = time.time() + seconds
        while time.time() < deadline:
            code, _ = self.run(["/usr/bin/xdotool", "getwindowname", wid], 10)
            if code != 0:
                return True
            time.sleep(0.25)
        return False

    # MARK: - fixture channels

    def status(self) -> str:
        path = self.args.fixture / ".kory-status"
        try:
            return path.read_text(encoding="utf-8").strip()
        except FileNotFoundError:
            return ""

    def wait_for_status(self, seconds: float, needle: str | None = None) -> str:
        deadline = time.time() + seconds
        text = ""
        while time.time() < deadline:
            text = self.status()
            if text and (needle is None or needle in text):
                return text
            time.sleep(0.15)
        return text

    def control(self, payload: dict) -> None:
        path = self.args.fixture / ".kory-control.json"
        path.write_text(json.dumps(payload), encoding="utf-8")

    def capture(self, window: str) -> tuple[bool, str]:
        out = self.args.capture
        if out.exists():
            out.unlink()
        for _ in range(4):
            code, _ = self.run(["/usr/bin/import", "-window", window, str(out)], 60)
            if code == 0 and out.exists():
                data = out.read_bytes()
                if len(data) > 24 and data[:8] == b"\x89PNG\r\n\x1a\n":
                    width, height = struct.unpack(">II", data[16:24])
                    if width > 100:
                        return True, "xvfb window PNG %dx%d" % (width, height)
            time.sleep(0.7)
        return False, "xvfb window capture failed"

    # MARK: - scenario

    def run_scenario(self) -> None:
        tauri_version = self.tauri_version()
        binary = self.build()
        if binary is None:
            for check in CHECKS:
                self.record(check, False, "the fixture did not build")
            return
        self.record(
            "tauri-packaged-runtime",
            tauri_version.startswith("2.") and self.is_elf(binary),
            "kory-desktop-native-fixture tauri %s elf=%s" % (tauri_version, self.is_elf(binary)),
        )
        if not self.start_display():
            for check in CHECKS:
                if check != "tauri-packaged-runtime":
                    self.record(check, False, "the virtual display did not start")
            self.errors.append("xvfb did not start")
            return
        if not self.launch(binary):
            self.errors.append("native window never appeared")
            for check in CHECKS:
                if check not in {c["id"] for c in self.checks}:
                    self.record(check, False, "the native window never appeared")
            return
        self.event("window:created")
        main = self.window_ids()[0]
        self.run(["/usr/bin/xdotool", "windowactivate", "--sync", main], 20)
        time.sleep(0.8)

        captured, detail = self.capture(main)
        self.record("native-renderer-and-capture", captured, detail)
        self.event("renderer:capture")

        inside = self.args.fixture / "safe-workspace" / "inside"
        outside = self.args.fixture / "outside-workspace"
        parked = self.args.fixture / "safe-workspace" / "inside-parked"

        # Cancelled dialog: the status must fall back to the canonical empty state.
        self.control({"action": "open", "directory": str(inside)})
        dialog = self.wait_for_dialog(20)
        self.record("native-folder-dialog-opened", dialog is not None, "GtkFileChooser window observed" if dialog else "no native folder dialog appeared")
        if dialog:
            self.run(["/usr/bin/xdotool", "windowactivate", "--sync", dialog], 20)
            self.run(["/usr/bin/xdotool", "key", "--window", dialog, "Escape"], 20)
            closed = self.wait_for_dialog_close(dialog, 15)
            cancel_status = self.wait_for_status(8)
            self.record(
                "native-dialog-cancel-is-none",
                closed and cancel_status == "No folder selected",
                "closed=%s status after cancel: %s" % (closed, cancel_status or "<empty>"),
            )
        else:
            self.record("native-dialog-cancel-is-none", False, "no dialog to cancel")

        # Accepted dialog: the chosen folder becomes the canonical status.
        self.control({"action": "open", "directory": str(inside)})
        dialog = self.wait_for_dialog(20)
        accept_status = ""
        closed = False
        if dialog:
            self.run(["/usr/bin/xdotool", "windowactivate", "--sync", dialog], 20)
            self.run(["/usr/bin/xdotool", "key", "--window", dialog, "Return"], 20)
            closed = self.wait_for_dialog_close(dialog, 15)
            accept_status = self.wait_for_status(10, "safe-workspace")
        self.record(
            "native-folder-selection",
            closed and "safe-workspace" in accept_status,
            "closed=%s status after accept: %s" % (closed, accept_status or "<empty>"),
        )

        self.control({"action": "read"})
        allowed = self.wait_for_status(10)
        self.record(
            "allowed-command-inside-root",
            allowed == "contained workspace fixture",
            "status after read: %s" % (allowed or "<empty>"),
        )

        # TOCTOU: swap the chosen folder for a link that points outside the fixture root.
        swap_armed = allowed == "contained workspace fixture"
        try:
            if parked.exists():
                shutil.rmtree(parked)
            shutil.move(str(inside), str(parked))
            os.symlink(str(outside), str(inside))
            self.event("fs:symlink-retargeted")
        except OSError as error:
            self.errors.append("cannot swap the chosen folder: %s" % error)
        self.control({"action": "read"})
        time.sleep(1.2)
        swapped = self.wait_for_status(8)
        self.record(
            "symlink-swap-at-use-denied",
            swap_armed and "ESCAPED WORKSPACE" not in swapped and swapped != "contained workspace fixture",
            "status after symlink swap: %s (selection established: %s)" % (swapped or "<empty>", swap_armed),
        )
        try:
            if os.path.islink(inside):
                os.unlink(inside)
            if parked.exists():
                shutil.move(str(parked), str(inside))
            self.event("fs:symlink-restored")
        except OSError as error:
            self.errors.append("cannot restore the chosen folder: %s" % error)

        self.control({"action": "probe"})
        time.sleep(1.2)
        probed = self.wait_for_status(8)
        self.record(
            "unexposed-command-denied",
            probed.lower().startswith("denied"),
            "status after probe: %s" % (probed or "<empty>"),
        )

        # Closing the window must not end the process.
        before = self.app.pid if self.app else -1
        self.run(["/usr/bin/xdotool", "windowclose", main], 20)
        time.sleep(2.5)
        after = self.app.pid if self.app and self.app.poll() is None else -1
        self.record(
            "native-window-lifecycle",
            before > 0 and after == before,
            "pid %s before close, %s two seconds after close" % (before, after),
        )
        self.event("window:closed")

        if self.app and self.app.poll() is None:
            self.app.terminate()
            try:
                self.app.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.app.kill()
        self.event("app:quit")

        # Relaunch: the canonical state must come back, not the previous selection.
        if not self.launch(binary):
            self.record("restart-restores-canonical-state", False, "the app did not present a window after restart")
        else:
            self.event("app:restarted")
            restart_status = self.wait_for_status(12)
            self.record(
                "restart-restores-canonical-state",
                restart_status == "No folder selected",
                "status after restart: %s" % (restart_status or "<empty>"),
            )

    # MARK: - helpers

    def tauri_version(self) -> str:
        lock = self.args.fixture / "src-tauri" / "Cargo.lock"
        if lock.exists():
            lines = lock.read_text(encoding="utf-8").splitlines()
            for index, line in enumerate(lines):
                if line.strip() == 'name = "tauri"':
                    for follow in lines[index : index + 4]:
                        if follow.startswith("version"):
                            return follow.split("=")[1].strip().strip('"')
        return "unknown"

    def is_elf(self, path: str) -> bool:
        try:
            with open(path, "rb") as handle:
                return handle.read(4) == b"\x7fELF"
        except OSError:
            return False

    def cleanup(self) -> None:
        if self.app and self.app.poll() is None:
            self.app.terminate()
            try:
                self.app.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.app.kill()
        if self.xvfb and self.xvfb.poll() is None:
            self.xvfb.terminate()

    def receipt(self, scenario: str, nonce: str) -> dict:
        for check in CHECKS:
            if check not in {c["id"] for c in self.checks}:
                self.record(check, False, "the check was not reached")
        return {
            "nonce": nonce,
            "scenarioId": scenario,
            "runtime": "tauri",
            "environment": {"kind": "linux-xvfb-container", "display": self.display},
            "checks": self.checks,
            "nativeEvents": self.events,
            "errors": self.errors,
            "buildLogTail": self.build_log[-1200:],
        }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", required=True)
    parser.add_argument("--scenario", required=True)
    parser.add_argument("--receipt", required=True)
    parser.add_argument("--capture", required=True)
    parser.add_argument("--nonce", required=True)
    args = parser.parse_args()
    args.fixture = Path(args.fixture).resolve()
    args.capture = Path(args.capture).resolve()
    driver = Driver(args)
    try:
        driver.run_scenario()
    finally:
        receipt = driver.receipt(args.scenario, args.nonce)
        driver.cleanup()
        Path(args.receipt).write_text(json.dumps(receipt, indent=1), encoding="utf-8")
    failures = [check for check in driver.checks if not check["passed"]]
    print(json.dumps({"checks": len(driver.checks), "failed": len(failures)}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
