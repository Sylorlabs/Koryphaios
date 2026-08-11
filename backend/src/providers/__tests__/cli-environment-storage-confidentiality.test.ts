import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildProviderCliEnv,
  PROVIDER_CLI_SECRET_KEYS_FOR_TESTING,
  type NativeCliProvider,
} from '../cli-environment';
import { CodexAppServer, CODEX_APP_SERVER_MAX_FRAME_BYTES_FOR_TESTING } from '../codex-app-server';
import {
  ensureManagedCliDirectory,
  healManagedCliFile,
  writeManagedCliFile,
} from '../managed-cli-storage';
import { writeAllCliRulesAndSkills } from '../cli-rules-skills';

const PROVIDERS = Object.keys(PROVIDER_CLI_SECRET_KEYS_FOR_TESTING) as NativeCliProvider[];

const CONFIG_KEYS: Record<NativeCliProvider, string> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  cline: 'CLINE_HOME',
  cursor: 'CURSOR_CONFIG_DIR',
  devin: 'DEVIN_CONFIG_DIR',
  antigravity: 'HOME',
  grok: 'GROK_HOME',
};

function mode(path: string): number {
  return lstatSync(path).mode & 0o777;
}

function assertPrivateTree(path: string): void {
  const metadata = lstatSync(path);
  if (process.platform !== 'win32') {
    expect(mode(path)).toBe(metadata.isDirectory() ? 0o700 : 0o600);
  }
  if (!metadata.isDirectory()) return;
  for (const entry of readdirSync(path)) assertPrivateTree(join(path, entry));
}

