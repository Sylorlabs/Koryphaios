/**
 * Native Settings bouncer.
 *
 * Anything on this Mac whose name matches "Native Settings" is agent spam:
 * the desktop-runtime eval fixture (`backend/src/eval/skills/skill-eval-desktop-runtime.ts`)
 * renders a page titled "Native Settings", and an agent that runs it or builds
 * an app around it leaves a window, an .app bundle, or a scratch file behind.
 * This guard is the bouncer: it walks the process table and the usual spam
 * directories, and kills / deletes anything that answers to that name.
 *
 *   bun scripts/native-settings-bouncer.ts              # report only
 *   bun scripts/native-settings-bouncer.ts --kill       # actually kill + delete
 *   bun scripts/native-settings-bouncer.ts --kill --watch 15
 *
 * Never touches its own pid, and never looks inside this repo (the fixture there
 * is legitimate source, not spam).
 */

import { execFile } from 'node:child_process';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BANNED_INPUT_PATTERNS, bannedNameIn } from '../backend/src/security/banned-names';
import { canonicalizePath } from '../backend/src/runtime/platform';

const exec = promisify(execFile);

/**
 * The names come from `backend/src/security/banned-names.ts`, which is the
 * bouncer the agent tool pipeline runs. This script is the backstop for
 * anything that got in before the bouncer existed, or through a provider that
 * bypassed the tool pipeline entirely.
 */
export const BANNED_NAMES = BANNED_INPUT_PATTERNS.map((entry) => entry.label);

const args = process.argv.slice(2);
const KILL = args.includes('--kill');
/** Restart the Dock, but only when it is actually holding a banned tile. */
const RESTART_DOCK = args.includes('--dock');
const WATCH = (() => {
  const i = args.indexOf('--watch');
  if (i === -1) return 0;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : 15;
})();

/**
 * Directories agents actually spam. Kept shallow: depth-limited scans. The
 * Library entries are the ones that make a deleted app keep showing up —
 * LaunchAgents relaunch it, a saved application state restores its window, and
 * a preferences plist keeps its name in `defaults` and in Settings.
 *
 * The home is a parameter, not a module constant, so a test can point the sweep
 * at a throwaway directory instead of the machine it is running on.
 */
export function scanDirs(home: string = homedir()): string[] {
  const library = (...parts: string[]) => join(home, 'Library', ...parts);
  return [
    join(home, 'Applications'),
    join(home, 'Desktop'),
    join(home, 'Documents'),
    join(home, 'Downloads'),
    library('Application Support'),
    library('LaunchAgents'),
    library('LaunchDaemons'),
    library('Saved Application State'),
    library('Preferences'),
    '/Applications',
    '/tmp',
    '/private/tmp',
    '/private/var/tmp',
  ];
}

const LAUNCH_SERVICES_REGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

export function isBannedName(name: string): boolean {
  return bannedNameIn(name) !== null;
}

/** Our own tooling legitimately carries the name in its filename. */
const SELF_ALLOW = [/native-settings-bouncer/, /skill-eval-desktop-runtime/, /banned-names/];

export type Hit = { kind: 'process'; pid: number; detail: string } | { kind: 'file'; path: string };

/** README: an eval run and its output directory are not spam, so skip them. */
function inProtectedTree(path: string): boolean {
  const repo = process.cwd();
  return path.startsWith(repo + '/') && !path.includes('/outputs/') && !path.includes('/data/');
}

/** Self and every ancestor shell: signalling one of these kills the guard itself. */
async function protectedPids(): Promise<Set<number>> {
  const guarded = new Set<number>([process.pid]);
  let pid = process.pid;
  for (let i = 0; i < 32; i += 1) {
    try {
      const { stdout } = await exec('ps', ['-o', 'ppid=', '-p', String(pid)]);
      const parent = Number(stdout.trim());
      if (!Number.isFinite(parent) || parent <= 1 || guarded.has(parent)) break;
      guarded.add(parent);
      pid = parent;
    } catch {
      break;
    }
  }
  return guarded;
}

async function findProcesses(protectedSet: Set<number>): Promise<Hit[]> {
  const { stdout } = await exec('ps', ['-axo', 'pid=,command='], { maxBuffer: 8 * 1024 * 1024 });
  const hits: Hit[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [pidText, ...rest] = trimmed.split(/\s+/);
    const pid = Number(pidText);
    if (!Number.isFinite(pid) || protectedSet.has(pid)) continue;
    const command = rest.join(' ');
    if (!isBannedName(command) || SELF_ALLOW.some((re) => re.test(command))) continue;
    hits.push({ kind: 'process', pid, detail: command.slice(0, 160) });
  }
  return hits;
}

/** Depth-limited walk. Returns the topmost matching entry, never its children. */
function walk(dir: string, depth: number, out: Hit[]): void {
  if (depth < 0 || !existsSync(dir) || inProtectedTree(dir)) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (isBannedName(entry)) {
      out.push({ kind: 'file', path: full });
      continue;
    }
    if (depth === 0) continue;
    try {
      if (statSync(full).isDirectory()) walk(full, depth - 1, out);
    } catch {
      /* vanished or unreadable: nothing to bound */
    }
  }
}

