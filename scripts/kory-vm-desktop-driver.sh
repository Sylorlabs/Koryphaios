#!/bin/bash
# Native desktop driver, host side, for an isolated Linux guest.
#
# It accepts the same arguments as the macOS driver and produces the same receipt, but the fixture is
# built and driven inside the guest machine. Nothing here can reach the display of the machine the
# person is using: the guest creates its own in-memory window server and every observation comes from
# that server.
#
#   --fixture=<root> --scenario=<id> --receipt=<path> --capture=<path> --nonce=<n>
set -euo pipefail

INSTANCE="${KORY_DESKTOP_VM_INSTANCE:-kory-desktop-eval}"
GUEST_ROOT="${KORY_DESKTOP_VM_ROOT:-/home/micah.guest/kory-run}"
DRIVER_SOURCE="${KORY_DESKTOP_VM_DRIVER:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/kory-linux-x11-driver.mjs}"
# The shared mount is the exchange: it carries the fixture and driver in and the receipt, pixels and
# measured executable back out, so no transfer depends on a guest directory's ownership.
# Each run owns its exchange directory, so two arms never delete each other's files.
EXCHANGE="/tmp/lima/kory-vm-exchange-$$"
trap 'rm -rf "$EXCHANGE"' EXIT

fixture=""; scenario=""; receipt=""; capture=""; nonce=""
for arg in "$@"; do
  case "$arg" in
    --fixture=*) fixture="${arg#--fixture=}" ;;
    --scenario=*) scenario="${arg#--scenario=}" ;;
    --receipt=*) receipt="${arg#--receipt=}" ;;
    --capture=*) capture="${arg#--capture=}" ;;
    --nonce=*) nonce="${arg#--nonce=}" ;;
  esac
done
if [ -z "$fixture" ] || [ -z "$scenario" ] || [ -z "$receipt" ] || [ -z "$capture" ] || [ -z "$nonce" ]; then
  echo "vm driver: --fixture, --scenario, --receipt, --capture and --nonce are required" >&2
  exit 2
fi

command -v limactl >/dev/null || { echo "vm driver: limactl is unavailable" >&2; exit 2; }
if ! limactl list --format '{{.Name}} {{.Status}}' | grep -qx "${INSTANCE} Running"; then
  limactl start --tty=false "${INSTANCE}" >/tmp/kory-vm-start.log 2>&1 || {
    echo "vm driver: guest ${INSTANCE} did not start; see /tmp/kory-vm-start.log" >&2
    exit 2
  }
fi

guest() {
  limactl shell "${INSTANCE}" -- sudo -E env HOME=/home/micah.guest \
    PATH=/root/.cargo/bin:/usr/local/bin:/usr/bin:/bin "$@"
}

rm -rf "$EXCHANGE" && mkdir -p "$EXCHANGE/fixture"
cp "$DRIVER_SOURCE" "$EXCHANGE/driver.mjs"
# The evaluation workspace lives outside every directory the guest can see, so the fixture is staged
# through the shared mount and then copied onto the guest's own disk before anything is compiled.
rsync -a --exclude 'target' --exclude 'node_modules' "$fixture/" "$EXCHANGE/fixture/"
guest bash -lc "rm -rf ${GUEST_ROOT} && mkdir -p ${GUEST_ROOT} && cp -a ${EXCHANGE}/fixture/. ${GUEST_ROOT}/"

# The guest keeps its crate cache and compiled artifacts across runs: the fixture is deleted and
# restaged every time, but a Rust rebuild from scratch costs minutes and would make the driver's own
# budget the limiting factor instead of the candidate.
CARGO_TARGET="${KORY_DESKTOP_VM_CARGO_TARGET:-/home/micah.guest/kory-cargo-target}"
guest bash -lc "mkdir -p ${CARGO_TARGET} && cd ${GUEST_ROOT}/src-tauri \
  && CARGO_TARGET_DIR=${CARGO_TARGET} CARGO_HOME=/root/.cargo RUSTUP_HOME=/root/.rustup \
  cargo build --release --quiet 2>&1 | tail -20"

# The driver looks for the packaged artifact at the conventional path inside the staged fixture, so
# the cached target directory is published there rather than the layout being special-cased.
guest bash -lc "mkdir -p ${GUEST_ROOT}/src-tauri/target/release \
  && cp ${CARGO_TARGET}/release/kory-desktop-native-fixture ${GUEST_ROOT}/src-tauri/target/release/ \
  && cp ${CARGO_TARGET}/release/kory-desktop-native-fixture ${EXCHANGE}/output.bin"
# A guest process can die to an unrelated toolkit fault (a GTK or tao panic in the harness, not in the
# candidate). That is an environment failure, so the drive is attempted again once; the second
# receipt is the one reported either way.
drive() {
  guest bash -lc "node ${EXCHANGE}/driver.mjs --fixture=${GUEST_ROOT} --scenario=${scenario} \
    --receipt=${EXCHANGE}/receipt.json --capture=${EXCHANGE}/capture.png --nonce=${nonce}"
}

if ! drive; then
  echo "vm driver: first drive exited non-zero, retrying once" >&2
  rm -f "${EXCHANGE}/receipt.json" "${EXCHANGE}/capture.png"
  drive
fi
if [ -f "${EXCHANGE}/receipt.json" ] && grep -q 'panicked' "${EXCHANGE}/receipt.json"; then
  echo "vm driver: the guest harness panicked, retrying once" >&2
  rm -f "${EXCHANGE}/receipt.json" "${EXCHANGE}/capture.png"
  drive
fi

# The receipt names the executable it measured, and the evaluator verifies that identity against the
# host copy of the fixture, so the binary and both paths come back together.
mkdir -p "$(dirname "$receipt")" "$(dirname "$capture")" "${fixture}/src-tauri/target/release"
cp "$EXCHANGE/receipt.json" "$receipt"
cp "$EXCHANGE/capture.png" "$capture"
cp "$EXCHANGE/output.bin" "${fixture}/src-tauri/target/release/kory-desktop-native-fixture"
chmod +x "${fixture}/src-tauri/target/release/kory-desktop-native-fixture"

node -e '
const fs = require("node:fs");
const [receiptPath, guestRoot, hostRoot] = process.argv.slice(1);
const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
const rewrite = (value) => (typeof value === "string" && value.startsWith(guestRoot)
  ? hostRoot + value.slice(guestRoot.length) : value);
receipt.packagedArtifact = rewrite(receipt.packagedArtifact);
fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
' "$receipt" "$GUEST_ROOT" "$fixture"

echo "vm driver: receipt written to $receipt"
