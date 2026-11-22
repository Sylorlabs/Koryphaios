import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium, type Browser } from 'playwright';
import type { SkillEvalDeterministicScore } from './skill-eval-execution';
import { fixtureTextEquals } from './skill-eval-fixture-helpers';

const execFileAsync = promisify(execFile);

export interface RuntimeCheck {
  name: string;
  passed: boolean;
  detail: string;
  browser: boolean;
}

export function recordCheck(
  checks: RuntimeCheck[],
  name: string,
  passed: boolean,
  detail: unknown,
  browser = true,
): void {
  checks.push({ name, passed, detail: String(detail), browser });
}

export async function tryCheck(
  checks: RuntimeCheck[],
  name: string,
  callback: () => Promise<[boolean, string]>,
): Promise<void> {
  try {
    const [passed, detail] = await callback();
    recordCheck(checks, name, passed, detail);
  } catch (error) {
    recordCheck(checks, name, false, error instanceof Error ? error.message.slice(0, 600) : error);
  }
}

export function finishChecks(
  checks: RuntimeCheck[],
  integrityFailure = false,
): SkillEvalDeterministicScore {
  const browser = checks.filter((check) => check.browser);
  return {
    passed: checks.length > 0 && checks.every((check) => check.passed) && !integrityFailure,
    quality: checks.length ? checks.filter((check) => check.passed).length / checks.length : 0,
    verification: browser.length
      ? browser.filter((check) => check.passed).length / browser.length
      : 0,
    integrityFailure,
    evidence: checks.map(
      (check) => `${check.name}: ${check.passed ? 'pass' : 'fail'} — ${check.detail}`,
    ),
  };
}

/** Resolve assets separately from HOME: isolated runners may expose only a
 * credential-free package cache. Never recover a host HOME or ignore an explicit
 * cache selection. Resolve relative paths before a fixture changes subprocess cwd. */
export function browserRuntimePackageCache(): string {
  const configured = process.env.BUN_INSTALL_CACHE_DIR?.trim();
  return configured ? resolve(configured) : join(homedir(), '.bun', 'install', 'cache');
}

export function pinnedBrowserPackage(name: string, version: string): string {
  const location = join(browserRuntimePackageCache(), `${name}@${version}@@@1`);
  let manifest: { name?: string; version?: string } | null;
  try {
    manifest = JSON.parse(readFileSync(join(location, 'package.json'), 'utf8'));
  } catch {
    throw new Error(`Missing pinned ${name}@${version} Bun runtime cache at ${location}`);
  }
  if (manifest?.name !== name || manifest.version !== version) {
    throw new Error(`Pinned ${name}@${version} cache manifest mismatch at ${location}`);
  }
  return location;
}

export function pinnedPackageBlockers(specs: readonly (readonly [string, string])[]): string[] {
  return specs.flatMap(([name, version]) => {
    try {
      pinnedBrowserPackage(name, version);
      return [];
    } catch (error) {
      return [error instanceof Error ? error.message : String(error)];
    }
  });
}

/** Pin launches to the same Playwright-managed binary that readiness checks.
 * A default headless launch otherwise selects a separate headless-shell asset.
 * No system browser or host-profile fallback is allowed here. */
export function chromiumLaunchOptions() {
  return { executablePath: chromium.executablePath(), headless: true } as const;
}

export function chromiumBlockers(): string[] {
  const { executablePath } = chromiumLaunchOptions();
  return existsSync(executablePath)
    ? []
    : [`Real Playwright Chromium is unavailable at ${executablePath}`];
}

/** A scorer must not copy agent-created links, device files or unbounded source into its runtime. */
export function safeCandidateTree(root: string, directories: readonly string[]): boolean {
  let inspected = 0;
  const visit = (path: string, depth: number): boolean => {
    if (depth > 12) return false;
    for (const name of readdirSync(path)) {
      if (++inspected > 500) return false;
      const candidate = join(path, name);
      const stat = lstatSync(candidate);
      if (stat.isDirectory()) {
        if (!visit(candidate, depth + 1)) return false;
      } else if (!stat.isFile() || stat.size > 2_000_000) return false;
    }
    return true;
  };
  try {
    return directories.every((directory) => visit(join(root, directory), 0));
  } catch {
    return false;
  }
}

export function fixedFilesUnmodified(root: string, expected: Record<string, string>): boolean {
  return Object.entries(expected).every(([path, text]) => fixtureTextEquals(root, path, text));
}

export async function runBounded(
  command: string,
  args: string[],
  cwd: string,
  timeout = 90_000,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      env,
      timeout,
      maxBuffer: 3_000_000,
    });
    return `${stdout}\n${stderr}`;
  } catch (error) {
    const failed = error as Error & { stdout?: string; stderr?: string };
    throw new Error(
      `${command} ${args.join(' ')} failed: ${failed.message}; ${failed.stderr ?? ''} ${failed.stdout ?? ''}`.slice(
        0,
        1_500,
      ),
    );
  }
}

export async function installPinnedOffline(root: string): Promise<void> {
  await runBounded('bun', ['install', '--offline', '--ignore-scripts', '--no-save'], root, 45_000, {
    ...process.env,
    BUN_INSTALL_CACHE_DIR: browserRuntimePackageCache(),
  });
}

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;
let users = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

export async function withRealChromium<T>(callback: (instance: Browser) => Promise<T>): Promise<T> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (!browser?.isConnected()) {
    if (!launching) launching = chromium.launch({ ...chromiumLaunchOptions(), timeout: 30_000 });
    try {
      browser = await launching;
    } finally {
      launching = null;
    }
  }
  users += 1;
  try {
    return await callback(browser!);
  } finally {
    users -= 1;
    if (users === 0) {
      idleTimer = setTimeout(() => {
        const closing = browser;
        browser = null;
        idleTimer = null;
        void closing?.close().catch(() => undefined);
      }, 5_000);
    }
  }
}
