// Registry search mapping: registry.modelcontextprotocol.io payloads ->
// the add-server form's `McpRegistrySearchResult`.
//
// Every assertion here corresponds to a command the mapping used to build that
// cannot actually run, or an entry the add form used to reject with a 422.

import { describe, expect, test } from 'bun:test';
import { buildCommand, mapSearchResult, pickBestPackage, pickBestRemote } from './mcp-registry';
import { FEATURED_MCP_CATEGORIES, FEATURED_MCP_SERVERS } from '../../mcp/featured-registry';

// ─── buildCommand ───────────────────────────────────────────────────────────

describe('registry buildCommand', () => {
  test('does not duplicate -y when the registry already supplies it', () => {
    // Real payload from the registry for com.pulsemcp/remote-filesystem.
    const built = buildCommand({
      registryType: 'npm',
      identifier: 'remote-filesystem-mcp-server',
      runtimeHint: 'npx',
      runtimeArguments: [{ value: '-y' }],
    });
    expect(built).toEqual({
      command: 'npx',
      args: ['-y', 'remote-filesystem-mcp-server'],
    });
    // The old shape was ['-y', pkg, '-y'] — the flag leaked into the package's argv.
    expect(built?.args.filter((a) => a === '-y')).toHaveLength(1);
  });

  test('adds -y only when the registry omits it', () => {
    const built = buildCommand({
      registryType: 'npm',
      identifier: 'some-server',
      runtimeHint: 'npx',
      runtimeArguments: [],
    });
    expect(built).toEqual({ command: 'npx', args: ['-y', 'some-server'] });
  });

  test('places runtime arguments before and package arguments after the identifier', () => {
    // Per the registry schema, runtimeArguments belong to the runtime command
    // and packageArguments to the package binary.
    const built = buildCommand({
      registryType: 'npm',
      identifier: 'server-postgres',
      runtimeHint: 'npx',
      runtimeArguments: [{ value: '-y' }],
      packageArguments: [{ value: 'postgresql://localhost:5432/mydb' }],
    });
    expect(built).toEqual({
      command: 'npx',
      args: ['-y', 'server-postgres', 'postgresql://localhost:5432/mydb'],
    });
    const args = built!.args;
    expect(args.indexOf('-y')).toBeLessThan(args.indexOf('server-postgres'));
    expect(args.indexOf('server-postgres')).toBeLessThan(
      args.lastIndexOf('postgresql://localhost:5432/mydb'),
    );
  });

  test('builds uvx commands for python packages', () => {
    const built = buildCommand({
      registryType: 'pypi',
      identifier: 'mcp-server-git',
      runtimeHint: 'uvx',
    });
    expect(built).toEqual({ command: 'uvx', args: ['mcp-server-git'] });
  });

  test('places python package arguments after the identifier', () => {
    const built = buildCommand({
      registryType: 'pypi',
      identifier: 'mcp-server-git',
      runtimeHint: 'uvx',
      packageArguments: [{ value: '--repository' }, { value: '/tmp/repo' }],
    });
    expect(built).toEqual({
      command: 'uvx',
      args: ['mcp-server-git', '--repository', '/tmp/repo'],
    });
  });

  test('builds a docker run command for OCI packages', () => {
    const built = buildCommand({
      registryType: 'oci',
      identifier: 'docker.io/example/mcp-server:1.2.3',
      runtimeHint: 'docker',
      runtimeArguments: [],
    });
    expect(built).toEqual({
      command: 'docker',
      args: ['run', '-i', '--rm', 'docker.io/example/mcp-server:1.2.3'],
    });
  });

  test('honours an explicit docker run flag list', () => {
    const built = buildCommand({
      registryType: 'oci',
      identifier: 'example/mcp',
      runtimeHint: 'docker',
      runtimeArguments: [{ value: 'run' }, { value: '--rm' }],
      packageArguments: [{ value: '--verbose' }],
    });
    expect(built).toEqual({
      command: 'docker',
      args: ['run', '--rm', 'example/mcp', '--verbose'],
    });
  });

  test('infers npx/uvx for npm/pypi packages with no runtimeHint', () => {
    expect(buildCommand({ registryType: 'npm', identifier: 'x' })?.command).toBe('npx');
    expect(buildCommand({ registryType: 'pypi', identifier: 'y' })?.command).toBe('uvx');
  });

  test('refuses to invent a command for runtimes it cannot drive', () => {
    // The old fallback spawned `<runtimeHint> <identifier>`, which for a
    // runtime like `deno`/`bun` silently resolves to a file path.
    expect(buildCommand({ registryType: 'oci', identifier: 'img' })).toBeNull();
    expect(
      buildCommand({
        registryType: 'unknown',
        identifier: 'weird',
        runtimeHint: 'totally-unknown',
      }),
    ).toBeNull();
  });

  test('returns null when there is no identifier', () => {
    expect(buildCommand({ registryType: 'npm', runtimeHint: 'npx' })).toBeNull();
  });
});

// ─── pickBestPackage / pickBestRemote ───────────────────────────────────────

