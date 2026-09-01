import { describe, expect, test } from 'bun:test';
import { FEATURED_MCP_CATEGORIES, FEATURED_MCP_SERVERS } from '../../mcp/featured-registry';

// The featured endpoint is a static curated catalog served from
// /api/v1/mcp-registry/featured; the route wrapper only adds local auth.
// These assertions lock the contract the Settings browse view relies on.

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
});
