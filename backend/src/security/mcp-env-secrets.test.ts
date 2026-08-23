import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  stripMcpEnvSecrets,
  hydrateMcpEnvSecrets,
  upsertMcpEnvSecrets,
  removeMcpEnvSecrets,
  loadMcpEnvSecrets,
} from './secret-store';
import {
  loadProjectMcpServers,
  syncMcpServersToConfig,
  removeMcpServerFromConfig,
} from '../runtime/config';

const temporaryRoots: string[] = [];

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'kory-mcp-env-secrets-'));
  temporaryRoots.push(root);
  // Create the .koryphaios directory so ensureSecureDir works
  return root;
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

describe('MCP env secret store', () => {
  test('stripMcpEnvSecrets extracts env values and keeps key names', () => {
    const servers = {
      github: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_TOKEN: 'ghp_secret_value_123', API_KEY: 'key_abc' },
      },
      filesystem: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem'],
        // No env — should pass through unchanged
      },
    };
    const { clean, secrets } = stripMcpEnvSecrets(servers);

    // Clean config keeps key names with empty values
    expect(clean.github.env).toEqual({ GITHUB_TOKEN: '', API_KEY: '' });
    expect(clean.filesystem).toEqual(servers.filesystem);

    // Secrets are extracted
    expect(secrets.github).toEqual({ GITHUB_TOKEN: 'ghp_secret_value_123', API_KEY: 'key_abc' });
    expect(secrets.filesystem).toBeUndefined();
  });

  test('upsert + load + remove round-trip', () => {
    const root = freshRoot();
    upsertMcpEnvSecrets(root, 'myserver', { TOKEN: 'secret_abc', KEY: 'value_def' });
    let loaded = loadMcpEnvSecrets(root);
    expect(loaded.myserver).toEqual({ TOKEN: 'secret_abc', KEY: 'value_def' });

    // Upsert merges, not replaces
    upsertMcpEnvSecrets(root, 'myserver', { EXTRA: 'extra_val' });
    loaded = loadMcpEnvSecrets(root);
    expect(loaded.myserver).toEqual({
      TOKEN: 'secret_abc',
      KEY: 'value_def',
      EXTRA: 'extra_val',
    });

    // Remove
    const removed = removeMcpEnvSecrets(root, 'myserver');
    expect(removed).toBe(true);
    loaded = loadMcpEnvSecrets(root);
    expect(loaded.myserver).toBeUndefined();
  });

  test('hydrateMcpEnvSecrets merges stored secrets back into a servers map', () => {
    const root = freshRoot();
    upsertMcpEnvSecrets(root, 'github', { GITHUB_TOKEN: 'ghp_real_token' });

    const configServers = {
      github: {
        type: 'stdio' as const,
        command: 'npx',
        env: { GITHUB_TOKEN: '', NODE_ENV: 'production' },
      },
      other: {
        type: 'stdio' as const,
        command: 'node',
      },
    };
    const hydrated = hydrateMcpEnvSecrets(root, configServers);
    // Stored secret fills the empty value, existing non-secret env is preserved
    expect(hydrated.github.env).toEqual({ GITHUB_TOKEN: 'ghp_real_token', NODE_ENV: 'production' });
    // Server without secrets is unchanged
    expect(hydrated.other).toEqual(configServers.other);
  });

  test('secret store file is created with 0600 permissions', () => {
    const root = freshRoot();
    upsertMcpEnvSecrets(root, 'test', { KEY: 'val' });
    const secretsPath = join(root, '.koryphaios', 'mcp-env.json');
    expect(existsSync(secretsPath)).toBe(true);
    // Unix enforces 0600; Windows has no equivalent permission bit (files are
    // always 0o666 regardless of chmod), so skip the mode check on win32.
    if (process.platform === 'win32') return;
    const stat = statSync(secretsPath);
    // Mode 0o600 = 0o100600 (regular file + 0600). Lower 9 bits should be 0o600.
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test('stripMcpEnvSecrets handles non-object env gracefully', () => {
    const servers = {
      bad: { type: 'stdio', command: 'node', env: 'not-an-object' as unknown },
      noenv: { type: 'stdio', command: 'node' },
    };
    const { clean, secrets } = stripMcpEnvSecrets(
      servers as Record<string, Record<string, unknown>>,
    );
    // Bad env passes through unchanged, no secrets extracted
    expect(clean.bad.env).toBe('not-an-object');
    expect(Object.keys(secrets).length).toBe(0);
  });

  test('project sync creates a missing config and reconciles the full secret snapshot', () => {
    const root = freshRoot();
    syncMcpServersToConfig(root, {
      github: {
        type: 'stdio',
        command: 'node',
        env: { GITHUB_TOKEN: 'first-secret' },
      },
    });
    expect(loadProjectMcpServers(root).github.env).toEqual({ GITHUB_TOKEN: 'first-secret' });
    expect(
      JSON.parse(readFileSync(join(root, 'koryphaios.json'), 'utf8')).mcpServers.github.env,
    ).toEqual({
      GITHUB_TOKEN: '',
    });

    syncMcpServersToConfig(root, {
      filesystem: { type: 'stdio', command: 'node', env: { FS_TOKEN: 'second-secret' } },
    });
    expect(loadMcpEnvSecrets(root)).toEqual({ filesystem: { FS_TOKEN: 'second-secret' } });
    expect(loadProjectMcpServers(root).github).toBeUndefined();
  });

  test('project removal is fail-closed and purges the matching env secret', () => {
    const root = freshRoot();
    writeFileSync(
      join(root, 'koryphaios.json'),
      JSON.stringify({
        mcpServers: {
          github: { type: 'stdio', command: 'node', env: { TOKEN: '' } },
        },
      }),
    );
    upsertMcpEnvSecrets(root, 'github', { TOKEN: 'remove-me' });
    removeMcpServerFromConfig(root, 'github');
    expect(loadProjectMcpServers(root).github).toBeUndefined();
    expect(loadMcpEnvSecrets(root).github).toBeUndefined();
  });
});
