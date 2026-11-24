// Drives the real CodexCliProvider through a recorded (synthetic) `codex exec --json`
// turn. Only the child process is replaced. Argv, stdin prompt, JSONL parsing and
// event normalization all run for real.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { ProviderConfig } from '@koryphaios/shared';
import { CodexCliProvider } from '../../codex-cli';
import type { ProviderEvent, StreamRequest } from '../../types';
import { createReplaySpawn } from '../replay-process';
import { loadTranscript } from '../transcript';
import { createCliSandbox, type CliSandbox } from './support';

const FIXTURE = join(import.meta.dir, '..', 'fixtures', 'codex-synthetic-turn.jsonl');
const PROMPT = 'List the files in src/ and summarise main.ts';

let sandbox: CliSandbox;

beforeAll(() => {
  sandbox = createCliSandbox(['codex'], { '.codex/auth.json': '{}' });
});

afterAll(() => {
  sandbox.dispose();
});

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('codex replay through CodexCliProvider', () => {
  test('normalizes a recorded turn into ordered reasoning, tool, text and completion events', async () => {
    const transcript = loadTranscript(FIXTURE);
    // Only the turn process gets the recording. The model-list probe (`app-server`)
    // has no recording and exits 127, which the adapter treats as "no models".
    const spawnChild = createReplaySpawn((_command, args) =>
      args.includes('exec') ? transcript : null,
    );
    const provider = new CodexCliProvider(
      { name: 'codex' } as ProviderConfig,
      spawnChild as never,
      sandbox.home,
    );

    const request: StreamRequest = {
      model: 'gpt-5-codex',
      systemPrompt: '',
      messages: [{ role: 'user', content: PROMPT }],
      workingDirectory: sandbox.workdir,
    };
    const events = await collect(provider.streamResponse(request));

    expect(events.map((event) => event.type)).toEqual([
      'thinking_delta',
      'tool_executed',
      'thinking_delta',
      'content_delta',
      'usage_update',
      'complete',
    ]);
    expect(events[0]).toEqual({
      type: 'thinking_delta',
      thinking:
        '**Planning the listing**\n\nI need the contents of src/ before I can summarise main.ts.\n\n',
    });
    expect(events[1]).toEqual({
      type: 'tool_executed',
      toolName: 'command_execution',
      toolInput: JSON.stringify({ command: 'ls src' }),
      toolOutput: 'main.ts\nroutes.ts\nserver.ts\n',
      isError: false,
    });
    expect(events[2]).toEqual({
      type: 'thinking_delta',
      thinking:
        '**Reading the entry point**\n\nmain.ts is the likely entry point, so it is the file to summarise.\n\n',
    });
    expect(events[3]).toEqual({
      type: 'content_delta',
      content: '`main.ts` starts the HTTP server and wires in the routes from `routes.ts`.',
    });
    expect(events[4]).toMatchObject({
      type: 'usage_update',
      tokensIn: 1840,
      tokensOut: 96,
      tokensCacheRead: 1024,
      billingTokensIn: 1840,
      billingTokensOut: 96,
      estimated: true,
    });
    expect(events[5]).toEqual({ type: 'complete', finishReason: 'end_turn' });
  });

  test('spawns the turn with the codex exec argv and writes the prompt to stdin', async () => {
    const spawnChild = createReplaySpawn((_command, args) =>
      args.includes('exec') ? loadTranscript(FIXTURE) : null,
    );
    const provider = new CodexCliProvider(
      { name: 'codex' } as ProviderConfig,
      spawnChild as never,
      sandbox.home,
    );
    await collect(
      provider.streamResponse({
        model: 'gpt-5-codex',
        systemPrompt: '',
        messages: [{ role: 'user', content: PROMPT }],
        workingDirectory: sandbox.workdir,
      }),
    );

    const turn = spawnChild.calls.find((call) => call.args.includes('exec'));
    expect(turn).toBeDefined();
    expect(turn!.args).toEqual(
      expect.arrayContaining([
        'exec',
        '--json',
        '--sandbox',
        'read-only',
        '--model',
        'gpt-5-codex',
      ]),
    );
    expect(turn!.stdin()).toContain(PROMPT);
  });
});

describe('codex auth failure outranks transient event text', () => {
  test('stderr refresh-token evidence turns a "stream disconnected" turn.failed into the codex-login error', async () => {
    const transcript = {
      header: {
        provider: 'codex',
        cliVersion: 'test',
        recordedAt: '',
        argv: [],
        synthetic: true,
      },
      frames: [
        {
          t: 0,
          stream: 'stdout' as const,
          data: `${JSON.stringify({
            type: 'turn.failed',
            error: { message: 'stream disconnected before completion' },
          })}\n`,
        },
        {
          t: 5,
          stream: 'stderr' as const,
          data: 'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.\n401 token_expired\n',
        },
        { t: 10, stream: 'exit' as const, code: 1 },
      ],
    };
    const spawnChild = createReplaySpawn((_command, args) =>
      args.includes('exec') ? transcript : null,
    );
    const provider = new CodexCliProvider(
      { name: 'codex' } as ProviderConfig,
      spawnChild as never,
      sandbox.home,
    );
    const request: StreamRequest = {
      model: 'gpt-5-codex',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'say hi' }],
      workingDirectory: sandbox.workdir,
    };
    const events = await collect(provider.streamResponse(request));
    const errors = events.filter((event) => event.type === 'error').map((e) => e.error ?? '');
    expect(errors.length).toBeGreaterThan(0);
    const last = errors[errors.length - 1];
    expect(last).toContain('codex login');
    expect(last).not.toContain('transient ChatGPT disconnect');
  });
});
