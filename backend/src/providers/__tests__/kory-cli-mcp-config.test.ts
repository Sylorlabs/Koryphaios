import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveKoryBridgeScript } from '../kory-cli-mcp-config';

const saved = process.env.KORY_MCP_BRIDGE_SCRIPT;
afterEach(() => {
  if (saved === undefined) delete process.env.KORY_MCP_BRIDGE_SCRIPT;
  else process.env.KORY_MCP_BRIDGE_SCRIPT = saved;
});

describe('resolveKoryBridgeScript', () => {
  test('prefers the sibling .ts in a source checkout', () => {
    delete process.env.KORY_MCP_BRIDGE_SCRIPT;
    const dir = mkdtempSync(join(tmpdir(), 'kory-bridge-src-'));
    try {
      writeFileSync(join(dir, 'kory-mcp-bridge.ts'), '// source');
      writeFileSync(join(dir, 'kory-mcp-bridge.js'), '// built');
      expect(resolveKoryBridgeScript(dir)).toBe(join(dir, 'kory-mcp-bridge.ts'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('falls back to the bundled .js in a packaged build', () => {
    delete process.env.KORY_MCP_BRIDGE_SCRIPT;
    const dir = mkdtempSync(join(tmpdir(), 'kory-bridge-build-'));
    try {
      writeFileSync(join(dir, 'kory-mcp-bridge.js'), '// built');
      expect(resolveKoryBridgeScript(dir)).toBe(join(dir, 'kory-mcp-bridge.js'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns null when neither script exists', () => {
    delete process.env.KORY_MCP_BRIDGE_SCRIPT;
    const dir = mkdtempSync(join(tmpdir(), 'kory-bridge-empty-'));
    try {
      expect(resolveKoryBridgeScript(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('KORY_MCP_BRIDGE_SCRIPT overrides both siblings', () => {
    process.env.KORY_MCP_BRIDGE_SCRIPT = '/opt/custom/bridge.js';
    expect(resolveKoryBridgeScript()).toBe('/opt/custom/bridge.js');
  });
});
