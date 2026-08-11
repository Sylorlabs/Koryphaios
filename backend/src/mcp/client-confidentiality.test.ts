import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  mcpMalformedStdoutLogMetadata,
  mcpOversizedStdoutLogMetadata,
  mcpStderrLogMetadata,
} from './client';

// Resolve relative to this test file so the path is correct regardless of CWD.
const clientModulePath = resolve(import.meta.dir, 'client.ts');

describe('MCP stderr confidentiality', () => {
  test('never decodes or copies MCP-controlled stderr into log metadata', () => {
    const sentinel = 'sk-proj-MCP_CONTROLLED_SENTINEL_123456789';
    const chunk = new TextEncoder().encode(
      `provider diagnostic api_key=${sentinel}\n${'tool output '.repeat(2_000)}`,
    );
    const metadata = mcpStderrLogMetadata('fixture-server', chunk);

    expect(metadata).toEqual({
      server: 'fixture-server',
      stream: 'stderr',
      outputBytes: chunk.byteLength,
    });
    expect(JSON.stringify(metadata)).not.toContain(sentinel);
    expect(Object.keys(metadata).sort()).toEqual(['outputBytes', 'server', 'stream']);
  });

  test('never copies malformed MCP stdout or its parser error into log metadata', () => {
    const sentinel = 'SYNTHETIC_MCP_PRIVATE_OUTPUT_4e91a6';
    const error = new SyntaxError(`Unexpected token in ${sentinel}`);
    const metadata = mcpMalformedStdoutLogMetadata('fixture-server', sentinel, error);

    expect(metadata).toEqual({
      server: 'fixture-server',
      stream: 'stdout',
      outputBytes: Buffer.byteLength(sentinel),
      errorType: 'SyntaxError',
    });
    expect(JSON.stringify(metadata)).not.toContain(sentinel);
    expect(JSON.stringify(metadata)).not.toContain(error.message);
  });

  test('keeps malformed MCP stdout out of the actual logger sink', () => {
    const sentinel = 'SYNTHETIC_MCP_PRIVATE_TOOL_OUTPUT_590bed';
    const childCode = `
      import { MCPClient } from ${JSON.stringify(clientModulePath)};
      const sentinel = ${JSON.stringify(sentinel)};
      const client = new MCPClient({ name: 'fixture-server', transport: 'stdio' });
      const processHandle = { kill() {} };
      client.process = processHandle;
      client.acceptStdoutText(processHandle, sentinel + '\\n');
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
    expect(output).not.toContain(sentinel);
    expect(output).not.toContain('Unexpected token');
    expect(output).not.toContain('"line"');
    expect(output).toContain('"server":"fixture-server"');
    expect(output).toContain('"stream":"stdout"');
    expect(output).toContain('"outputBytes":');
    expect(output).toContain('"errorType":"SyntaxError"');
  });

  test('keeps oversized MCP stdout out of metadata and the actual logger sink', () => {
    const sentinel = 'SYNTHETIC_OVERSIZED_MCP_OUTPUT_b15bf4';
    const metadata = mcpOversizedStdoutLogMetadata('fixture-server', 65, 64);
    expect(metadata).toEqual({
      server: 'fixture-server',
      stream: 'stdout',
      outputBytes: 65,
      limitBytes: 64,
      reason: 'frame_too_large',
    });

    const childCode = `
      import { MCPClient } from ${JSON.stringify(clientModulePath)};
      const sentinel = ${JSON.stringify(sentinel)};
      const client = new MCPClient({ name: 'fixture-server', transport: 'stdio' });
      const processHandle = { kill() {} };
      client.process = processHandle;
      client.maxStdoutFrameBytes = 64;
      client.acceptStdoutText(processHandle, sentinel.repeat(2));
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
    expect(output).not.toContain(sentinel);
    expect(output).toContain('"reason":"frame_too_large"');
    expect(output).toContain('"limitBytes":64');
    expect(output).toContain('"outputBytes":');
  });
});
