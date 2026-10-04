// Subprocess-only fixture: SDK/context mocks must not leak into other providers.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mock } from 'bun:test';
import type { CodebuffClientOptions, RunOptions } from '@codebuff/sdk';
import type { ToolContext } from '../../tools/registry';

const scenario = process.argv[2];
const settingsModule = await import('../../agent-settings');
const settings = {
  ...settingsModule.DEFAULT_AGENT_SETTINGS,
  permissionMode: 'yolo' as const,
  toolBlocklist: scenario === 'blocked' ? ['write_file'] : [],
  toolPermissionsByTier:
    scenario === 'rejected' ? { yolo: { allow: [], block: [], ask: ['write_file'] } } : {},
};
mock.module('../../agent-settings', () => ({
  ...settingsModule,
  loadAgentSettingsForSession: (cwd: string, sessionId: string) => {
    assert.equal(cwd, process.env.PROJECT_ROOT);
    assert.equal(sessionId, 'host-session');
    return settings;
  },
}));

let constructorOptions: CodebuffClientOptions;
let runOptions: RunOptions & CodebuffClientOptions;
let invocationOutput: unknown;
let approvals = 0;
let executions = 0;
let executedContext: ToolContext | undefined;
const calls: string[] = [];
const { ToolRegistry } = await import('../../tools/registry');
const registry = new ToolRegistry();
registry.register({
  name: 'write_file',
  description: 'Fixture write (no filesystem side effects)',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
  },
  async run(ctx, call) {
    executions++;
    executedContext = ctx;
    return {
      callId: call.id,
      name: call.name,
      output: scenario === 'tool-error' ? 'host tool failed' : 'host-owned write output',
      isError: scenario === 'tool-error',
      durationMs: 0,
    };
  },
});
mock.module('../../context', () => ({
  getContext: () => ({
    goals: { list: async () => [] },
    tools: {
      execute: async (ctx: ToolContext, call: Parameters<ToolRegistry['execute']>[1]) => {
        calls.push(call.name);
        return registry.execute(ctx, call);
      },
    },
    kory: {
      requestToolApproval: async (sessionId: string) => {
        assert.equal(sessionId, 'host-session');
        approvals++;
        return 'Reject';
      },
    },
  }),
}));
mock.module('@codebuff/sdk', () => ({
  CodebuffClient: class {
    constructor(options: CodebuffClientOptions) {
      constructorOptions = options;
    }
    async run(options: RunOptions & CodebuffClientOptions) {
      runOptions = options;
      assert.ok(existsSync(constructorOptions.cwd!));
      if (scenario === 'throws') throw new Error('SDK transport failed');
      if (scenario === 'error-output')
        return { output: { type: 'error', message: 'store agent failed' } };
      if (scenario !== 'config') {
        invocationOutput = await constructorOptions.overrideTools!.write_file!({
          path: 'result.txt',
          content: 'fixture',
          instructions: 'write fixture',
        });
      }
      return { output: { type: 'lastMessage', value: [] } };
    }
  },
  getCustomToolDefinition: () => {
    throw new Error('Do not pretend custom tools extend the pinned store agent');
  },
}));

const { CodebuffProvider, CODEBUFF_BASE_AGENT, CODEBUFF_NOTES_UNAVAILABLE } =
  await import('../codebuff');
const provider = new CodebuffProvider({ name: 'codebuff', apiKey: 'test-codebuff-key' });
const events = [];
const signal = new AbortController().signal;
for await (const event of provider.streamResponse({
  model: CODEBUFF_BASE_AGENT,
  sessionId: 'host-session',
  workingDirectory: process.env.PROJECT_ROOT,
  harnessRole: 'worker',
  permissionMode: scenario === 'plan' ? 'plan' : undefined,
  messages: [{ role: 'user', content: 'Hello' }],
  systemPrompt: 'Host instructions',
  signal,
}))
  events.push(event);

assert.equal(constructorOptions!.apiKey, 'test-codebuff-key');
assert.notEqual(constructorOptions!.cwd, process.env.PROJECT_ROOT);
assert.equal(existsSync(constructorOptions!.cwd!), false, 'disposable workspace must be removed');
assert.deepEqual(constructorOptions!.fileFilter!('/secret.txt'), { status: 'blocked' });
assert.equal(runOptions!.agent, CODEBUFF_BASE_AGENT);
assert.equal(runOptions!.signal, signal);
assert.equal(runOptions!.prompt, 'Hello');
assert.match(constructorOptions!.knowledgeFiles!['knowledge.md'], /Host instructions/);
assert.ok(constructorOptions!.knowledgeFiles!['knowledge.md'].includes(CODEBUFF_NOTES_UNAVAILABLE));
assert.ok(provider.getModelDiscoveryError()!.includes(CODEBUFF_NOTES_UNAVAILABLE));
for (const options of [constructorOptions!, runOptions!]) {
  assert.equal(
    options.customToolDefinitions,
    undefined,
    'unused tool definitions are not Notes support',
  );
  assert.equal(options.agentDefinitions, undefined, 'do not silently replace the store agent');
}
assert.equal(
  calls.some((name) => name.includes('note')),
  false,
);
if (scenario === 'throws' || scenario === 'error-output') {
  assert.equal(
    events.some((event) => event.type === 'complete'),
    false,
  );
  assert.match(
    events.find((event) => event.type === 'error')!.error!,
    scenario === 'throws' ? /SDK transport failed/ : /store agent failed/,
  );
} else {
  assert.equal(events.at(-1)!.type, 'complete');
  if (scenario === 'allow' || scenario === 'tool-error') {
    assert.equal(executions, 1);
    assert.equal(executedContext!.sessionId, 'host-session');
    assert.equal(executedContext!.agentId, 'codebuff:worker');
    assert.equal(executedContext!.activeProvider, 'codebuff');
    assert.equal(executedContext!.workingDirectory, process.env.PROJECT_ROOT);
    assert.match(
      JSON.stringify(invocationOutput),
      scenario === 'tool-error' ? /host tool failed/ : /host-owned write output/,
    );
  } else if (scenario !== 'config') {
    assert.equal(executions, 0, 'denied calls must not reach the tool handler');
    assert.deepEqual(calls, ['write_file']);
    assert.match(JSON.stringify(invocationOutput), /blocked|disabled|denied|reject|plan/i);
  }
}
assert.equal(approvals, scenario === 'rejected' ? 1 : 0);
console.log(`PASS ${scenario}`);
