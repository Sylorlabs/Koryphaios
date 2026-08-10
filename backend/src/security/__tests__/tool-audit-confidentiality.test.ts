import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { summarizeBashCommandForAudit, summarizeToolErrorForAudit } from '../bash-sandbox';

const SENTINEL = 'SYNTHETIC_PRIVATE_TOOL_AUDIT_7ea9';

describe('tool and command audit confidentiality', () => {
  test('summaries retain only structural command and error identity', () => {
    const command = `printf -- ${SENTINEL}`;
    const commandAudit = summarizeBashCommandForAudit(command);
    const errorAudit = summarizeToolErrorForAudit(new Error(SENTINEL));
    const serialized = JSON.stringify({ commandAudit, errorAudit });

    expect(commandAudit).toMatchObject({
      executable: 'printf',
      category: 'other',
      argCount: 2,
      commandBytes: Buffer.byteLength(command),
    });
    expect(commandAudit.commandDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(errorAudit).toMatchObject({ errorClass: 'Error', errorCode: 'UNKNOWN' });
    expect(errorAudit.errorFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(serialized).not.toContain(SENTINEL);
    expect(summarizeBashCommandForAudit('env')).toMatchObject({
      executable: 'env',
      argCount: 0,
    });
    expect(summarizeBashCommandForAudit('NODE_ENV=test npm start')).toMatchObject({
      executable: 'npm',
      category: 'package-build',
      argCount: 1,
    });
  });

  test('keeps allow, deny, background, registration, preflight, and tool-throw sentinels out of actual sinks', () => {
    const childCode = `
      import {
        auditBashCommand,
        logBackgroundRegistrationFailure,
        logBashExecutionAudit,
      } from './backend/src/security/bash-sandbox.ts';
      import { ToolRegistry } from './backend/src/tools/registry.ts';

      const sentinel = ${JSON.stringify(SENTINEL)};
      auditBashCommand('printf -- ' + sentinel, {
        cwd: '/tmp/synthetic-audit-project',
        toolCallId: 'allow-call',
        sessionId: 'audit-session',
        isSandboxed: false,
        allowed: true,
      });
      auditBashCommand('curl https://example.invalid/?opaque=' + sentinel, {
        cwd: '/tmp/synthetic-audit-project',
        toolCallId: 'deny-call',
        sessionId: 'audit-session',
        isSandboxed: true,
        allowed: false,
        decisionCode: 'BLOCKED_NETWORK_TOOL',
      });
      logBashExecutionAudit('node --opaque ' + sentinel, {
        cwd: '/tmp/synthetic-audit-project',
        phase: 'background_start',
        toolCallId: 'background-call',
        sessionId: 'audit-session',
      });
      logBackgroundRegistrationFailure({
        command: 'node --opaque ' + sentinel,
        cwd: '/tmp/synthetic-audit-project',
        error: new Error(sentinel),
        phase: 'registration_failed',
        sessionId: 'audit-session',
        toolCallId: 'registration-call',
      });

      const registry = new ToolRegistry();
      registry.register({
        name: 'synthetic_throw',
        description: 'synthetic',
        inputSchema: { type: 'object' },
        run: async () => { throw new Error(sentinel); },
      });
      registry.register({
        name: 'write_file',
        description: 'synthetic',
        inputSchema: { type: 'object' },
        run: async (_ctx, call) => ({
          callId: call.id,
          name: call.name,
          output: 'must-not-run',
          isError: false,
          durationMs: 0,
        }),
      });
      const thrown = await registry.execute(
        { sessionId: 'audit-session', workingDirectory: '/tmp' },
        { id: 'throw-call', name: 'synthetic_throw', input: { private: sentinel } },
      );
      const preflight = await registry.execute(
        {
          sessionId: 'audit-session',
          workingDirectory: '/tmp',
          preflightFileChange: async () => { throw new Error(sentinel); },
        },
        { id: 'preflight-call', name: 'write_file', input: { path: 'safe.txt', content: sentinel } },
      );
      const denied = await registry.execute(
        {
          sessionId: 'audit-session',
          workingDirectory: '/tmp',
          preflightFileChange: async () => ({ allowed: false, reason: sentinel }),
        },
        { id: 'deny-call', name: 'write_file', input: { path: 'safe.txt', content: sentinel } },
      );
      console.log(JSON.stringify({ thrown, preflight, denied }));
    `;
    const child = spawnSync(process.execPath, ['--no-env-file', '-e', childCode], {
      cwd: process.cwd(),
      env: {
        HOME: '/tmp',
        NODE_ENV: 'test',
        PATH: process.env.PATH,
      },
      encoding: 'utf8',
      timeout: 8_000,
    });
    const output = `${child.stdout ?? ''}${child.stderr ?? ''}`;

    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(output).not.toContain(SENTINEL);
    expect(output).not.toContain('"command":"');
    expect(output).not.toContain('"message":"SYNTHETIC');
    expect(output).not.toContain('"stack":');
    expect(output).toContain('"executable":"printf"');
    expect(output).toContain('"executable":"curl"');
    expect(output).toContain('"category":"network"');
    expect(output).toContain('"decision":"allowed"');
    expect(output).toContain('"decision":"blocked"');
    expect(output).toContain('"decision":"background_start"');
    expect(output).toContain('"decision":"background_registration_failed"');
    expect(output).toContain('"decision":"preflight_blocked"');
    expect(output).toContain('"decision":"preflight_denied"');
    expect(output).toContain('"decision":"tool_execution_failed"');
    expect(output).toMatch(/"commandDigest":"[a-f0-9]{64}"/);
    expect(output).toMatch(/"errorFingerprint":"[a-f0-9]{64}"/);
    expect(output).toContain('Tool execution failed safely (code: UNKNOWN; reference:');
    expect(output).toContain('Preflight check failed — tool blocked for safety.');
    expect(output).toContain('Tool change blocked by the preflight safety policy.');
    expect(Buffer.byteLength(output)).toBeLessThan(24_000);
  });

  test('manager registration path uses the content-free audit helper', () => {
    const manager = readFileSync(resolve(import.meta.dir, '../../kory/manager.ts'), 'utf8');
    const registrationSection = manager.slice(
      manager.indexOf('const bgMatch ='),
      manager.indexOf('const agenticArchiveId ='),
    );

    expect(registrationSection).toContain('logBackgroundRegistrationFailure({');
    expect(registrationSection).not.toContain('serverLog.debug(');
    expect(registrationSection).not.toContain('err instanceof Error ? err.message');
  });
});
