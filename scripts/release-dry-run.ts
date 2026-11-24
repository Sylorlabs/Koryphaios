#!/usr/bin/env bun
/**
 * Local dry-run of the release trigger, mirroring the logic in
 * `.github/workflows/auto-release.yml` so a `/update` can be rehearsed without
 * creating a tag or dispatching anything.
 *
 * This is a rehearsal, not the workflow. It answers one question: if I pushed a
 * commit containing `/update`, would CI create a release, and from what bytes?
 * The real workflow additionally requires a successful `build-shell.yml` run
 * whose shell-relevant source matches the commit, which this cannot check.
 *
 * Usage:
 *   bun run release:dry-run
 *   bun run release:dry-run -- --version 0.6.0
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
const versionFlagIndex = args.indexOf('--version');
const REQUESTED = versionFlagIndex >= 0 ? (args[versionFlagIndex + 1] ?? '').replace(/^v/, '') : '';

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};

const log = (m: string, c = colors.reset) => console.log(`${c}${m}${colors.reset}`);
const ok = (m: string) => log(`  ok    ${m}`, colors.green);
const warn = (m: string) => log(`  warn  ${m}`, colors.yellow);
const bad = (m: string) => log(`  FAIL  ${m}`, colors.red);

function git(...gitArgs: string[]): string {
  return execFileSync('git', gitArgs, { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim();
}

function gitOrNull(...gitArgs: string[]): string | null {
  try {
    return execFileSync('git', gitArgs, {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function resolveComparisonRef(): string {
  const upstream = gitOrNull('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');
  if (upstream) return upstream;
  for (const candidate of ['origin/master', 'origin/main']) {
    if (gitOrNull('rev-parse', '--verify', candidate)) return candidate;
  }
  return 'HEAD';
}

function readJson(rel: string): Record<string, unknown> | null {
  const p = join(PROJECT_ROOT, rel);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The workflow validates exactly these surfaces (auto-release.yml:70-98). */
function collectVersionSurfaces(): Array<{ file: string; version: string | null }> {
  const out: Array<{ file: string; version: string | null }> = [];

  const conf = readJson('desktop/src-tauri/tauri.conf.json');
  out.push({
    file: 'desktop/src-tauri/tauri.conf.json',
    version: (conf?.version as string) ?? null,
  });

  for (const pkg of [
    'package.json',
    'desktop/package.json',
    'backend/package.json',
    'frontend/package.json',
    'shared/package.json',
    'mcp-server/package.json',
  ]) {
    if (!existsSync(join(PROJECT_ROOT, pkg))) continue;
    const j = readJson(pkg);
    out.push({ file: pkg, version: (j?.version as string) ?? null });
  }

  // Cargo.toml has no JSON; parse the [package] version the same way CI's awk does.
  const cargoPath = join(PROJECT_ROOT, 'desktop/src-tauri/Cargo.toml');
  if (existsSync(cargoPath)) {
    const cargo = readFileSync(cargoPath, 'utf-8');
    const m = cargo.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m);
    out.push({ file: 'desktop/src-tauri/Cargo.toml', version: m?.[1] ?? null });
  }

  for (const appConfig of ['frontend/static/app.config.json', 'config/app.config.json']) {
    if (!existsSync(join(PROJECT_ROOT, appConfig))) continue;
    const j = readJson(appConfig);
    out.push({ file: appConfig, version: (j?.app as { version?: string })?.version ?? null });
  }

  return out;
}

console.log(
  `${colors.bold}Release dry-run${colors.reset} ${colors.dim}(no tag, no dispatch)${colors.reset}\n`,
);

// ── 1. Would the /update trigger even fire? ────────────────────────────────────
log('1. Trigger', colors.bold);
const headMsg = git('log', '-1', '--format=%B');
const triggerByMessage = headMsg.includes('/update');
log(`   HEAD: ${git('log', '-1', '--format=%h %s')}`);
if (triggerByMessage) ok('HEAD commit message contains "/update"');
else warn('HEAD has no "/update" — push it to trigger, or use the Prepare Release dispatch');
log('');

// ── 2. Version alignment ──────────────────────────────────────────────────────
log('2. Version alignment', colors.bold);
const surfaces = collectVersionSurfaces();
const tauriVersion =
  surfaces.find((s) => s.file === 'desktop/src-tauri/tauri.conf.json')?.version ?? null;
let aligned = true;

if (!tauriVersion) {
  bad('could not read desktop/src-tauri/tauri.conf.json version');
  aligned = false;
} else if (!/^\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$/.test(tauriVersion)) {
  bad(`tauri.conf.json version is not semver: ${tauriVersion}`);
  aligned = false;
} else {
  ok(`prepared version ${tauriVersion}`);
}

if (REQUESTED && REQUESTED !== tauriVersion) {
  bad(`requested ${REQUESTED} != prepared ${tauriVersion}`);
  aligned = false;
} else if (REQUESTED) {
  ok(`requested version matches (${REQUESTED})`);
}

