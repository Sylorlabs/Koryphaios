// Drives the real ClaudeCodeProvider through a recorded (synthetic) stream-json turn.
// Only the child process is replaced. The model-catalog probe and effort probe go
// through the same seam, so no real `claude` binary runs.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { ProviderConfig } from '@koryphaios/shared';
import { ClaudeCodeProvider, __resetClaudeCodeModelCacheForTesting } from '../../claude-code';
import type { ProviderEvent, StreamRequest } from '../../types';
import { createReplaySpawn } from '../replay-process';
import { loadTranscript } from '../transcript';
import { createCliSandbox, type CliSandbox } from './support';

const FIXTURE = join(import.meta.dir, '..', 'fixtures', 'claude-synthetic-turn.jsonl');
const PROMPT = 'List the files in src/ and summarise main.ts';

let sandbox: CliSandbox;

beforeAll(() => {
  sandbox = createCliSandbox(['claude']);
});

afterAll(() => {
  sandbox.dispose();
});

beforeEach(() => {
  __resetClaudeCodeModelCacheForTesting();
});

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function request(): StreamRequest {
  return {
    model: 'opus',
    systemPrompt: '',
    messages: [{ role: 'user', content: PROMPT }],
    workingDirectory: sandbox.workdir,
  };
}

describe('claude replay through ClaudeCodeProvider', () => {
  test('normalizes a recorded stream-json turn into ordered events', async () => {
    const transcript = loadTranscript(FIXTURE);
    // Only the real turn carries --include-partial-messages. Probes get no recording (exit 127).
    const spawnChild = createReplaySpawn((_command, args) =>
      args.includes('--include-partial-messages') ? transcript : null,
    );
    const provider = new ClaudeCodeProvider({ name: 'claude' } as ProviderConfig, spawnChild as never);

    const events = await collect(provider.streamResponse(request()));

    expect(events.map((event) => event.type)).toEqual([
      'cli_commands',
      'usage_update',
      'thinking_delta',
      'tool_executed',
      'thinking_delta',
      'content_delta',
      'content_delta',
      'usage_update',
      'complete',
    ]);
    expect(events[0]).toMatchObject({ type: 'cli_commands' });
    expect(events[1]).toEqual({
      type: 'usage_update',
      tokensIn: 2100,
      tokensOut: 1,
      tokensCache: 1800,
      tokensCacheRead: 1500,
      tokensCacheWrite: 300,
    });
    expect(events[2]).toEqual({
      type: 'thinking_delta',
      thinking: 'The user wants the file list, so I will run ls first.',
    });
    expect(events[3]).toEqual({
      type: 'tool_executed',
      toolName: 'Bash',
      toolInput: JSON.stringify({ command: 'ls src', description: 'List the src directory' }),
      toolOutput: 'main.ts\nroutes.ts\nserver.ts',
      isError: false,
    });
    expect(events[4]).toEqual({
      type: 'thinking_delta',
      thinking: 'main.ts is the entry point, so I will summarise it.',
    });
    expect(events[5]).toEqual({ type: 'content_delta', content: '`main.ts` starts ' });
    expect(events[6]).toEqual({ type: 'content_delta', content: 'the HTTP server and wires in the routes.' });
    expect(events[7]).toMatchObject({ type: 'usage_update', tokensIn: 2100, tokensOut: 120, tokensCacheRead: 1500 });
    expect(events[8]).toEqual({ type: 'complete', finishReason: 'end_turn' });
  });

  test('runs the turn with the stream-json argv and sends the prompt on stdin', async () => {
    const transcript = loadTranscript(FIXTURE);
    const spawnChild = createReplaySpawn((_command, args) =>
      args.includes('--include-partial-messages') ? transcript : null,
    );
    const provider = new ClaudeCodeProvider({ name: 'claude' } as ProviderConfig, spawnChild as never);
    await collect(provider.streamResponse(request()));

    const turn = spawnChild.calls.find((call) => call.args.includes('--include-partial-messages'));
    expect(turn).toBeDefined();
    expect(turn!.command).toBe('claude');
    expect(turn!.args).toEqual(
      expect.arrayContaining(['-p', '--output-format', 'stream-json', '--model', 'opus']),
    );
    expect(turn!.stdin()).toContain(PROMPT);
  });
});