describe('provider CLI environment confidentiality', () => {
  it('passes only common plumbing, Kory bridge state, and the selected provider family', () => {
    const source: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/bin',
      LANG: 'en_US.UTF-8',
      HTTPS_PROXY: 'http://synthetic-proxy.invalid',
      SSL_CERT_FILE: '/synthetic/cert.pem',
      KORY_BACKEND_URL: 'http://127.0.0.1:3001',
      KORY_BRIDGE_AUTH_FILE: '/private/synthetic-grant.json',
      KORY_CLI_ENV_SENTINEL: 'must-never-cross',
    };

    for (const provider of PROVIDERS) {
      for (const [family, key] of Object.entries(PROVIDER_CLI_SECRET_KEYS_FOR_TESTING)) {
        source[key] = `synthetic-${family}-secret`;
      }
      source[CONFIG_KEYS[provider]] = `/private/${provider}-home`;

      // Config roots are explicit overrides: the helper must never copy the
      // backend's real HOME/XDG roots from ambient source state.
      const env = buildProviderCliEnv(
        provider,
        { [CONFIG_KEYS[provider]]: `/private/${provider}-home` },
        source,
      );
      expect(env[PROVIDER_CLI_SECRET_KEYS_FOR_TESTING[provider]]).toBe(
        `synthetic-${provider}-secret`,
      );
      expect(env[CONFIG_KEYS[provider]]).toBe(`/private/${provider}-home`);
      expect(env.KORY_BACKEND_URL).toBe('http://127.0.0.1:3001');
      expect(env.KORY_BRIDGE_AUTH_FILE).toBe('/private/synthetic-grant.json');
      expect(env.KORY_CLI_ENV_SENTINEL).toBeUndefined();

      for (const otherProvider of PROVIDERS) {
        if (otherProvider === provider) continue;
        expect(env[PROVIDER_CLI_SECRET_KEYS_FOR_TESTING[otherProvider]]).toBeUndefined();
      }

      const fakeChild = spawnSync(
        process.execPath,
        ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
        { env, encoding: 'utf8' },
      );
      expect(fakeChild.status).toBe(0);
      const observed = JSON.parse(fakeChild.stdout) as NodeJS.ProcessEnv;
      expect(observed.KORY_CLI_ENV_SENTINEL).toBeUndefined();
      expect(observed[PROVIDER_CLI_SECRET_KEYS_FOR_TESTING[provider]]).toBe(
        `synthetic-${provider}-secret`,
      );
      for (const otherProvider of PROVIDERS) {
        if (otherProvider === provider) continue;
        expect(observed[PROVIDER_CLI_SECRET_KEYS_FOR_TESTING[otherProvider]]).toBeUndefined();
      }
    }
  });

  it('rejects a non-allowlisted override instead of silently widening the boundary', () => {
    expect(() => buildProviderCliEnv('codex', { KORY_CLI_ENV_SENTINEL: 'forbidden' })).toThrow(
      'Refusing non-allowlisted codex CLI environment key',
    );
  });

  it('keeps the managed Codex app-server on the central environment boundary', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'codex-app-server.ts'), 'utf8');
    expect(source).toContain("buildProviderCliEnv('codex'");
    expect(source).not.toContain('env: { ...process.env');
  });

  it('terminates an oversized JSONL producer and rejects RPC plus login waiters', async () => {
    if (process.platform === 'win32') return;
    const testRoot = mkdtempSync(join(tmpdir(), 'kory-codex-frame-cap-'));
    const fakeBinary = join(testRoot, 'codex');
    const exitMarker = join(testRoot, 'terminated');
    const codexHome = join(testRoot, 'data', 'codex-home');
    const fakeSource = `#!${process.execPath}
import { writeFileSync } from 'node:fs';
let buffer = '';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\\n');
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.method === 'initialize') {
      send({ jsonrpc: '2.0', id: request.id, result: {} });
    } else if (request.method === 'account/login/start') {
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          type: 'chatgpt',
          loginId: 'synthetic-login',
          authUrl: 'https://example.invalid/sign-in',
        },
      });
      setTimeout(() => {
        process.stdout.write('x'.repeat(${CODEX_APP_SERVER_MAX_FRAME_BYTES_FOR_TESTING + 1}));
      }, 100);
    }
  }
});
process.on('SIGTERM', () => {
  writeFileSync(${JSON.stringify(exitMarker)}, 'terminated');
  process.exit(0);
});
setInterval(() => {}, 1000);
`;

    writeFileSync(fakeBinary, fakeSource, { mode: 0o700 });
    chmodSync(fakeBinary, 0o700);
    const server = new CodexAppServer(codexHome, fakeBinary);
    try {
      const login = await server.startChatgptLogin();
      const startedAt = Date.now();
      const [loginResult, requestResult] = await Promise.allSettled([
        server.waitForLoginCompletion(login.loginId, 5_000),
        server.account(),
      ]);

      expect(loginResult.status).toBe('rejected');
      expect(requestResult.status).toBe('rejected');
      if (loginResult.status === 'rejected') {
        expect(String(loginResult.reason)).toContain('invalid protocol stream');
      }
      if (requestResult.status === 'rejected') {
        expect(String(requestResult.reason)).toContain('invalid protocol stream');
      }
      expect(Date.now() - startedAt).toBeLessThan(2_000);

      for (let attempt = 0; attempt < 100 && !existsSync(exitMarker); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(readFileSync(exitMarker, 'utf8')).toBe('terminated');
    } finally {
      server.close();
      rmSync(testRoot, { recursive: true, force: true });
    }
  });
});

