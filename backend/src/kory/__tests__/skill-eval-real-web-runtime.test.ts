import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { chromium } from 'playwright';
import { shouldSkipBrowserControl } from './browser-runtime-test-policy';
import {
  browserRuntimePackageCache,
  chromiumBlockers,
  chromiumLaunchOptions,
  pinnedBrowserPackage,
  pinnedPackageBlockers,
  withRealChromium,
} from '../../eval/skills/skill-eval-real-web-runtime';

const originalCache = process.env.BUN_INSTALL_CACHE_DIR;
const roots: string[] = [];
afterEach(() => {
  if (originalCache === undefined) delete process.env.BUN_INSTALL_CACHE_DIR;
  else process.env.BUN_INSTALL_CACHE_DIR = originalCache;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function cache(): string {
  const root = mkdtempSync(join(tmpdir(), 'kory-browser-cache-test-'));
  roots.push(root);
  process.env.BUN_INSTALL_CACHE_DIR = root;
  return root;
}

// Locator-only metadata, never used as runtime or browser qualification evidence.
function manifest(
  root: string,
  name: string,
  version: string,
  contents = { name, version },
): string {
  const directory = join(root, `${name}@${version}@@@1`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify(contents));
  return directory;
}

test('browser package lookup uses the explicit cache without replacing isolated HOME', () => {
  const home = homedir();
  const root = cache();
  const specs = [
    ['react', '19.2.8'],
    ['vue', '3.5.30'],
    ['next', '15.5.12'],
  ] as const;
  for (const [name, version] of specs) {
    const directory = manifest(root, name, version);
    expect(pinnedBrowserPackage(name, version)).toBe(directory);
  }
  expect(pinnedPackageBlockers(specs)).toEqual([]);
  expect(homedir()).toBe(home);
});

test('an explicit missing cache fails closed instead of falling back to another cache', () => {
  const populated = cache();
  manifest(populated, 'react', '19.2.8');
  expect(pinnedPackageBlockers([['react', '19.2.8']])).toEqual([]);
  const empty = cache();
  expect(pinnedPackageBlockers([['react', '19.2.8']])).toEqual([
    `Missing pinned react@19.2.8 Bun runtime cache at ${join(empty, 'react@19.2.8@@@1')}`,
  ]);
  expect(() => pinnedBrowserPackage('react', '19.2.8')).toThrow('Missing pinned react@19.2.8');
});

test('readiness and copying both reject wrong package identity and changed versions', () => {
  const root = cache();
  manifest(root, 'react', '19.2.8', { name: 'not-react', version: '19.2.8' });
  expect(pinnedPackageBlockers([['react', '19.2.8']])[0]).toContain('manifest mismatch');
  manifest(root, 'react', '19.2.8');
  expect(pinnedBrowserPackage('react', '19.2.8')).toBe(join(root, 'react@19.2.8@@@1'));
  manifest(root, 'react', '19.2.8', { name: 'react', version: '19.2.7' });
  expect(() => pinnedBrowserPackage('react', '19.2.8')).toThrow('manifest mismatch');
});

test('relative cache selection is resolved before changing to a temporary fixture cwd', () => {
  const root = cache();
  process.env.BUN_INSTALL_CACHE_DIR = relative(process.cwd(), root);
  expect(browserRuntimePackageCache()).toBe(resolve(root));
});

test('without an explicit cache only the current HOME cache is selected', () => {
  delete process.env.BUN_INSTALL_CACHE_DIR;
  expect(browserRuntimePackageCache()).toBe(join(homedir(), '.bun', 'install', 'cache'));
});

test('only unprovisioned real-browser controls skip missing assets', () => {
  const blockers = ['Missing selected browser or package asset'];
  expect(shouldSkipBrowserControl(blockers, {})).toBe(true);
  expect(shouldSkipBrowserControl([], {})).toBe(false);
  for (const name of ['BUN_INSTALL_CACHE_DIR', 'PLAYWRIGHT_BROWSERS_PATH']) {
    expect(shouldSkipBrowserControl(blockers, { [name]: '/explicit/assets' })).toBe(false);
    // Invalid explicit selections must fail, not silently become an automatic skip.
    expect(shouldSkipBrowserControl(blockers, { [name]: '' })).toBe(false);
  }
  expect(
    shouldSkipBrowserControl(blockers, {
      BUN_INSTALL_CACHE_DIR: '/explicit/cache',
      PLAYWRIGHT_BROWSERS_PATH: '/explicit/browsers',
    }),
  ).toBe(false);
});

test('Chromium readiness and launch use the identical selected executable without fallback', async () => {
  const root = cache();
  const executable = join(root, 'selected-chromium');
  const path = spyOn(chromium, 'executablePath').mockReturnValue(executable);
  const launch = spyOn(chromium, 'launch').mockRejectedValue(
    new Error('Selected executable cannot launch'),
  );
  try {
    expect(chromiumBlockers()).toEqual([
      `Real Playwright Chromium is unavailable at ${executable}`,
    ]);
    // Locator-only fixture. Launch stays mocked and no runtime evidence is credited.
    writeFileSync(executable, 'locator only');
    expect(chromiumBlockers()).toEqual([]);
    expect(chromiumLaunchOptions()).toEqual({ executablePath: executable, headless: true });
    await expect(
      withRealChromium(async () => {
        throw new Error('Unexpected browser callback');
      }),
    ).rejects.toThrow('Selected executable cannot launch');
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]?.[0]).toEqual({
      executablePath: executable,
      headless: true,
      timeout: 30_000,
    });
  } finally {
    launch.mockRestore();
    path.mockRestore();
  }
});
