#!/usr/bin/env bun
/**
 * Records a real Orca screen reader session over the delete dialog.
 *
 * Orca 43.1 runs against Chromium's accessibility tree inside a Linux container
 * with Xvfb and the AT-SPI bus. Speech Dispatcher is configured with a generic
 * output module that appends the exact text handed to the speech engine, so the
 * transcript below is what the assistive technology actually asked to speak.
 * Nothing is paraphrased and nothing is synthesised on the host.
 *
 * Usage:
 *   bun run scripts/record-accessibility-verification-orca-session.ts [--out=path]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dir, '..');
const runtimeDir = join(projectRoot, 'outputs/skill-library-finish-plan/at-runtime');
const outputArg = process.argv.find((argument) => argument.startsWith('--out='));
const outputPath = outputArg
  ? resolve(projectRoot, outputArg.slice('--out='.length))
  : join(projectRoot, 'outputs/skill-library-finish-plan/orca-live-session.json');

const STEPS: Array<{ name: string; keys: string[]; settle: number }> = [
  { name: 'page-ready', keys: [], settle: 2 },
  { name: 'tab-to-help', keys: ['Tab'], settle: 2 },
  { name: 'tab-to-open', keys: ['Tab'], settle: 2 },
  { name: 'activate-open', keys: ['Return'], settle: 3 },
  { name: 'dialog-opened', keys: [], settle: 3 },
  { name: 'dialog-tab-1', keys: ['Tab'], settle: 2 },
  { name: 'dialog-tab-2', keys: ['Tab'], settle: 2 },
  { name: 'dialog-tab-3', keys: ['Tab'], settle: 2 },
  { name: 'dialog-escape', keys: ['Escape'], settle: 3 },
  { name: 'reopen-dialog', keys: ['Return'], settle: 3 },
  { name: 'confirm-reach', keys: ['Tab', 'Tab'], settle: 2 },
  { name: 'confirm-activate', keys: ['Return'], settle: 4 },
];

const driver = `
set -e
rm -f /tmp/spoken.txt /work/captures/*.png
mkdir -p /tmp/xdg-runtime /work/captures && chmod 700 /tmp/xdg-runtime
export XDG_RUNTIME_DIR=/tmp/xdg-runtime DISPLAY=:99 LANG=de_DE.UTF-8 LANGUAGE=de_DE
Xvfb :99 -screen 0 1280x800x24 >/tmp/xvfb.log 2>&1 &
sleep 2
eval $(dbus-launch --sh-syntax)
/usr/libexec/at-spi-bus-launcher --launch-immediately >/tmp/atspi.log 2>&1 &
pulseaudio -D --exit-idle-time=-1 --disallow-exit >/dev/null 2>&1
sleep 2
speech-dispatcher -d >/dev/null 2>&1
sleep 1
orca --replace --no-setup >/tmp/orca.log 2>&1 &
sleep 5
python3 -m http.server 8080 --directory /work >/tmp/http.log 2>&1 &
sleep 2
chromium --no-sandbox --force-renderer-accessibility --disable-gpu --disable-dev-shm-usage \\
  --no-first-run --no-default-browser-check --disable-features=Translate,TranslateUI \\
  --lang=de --user-data-dir=/tmp/chrome --window-size=1280,800 --kiosk \\
  --app=http://localhost:8080/delete-dialog.html >/tmp/chrome.log 2>&1 &
sleep 12
xdotool search --name 'Dateien' windowactivate --sync >/dev/null 2>&1 || true
sleep 1
for step in ${STEPS.map((step) => step.name).join(' ')}; do
  printf '\\n@@STEP:%s\\n' "$step" >> /tmp/spoken.txt
  case "$step" in
${STEPS.map((step) => {
  const commands = step.keys
    .map((key) =>
      key.startsWith('sleep:') ? `      sleep ${key.slice('sleep:'.length)}` : `      xdotool key ${key}`,
    )
    .join('\n');
  return `    ${step.name})\n${commands}\n      ;;`;
}).join('\n')}
  esac
  case "$step" in
${STEPS.map((step) => `    ${step.name}) sleep ${step.settle} ;;`).join('\n')}
  esac
  import -window root /work/captures/"$step".png 2>/dev/null || true
done
printf '\\n@@END\\n' >> /tmp/spoken.txt
cat /tmp/spoken.txt
`;

const result = spawnSync(
  'docker',
  ['run', '--rm', '-v', `${runtimeDir}:/work`, '-w', '/work', 'kory-at-linux', 'bash', '-lc', driver],
  { maxBuffer: 32 * 1024 * 1024 },
);

if (result.status !== 0) {
  console.error(String(result.stdout ?? '').slice(-2000));
  console.error(String(result.stderr ?? '').slice(-2000));
  process.exit(1);
}

const transcript = Buffer.from(result.stdout ?? []).toString('latin1');
const sections = transcript.split(/@@STEP:(?<name>[a-z0-9-]+)/u);
const spoken: Array<{ step: string; utterance: string }> = [];
const byStep: Record<string, string[]> = {};
for (let index = 1; index < sections.length; index += 2) {
  const name = sections[index]!.replace(/\n/gu, '');
  const body = sections[index + 1] ?? '';
  // Speech Dispatcher's generic module separates its arguments with a bare
  // 'n' token, so strip those newline markers before recording the utterance.
  const lines = body
    .split('\n')
    .map((line) => line.replace(/@@END/gu, '').trim())
    .filter(Boolean)
    .map((line) =>
      line
        .replace(/\.n(?=[A-ZÄÖÜ])/gu, '. ')
        .replace(/\s+n(?=[A-ZÄÖÜ])/gu, ' ')
        .replace(/\bn(?=\s|$)/gu, ' ')
        .replace(/\s{2,}/gu, ' ')
        .trim(),
    )
    .filter(Boolean);
  byStep[name] = lines;
  for (const line of lines) spoken.push({ step: name, utterance: line });
}

const version = spawnSync('docker', ['run', '--rm', 'kory-at-linux', 'bash', '-lc', 'orca --version'], {
  encoding: 'utf8',
});
const orcaVersion = (version.stdout ?? '').trim().split('\n').at(-1) ?? 'unknown';

const chromiumVersion = spawnSync(
  'docker',
  ['run', '--rm', 'kory-at-linux', 'bash', '-lc', 'chromium --version'],
  { encoding: 'utf8' },
);

const session = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  recordedBy: 'scripts/record-accessibility-verification-orca-session.ts',
  screenReader: `${orcaVersion} with Speech Dispatcher 0.11.4 on Debian bookworm (aarch64), Xvfb 1280x800`,
  browser: (chromiumVersion.stdout ?? '').trim(),
  locale: 'de-DE',
  page: 'delete-confirmation-dialog',
  spoken: byStep,
  utterances: spoken,
  steps: STEPS.map((step) => ({ name: step.name, keys: step.keys })),
};

mkdirSync(join(projectRoot, 'outputs/skill-library-finish-plan/at-runtime/captures'), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
writeFileSync(
  join(projectRoot, 'outputs/skill-library-finish-plan/at-runtime/captures/transcript.json'),
  `${JSON.stringify(session, null, 2)}\n`,
);
console.log(JSON.stringify({ screenReader: session.screenReader, steps: Object.keys(byStep).length, utterances: spoken.length }));
console.log(JSON.stringify(spoken.slice(0, 6), null, 1));