describe('managed CLI storage confidentiality and durability', () => {
  it('heals loose custom-root modes without rewriting file content', () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'kory-managed-heal-'));
    const managedRoot = join(testRoot, 'cli-homes');
    const nested = join(managedRoot, 'codex-home', 'nested');
    const config = join(nested, 'config.toml');
    try {
      mkdirSync(nested, { recursive: true, mode: 0o775 });
      chmodSync(managedRoot, 0o775);
      chmodSync(join(managedRoot, 'codex-home'), 0o775);
      chmodSync(nested, 0o775);
      writeFileSync(config, 'content-that-must-survive', { mode: 0o664 });
      chmodSync(config, 0o664);

      healManagedCliFile(config, { root: managedRoot });

      expect(readFileSync(config, 'utf8')).toBe('content-that-must-survive');
      if (process.platform !== 'win32') {
        expect(mode(managedRoot)).toBe(0o700);
        expect(mode(join(managedRoot, 'codex-home'))).toBe(0o700);
        expect(mode(nested)).toBe(0o700);
        expect(mode(config)).toBe(0o600);
      }
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('atomically replaces files at 0600 and leaves no staging file', () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'kory-managed-atomic-'));
    const managedRoot = join(testRoot, 'cli-homes');
    const config = join(managedRoot, 'grok-home', 'mcp.json');
    try {
      writeManagedCliFile(config, 'first', {}, { root: managedRoot });
      const interrupted = join(managedRoot, 'grok-home', '.mcp.json.kory-write-dead-process');
      writeFileSync(interrupted, 'partial-private-content', { mode: 0o600 });
      const staleAt = new Date(Date.now() - 2 * 60 * 60_000);
      utimesSync(interrupted, staleAt, staleAt);
      writeManagedCliFile(config, 'second', {}, { root: managedRoot });

      expect(readFileSync(config, 'utf8')).toBe('second');
      expect(readdirSync(join(managedRoot, 'grok-home'))).toEqual(['mcp.json']);
      if (process.platform !== 'win32') expect(mode(config)).toBe(0o600);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('preserves an existing file and cleans staging when an atomic write fails', () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'kory-managed-failure-'));
    const managedRoot = join(testRoot, 'cli-homes');
    const configDir = ensureManagedCliDirectory(join(managedRoot, 'claude-home'), {
      root: managedRoot,
    });
    const config = join(configDir, 'settings.json');
    try {
      writeManagedCliFile(config, 'original', {}, { root: managedRoot });
      expect(() =>
        writeManagedCliFile(config, undefined as unknown as string, {}, { root: managedRoot }),
      ).toThrow();

      expect(readFileSync(config, 'utf8')).toBe('original');
      expect(readdirSync(configDir)).toEqual(['settings.json']);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('rejects symlink traversal and hard-link replacement without touching external data', () => {
    if (process.platform === 'win32') return;
    const testRoot = mkdtempSync(join(tmpdir(), 'kory-managed-escape-'));
    const managedRoot = join(testRoot, 'cli-homes');
    const outside = join(testRoot, 'outside');
    try {
      ensureManagedCliDirectory(managedRoot, { root: managedRoot });
      mkdirSync(outside, { mode: 0o700 });
      const external = join(outside, 'external.txt');
      writeFileSync(external, 'external', { mode: 0o600 });
      symlinkSync(outside, join(managedRoot, 'escape'));

      expect(() =>
        writeManagedCliFile(
          join(managedRoot, 'escape', 'external.txt'),
          'replaced',
          {},
          {
            root: managedRoot,
          },
        ),
      ).toThrow();
      expect(readFileSync(external, 'utf8')).toBe('external');

      const owned = join(managedRoot, 'owned.txt');
      const alias = join(managedRoot, 'owned-alias.txt');
      writeManagedCliFile(owned, 'owned', {}, { root: managedRoot });
      linkSync(owned, alias);
      expect(() => writeManagedCliFile(owned, 'replaced', {}, { root: managedRoot })).toThrow(
        'multiple hard links',
      );
      expect(readFileSync(owned, 'utf8')).toBe('owned');
      expect(readFileSync(alias, 'utf8')).toBe('owned');
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('writes every custom-data-root rules directory/file with private modes', () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), 'kory-managed-rules-'));
    const managedRoot = join(dataDirectory, 'cli-homes');
    try {
      expect(
        writeAllCliRulesAndSkills('private-session', 'Synthetic prompt', {
          env: { KORYPHAIOS_DATA_DIR: dataDirectory },
        }),
      ).toBe(true);
      expect(existsSync(managedRoot)).toBe(true);
      assertPrivateTree(managedRoot);
    } finally {
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  });
});
