import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('probes `agy models` with the real HOME so the OS keychain login resolves', async () => {
    // agy stores its Google OAuth token in the OS credential store (macOS login
    // keychain, libsecret elsewhere). The Security framework resolves the login
    // keychain from the user's home directory, so a discovery probe launched
    // with Koryphaios's isolated HOME finds no keychain, agy answers
    // "Please sign in to view available models", and the provider ends up
    // "Connected" with an empty catalog. The fake agy below stands in for the
    // real binary and reports which HOME it was handed.
    fakeAgy(
      workdir,
      'if [ "$HOME" = "' +
        homedir() +
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
