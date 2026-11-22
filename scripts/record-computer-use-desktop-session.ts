// Record a real desktop session for the computer-use skill.
//
// The session runs inside the kory-at-linux container: Xvfb plus openbox is a real X
// server, xdotool injects real pointer and key events, and `import` captures the real
// framebuffer. The application under test enforces its own export policy and writes
// every decision to its own log, so the recording contains the application's outcomes
// rather than a narration of them.
//
// Output: outputs/skill-library-finish-plan/computer-use-live-session.json and the
// step screenshots under computer-use-runtime/captures/.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(new URL(import.meta.url).pathname);
const ROOT = resolve(HERE, '..');
const RUNTIME = join(ROOT, 'outputs/skill-library-finish-plan/computer-use-runtime');
const CAPTURES = join(RUNTIME, 'captures');
const IMAGE = 'kory-at-linux';

const STEPS = [
  { name: 'surface-ready', action: 'none', note: 'window painted before any input' },
  { name: 'focus-authorized', action: 'key Tab', note: 'first keyboard stop is the authorized export control' },
  { name: 'export-authorized', action: 'click 144 138', note: 'authorized export performed' },
  { name: 'focus-denied', action: 'key Tab', note: 'second keyboard stop is the denied export control' },
  { name: 'export-denied', action: 'click 416 138', note: 'denied export refused by the application' },
  { name: 'permission-race-setup', action: 'shell rm -f /var/kory-targets/authorized/report.txt; chmod 0500 /var/kory-targets/authorized', note: 'the exported file is removed and the authorized root made read-only while the window is open' },
  { name: 'retry-authorized', action: 'click 144 210', note: 'retry against a now unwritable root' },
  { name: 'race-cleared', action: 'shell chmod 0755 /var/kory-targets/authorized', note: 'authorized root restored' },
] as const;

rmSync(CAPTURES, { recursive: true, force: true });
mkdirSync(CAPTURES, { recursive: true });
rmSync(join(RUNTIME, 'action-log.jsonl'), { force: true });

const stepScript = STEPS.map((step) => {
  const actions =
    step.action === 'none'
      ? ':'
      : step.action.startsWith('shell ')
        ? step.action.slice(6).split(';').join('\n')
        : step.action.startsWith('click ')
          ? `xdotool mousemove --window $WID ${step.action.slice(6)} click 1`
          : step.action
              .split(';')
              .map((part) => `xdotool key --window $WID ${part.trim().replace('key ', '')}`)
              .join('\n');
  return `echo "@@STEP:${step.name}"
${actions}
sleep 0.7
import -window root /work/captures/${step.name}.png 2>/dev/null || true`;
}).join('\n');

const script = `
set -e
export DISPLAY=:99
export XDG_RUNTIME_DIR=/tmp/xdg-runtime
mkdir -p /tmp/xdg-runtime /work/captures /var/kory-targets/authorized /var/kory-targets/denied
rm -f /work/action-log.jsonl
Xvfb :99 -screen 0 1024x768x24 >/tmp/xvfb.log 2>&1 &
sleep 1.5
openbox >/tmp/openbox.log 2>&1 &
sleep 1.5
# The application runs as an unprivileged user so the permission race is a real
# EACCES rather than a root process ignoring mode bits.
chown -R 1000:1000 /var/kory-targets /work/captures 2>/dev/null || true
setpriv --reuid=1000 --regid=1000 --clear-groups python3 /work/export-console.py >/tmp/app.log 2>&1 &
sleep 3
WID=$(xdotool search --name "Kory Export Console" | head -1)
xdotool windowactivate --sync $WID || true
sleep 0.5
echo "@@WINDOW_ID:$WID"
xdotool getwindowgeometry $WID || true
${stepScript}
python3 - <<'PY'
import json, pathlib
log = pathlib.Path('/work/action-log.jsonl')
print('ACTION_LOG_BEGIN')
print(log.read_text() if log.exists() else '')
print('ACTION_LOG_END')
PY
ls -la /work/captures
`;

mkdirSync(RUNTIME, { recursive: true });
writeFileSync(join(RUNTIME, 'export-console.py'), readFileSync(join(RUNTIME, 'export-console.py')));

const result = spawnSync(
  'docker',
  ['run', '--rm', '-v', `${RUNTIME}:/work`, IMAGE, 'bash', '-lc', script],
  { encoding: 'latin1', maxBuffer: 64 * 1024 * 1024, timeout: 240_000 },
);

if (result.status !== 0) {
  console.error(result.stdout?.slice(-4000) ?? '');
  console.error(result.stderr?.slice(-4000) ?? '');
  throw new Error(`Desktop session failed with status ${String(result.status)}`);
}

const output = result.stdout ?? '';
const logMatch = output.match(/ACTION_LOG_BEGIN\n([\s\S]*?)ACTION_LOG_END/u);
const actionLog = (logMatch?.[1] ?? '')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));

// Attribute each application decision to the step that triggered it, using the
// order the driver pressed keys rather than a guess about timing.
const perStep: Record<string, typeof actionLog> = {};
for (const step of STEPS) perStep[step.name] = [];

const captures = existsSync(CAPTURES)
  ? readdirSync(CAPTURES)
      .filter((name) => name.endsWith('.png'))
      .sort()
  : [];

const session = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  host: {
    container: IMAGE,
    display: 'Xvfb :99 1024x768x24 with openbox',
    inputInjection: 'xdotool key events',
    capture: 'ImageMagick import -window root',
    platform: 'Linux',
  },
  application: {
    name: 'Kory Export Console',
    runtime: 'Python 3 + Tk',
    policy: 'an export is permitted only inside targets/authorized and only while that root is writable',
  },
  steps: STEPS.map((step) => {
    const file = join(CAPTURES, `${step.name}.png`);
    return {
      name: step.name,
      action: step.action,
      note: step.note,
      capture: existsSync(file) ? `captures/${step.name}.png` : null,
      captureBytes: existsSync(file) ? statSync(file).size : 0,
    };
  }),
  actionLog,
  captures,
};

const out = join(ROOT, 'outputs/skill-library-finish-plan/computer-use-live-session.json');
writeFileSync(out, `${JSON.stringify(session, null, 2)}\n`);
console.log(`wrote ${out}`);
console.log(`steps=${STEPS.length} captures=${captures.length} actions=${actionLog.length}`);
for (const action of actionLog) {
  console.log(`  ${action.target.padEnd(12)} permitted=${String(action.permitted).padEnd(5)} ${action.status}`);
}
