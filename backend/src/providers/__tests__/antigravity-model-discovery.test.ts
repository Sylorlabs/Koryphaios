import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { AntigravityProvider } from '../antigravity';
import { fetchAntigravityQuotaGroups } from '../antigravity-quota';
import {
  antigravityProbeAuthBlocked,
  antigravityProbeEnv,
  getKoryphaiosAntigravityHome,
  hasAntigravityPortableLogin,
  markAntigravityProbeAuthBlocked,
} from '../cli-bridges';

const ISOLATED_HOME_MARKER = '.koryphaios/antigravity-home';

function fakeAgy(dir: string, body: string): void {
  const bin = join(dir, 'agy');
  writeFileSync(bin, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(bin, 0o755);
}

describe('Antigravity model discovery environment', () => {
  let workdir: string;
  let hostHome: string;
  let originalPath: string | undefined;
  let originalHome: string | undefined;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'agy-discovery-'));
    originalPath = process.env.PATH;
    originalHome = process.env.HOME;
    // Passive discovery requires login material in the home the probe reads —
    // the REAL home, the same files the CLI itself sees. Staging it in this
    // fake host home proves the gate never consults the Kory-managed turn home
    // or the ambient shell.
    hostHome = mkdtempSync(join(tmpdir(), 'agy-host-home-'));
    process.env.HOME = hostHome;
    const staged = join(hostHome, '.gemini', 'antigravity-cli');
    mkdirSync(staged, { recursive: true });
    writeFileSync(join(staged, 'antigravity-oauth-token'), '{}');
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(workdir, { recursive: true, force: true });
    rmSync(hostHome, { recursive: true, force: true });
  });

  it('serves a cold catalog without blocking and coalesces failed discovery', async () => {
    const attempts = join(workdir, 'attempts');
    fakeAgy(
      workdir,
      `if [ "$1" = "models" ]; then printf 'probe\\n' >> "${attempts}"; /bin/sleep 0.3; exit 1; fi\nprintf '{}\\n'`,
    );
    process.env.PATH = `${workdir}:${originalPath ?? ''}`;
    const provider = new AntigravityProvider({
      name: 'antigravity',
      authToken: 'cli-login',
    } as never);
    let settled = false;
    const refresh = provider.refreshModels().then((models) => {
      settled = true;
      return models;
    });
    expect(provider.listModels()).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(await refresh).toEqual([]);
    provider.listModels();
    provider.isAvailable();
    provider.getQuota();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(readFileSync(attempts, 'utf8')).toBe('probe\n');

    // An explicit refresh must bypass the negative-cache cooldown rather than
    // silently returning the previous failed result.
    await provider.refreshModels();
    expect(readFileSync(attempts, 'utf8')).toBe('probe\nprobe\n');
  });

  it('probes `agy models` under the real HOME so the CLI resolves its own credentials', async () => {
    // agy resolves its OAuth credential through the *real* home (macOS login
    // keychain / real ~/.gemini). A managed HOME makes it report "Please sign
    // in" and `agy --print` enters the OAuth flow that pops a browser — the
    // probe must therefore run with HOME = the user's home, exactly like a
    // terminal `agy models`.
    const managedHome = getKoryphaiosAntigravityHome();
    fakeAgy(
      workdir,
      'if [ "$HOME" = "' +
        hostHome +
        '" ]; then printf "gemini-3.8-flash-high\\tGemini 3.8 Flash (High)\\n"; elif [ "$HOME" = "' +
        managedHome +
        '" ]; then printf "managed-home-would-sign-in\\n" >&2; exit 1; else printf "other-home\\n" >&2; exit 1; fi',
    );
    process.env.PATH = `${workdir}:${originalPath ?? ''}`;

    const provider = new AntigravityProvider({
      name: 'antigravity',
      baseUrl: '',
      authToken: 'cli-login',
    } as never);

    const models = await provider.refreshModels();
    const ids = models.map((m) => m.apiModelId);
    expect(ids).toContain('gemini-3.8-flash-high');
  });

  it('requires a staged portable login before any passive probe', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agy-gate-'));
    try {
      expect(hasAntigravityPortableLogin(home)).toBe(false);
      mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true });
      writeFileSync(join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), '{}');
      expect(hasAntigravityPortableLogin(home)).toBe(true);
      // Pins the managed-home env, which is what keeps agy off the host keychain.
      expect(antigravityProbeEnv(home).HOME).toBe(home);
      expect(antigravityProbeEnv(home).GEMINI_DIR).toBe(join(home, '.gemini'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('never spawns agy for quota when no portable login is staged', async () => {
    const attempts = join(workdir, 'quota-attempts');
    fakeAgy(
      workdir,
      `if [ "$1" = "--print" ]; then printf 'spawned\\n' >> "${attempts}"; fi\nprintf '{}\\n'`,
    );
    process.env.PATH = `${workdir}:${originalPath ?? ''}`;
    const emptyHome = mkdtempSync(join(tmpdir(), 'agy-empty-home-'));
    try {
      expect(await fetchAntigravityQuotaGroups({ home: emptyHome })).toBeNull();
      expect(existsSync(attempts)).toBe(false);
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  it('does not launch discovery under the isolated per-turn HOME', () => {
    // Guards the specific regression: the isolated home must never be handed to
    // the read-only discovery probe.
    const isolated = getKoryphaiosAntigravityHome();
    expect(isolated).toContain(ISOLATED_HOME_MARKER);
    expect(isolated).not.toBe(homedir());
  });

  it('pins the probe PATH to a private dir with no browser openers', () => {
    // A credential-less agy execs `open`/`xdg-open`/`rundll32` through PATH to
    // start its OAuth flow — from a background poll. The probe env must carry
    // a PATH where none of those resolve, or the poll pops a browser window.
    const env = antigravityProbeEnv(hostHome);
    expect(env.PATH).toBe(join(getKoryphaiosAntigravityHome(), '.probe-bin'));
    expect(existsSync(join(env.PATH as string, 'open'))).toBe(false);
    expect(existsSync(join(env.PATH as string, 'xdg-open'))).toBe(false);
    // And the probe's HOME is the caller-supplied (real) home, not managed.
    expect(env.HOME).toBe(hostHome);
  });

  it('latches probe-auth failures until the credential set changes', () => {
    const home = mkdtempSync(join(tmpdir(), 'agy-latch-'));
    try {
      const staged = join(home, '.gemini', 'antigravity-cli');
      mkdirSync(staged, { recursive: true });
      writeFileSync(join(staged, 'antigravity-oauth-token'), '{}');
      expect(antigravityProbeAuthBlocked(home)).toBe(false);
      markAntigravityProbeAuthBlocked(home);
      expect(antigravityProbeAuthBlocked(home)).toBe(true);
      // A fresh `agy login` rewrites the staged markers — the latch releases.
      writeFileSync(join(home, '.gemini', 'oauth_creds.json'), '{"ok":true}');
      expect(antigravityProbeAuthBlocked(home)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
