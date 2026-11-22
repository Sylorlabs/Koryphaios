#!/bin/bash
# Electron scenario, host side, for an isolated Linux guest.
#
# The Electron probe is authored by the evaluator and does its own observations through Electron's
# window, IPC and compositor. This script only gives it a machine to run on that nobody is looking at:
# the fixture and probe are staged into the guest, Electron runs against the guest's in-memory window
# server, and the receipt and pixels come back unchanged.
#
#   --fixture=<root> --probe=<dir> --receipt=<path> --capture=<path> --nonce=<n> --identity=<path>
set -euo pipefail

INSTANCE="${KORY_DESKTOP_VM_INSTANCE:-kory-desktop-eval}"
GUEST_ROOT="${KORY_DESKTOP_VM_ROOT:-/home/micah.guest/kory-run}"
GUEST_ELECTRON="${KORY_DESKTOP_VM_ELECTRON:-/opt/kory-electron/node_modules/electron/dist/electron}"
# Each run owns its exchange directory, so two arms never delete each other's files.
EXCHANGE="/tmp/lima/kory-vm-exchange-$$"
trap 'rm -rf "$EXCHANGE"' EXIT

fixture=""; probe=""; receipt=""; capture=""; nonce=""; identity=""
for arg in "$@"; do
  case "$arg" in
    --fixture=*) fixture="${arg#--fixture=}" ;;
    --probe=*) probe="${arg#--probe=}" ;;
    --receipt=*) receipt="${arg#--receipt=}" ;;
    --capture=*) capture="${arg#--capture=}" ;;
    --nonce=*) nonce="${arg#--nonce=}" ;;
    --identity=*) identity="${arg#--identity=}" ;;
  esac
done
if [ -z "$fixture" ] || [ -z "$probe" ] || [ -z "$receipt" ] || [ -z "$capture" ] ||
   [ -z "$nonce" ] || [ -z "$identity" ]; then
  echo "vm electron driver: --fixture, --probe, --receipt, --capture, --nonce and --identity are required" >&2
  exit 2
fi

command -v limactl >/dev/null || { echo "vm electron driver: limactl is unavailable" >&2; exit 2; }
if ! limactl list --format '{{.Name}} {{.Status}}' | grep -qx "${INSTANCE} Running"; then
  limactl start --tty=false "${INSTANCE}" >/tmp/kory-vm-start.log 2>&1 || {
    echo "vm electron driver: guest ${INSTANCE} did not start; see /tmp/kory-vm-start.log" >&2
    exit 2
  }
fi

guest() {
  limactl shell "${INSTANCE}" -- sudo -E env HOME=/home/micah.guest \
    PATH=/root/.cargo/bin:/usr/local/bin:/usr/bin:/bin "$@"
}

rm -rf "$EXCHANGE" && mkdir -p "$EXCHANGE/probe"
rsync -a --exclude 'target' --exclude 'node_modules' "$fixture/" "$EXCHANGE/fixture/"
rsync -a "$probe/" "$EXCHANGE/probe/"
guest bash -lc "rm -rf ${GUEST_ROOT} && mkdir -p ${GUEST_ROOT}/app ${GUEST_ROOT}/probe &&
  cp -a ${EXCHANGE}/fixture/. ${GUEST_ROOT}/app/ && cp -a ${EXCHANGE}/probe/. ${GUEST_ROOT}/probe/"

# The display is created for this run and proven reachable before anything is launched against it.
start_display() {
  guest bash -c 'if xdpyinfo -display :99 >/dev/null 2>&1; then exit 0; fi
pkill -x Xvfb >/dev/null 2>&1 || true
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
nohup Xvfb :99 -screen 0 1600x1100x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
for attempt in $(seq 1 60); do xdpyinfo -display :99 >/dev/null 2>&1 && exit 0; sleep 0.5; done
exit 3'
}

# A guest that is still finishing the previous run can be slow to accept a new display, and the
# start is cheap to repeat. A display that never comes up is still reported, never assumed.
if ! start_display; then
  sleep 3
  start_display || { echo "the guest display never started" >&2; exit 3; }
fi

run_probe() {
  guest bash -c "rm -rf ${GUEST_ROOT}/user-data ${EXCHANGE}/receipt.json ${EXCHANGE}/capture.png
DISPLAY=:99 ${GUEST_ELECTRON} ${GUEST_ROOT}/probe --no-sandbox --disable-gpu \
  --disable-dev-shm-usage --disable-software-rasterizer \
  --kory-root=${GUEST_ROOT}/app --kory-report=${EXCHANGE}/receipt.json \
  --kory-capture=${EXCHANGE}/capture.png --kory-nonce=${nonce} \
  --kory-user-data=${GUEST_ROOT}/user-data >/tmp/electron.log 2>&1 &
pid=\$!
echo \$pid > ${EXCHANGE}/electron.pid
wait \$pid
echo \$? > ${EXCHANGE}/electron.status"
}

run_probe
status="$(cat "$EXCHANGE/electron.status" 2>/dev/null || echo missing)"
if [ "$status" != "0" ] || [ ! -f "$EXCHANGE/receipt.json" ]; then
  # A Chromium that dies during start up is restarted once: the probe writes its receipt only when
  # it actually ran, so a dead start still reports no evidence rather than a green run.
  echo "vm electron driver: first attempt exited ${status}, retrying once" >&2
  run_probe
  status="$(cat "$EXCHANGE/electron.status" 2>/dev/null || echo missing)"
fi

if [ "$status" != "0" ] || [ ! -f "$EXCHANGE/receipt.json" ]; then
  echo "vm electron driver: Electron exited with status ${status}" >&2
  limactl shell "${INSTANCE}" -- sudo -E tail -20 /tmp/electron.log >&2 || true
  exit 1
fi

mkdir -p "$(dirname "$receipt")" "$(dirname "$capture")" "$(dirname "$identity")"
cp "$EXCHANGE/receipt.json" "$receipt"
cp "$EXCHANGE/capture.png" "$capture"
cp "$EXCHANGE/electron.pid" "$identity"
echo "vm electron driver: receipt written to $receipt"
