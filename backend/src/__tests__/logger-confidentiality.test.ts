import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { sanitizeLogMetadata } from '../logger';

// Resolve relative to this test file so the path is correct regardless of CWD.
const loggerModulePath = resolve(import.meta.dir, '../logger.ts');

const SENTINEL = 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const BASIC_SENTINEL = 'QWxhZGRpbjpPcGVuU2VzYW1l';

describe('central logger confidentiality boundary', () => {
  test('recursively redacts and bounds errors, cycles, arrays, objects, and binary values', () => {
    const cause = new Error(`authorization=Bearer ${SENTINEL}`);
    const error = new Error(`token=${SENTINEL}`, { cause });
    Object.assign(error, {
      response: { password: SENTINEL, body: `provider response ${SENTINEL}` },
    });

    const cyclic: Record<string, unknown> = {
      sessionId: 'session-safe',
      command: `provider --auth-token ${SENTINEL} --header "Authorization: Basic ${BASIC_SENTINEL}"`,
      githubToken: 'opaque-provider-credential',
      error,
      tokensIn: 42,
      output: 'x'.repeat(20_000),
      items: Array.from({ length: 100 }, (_, index) => ({ index, token: SENTINEL })),
      binary: Buffer.alloc(64),
    };
    Object.defineProperty(cyclic, '__proto__', {
      enumerable: true,
      value: { token: SENTINEL },
    });
    cyclic.self = cyclic;
    let nested = cyclic;
    for (let depth = 0; depth < 12; depth += 1) {
      const child: Record<string, unknown> = { depth };
      nested.child = child;
      nested = child;
    }
    for (let index = 0; index < 100; index += 1) cyclic[`field-${index}`] = index;

    const sanitized = sanitizeLogMetadata(cyclic);
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).not.toContain(BASIC_SENTINEL);
    expect(serialized).not.toContain('opaque-provider-credential');
    expect(serialized).toContain('[REDACTED');
    expect(serialized).toContain('[CIRCULAR]');
    expect(serialized).toContain('[MAX_DEPTH]');
    expect(serialized).toContain('more items');
    expect(serialized).toContain('_truncatedKeys');
    expect(serialized.length).toBeLessThan(40_000);
    expect(sanitized.sessionId).toBe('session-safe');
    expect(sanitized.tokensIn).toBe(42);
    expect(sanitized.binary).toEqual({ type: 'Buffer', byteLength: 64 });
    expect(Object.getPrototypeOf(sanitized)).toBeNull();
  });

  test('sanitizes raw manager-style command and Error metadata at the actual logger sink', () => {
    const childCode = `
      import { koryLog } from ${JSON.stringify(loggerModulePath)};
      const sentinel = ${JSON.stringify(SENTINEL)};
      koryLog.warn(
        { sessionId: 'session-safe', command: 'agent --token ' + sentinel, error: new Error('token=' + sentinel) },
        'Background-process wake-up failed; batch retained',
      );
      koryLog.error(
        { err: new Error('authorization=Bearer ' + sentinel), errDetail: { message: sentinel, stack: 'x'.repeat(50000) } },
        'Error in processManagerTurn',
      );
    `;
    const child = spawnSync(process.execPath, ['--no-env-file', '-e', childCode], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: 'test',
      },
      encoding: 'utf8',
      timeout: 5_000,
    });
    const output = `${child.stdout ?? ''}${child.stderr ?? ''}`;

    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(output).not.toContain(SENTINEL);
    expect(output).toContain('[REDACTED');
    expect(output).toContain('session-safe');
    expect(output).toContain('Background-process wake-up failed; batch retained');
    expect(output).toContain('Error in processManagerTurn');
    expect(Buffer.byteLength(output)).toBeLessThan(40_000);
  });
});