export function findFiles(home: string = homedir()): Hit[] {
  const out: Hit[] = [];
  for (const dir of scanDirs(home)) walk(dir, 3, out);
  // `/tmp` is `/private/tmp` on macOS and a home may sit inside a scanned root,
  // so the same artifact is reachable by several spellings. Canonicalize and
  // keep one hit per real path, or the sweep reports (and deletes) it twice.
  const seen = new Set<string>();
  return out.filter((hit) => {
    if (hit.kind !== 'file') return true;
    const key = (() => {
      try {
        return canonicalizePath(hit.path);
      } catch {
        return hit.path;
      }
    })();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function signal(pid: number, sig: NodeJS.Signals): Promise<boolean> {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
}

/**
 * Deleting an .app is not enough: LaunchServices keeps the registration, so the
 * name survives in Spotlight, “Open With”, recent items and the Dock. Deregister
 * is what makes the app stop existing as far as macOS is concerned.
 */
async function deregisterAppBundle(path: string): Promise<string | null> {
  if (!path.endsWith('.app') || !existsSync(LAUNCH_SERVICES_REGISTER)) return null;
  try {
    await exec(LAUNCH_SERVICES_REGISTER, ['-u', path], { maxBuffer: 4 * 1024 * 1024 });
    return 'LaunchServices registration dropped';
  } catch (error) {
    const message = (error as Error).message;
    // Never registered (kLSApplicationNotFoundErr) is the normal case for a
    // freshly written fixture, and is not a failure worth reporting.
    if (/-10814|failed to scan/u.test(message)) return null;
    return `LaunchServices deregistration failed: ${message.split('\n')[0]}`;
  }
}

/** A LaunchAgent would relaunch the app after deletion, so unload it first. */
async function bootoutLaunchAgent(path: string): Promise<string | null> {
  if (!path.endsWith('.plist')) return null;
  if (!path.includes('/LaunchAgents/') && !path.includes('/LaunchDaemons/')) return null;
  const domain = path.includes('/LaunchAgents/') ? `gui/${process.getuid?.() ?? 501}` : 'system';
  try {
    await exec('launchctl', ['bootout', domain, path]);
    return 'launchd job unloaded';
  } catch {
    // Not loaded is the normal case and not a failure.
    return null;
  }
}

/** Dock tiles are plist state, not files: report them, restart only on request. */
async function dockEntries(): Promise<number> {
  if (process.platform !== 'darwin') return 0;
  try {
    const { stdout } = await exec('defaults', ['read', 'com.apple.dock', 'persistent-apps'], {
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.split('\n').filter((line) => isBannedName(line)).length;
  } catch {
    return 0;
  }
}

async function restartDock(): Promise<void> {
  try {
    await exec('killall', ['Dock']);
    console.log('dock: restarted, stale tiles dropped');
  } catch {
    /* the Dock restarts itself; a failure here is cosmetic */
  }
}

export interface SweepOptions {
  /** Home directory to scan. Defaults to the real one. */
  home?: string;
}

async function sweep(options: SweepOptions = {}): Promise<number> {
  const hits = [
    ...(await findProcesses(await protectedPids())),
    ...findFiles(options.home ?? homedir()),
  ];
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);

  if (hits.length === 0) {
    if (!WATCH) console.log(`[${stamp}] bouncer: clean`);
    return 0;
  }

  for (const hit of hits) {
    const label = hit.kind === 'process' ? `pid ${hit.pid} — ${hit.detail}` : hit.path;
    if (!KILL) {
      console.log(`[${stamp}] would block: ${label}`);
      continue;
    }
    if (hit.kind === 'process') {
      const term = await signal(hit.pid, 'SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
      const force = await signal(hit.pid, 'SIGKILL');
      if (term || force) console.log(`[${stamp}] killed: ${label}`);
      continue;
    }
    const latest = await bootoutLaunchAgent(hit.path);
    const deregistered = await deregisterAppBundle(hit.path);
    try {
      rmSync(hit.path, { recursive: true, force: true });
      const notes = [latest, deregistered].filter(Boolean).join('; ');
      console.log(`[${stamp}] deleted: ${label}${notes ? ` (${notes})` : ''}`);
    } catch (error) {
      console.log(`[${stamp}] failed to delete ${label}: ${(error as Error).message}`);
    }
  }
  if (!KILL) console.log(`[${stamp}] ${hits.length} hit(s) — rerun with --kill to block them`);
  return hits.length;
}

/** Report (and optionally clear) the Dock tile a deleted app leaves behind. */
async function sweepDock(): Promise<void> {
  const tiles = await dockEntries();
  if (tiles === 0) return;
  if (!KILL) {
    console.log(`would clear: ${tiles} Dock tile(s) named "Native Settings" (add --kill)`);
    return;
  }
  if (!RESTART_DOCK) {
    console.log(
      `dock: ${tiles} tile(s) still hold the name; rerun with --dock to restart the Dock and drop them`,
    );
    return;
  }
  await restartDock();
}

if (import.meta.main) {
  const run = async () => {
    await sweep();
    await sweepDock();
  };
  await run();
  if (WATCH > 0) {
    console.log(`bouncer: watching every ${WATCH}s — anything named "Native Settings" dies`);
    setInterval(() => void run(), WATCH * 1000);
  }
}
