import { describe, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createIsolatedTestEnvironment } from '../../../scripts/test-backend-isolated';
import { handleWSMessage, type WSClientData } from './websocket-handler';

// Resolve relative to this test file so the path is correct regardless of CWD.
const wsHandlerModulePath = resolve(import.meta.dir, 'websocket-handler.ts');

describe('websocket heartbeat handling', () => {
  test('marks the exact client alive when it answers an application heartbeat', async () => {
    const pongClients: string[] = [];
    const socket = { data: { id: 'client-heartbeat' } } as ServerWebSocket<WSClientData>;
    const dependencies = {
      wsManager: {
        handlePong: (clientId: string) => pongClients.push(clientId),
      },
      sessions: {},
      kory: {},
      providers: {},
    } as unknown as Parameters<typeof handleWSMessage>[2];

    await handleWSMessage(
      socket,
      JSON.stringify({ type: 'pong', timestamp: Date.now() }),
      dependencies,
    );

    expect(pongClients).toEqual(['client-heartbeat']);
  });

  test('logs only structural metadata when downstream user input handling fails', () => {
    const sentinel = 'SYNTHETIC_PRIVATE_PROMPT_7f2b1c';
    const childCode = `
      import { handleWSMessage } from ${JSON.stringify(wsHandlerModulePath)};
      const sentinel = ${JSON.stringify(sentinel)};
      const socket = { data: { id: 'audit-client' } };
      const dependencies = {
        wsManager: { handlePong() {} },
        sessions: { async get() { return { id: 'session-a' }; } },
        kory: { async handleUserInput() { throw new Error('synthetic downstream failure'); } },
        providers: {},
      };
      await handleWSMessage(
        socket,
        JSON.stringify({
          type: 'user_input',
          sessionId: 'session-a',
          selection: 'answer',
          text: sentinel,
          questionId: 'q',
        }),
        dependencies,
      );
    `;
    const home = mkdtempSync(join(tmpdir(), 'kory-ws-audit-'));
    mkdirSync(join(home, 'tmp'));
    mkdirSync(join(home, 'project'));
    const child = (() => {
      try {
        return spawnSync(process.execPath, ['--no-env-file', '-e', childCode], {
          cwd: process.cwd(),
          env: {
            ...createIsolatedTestEnvironment(
              { ...process.env, KORY_RUN_LIVE_PROVIDER_TESTS: '0' },
              home,
            ),
            DATABASE_URL: `sqlite:${join(home, 'db', 'audit.db')}`,
          },
          encoding: 'utf8',
          timeout: 5_000,
        });
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    })();
    const output = `${child.stdout ?? ''}${child.stderr ?? ''}`;

    expect(child.error).toBeUndefined();
    expect(child.status, output).toBe(0);
    expect(output).not.toContain(sentinel);
    expect(output).not.toContain('synthetic downstream failure');
    expect(output).not.toContain('"raw"');
    expect(output).toContain('"messageType":"user_input"');
    expect(output).toContain('"messageBytes":');
    expect(output).toContain('"errorType":"Error"');
  });
});
