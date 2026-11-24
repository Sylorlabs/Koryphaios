// Drives the real OpenCodeCliProvider through a recorded (synthetic) ACP session:
// initialize, session/new, set_config_option, session/prompt with notifications,
// then session/close. Only the child process is replaced. JSON-RPC framing, request
// ids, session/update mapping and ProviderEvent normalization run for real.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { ProviderConfig } from '@koryphaios/shared';
import { OpenCodeCliProvider } from '../../opencode-cli';
import type { ProviderEvent, StreamRequest } from '../../types';
import { createReplaySpawn } from '../replay-process';
import { loadTranscript } from '../transcript';
import { createCliSandbox, type CliSandbox } from './support';

const FIXTURE = join(import.meta.dir, '..', 'fixtures', 'opencode-synthetic-turn.jsonl');
const PROMPT = 'List the files in src/ and summarise main.ts';

let sandbox: CliSandbox;

beforeAll(() => {
  sandbox = createCliSandbox(['opencode']);
});

afterAll(() => {
  sandbox.dispose();
});

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('opencode replay through OpenCodeCliProvider (ACP)', () => {
  test('normalizes a recorded ACP session into ordered reasoning, tool, text and completion events', async () => {
    const transcript = loadTranscript(FIXTURE);
    const spawnChild = createReplaySpawn((_command, args) =>
      args[0] === 'acp' ? transcript : null,
    );
    const provider = new OpenCodeCliProvider(
      { name: 'opencode' } as ProviderConfig,
      spawnChild as never,
    );

    const request: StreamRequest = {
      model: 'opencode/test-model',
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
      'content_delta',
      'usage_update',
      'usage_update',
      'complete',
    ]);
    expect(events[0]).toEqual({
      type: 'thinking_delta',
      thinking: 'The user wants the file list. I will run ls first.',
    });
    expect(events[1]).toMatchObject({
      type: 'tool_executed',
      toolName: 'bash',
      toolInput: JSON.stringify({ command: 'ls src' }),
      toolOutput: 'main.ts\nroutes.ts\nserver.ts',
      isError: false,
    });
    expect(events[2]).toEqual({
      type: 'thinking_delta',
      thinking: 'main.ts is the entry point, so I will summarise it.',
    });
    expect(events[3]).toEqual({
      type: 'content_delta',
      content: '`main.ts` starts the HTTP server ',
    });
    expect(events[4]).toEqual({
      type: 'content_delta',
      content: 'and wires in the routes from `routes.ts`.',
    });
    expect(events[5]).toMatchObject({ type: 'usage_update', tokensIn: 3100 });
    expect(events[6]).toMatchObject({
      type: 'usage_update',
      billingTokensIn: 3100,
      billingTokensOut: 110,
    });
    expect(events[7]).toEqual({ type: 'complete', finishReason: 'end_turn' });
  });

  test('sends the ACP requests the transcript expects, with the prompt and session id', async () => {
    const transcript = loadTranscript(FIXTURE);
    const spawnChild = createReplaySpawn((_command, args) =>
      args[0] === 'acp' ? transcript : null,
    );
    const provider = new OpenCodeCliProvider(
      { name: 'opencode' } as ProviderConfig,
      spawnChild as never,
    );
    await collect(
      provider.streamResponse({
        model: 'opencode/test-model',
        systemPrompt: '',
        messages: [{ role: 'user', content: PROMPT }],
        workingDirectory: sandbox.workdir,
      }),
    );

    const acp = spawnChild.calls.find((call) => call.args[0] === 'acp');
    expect(acp).toBeDefined();
    const methods = acp!
      .stdin()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => (JSON.parse(line) as { method: string }).method);
    expect(methods).toEqual([
      'initialize',
      'session/new',
      'session/set_config_option',
      'session/prompt',
      'session/close',
    ]);
    expect(acp!.stdin()).toContain(PROMPT);
  });
});