describe('registry remote selection', () => {
  test('prefers streamable-http, which is what hosted servers publish', () => {
    // r.type === 'sse' never matches these, so the old preference was dead code.
    const picked = pickBestRemote({
      name: 'ac.inference.sh/mcp',
      remotes: [
        { type: 'streamable-http', url: 'https://sh.inference.ac' },
        { type: 'streamable-http', url: 'https://api.inference.sh/mcp' },
      ],
    });
    expect(picked?.url).toBe('https://sh.inference.ac');
  });

  test('falls back to a genuine sse endpoint', () => {
    const picked = pickBestRemote({
      name: 'io.github.Evozim/chroot-filesystem-jail-mcp',
      remotes: [{ type: 'sse', url: 'https://api.m2mcent.com/chroot/sse' }],
    });
    expect(picked?.url).toBe('https://api.m2mcent.com/chroot/sse');
  });

  test('honours author ordering when types are mixed and sse comes first', () => {
    const picked = pickBestRemote({
      name: 'mixed',
      remotes: [
        { type: 'sse', url: 'https://legacy.example/sse' },
        { type: 'streamable-http', url: 'https://modern.example/mcp' },
      ],
    });
    expect(picked?.url).toBe('https://modern.example/mcp');
  });

  test('returns null with no remotes', () => {
    expect(pickBestRemote({ name: 'x' })).toBeNull();
    expect(pickBestRemote({ name: 'x', remotes: [] })).toBeNull();
  });

  test('prefers an npm package when both package types are published', () => {
    const picked = pickBestPackage({
      name: 'x',
      packages: [
        { registryType: 'pypi', identifier: 'py-pkg' },
        { registryType: 'npm', identifier: 'npm-pkg' },
      ],
    });
    expect(picked?.identifier).toBe('npm-pkg');
  });
});

// ─── mapSearchResult ────────────────────────────────────────────────────────

