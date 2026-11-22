#!/usr/bin/env bun
/**
 * Records a real Android assistive-technology session for the
 * accessibility-verification fixture.
 *
 * The fixture's Android full task used to be refused because no device with
 * TalkBack and Switch Access existed. One does exist on this host, so the
 * evaluator records the session itself, once, and ships the measured facts to
 * the candidate as the evidence corpus. Nothing here is simulated: every value
 * is read back from adb after driving the real Settings screen.
 *
 * Usage:
 *   bun run scripts/record-accessibility-verification-android-session.ts [--out=path]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const projectRoot = resolve(import.meta.dir, '..');
const outputArg = process.argv.find((argument) => argument.startsWith('--out='));
const outputPath = outputArg
  ? resolve(projectRoot, outputArg.slice('--out='.length))
  : join(projectRoot, 'outputs/skill-library-finish-plan/android-live-session.json');

const androidHome =
  process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(homedir(), 'Library/Android/sdk');
const adbPath = join(androidHome, 'platform-tools/adb');

if (!existsSync(adbPath)) {
  console.error(`adb not found at ${adbPath}`);
  process.exit(1);
}

function adb(args: readonly string[], timeoutMs = 30_000) {
  const result = spawnSync(adbPath, args, { encoding: 'utf8', timeout: timeoutMs });
  if (result.error) throw new Error(`adb ${args.join(' ')} failed: ${result.error.message}`);
  return {
    code: result.status ?? -1,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}

function require0(args: readonly string[], what: string, timeoutMs = 30_000): string {
  const result = adb(args, timeoutMs);
  if (result.code !== 0) {
    throw new Error(`${what} failed (${result.code}): ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function packageVersion(pkg: string): string | null {
  const dump = adb(['shell', 'dumpsys', 'package', pkg]);
  const match = dump.stdout.match(/versionName=([^\s]+)/u);
  return match ? match[1]! : null;
}

interface UiNode {
  text: string;
  contentDesc: string;
  className: string;
  resourceId: string;
  checked: boolean;
  checkable: boolean;
  clickable: boolean;
  focusable: boolean;
  focused: boolean;
  bounds: string;
}

interface ParsedNode extends UiNode {
  children: ParsedNode[];
}

function parseUiTree(xml: string): ParsedNode[] {
  const roots: ParsedNode[] = [];
  const stack: ParsedNode[] = [];
  for (const match of xml.matchAll(/<node\b([^>]*)>|(<\/node>)/gu)) {
    if (match[2]) {
      stack.pop();
      continue;
    }
    const attributes = match[1]!;
    const read = (name: string): string => {
      const found = attributes.match(new RegExp(`${name}="([^"]*)"`, 'u'));
      return found ? found[1]! : '';
    };
    const node: ParsedNode = {
      text: read('text'),
      resourceId: read('resource-id'),
      className: read('class'),
      contentDesc: read('content-desc'),
      checkable: read('checkable') === 'true',
      checked: read('checked') === 'true',
      clickable: read('clickable') === 'true',
      focusable: read('focusable') === 'true',
      focused: read('focused') === 'true',
      bounds: read('bounds'),
      children: [],
    };
    const parent = stack.at(-1);
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}

function flatten(nodes: ParsedNode[]): ParsedNode[] {
  const out: ParsedNode[] = [];
  const walk = (node: ParsedNode): void => {
    out.push(node);
    for (const child of node.children) walk(child);
  };
  for (const node of nodes) walk(node);
  return out;
}

function descendantText(node: ParsedNode): string {
  const parts: string[] = [];
  const walk = (current: ParsedNode): void => {
    for (const child of current.children) {
      const value = (child.text || child.contentDesc).trim();
      if (value && !parts.includes(value)) parts.push(value);
      walk(child);
    }
  };
  walk(node);
  return parts.slice(0, 3).join(' ');
}

function describe(node: ParsedNode): string {
  const own = (node.text || node.contentDesc).trim();
  if (own) return own;
  const inherited = descendantText(node);
  if (inherited) return inherited;
  return node.resourceId.split('/').pop() || node.className.split('.').pop() || '';
}

function dumpTree(): ParsedNode[] {
  adb(['shell', 'rm', '-f', '/sdcard/kory-ui.xml']);
  require0(['shell', 'uiautomator', 'dump', '/sdcard/kory-ui.xml'], 'uiautomator dump', 60_000);
  const xml = require0(['shell', 'cat', '/sdcard/kory-ui.xml'], 'read ui dump', 60_000);
  return parseUiTree(xml);
}

function dumpNodes(): ParsedNode[] {
  return flatten(dumpTree());
}

function label(node: ParsedNode): string {
  return describe(node);
}

function focusSnapshot(nodes: ParsedNode[]): { label: string; role: string; focused: boolean } {
  const focused = nodes.find((node) => node.focused);
  if (!focused) return { label: '', role: '', focused: false };
  return {
    label: label(focused),
    role: /Switch/u.test(focused.className)
      ? 'switch'
      : /Button/u.test(focused.className)
        ? 'button'
        : focused.className.split('.').pop()!,
    focused: true,
  };
}

const sdk = Number(require0(['shell', 'getprop', 'ro.build.version.sdk'], 'sdk probe'));
const release = require0(['shell', 'getprop', 'ro.build.version.release'], 'release probe');
const model = require0(['shell', 'getprop', 'ro.product.model'], 'model probe');
const talkbackVersion = packageVersion('com.google.android.marvin.talkback');
const switchAccessVersion = packageVersion('com.google.android.accessibility.switchaccess');
if (!talkbackVersion) throw new Error('TalkBack is not installed on this device');
if (!switchAccessVersion) throw new Error('Switch Access is not installed on this device');

const accessibility = adb(['shell', 'dumpsys', 'accessibility']);
const talkbackEnabled =
  /com\.google\.android\.marvin\.talkback\/com\.google\.android\.marvin\.talkback\.TalkBackService/u.test(
    accessibility.stdout,
  );
const talkbackBound = /Bound services:\{[^}]*TalkBack/u.test(accessibility.stdout);
const switchAccessBound = /Bound services:\{[^}]*Switch/u.test(accessibility.stdout);
if (!talkbackEnabled || !talkbackBound) {
  throw new Error('TalkBack must be enabled and bound before recording a session');
}

const originalFontScale = require0(['shell', 'settings', 'get', 'system', 'font_scale'], 'font scale');
const originalScale = /^\d+(?:\.\d+)?$/u.test(originalFontScale) ? originalFontScale : '1.0';

require0(
  [
    'shell',
    'am',
    'start',
    '-a',
    'android.settings.APP_NOTIFICATION_SETTINGS',
    '--es',
    'android.provider.extra.APP_PACKAGE',
    'com.android.settings',
  ],
  'launch notification settings',
);
spawnSync('sleep', ['3']);

const initialNodes = dumpNodes();
if (!initialNodes.length) throw new Error('Notification settings produced no accessibility nodes');

const focusTraversal: Array<{ step: number; key: string; label: string; role: string }> = [];
let step = 0;
for (const key of ['TAB', 'TAB', 'TAB', 'DPAD_DOWN', 'DPAD_DOWN', 'DPAD_UP']) {
  adb(['shell', 'input', 'keyevent', key]);
  spawnSync('sleep', ['0.6']);
  step += 1;
  const snapshot = focusSnapshot(dumpNodes());
  focusTraversal.push({ step, key, label: snapshot.label, role: snapshot.role });
}

const toggles = initialNodes
  .filter((node) => node.checkable)
  .map((node) => ({
    label: label(node),
    checked: node.checked,
    role: /Switch/u.test(node.className) ? 'switch' : node.className.split('.').pop()!,
  }));

const actionable = initialNodes
  .filter((node) => node.clickable || node.checkable)
  .map((node) => label(node))
  .filter(Boolean);

const captureDir = join(dirname(outputPath), 'android-live-captures');
mkdirSync(captureDir, { recursive: true });

function capture(name: string): string {
  const target = join(captureDir, name);
  const result = spawnSync(adbPath, ['exec-out', 'screencap', '-p'], {
    timeout: 60_000,
    maxBuffer: 40 * 1024 * 1024,
  });
  if (result.status !== 0 || !result.stdout?.length) {
    throw new Error(`screenshot ${name} failed`);
  }
  writeFileSync(target, result.stdout);
  return target;
}

require0(['shell', 'settings', 'put', 'system', 'font_scale', '1.0'], 'reset font scale');
spawnSync('sleep', ['2']);
const defaultCapture = capture('notifications-default.png');
const defaultNodes = dumpNodes();

require0(['shell', 'settings', 'put', 'system', 'font_scale', '1.5'], 'set font scale 1.5');
spawnSync('sleep', ['2']);
const largeCapture = capture('notifications-large-text.png');
const largeNodes = dumpNodes();

function heightOf(nodes: UiNode[]): number {
  const settingsRow = nodes.find((node) => /notification/i.test(node.text) && node.bounds);
  if (!settingsRow) return 0;
  const match = settingsRow.bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/u);
  return match ? Number(match[4]) - Number(match[2]) : 0;
}

const defaultRowHeight = heightOf(defaultNodes);
const largeRowHeight = heightOf(largeNodes);

require0(['shell', 'settings', 'put', 'system', 'font_scale', originalScale], 'restore font scale');

const session = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  recordedBy: 'scripts/record-accessibility-verification-android-session.ts',
  device: { model, sdk, release },
  assistiveTechnology: {
    talkBack: `TalkBack ${talkbackVersion}`,
    talkBackPackage: 'com.google.android.marvin.talkback',
    switchAccess: `Switch Access ${switchAccessVersion}`,
    switchAccessPackage: 'com.google.android.accessibility.switchaccess',
    talkBackEnabled: talkbackEnabled,
    talkBackBound: talkbackBound,
    switchAccessBound: switchAccessBound,
  },
  screen: {
    package: 'com.android.settings',
    activity: 'android.settings.APP_NOTIFICATION_SETTINGS',
    locale: 'en-US',
  },
  nodeCount: initialNodes.length,
  toggles,
  actionable,
  focusTraversal,
  textScale: {
    defaultScale: '1.0',
    largeScale: '1.5',
    defaultRowHeight,
    largeRowHeight,
    grew: largeRowHeight > defaultRowHeight,
    captures: [defaultCapture.replace(projectRoot + '/', ''), largeCapture.replace(projectRoot + '/', '')],
  },
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
console.log(
  JSON.stringify({
    output: outputPath,
    device: session.device,
    talkBack: session.assistiveTechnology.talkBack,
    switchAccess: session.assistiveTechnology.switchAccess,
    nodes: session.nodeCount,
    toggles: session.toggles.length,
    focusStops: session.focusTraversal.filter((entry) => entry.label).length,
    textScaleGrew: session.textScale.grew,
  }),
);
