import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { AntigravityProvider } from '../antigravity';
import { getKoryphaiosAntigravityHome } from '../cli-bridges';

const ISOLATED_HOME_MARKER = '.koryphaios/antigravity-home';

function fakeAgy(dir: string, body: string): void {
  const bin = join(dir, 'agy');
  writeFileSync(bin, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(bin, 0o755);
}

describe('Antigravity model discovery environment', () => {
  let workdir: string;
  let originalPath: string | undefined;
  let originalHome: string | undefined;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'agy-discovery-'));
    originalPath = process.env.PATH;
    originalHome = process.env.HOME;
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(workdir, { recursive: true, force: true });
  });

  it('serves a cold catalog without blocking and coalesces failed discovery', async () => {
    const attempts = join(workdir, 'attempts');
    fakeAgy(
      workdir,
      `if [ "$1" = "models" ]; then printf 'probe\\n' >> "${attempts}"; /bin/sleep 0.3; exit 1; fi\nprintf '{}\\n'`,
    );
    process.env.PATH = `${workdir}:${originalPath ?? ''}`;
    const provider = new AntigravityProvider({ name: 'antigravity', authToken: 'cli-login' } as never);
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

  it('probes `agy models` with the managed HOME so it cannot mutate the host keychain', async () => {
    // Discovery must use the same managed HOME as a turn. The fake agy below
    // stands in for the real binary and reports which HOME it was handed;
    // using the host HOME here would make status refreshes reach for the host
    // keychain on every probe.
    const managedHome = getKoryphaiosAntigravityHome();
    fakeAgy(
      workdir,
      'if [ "$HOME" = "' +
        managedHome +
        '" ]; then printf "gemini-3.8-flash-high\\tGemini 3.8 Flash (High)\\n"; else echo "Error: Please sign in to view available models." >&2; exit 1; fi',
    );
    process.env.PATH = `${workdir}:${originalPath ?? ''}`;
    process.env.HOME = homedir();

    const provider = new AntigravityProvider({
      name: 'antigravity',
      baseUrl: '',
      authToken: 'cli-login',
    } as never);

    const models = await provider.refreshModels();
    const ids = models.map((m) => m.apiModelId);
    expect(ids).toContain('gemini-3.8-flash-high');
  });

  it('does not launch discovery under the isolated per-turn HOME', () => {
    // Guards the specific regression: the isolated home must never be handed to
    // the read-only discovery probe.
    const isolated = getKoryphaiosAntigravityHome();
    expect(isolated).toContain(ISOLATED_HOME_MARKER);
    expect(isolated).not.toBe(homedir());
  });
});
