import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { credentialLinkCandidates, mcpConfigCandidates } from '../cli-config-paths';

describe('unverified CLI config roots', () => {
  test('covers both the config root and the nested dot-directory', () => {
    expect(mcpConfigCandidates('/home', '.cursor')).toEqual([
      '/home/mcp.json',
      '/home/.cursor/mcp.json',
    ]);
  });

  test('never emits a duplicate candidate', () => {
    const candidates = mcpConfigCandidates('/home', '.grok');
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  test('links each credential at both resolution points', () => {
    const links = credentialLinkCandidates('/real/.grok', '/home', '.grok', [
      'auth.json',
      'models_cache.json',
    ]);
    expect(links).toEqual([
      { source: '/real/.grok/auth.json', target: '/home/auth.json' },
      { source: '/real/.grok/auth.json', target: '/home/.grok/auth.json' },
      { source: '/real/.grok/models_cache.json', target: '/home/models_cache.json' },
      { source: '/real/.grok/models_cache.json', target: '/home/.grok/models_cache.json' },
    ]);
  });

  test('keeps every source inside the real config dir', () => {
    // A malformed join here would silently link something outside the CLI's own
    // config, e.g. resolving an absolute target against the source directory.
    const realDir = '/real/.grok';
    for (const { source } of credentialLinkCandidates(realDir, '/home', '.grok', [
      'auth.json',
    ])) {
      expect(source).toBe(join(realDir, 'auth.json'));
      expect(source.startsWith('/home')).toBe(false);
    }
  });
});