for (const s of surfaces) {
  if (s.version === tauriVersion) ok(`${s.file} = ${s.version}`);
  else {
    bad(`${s.file} = ${s.version ?? '(missing)'} (expected ${tauriVersion})`);
    aligned = false;
  }
}
log('');

// ── 3. Tag immutability ────────────────────────────────────────────────────────
log('3. Tag', colors.bold);
const tag = tauriVersion ? `v${tauriVersion}` : null;
if (tag) {
  const exists = gitOrNull('ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${tag}`);
  if (exists === null) ok(`${tag} does not exist yet — safe to create`);
  else bad(`${tag} already exists — releases are immutable, bump the version first`);
}
log('');

// ── 4. Would CI even see this commit? ─────────────────────────────────────────
log('4. Pushed state', colors.bold);
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
const comparisonRef = resolveComparisonRef();
let ahead = 0;
let pushedKnown = false;
if (comparisonRef === 'HEAD') {
  warn('no origin branch is available; cannot check pushed state');
} else {
  const counts = git('rev-list', '--left-right', '--count', `HEAD...${comparisonRef}`);
  const [aheadCount, behindCount] = counts.split(/\s+/).map(Number);
  ahead = aheadCount;
  pushedKnown = true;
  if (ahead > 0) ok(`${ahead} commit(s) ahead of ${comparisonRef}`);
  else bad(`nothing to push — HEAD is not ahead of ${comparisonRef}`);
  if (behindCount > 0) warn(`${behindCount} commit(s) behind ${comparisonRef}`);
  if (comparisonRef !== `origin/${branch}`) {
    warn(`current branch has no upstream; comparing against ${comparisonRef}`);
  }
}

const dirty = git('status', '--porcelain');
if (dirty) {
  const n = dirty.split('\n').filter(Boolean).length;
  bad(`working tree has ${n} uncommitted change(s) — CI would build without them`);
} else {
  ok('working tree is clean');
}
log('');

// ── 5. CI and shell-build provenance (cannot be checked locally) ───────────────
log('5. CI and shell-build provenance', colors.bold);
const SHELL_PATHS = [
  'desktop/src-tauri/Cargo.toml',
  'desktop/src-tauri/Cargo.lock',
  'desktop/src-tauri/src',
  'desktop/src-tauri/build.rs',
  'desktop/src-tauri/tauri.conf.json',
  'desktop/src-tauri/icons',
  '.github/workflows/build-shell.yml',
];
const unpushed =
  comparisonRef === 'HEAD'
    ? ''
    : (gitOrNull('diff', '--name-only', `${comparisonRef}..HEAD`) ?? '');
const touched = SHELL_PATHS.filter((p) => unpushed.split('\n').includes(p));
if (touched.length > 0) {
  warn(`shell-relevant source changed in these commits: ${touched.join(', ')}`);
  warn('CI will require a fresh successful build-shell.yml run before tagging');
} else {
  ok('no shell-relevant source changed — an existing build-shell run stays valid');
}
warn('CI success is checked by the workflow for the exact commit');
log('');

// ── 6. Signer availability ─────────────────────────────────────────────────────
log('6. Signing', colors.bold);
const confText = readFileSync(join(PROJECT_ROOT, 'desktop/src-tauri/tauri.conf.json'), 'utf-8');
const pubkeyMatch = confText.match(/"pubkey"\s*:\s*"([^"]+)"/);
if (!pubkeyMatch) bad('no updater pubkey in tauri.conf.json — the updater cannot verify anything');
else {
  try {
    const decoded = Buffer.from(pubkeyMatch[1], 'base64').toString();
    if (decoded.includes('minisign public key'))
      ok('updater pubkey is a valid minisign public key');
    else bad('updater pubkey is not a minisign public key');
  } catch {
    bad('updater pubkey is not valid base64');
  }
}
if (process.env.TAURI_SIGNING_PRIVATE_KEY) ok('TAURI_SIGNING_PRIVATE_KEY is set in this shell');
else warn('TAURI_SIGNING_PRIVATE_KEY is not set here (CI holds it as a repo secret)');
log('');

// ── Verdict ────────────────────────────────────────────────────────────────────
const blockers: string[] = [];
if (!aligned) blockers.push('version alignment failed');
if (dirty) blockers.push('working tree is dirty');
if (pushedKnown && ahead === 0)
  blockers.push(`nothing to push — HEAD is not ahead of ${comparisonRef}`);

console.log(`${colors.bold}Verdict${colors.reset}`);
if (blockers.length === 0) {
  log(`  A /update push of ${tag} would start the release pipeline.`, colors.green);
  log(
    `  ${colors.dim}It would still wait for a successful ci.yml run and a matching build-shell.yml run.${colors.reset}`,
    colors.dim,
  );
} else {
  log(`  Not ready to release:`, colors.red);
  for (const b of blockers) log(`    - ${b}`, colors.red);
  process.exitCode = 1;
}
log('');