describe('registry search result mapping', () => {
  test('drops an entry whose only package cannot produce a command', () => {
    // With no remote to fall back to, this produced `transport: 'stdio',
    // command: null`, which the add form rejects with a 422. Skipping it keeps
    // every surfaced result addable.
    expect(
      mapSearchResult({
        server: {
          name: 'io.github.example/broken',
          packages: [{ registryType: 'oci', identifier: 'some/image' }],
        },
      }),
    ).toBeNull();
  });

  test('never emits a stdio entry with no runnable command', () => {
    for (const server of [
      { name: 'a/oci', packages: [{ registryType: 'oci', identifier: 'i' }] },
      { name: 'b/no-hint', packages: [{ registryType: 'oci' }] },
      { name: 'c/unknown', packages: [{ registryType: 'oci', identifier: 'i' }] },
    ]) {
      const result = mapSearchResult({ server });
      expect(result).toBeNull();
    }
  });

  test('falls back to the remote when the package cannot produce a command', () => {
    const result = mapSearchResult({
      server: {
        name: 'io.github.example/both',
        packages: [{ registryType: 'oci', identifier: 'some/image' }],
        remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp' }],
      },
    });
    expect(result?.transport).toBe('sse');
    expect(result?.url).toBe('https://example.com/mcp');
  });

  test('skips servers with neither a runnable package nor a remote', () => {
    expect(mapSearchResult({ server: { name: 'io.github.example/nothing' } })).toBeNull();
    expect(
      mapSearchResult({
        server: { name: 'io.github.example/oci-only', packages: [{ registryType: 'oci' }] },
      }),
    ).toBeNull();
  });

  test('skips entries with no name', () => {
    expect(mapSearchResult({ server: { name: '' } })).toBeNull();
  });

  test('maps a stdio server with required and secret env vars', () => {
    const result = mapSearchResult({
      server: {
        name: 'com.mcparmory/notion',
        title: 'Notion',
        description: 'Notion workspace tools',
        version: '2.0.1',
        repository: { url: 'https://github.com/mcparmory/notion' },
        packages: [
          {
            registryType: 'npm',
            identifier: 'notion-mcp-server',
            runtimeHint: 'npx',
            runtimeArguments: [{ value: '-y' }],
            environmentVariables: [
              {
                name: 'NOTION_TOKEN',
                description: 'Integration token',
                isRequired: true,
                isSecret: true,
              },
              { name: 'LOG_LEVEL', default: 'info' },
            ],
          },
        ],
      },
    });

    expect(result).not.toBeNull();
    expect(result?.transport).toBe('stdio');
    expect(result?.command).toBe('npx');
    expect(result?.args).toEqual(['-y', 'notion-mcp-server']);
    expect(result?.url).toBeNull();
    expect(result?.envVars).toEqual([
      {
        name: 'NOTION_TOKEN',
        description: 'Integration token',
        isRequired: true,
        isSecret: true,
        defaultValue: null,
      },
      {
        name: 'LOG_LEVEL',
        description: '',
        isRequired: false,
        isSecret: false,
        defaultValue: 'info',
      },
    ]);
    expect(result?.repositoryUrl).toBe('https://github.com/mcparmory/notion');
  });

  test('maps a remote server and surfaces its auth headers', () => {
    const result = mapSearchResult({
      server: {
        name: 'ai.smithery/smithery-notion',
        title: 'Notion via Smithery',
        description: 'Hosted Notion tools',
        websiteUrl: 'https://smithery.ai',
        remotes: [
          {
            type: 'streamable-http',
            url: 'https://server.smithery.ai/mcp',
            headers: [
              { name: 'Authorization', description: 'Bearer token', isSecret: true },
              { name: 'X-Trace', description: 'Optional' },
            ],
          },
        ],
      },
    });

    expect(result?.transport).toBe('sse');
    expect(result?.url).toBe('https://server.smithery.ai/mcp');
    expect(result?.command).toBeNull();
    expect(result?.args).toEqual([]);
    expect(result?.envVars).toEqual([]);
    expect(result?.headerVars).toEqual([
      { name: 'Authorization', description: 'Bearer token', isSecret: true },
      { name: 'X-Trace', description: 'Optional', isSecret: false },
    ]);
  });

  test('title falls back to the reverse-DNS name and version to an empty string', () => {
    const result = mapSearchResult({
      server: { name: 'io.github.example/bare', remotes: [{ type: 'sse', url: 'https://x/mcp' }] },
    });
    expect(result?.title).toBe('io.github.example/bare');
    expect(result?.version).toBe('');
  });

  test('every mapped stdio result is immediately addable', () => {
    // The add form requires a command for stdio and an https URL for sse.
    const samples = [
      { name: 'a/b', packages: [{ registryType: 'npm', identifier: 'p', runtimeHint: 'npx' }] },
      {
        name: 'c/d',
        packages: [{ registryType: 'pypi', identifier: 'p', runtimeHint: 'uvx' }],
      },
      { name: 'e/f', remotes: [{ type: 'streamable-http', url: 'https://e.example/mcp' }] },
    ];
    for (const server of samples) {
      const result = mapSearchResult({ server });
      expect(result).not.toBeNull();
      if (result?.transport === 'stdio') {
        expect(result.command).toBeTruthy();
        expect(result.url).toBeNull();
      } else {
        expect(result?.url).toMatch(/^https:\/\//);
        expect(result?.command).toBeNull();
      }
    }
  });
});

// ─── featured catalog ───────────────────────────────────────────────────────

const NAMES = new Set(FEATURED_MCP_SERVERS.map((server) => server.name));

describe('featured MCP registry catalog', () => {
  test('includes the connectors users reach for first', () => {
    for (const expected of [
      'github',
      'gitlab',
      'sentry',
      'atlassian',
      'supabase',
      'neon',
      'postgres',
      'mongodb',
      'playwright',
      'brave-search',
      'context7',
      'notion',
      'figma',
      'slack',
      'stripe',
    ]) {
      expect(NAMES.has(expected)).toBe(true);
    }
  });

  test('excludes servers duplicating native Koryphaios capabilities', () => {
    for (const excluded of [
      'memory',
      'filesystem',
      'git',
      'obsidian',
      'linear',
      'sequential-thinking',
    ]) {
      expect(NAMES.has(excluded)).toBe(false);
    }
    const serialized = JSON.stringify(FEATURED_MCP_SERVERS).toLowerCase();
    expect(serialized).not.toContain('server-memory');
    expect(serialized).not.toContain('server-filesystem');
  });

  test('every entry is addable: stdio command or remote URL, with metadata', () => {
    for (const server of FEATURED_MCP_SERVERS) {
      expect(server.id.length).toBeGreaterThan(0);
      expect(server.title.length).toBeGreaterThan(0);
      expect(server.description.length).toBeGreaterThan(0);
      expect(FEATURED_MCP_CATEGORIES).toContain(server.category as never);
      if (server.transport === 'stdio') {
        expect(server.command).toBeTruthy();
        expect(server.args.length).toBeGreaterThan(0);
        expect(server.url).toBeNull();
      } else {
        expect(server.url ?? '').toMatch(/^https:\/\//);
        expect(server.command).toBeNull();
      }
    }
  });

  test('names are unique so the list can be keyed by name', () => {
    expect(NAMES.size).toBe(FEATURED_MCP_SERVERS.length);
  });

  test('remote entries declare their auth headers completely', () => {
    // The add form seeds one editable `Key:` line per declared header. A
    // duplicate or nameless header would produce a config the user cannot fix.
    for (const server of FEATURED_MCP_SERVERS) {
      if (server.transport !== 'sse') continue;
      const names = server.headerVars.map((h) => h.name);
      expect(new Set(names).size).toBe(names.length);
      for (const header of server.headerVars) {
        expect(header.name.trim().length).toBeGreaterThan(0);
        // Header names go straight into a request; reject anything unsafe.
        expect(header.name).toMatch(/^[A-Za-z0-9-]+$/);
      }
    }
  });

  test('every remote entry is reachable over https', () => {
    for (const server of FEATURED_MCP_SERVERS) {
      if (server.transport !== 'sse') continue;
      const url = new URL(server.url as string);
      expect(url.protocol).toBe('https:');
    }
  });
});
