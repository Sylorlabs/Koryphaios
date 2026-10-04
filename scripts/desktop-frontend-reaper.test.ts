import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import {
  isFrontendDevServerCommand,
  normalizeCommand,
  parseCimOutput,
  parseFrontendPort,
  parsePsOutput,
  selectFreeFrontendPort,
} from './desktop-frontend-reaper';

const FRONTEND_DIR = '/Users/micah/koryphaios/frontend';
const VITE = `${FRONTEND_DIR}/node_modules/.bin/vite`;

describe('frontend dev-server reaper', () => {
  it('matches a vite dev server rooted at this frontend', () => {
    expect(
      isFrontendDevServerCommand(
        `node ${VITE} dev --host 127.0.0.1 --port 3003 --strictPort`,
        FRONTEND_DIR,
      ),
    ).toBe(true);
  });

  it('matches the Windows command form', () => {
    expect(
      isFrontendDevServerCommand(
        String.raw`C:\Users\micah\koryphaios\frontend\node_modules\.bin\vite.CMD dev --port 3003`,
        FRONTEND_DIR,
      ),
    ).toBe(true);
  });

  it('ignores a vite server rooted at a different project', () => {
    expect(
      isFrontendDevServerCommand(
        'node /Users/micah/other-app/node_modules/.bin/vite dev',
        FRONTEND_DIR,
      ),
    ).toBe(false);
  });

  it('ignores non-dev vite commands', () => {
    expect(isFrontendDevServerCommand(`node ${VITE} build`, FRONTEND_DIR)).toBe(false);
  });

  it('ignores the launcher parent that wraps vite', () => {
    expect(isFrontendDevServerCommand('bun run --cwd frontend dev --port 5174', FRONTEND_DIR)).toBe(
      false,
    );
  });

  it('reads the port a stray server was started with', () => {
    expect(parseFrontendPort(`node ${VITE} dev --host 127.0.0.1 --port 5174`)).toBe(5174);
    expect(parseFrontendPort(`node ${VITE} dev --port=3003`)).toBe(3003);
    expect(parseFrontendPort(`node ${VITE} dev`)).toBeNull();
    expect(parseFrontendPort(`node ${VITE} dev --port 99999999`)).toBeNull();
  });

  it('parses ps output', () => {
    expect(
      parsePsOutput(
        `  5886 node ${VITE} dev --host 127.0.0.1 --port 3003 --strictPort\n` +
          `  5711 bun run src/server.ts\n`,
      ),
    ).toEqual([
      {
        pid: 5886,
        port: 3003,
        command: `node ${VITE} dev --host 127.0.0.1 --port 3003 --strictPort`,
      },
      { pid: 5711, port: null, command: 'bun run src/server.ts' },
    ]);
  });

  it('parses Windows CIM output including the single-object form', () => {
    expect(
      parseCimOutput(
        JSON.stringify([
          { ProcessId: 41819, CommandLine: `node ${VITE} dev --port 5174` },
          { ProcessId: 4, CommandLine: '' },
        ]),
      ),
    ).toEqual([{ pid: 41819, port: 5174, command: `node ${VITE} dev --port 5174` }]);
    expect(parseCimOutput(JSON.stringify({ ProcessId: 9, CommandLine: 'bun x vite dev' }))).toEqual(
      [{ pid: 9, port: null, command: 'bun x vite dev' }],
    );
  });

  it('normalizes Windows separators', () => {
    expect(normalizeCommand(String.raw`a\b\c`)).toBe('a/b/c');
  });

  it('keeps the preferred port when it is free', async () => {
    expect(await selectFreeFrontendPort(3003, async () => false)).toBe(3003);
  });

  it('moves to the next free port when the preferred one is held', async () => {
    const held = new Set([3003, 3004]);
    expect(await selectFreeFrontendPort(3003, async (port) => held.has(port))).toBe(3005);
  });

  it('gives up rather than loop past the port ceiling', async () => {
    expect(await selectFreeFrontendPort(65_535, async () => true)).toBeNull();
  });
});

describe('vite dependency cache isolation', () => {
  it('scopes cacheDir by port so two dev servers cannot share it', async () => {
    const viteConfig = await Bun.file(
      resolve(import.meta.dir, '../frontend/vite.config.ts'),
    ).text();
    expect(viteConfig).toContain('cacheDir:');
    expect(viteConfig).toContain('cacheScopePort');
    expect(viteConfig).toContain('KORYPHAIOS_FRONTEND_PORT');
  });

  it('documents the shared-cache cause of the next_sibling_getter crash', async () => {
    const viteConfig = await Bun.file(
      resolve(import.meta.dir, '../frontend/vite.config.ts'),
    ).text();
    expect(viteConfig).toContain('next_sibling_getter');
  });
});
