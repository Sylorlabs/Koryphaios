import { describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import {
  OmnirushEvents,
  OmnirushCliProvider,
  OmnirushRpc,
  resolveOmnirushRuntimeBinding,
  parseOmnirushModelList,
  parseOmnirushCliCatalog,
  parseOmnirushClaudeCatalog,
  parseOmnirushClaudeAccess,
  parseOmnirushContainerArchitecture,
  parseOmnirushRpcCatalog,
  parseOmnirushThinkingLevels,
  parseOmnirushPrintTelemetry,
  parseOmnirushEngineTelemetry,
  resolveOmnirushReasoningLevel,
  resolveOmnirushTurnTimeoutMs,
  isOmnirushSeatWait,
  updateOmnirushCli,
} from '../omnirush-cli';
import { createOmnirushKoryToolsArtifact } from '../omnirush-kory-tools';
import { createKoryBridgeGrantLease, verifySignedBridgeRequest } from '../bridge-grant';

describe('Omnirush CLI turn timeout budgeting', () => {
  it('uses the host-owned sandbox deadline when one is provided', () => {
    expect(resolveOmnirushTurnTimeoutMs({ sandbox: { maxRuntimeSeconds: 900 } as never })).toBe(
      900_000,
    );
    expect(resolveOmnirushTurnTimeoutMs({ sandbox: { maxRuntimeSeconds: 0 } as never })).toBe(
      300_000,
    );
    expect(resolveOmnirushTurnTimeoutMs({ sandbox: undefined })).toBe(300_000);
  });
});

describe('Omnirush CLI catalog parsing', () => {
  it('maps the container daemon architecture to the published helper package', () => {
    expect(parseOmnirushContainerArchitecture('x86_64')).toBe('amd64');
    expect(parseOmnirushContainerArchitecture('aarch64')).toBe('arm64');
    expect(parseOmnirushContainerArchitecture('unknown')).toBeNull();
  });

  it('does not retain the retired MCP-disabled failure path', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'omnirush-cli.ts'), 'utf8');
    expect(source).not.toContain('Omnirush 2.x disables MCP');
    expect(source).not.toContain('Kory tools are unavailable with this CLI');
    expect(source).toContain('createOmnirushKoryToolsArtifact');
  });

  it('does not use the packaged internal engine as the provider launcher', () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'kory-omnirush-engine-'));
    const internalBin = join(
      testRoot,
      'node_modules',
      '@omnirush-ai',
      'cli-darwin-arm64',
      'bin',
      'omnirush',
    );
    try {
      mkdirSync(join(internalBin, '..'), { recursive: true, mode: 0o700 });
      writeFileSync(internalBin, `#!${process.execPath}\n`, { mode: 0o700 });
      chmodSync(internalBin, 0o700);
      expect(() =>
        resolveOmnirushRuntimeBinding({
          pathEnv: join(testRoot, 'node_modules', '@omnirush-ai', 'cli-darwin-arm64', 'bin'),
          stateRoot: testRoot,
        }),
      ).toThrow('repository-supported launcher is unavailable');
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('parses the current OpenCode-era catalog cached by the CLI', () => {
    const models = parseOmnirushCliCatalog({
      gateway: 'https://omnirush.ai/omnirush/v1',
      payload: {
        data: [
          {
            id: 'gpt-6-astra',
            display_name: 'GPT 6 Astra',
            reasoning_levels: ['low', 'high', 'xhigh', 'max'],
            limits: { context: 400_000, output: 128_000 },
            capabilities: { reasoning: true, tool_call: true, image_input: true },
          },
        ],
      },
    });
    expect(models[0]).toMatchObject({
      id: 'gpt-6-astra',
      contextWindow: 400_000,
      maxOutputTokens: 128_000,
      reasoningLevels: ['low', 'high', 'xhigh', 'max'],
      vision: true,
      supportsStreaming: true,
    });
  });

  it('keeps every Claude picker model visible independently of account eligibility', () => {
    const models = parseOmnirushClaudeCatalog({
      offered: false,
      catalog: [
        { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
        { id: 'claude-opus-5-5', name: 'duplicate' },
        { id: 'not-a-claude-model', name: 'ignored' },
      ],
    });
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: 'claude-opus-5-5',
      apiModelId: 'claude-opus-5-5',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      supportsStreaming: true,
      functionCall: true,
    });
  });

  it('keeps the Claude catalog visible while exposing server entitlement separately', () => {
    expect(
      parseOmnirushClaudeAccess({
        offered: false,
        catalog: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5', allowed: false }],
      }),
    ).toEqual({ offered: false, allowedModels: [], reason: 'not_allowed' });
    expect(
      parseOmnirushClaudeAccess({
        offered: true,
        catalog: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5', allowed: true }],
      }),
    ).toEqual({ offered: true, allowedModels: ['claude-opus-5-5'], reason: null });
  });

  it('uses the installed CLI table as the source of model capabilities', () => {
    const models = parseOmnirushModelList(`
provider  model                       context  max-out  thinking  images
omnirush  future-model                512K     32K      yes       yes
omnirush  text-model                  128K     8K       no        no
other     ignored-model               1M       1K       yes       yes
`);

    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      apiModelId: 'future-model',
      contextWindow: 512 * 1024,
      maxOutputTokens: 32 * 1024,
      canReason: true,
      supportsAttachments: true,
      contextVerified: true,
    });
    expect(models[1]).toMatchObject({
      apiModelId: 'text-model',
      contextWindow: 128 * 1024,
      maxOutputTokens: 8 * 1024,
      canReason: false,
      supportsAttachments: false,
    });
  });

  it('derives thinking choices from the installed CLI help output', () => {
    expect(
      parseOmnirushThinkingLevels(
        '  --thinking <level> Set thinking level: off, minimal, low, medium, high, xhigh, max\n',
      ),
    ).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('maps exact structured metadata from the CLI RPC catalog', () => {
    const models = parseOmnirushRpcCatalog([
      {
        provider: 'omnirush',
        id: 'future-model',
        name: 'Future Model',
        reasoning: true,
        thinkingLevelMap: { low: 'low', max: 'max' },
        input: ['text', 'image'],
        contextWindow: 600_000,
        maxTokens: 20_000,
      },
    ]);
    expect(models[0]).toMatchObject({
      apiModelId: 'future-model',
      name: 'Future Model',
      contextWindow: 600_000,
      maxOutputTokens: 20_000,
      reasoningLevels: ['low', 'max'],
      supportsAttachments: true,
    });
  });

  it('accepts array-shaped effort metadata from newer CLI builds', () => {
    const models = parseOmnirushRpcCatalog([
      {
        provider: 'omnirush',
        id: 'future-model',
        reasoning: true,
        supportedReasoningEfforts: ['low', 'high'],
      },
    ]);
    expect(models[0]?.reasoningLevels).toEqual(['low', 'high']);
  });

  it('accepts the current CLI catalog field shapes for limits and efforts', () => {
    const models = parseOmnirushRpcCatalog([
      {
        provider: 'omnirush',
        id: 'gpt-6-astra',
        name: 'GPT 6 Astra',
        reasoning: true,
        thinkingLevelMap: {
          minimal: 'minimal',
          low: 'low',
          medium: 'medium',
          high: 'high',
          xhigh: 'xhigh',
          max: 'max',
        },
        input: ['text', 'image'],
        contextWindow: '400000',
        maxTokens: '16384',
      },
    ]);
    expect(models[0]).toMatchObject({
      contextWindow: 400_000,
      contextVerified: true,
      maxOutputTokens: 16_384,
      reasoningLevels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      vision: true,
    });
    expect(models[0]?.reasoningVariants?.minimal).toBe('off');
  });

  it('preserves and resolves provider-specific reasoning states without standardizing them', () => {
    const model = parseOmnirushRpcCatalog([
      {
        provider: 'omnirush',
        id: 'custom-reasoner',
        reasoning: true,
        thinkingLevelMap: {
          focused: 'deliberate-v2',
          'deep-plus': 'deep-plus-native',
        },
      },
    ])[0]!;

    expect(model.reasoningLevels).toEqual(['focused', 'deep-plus']);
    expect(model.reasoningVariants).toEqual({
      focused: 'deliberate-v2',
      'deep-plus': 'deep-plus-native',
    });
    expect(resolveOmnirushReasoningLevel(model, 'FOCUSED')).toBe('deliberate-v2');
    expect(resolveOmnirushReasoningLevel(model, 'deep-plus-native')).toBe('deep-plus-native');
  });

  it('handles the current message and agent_settled completion events', () => {
    const events = new OmnirushEvents('gpt-6-astra');
    expect(
      events.accept({
        type: 'message',
        message: {
          role: 'assistant',
          provider: 'omnirush',
          model: 'gpt-6-astra',
          content: [{ type: 'text', text: 'ok' }],
          stopReason: 'stop',
          usage: { input: 12, output: 2 },
        },
      }),
    ).toEqual(
      expect.arrayContaining([
        { type: 'content_delta', content: 'ok' },
        expect.objectContaining({ type: 'usage_update', tokensIn: 12, tokensOut: 2 }),
      ]),
    );
    expect(events.accept({ type: 'agent_settled' })).toEqual([]);
    expect(events.complete).toBe(true);
    expect(events.failed).toBe(false);
  });

  it('accepts only provider-reported print telemetry, including context and cache fields', () => {
    expect(
      parseOmnirushPrintTelemetry({
        info: {
          modelID: 'gpt-6-astra',
          tokens: { input: 41, output: 9, cache: { read: 7, write: 3 } },
        },
      }),
    ).toEqual({
      model: 'gpt-6-astra',
      usage: { input: 41, output: 9, cacheRead: 7, cacheWrite: 3 },
    });
    expect(parseOmnirushPrintTelemetry({ info: { tokens: { input: '41' } } })).toBeNull();
    expect(
      parseOmnirushPrintTelemetry({ part: { id: 'p1', type: 'text', text: 'hello' } }),
    ).toEqual({
      text: 'hello',
      partId: 'p1',
    });
  });

  it('parses normal-engine idle and completed Kory tool telemetry without terminal output', () => {
    expect(
      parseOmnirushEngineTelemetry({
        type: 'message.part.updated',
        part: {
          id: 'tool-1',
          type: 'tool',
          tool: 'kory__notes_search',
          state: { status: 'completed', input: { query: 'x' }, output: 'ok' },
        },
      }),
    ).toMatchObject({
      toolActivity: true,
      tool: { id: 'tool-1', name: 'kory__notes_search', input: { query: 'x' }, output: 'ok' },
    });
    expect(parseOmnirushEngineTelemetry({ type: 'session.idle' })).toEqual({ complete: true });
    expect(
      parseOmnirushEngineTelemetry({
        type: 'session.error',
        properties: { error: 'Claude sandbox unavailable' },
      }),
    ).toEqual({ error: 'Claude sandbox unavailable' });
  });

  it('marks Omnirush temporary API outages as retryable', () => {
    const events = new OmnirushEvents('gpt-6-astra');
    const [event] = events.accept({
      type: 'error',
      error:
        'omnirush API error (426): 426 Omnirush is briefly unavailable and could not complete this request (tried 1 time, waited 1s) — please retry in a moment. [ref omr-b2b64215]',
    });

    expect(event).toMatchObject({ type: 'error', errorTransient: true });
  });

  it('turns a seat-queue status into a non-terminal waiting event', () => {
    const events = new OmnirushEvents('gpt-6-astra');
    expect(
      events.accept({
        type: 'kory_waiting',
        waitingReason: 'Waiting for an Omnirush seat',
      }),
    ).toEqual([{ type: 'waiting', waitingReason: 'Waiting for an Omnirush seat' }]);
    expect(events.failed).toBe(false);
    expect(events.complete).toBe(false);
  });

  it('recognizes the CLI seat-wait wording without classifying other queue text', () => {
    expect(isOmnirushSeatWait('Waiting for a seat…')).toBe(true);
    expect(isOmnirushSeatWait('Waiting for an available seat')).toBe(true);
    expect(isOmnirushSeatWait('Waiting for the model response')).toBe(false);
  });

  it('writes the per-turn MCP file inside the CLI-owned state root and removes it on close', async () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'kory-omnirush-rpc-'));
    const stateRoot = join(testRoot, 'omnirush-state');
    const fakeBinary = join(testRoot, 'omnirush');
    try {
      writeFileSync(
        fakeBinary,
        `#!${process.execPath}
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
send({ type: "kory_ready" });
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (const line of buffer.split("\\n").slice(0, -1)) {
    const request = JSON.parse(line);
    if (request.type === "get_available_models") {
      send({ type: "response", id: request.id, success: true, data: { models: [] } });
    }
  }
  buffer = buffer.slice(buffer.lastIndexOf("\\n") + 1);
});
`,
        { mode: 0o700 },
      );
      chmodSync(fakeBinary, 0o700);
      mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
      writeFileSync(join(stateRoot, 'auth.json'), '{}', { mode: 0o600 });

      const previousStateRoot = process.env.OMNIRUSH_DIR;
      process.env.OMNIRUSH_DIR = stateRoot;
      try {
        const rpc = new OmnirushRpc(fakeBinary, {
          model: 'gpt-6-astra',
          messages: [],
          systemPrompt: '',
          sessionId: 'omnirush-storage-test',
          tools: [],
        });
        try {
          await rpc.ready;
          await rpc.call('get_available_models');
          const mcpPath = join(stateRoot, 'mcp.json');
          expect(mcpPath.startsWith(testRoot)).toBe(true);
          expect(JSON.parse(readFileSync(mcpPath, 'utf8'))).toHaveProperty('mcpServers.kory');
        } finally {
          await rpc.close();
        }
      } finally {
        if (previousStateRoot === undefined) delete process.env.OMNIRUSH_DIR;
        else process.env.OMNIRUSH_DIR = previousStateRoot;
      }

      expect(existsSync(join(stateRoot, 'mcp.json'))).toBe(false);
      expect(existsSync(join(stateRoot, '.mcp.json.kory-write-'))).toBe(false);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('serializes legacy RPC MCP config ownership across overlapping children', async () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'kory-omnirush-rpc-serial-'));
    const stateRoot = join(testRoot, 'omnirush-state');
    const fakeBinary = join(testRoot, 'omnirush');
    const previousStateRoot = process.env.OMNIRUSH_DIR;
    let first: OmnirushRpc | undefined;
    let second: OmnirushRpc | undefined;
    try {
      mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
      writeFileSync(join(stateRoot, 'auth.json'), '{}', { mode: 0o600 });
      writeFileSync(join(stateRoot, 'mcp.json'), '{"original":true}', { mode: 0o600 });
      writeFileSync(
        fakeBinary,
        `#!${process.execPath}
setInterval(() => {}, 1000);
`,
        { mode: 0o700 },
      );
      chmodSync(fakeBinary, 0o700);
      process.env.OMNIRUSH_DIR = stateRoot;

      first = new OmnirushRpc(fakeBinary, {
        model: 'gpt-6-astra',
        messages: [],
        systemPrompt: '',
        sessionId: 'omnirush-serial-first',
        tools: [],
      });
      await first.ready;
      second = new OmnirushRpc(fakeBinary, {
        model: 'gpt-6-astra',
        messages: [],
        systemPrompt: '',
        sessionId: 'omnirush-serial-second',
        tools: [],
      });
      let secondReady = false;
      void second.ready.then(() => {
        secondReady = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(secondReady).toBe(false);

      await first.close();
      await second.ready;
      expect(JSON.parse(readFileSync(join(stateRoot, 'mcp.json'), 'utf8'))).toHaveProperty(
        'mcpServers.kory',
      );
      await second.close();
      expect(readFileSync(join(stateRoot, 'mcp.json'), 'utf8')).toBe('{"original":true}');
    } finally {
      await first?.close();
      await second?.close();
      if (previousStateRoot === undefined) delete process.env.OMNIRUSH_DIR;
      else process.env.OMNIRUSH_DIR = previousStateRoot;
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('runs the CLI-owned self-update command through the bounded provider environment', async () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'kory-omnirush-update-'));
    const fakeBinary = join(testRoot, 'omnirush');
    const marker = join(testRoot, 'updated');
    try {
      writeFileSync(
        fakeBinary,
        `#!${process.execPath}
import { writeFileSync } from 'node:fs';
if (process.argv.includes('update') && process.argv.includes('--self')) {
  writeFileSync(${JSON.stringify(marker)}, process.env.OMNIRUSH_DIR || '');
  process.exit(0);
}
process.exit(1);
`,
        { mode: 0o700 },
      );
      chmodSync(fakeBinary, 0o700);

      const updated = await updateOmnirushCli(fakeBinary, join(testRoot, 'state'));

      expect(updated).toBe(true);
      expect(readFileSync(marker, 'utf8')).toBe(join(testRoot, 'state'));
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('lets a cancelled request stop waiting without releasing the shared updater', async () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'kory-omnirush-update-cancel-'));
    const fakeBinary = join(testRoot, 'omnirush');
    const started = join(testRoot, 'started');
    const previousStateRoot = process.env.OMNIRUSH_DIR;
    try {
      writeFileSync(
        fakeBinary,
        `#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(started)}, 'started\\n');
setTimeout(() => process.exit(0), 80);
`,
        { mode: 0o700 },
      );
      chmodSync(fakeBinary, 0o700);
      const stateRoot = join(testRoot, 'state');
      process.env.OMNIRUSH_DIR = stateRoot;
      const controller = new AbortController();
      const startedAt = Date.now();
      const cancelled = updateOmnirushCli(fakeBinary, stateRoot, controller.signal);
      setTimeout(() => controller.abort(), 10);
      await expect(cancelled).rejects.toThrow('cancelled');
      expect(Date.now() - startedAt).toBeLessThan(70);

      // A second caller shares the still-live updater instead of starting a
      // competing self-update after the first request stops waiting.
      await expect(updateOmnirushCli(fakeBinary, stateRoot)).resolves.toBe(true);
      expect(readFileSync(started, 'utf8')).toBe('started\n');
    } finally {
      if (previousStateRoot === undefined) delete process.env.OMNIRUSH_DIR;
      else process.env.OMNIRUSH_DIR = previousStateRoot;
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('keeps the self-update lock held until a timed-out updater exits', async () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'kory-omnirush-update-timeout-'));
    const fakeBinary = join(testRoot, 'omnirush');
    const pidMarker = join(testRoot, 'pid');
    const stateRoot = join(testRoot, 'state');
    const previousStateRoot = process.env.OMNIRUSH_DIR;
    const originalSetTimeout = globalThis.setTimeout;
    const originalProcessKill = process.kill;
    let pid: number | undefined;
    try {
      writeFileSync(
        fakeBinary,
        `#!${process.execPath}
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(pidMarker)}, String(process.pid));
setInterval(() => {}, 1000);
`,
        { mode: 0o700 },
      );
      chmodSync(fakeBinary, 0o700);
      process.env.OMNIRUSH_DIR = stateRoot;
      globalThis.setTimeout = ((
        callback: (...args: any[]) => void,
        delay?: number,
        ...args: any[]
      ) =>
        originalSetTimeout(callback, delay === 120_000 ? 15 : delay, ...args)) as typeof setTimeout;
      process.kill = ((target: number, signal?: NodeJS.Signals | number) => {
        if (target < 0 && signal === 'SIGKILL') return true;
        return originalProcessKill(target, signal);
      }) as typeof process.kill;

      const update = updateOmnirushCli(fakeBinary, stateRoot);
      const deadline = Date.now() + 500;
      while (!existsSync(pidMarker) && Date.now() < deadline)
        await new Promise((resolve) => originalSetTimeout(resolve, 2));
      pid = Number(readFileSync(pidMarker, 'utf8'));
      const state = await Promise.race([
        update.then(() => 'settled'),
        new Promise<'alive'>((resolve) => originalSetTimeout(() => resolve('alive'), 40)),
      ]);
      expect(state).toBe('alive');

      originalProcessKill(pid, 'SIGKILL');
      await expect(update).resolves.toBe(false);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      process.kill = originalProcessKill;
      if (pid) {
        try {
          originalProcessKill(pid, 'SIGKILL');
        } catch {
          // The updater already exited.
        }
      }
      if (previousStateRoot === undefined) delete process.env.OMNIRUSH_DIR;
      else process.env.OMNIRUSH_DIR = previousStateRoot;
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('retries catalog discovery after updating a CLI that fails its RPC startup', async () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'kory-omnirush-recovery-'));
    const stateRoot = join(testRoot, 'state');
    const fakeBinary = join(testRoot, 'omnirush');
    const updateMarker = join(testRoot, 'updated');
    const previousPath = process.env.PATH;
    const previousStateRoot = process.env.OMNIRUSH_DIR;
    try {
      mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
      writeFileSync(join(stateRoot, 'auth.json'), '{}', { mode: 0o600 });
      writeFileSync(
        fakeBinary,
        `#!${process.execPath}
import { existsSync, writeFileSync } from 'node:fs';
const marker = ${JSON.stringify(updateMarker)};
if (process.argv.includes('update')) {
  writeFileSync(marker, 'updated');
  process.exit(0);
}
if (!existsSync(marker)) process.exit(1);
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (const line of buffer.split("\\n").slice(0, -1)) {
    const request = JSON.parse(line);
    if (request.type === "get_available_models") {
      send({ type: "response", id: request.id, success: true, data: { models: [{ provider: "omnirush", id: "recovered", name: "Recovered", reasoning: false, contextWindow: 400000, maxTokens: 16384, input: ["text"] }] } });
    }
  }
  buffer = buffer.slice(buffer.lastIndexOf("\\n") + 1);
});
`,
        { mode: 0o700 },
      );
      chmodSync(fakeBinary, 0o700);
      process.env.PATH = testRoot;
      process.env.OMNIRUSH_DIR = stateRoot;

      const provider = new OmnirushCliProvider({ name: 'omnirush', disabled: false });
      const models = await provider.refreshModels(true);

      expect(existsSync(updateMarker)).toBe(true);
      expect(models.map((model) => model.id)).toEqual(['recovered']);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousStateRoot === undefined) delete process.env.OMNIRUSH_DIR;
      else process.env.OMNIRUSH_DIR = previousStateRoot;
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('uses the current print engine for an inference-only turn', async () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'kory-omnirush-print-'));
    const stateRoot = join(testRoot, 'state');
    const fakeBinary = join(testRoot, 'omnirush');
    const previousPath = process.env.PATH;
    const previousStateRoot = process.env.OMNIRUSH_DIR;
    try {
      mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
      writeFileSync(join(stateRoot, 'auth.json'), '{}', { mode: 0o600 });
      writeFileSync(
        join(stateRoot, 'model-catalog.json'),
        JSON.stringify({
          payload: {
            data: [
              {
                id: 'gpt-6-astra',
                display_name: 'GPT 6 Astra',
                reasoning_levels: ['low', 'high'],
                limits: { context: 400_000, output: 128_000 },
                capabilities: { reasoning: true, tool_call: false, image_input: false },
              },
            ],
          },
        }),
        { mode: 0o600 },
      );
      writeFileSync(
        fakeBinary,
        `#!${process.execPath}
if (process.argv.includes('--print')) {
  const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
  if (config.permission?.['*'] !== 'deny') process.exit(23);
  process.stdout.write('KORY_PRINT_OK\\n');
}
else process.exit(1);
`,
        { mode: 0o700 },
      );
      chmodSync(fakeBinary, 0o700);
      process.env.PATH = testRoot;
      process.env.OMNIRUSH_DIR = stateRoot;

      const provider = new OmnirushCliProvider({ name: 'omnirush', disabled: false });
      const events = [];
      for await (const event of provider.streamResponse({
        model: 'gpt-6-astra',
        messages: [{ role: 'user', content: 'Say KORY_PRINT_OK.' }],
        systemPrompt: '',
        nativeToolsDisabled: true,
      })) {
        events.push(event);
      }
      expect(events).toEqual([
        { type: 'content_delta', content: 'KORY_PRINT_OK' },
        { type: 'complete', finishReason: 'end_turn' },
      ]);
      const unsupportedEvents = [];
      for await (const event of provider.streamResponse({
        model: 'gpt-6-astra',
        messages: [{ role: 'user', content: 'Use an unsupported level.' }],
        systemPrompt: '',
        reasoningLevel: 'unsupported',
        nativeToolsDisabled: true,
      })) {
        unsupportedEvents.push(event);
      }
      expect(unsupportedEvents).toEqual([
        expect.objectContaining({
          type: 'error',
          error: expect.stringContaining('does not advertise that reasoning level'),
        }),
      ]);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousStateRoot === undefined) delete process.env.OMNIRUSH_DIR;
      else process.env.OMNIRUSH_DIR = previousStateRoot;
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('keeps a provider turn on the launcher captured before PATH changes', async () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'kory-omnirush-binding-'));
    const launcherA = join(testRoot, 'a', 'omnirush');
    const launcherB = join(testRoot, 'b', 'omnirush');
    const stateRoot = join(testRoot, 'state');
    const used = join(testRoot, 'used.log');
    const previousPath = process.env.PATH;
    try {
      mkdirSync(join(testRoot, 'a'), { recursive: true, mode: 0o700 });
      mkdirSync(join(testRoot, 'b'), { recursive: true, mode: 0o700 });
      mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
      writeFileSync(join(stateRoot, 'auth.json'), '{}', { mode: 0o600 });
      writeFileSync(
        join(stateRoot, 'model-catalog.json'),
        JSON.stringify({
          payload: {
            data: [
              {
                id: 'gpt-6-astra',
                limits: { context: 400_000, output: 128_000 },
                capabilities: { reasoning: false, tool_call: false, image_input: false },
              },
            ],
          },
        }),
        { mode: 0o600 },
      );
      for (const [launcher, label] of [
        [launcherA, 'A'],
        [launcherB, 'B'],
      ] as const) {
        writeFileSync(
          launcher,
          `#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(used)}, '${label}:' + process.argv.slice(2).join(' ') + '\\n');
if (process.argv.includes('--version')) process.stdout.write('omnirush ${label}\\n');
else if (process.argv.includes('whoami')) process.stdout.write('verified\\n');
else if (process.argv.includes('--print')) process.stdout.write('${label}\\n');
else process.exit(1);
`,
          { mode: 0o700 },
        );
        chmodSync(launcher, 0o700);
      }

      process.env.PATH = join(testRoot, 'a');
      const binding = resolveOmnirushRuntimeBinding({ stateRoot });
      expect(binding.binary).toBe(launcherA);
      process.env.PATH = join(testRoot, 'b');

      const provider = new OmnirushCliProvider({ name: 'omnirush', disabled: false }, binding);
      const events = [];
      for await (const event of provider.streamResponse({
        model: 'gpt-6-astra',
        messages: [{ role: 'user', content: 'Use A.' }],
        systemPrompt: '',
        nativeToolsDisabled: true,
      })) {
        events.push(event);
      }

      expect(events).toEqual([
        { type: 'content_delta', content: 'A' },
        { type: 'complete', finishReason: 'end_turn' },
      ]);
      expect(readFileSync(used, 'utf8')).toContain('A:--version');
      expect(readFileSync(used, 'utf8')).toContain('A:--model gpt-6-astra --print');
      expect(readFileSync(used, 'utf8')).not.toContain('B:');
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('forwards print chunks and provider-reported context usage while preserving model identity', async () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'kory-omnirush-print-stream-'));
    const stateRoot = join(testRoot, 'state');
    const fakeBinary = join(testRoot, 'omnirush');
    const previousPath = process.env.PATH;
    const previousStateRoot = process.env.OMNIRUSH_DIR;
    try {
      mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
      writeFileSync(join(stateRoot, 'auth.json'), '{}', { mode: 0o600 });
      writeFileSync(
        join(stateRoot, 'model-catalog.json'),
        JSON.stringify({
          payload: {
            data: [
              {
                id: 'gpt-6-astra',
                display_name: 'GPT 6 Astra',
                limits: { context: 400_000, output: 128_000 },
                capabilities: { reasoning: true, tool_call: false, image_input: false },
              },
            ],
          },
        }),
        { mode: 0o600 },
      );
      writeFileSync(
        fakeBinary,
        `#!${process.execPath}
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { appendFileSync, writeFileSync } from 'node:fs';
if (process.argv.includes('--print')) {
  const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
  const plugin = fileURLToPath(config.plugin.at(-1));
  const events = join(dirname(plugin), 'events.ndjson');
  writeFileSync(events, JSON.stringify({ part: { id: 'answer', type: 'text', text: 'stream' } }) + '\\n');
  appendFileSync(events, JSON.stringify({ info: { modelID: 'gpt-6-astra', tokens: { input: 41, output: 9, cache: { read: 7, write: 3 } } } }) + '\\n');
  process.stdout.write('stream');
  setTimeout(() => { appendFileSync(events, JSON.stringify({ part: { id: 'answer', type: 'text', text: 'streamed' } }) + '\\n'); process.stdout.write('ed\\n'); }, 30);
} else process.exit(1);
`,
        { mode: 0o700 },
      );
      chmodSync(fakeBinary, 0o700);
      process.env.PATH = testRoot;
      process.env.OMNIRUSH_DIR = stateRoot;

      const provider = new OmnirushCliProvider({ name: 'omnirush', disabled: false });
      const events = [];
      for await (const event of provider.streamResponse({
        model: 'gpt-6-astra',
        messages: [{ role: 'user', content: 'Stream this.' }],
        systemPrompt: '',
      })) {
        events.push(event);
      }
      expect(
        events
          .filter((event) => event.type === 'content_delta')
          .map((event) => event.content)
          .join(''),
      ).toBe('streamed');
      expect(events).toContainEqual({
        type: 'usage_update',
        tokensIn: 41,
        tokensOut: 9,
        tokensCacheRead: 7,
        tokensCacheWrite: 3,
        billingTokensIn: 41,
        billingTokensOut: 9,
        billingUsageSamples: [
          { tokensIn: 41, tokensOut: 9, tokensCacheRead: 7, tokensCacheWrite: 3 },
        ],
        usagePrecision: 'provider-reported',
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousStateRoot === undefined) delete process.env.OMNIRUSH_DIR;
      else process.env.OMNIRUSH_DIR = previousStateRoot;
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('updates once and replays the same safe print request after the real update gate', async () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'kory-omnirush-print-recovery-'));
    const stateRoot = join(testRoot, 'state');
    const fakeBinary = join(testRoot, 'omnirush');
    const updateMarker = join(testRoot, 'updated');
    const requestMarker = join(testRoot, 'requests');
    const previousPath = process.env.PATH;
    const previousStateRoot = process.env.OMNIRUSH_DIR;
    try {
      mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
      writeFileSync(join(stateRoot, 'auth.json'), '{}', { mode: 0o600 });
      writeFileSync(
        join(stateRoot, 'model-catalog.json'),
        JSON.stringify({
          payload: {
            data: [
              {
                id: 'gpt-6-astra',
                limits: { context: 400000, output: 128000 },
                capabilities: { reasoning: true, tool_call: false, image_input: false },
              },
            ],
          },
        }),
        { mode: 0o600 },
      );
      writeFileSync(
        fakeBinary,
        `#!${process.execPath}
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const updated = ${JSON.stringify(updateMarker)};
if (process.argv.includes('update')) { writeFileSync(updated, 'ok'); process.exit(0); }
appendFileSync(${JSON.stringify(requestMarker)}, 'request\\n');
if (!existsSync(updated)) {
  process.stderr.write('omnirush 2.4.12 is required — this version can no longer send requests. Updating now…\\n');
  process.stderr.write('omnirush 2.4.13 is installed. This run was not started again.\\n');
  process.exit(1);
}
process.stdout.write('replayed\\n');
`,
        { mode: 0o700 },
      );
      chmodSync(fakeBinary, 0o700);
      process.env.PATH = testRoot;
      process.env.OMNIRUSH_DIR = stateRoot;

      const provider = new OmnirushCliProvider({ name: 'omnirush', disabled: false });
      const events = [];
      for await (const event of provider.streamResponse({
        model: 'gpt-6-astra',
        messages: [{ role: 'user', content: 'Continue safely.' }],
        systemPrompt: '',
      })) {
        events.push(event);
      }
      expect(existsSync(updateMarker)).toBe(true);
      expect(readFileSync(requestMarker, 'utf8')).toBe('request\nrequest\n');
      expect(events).toEqual([
        { type: 'content_delta', content: 'replayed' },
        { type: 'complete', finishReason: 'end_turn' },
      ]);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousStateRoot === undefined) delete process.env.OMNIRUSH_DIR;
      else process.env.OMNIRUSH_DIR = previousStateRoot;
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('does not replay an update gate after content has escaped', async () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'kory-omnirush-print-no-replay-'));
    const stateRoot = join(testRoot, 'state');
    const fakeBinary = join(testRoot, 'omnirush');
    const updateMarker = join(testRoot, 'updated');
    const previousPath = process.env.PATH;
    const previousStateRoot = process.env.OMNIRUSH_DIR;
    try {
      mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
      writeFileSync(join(stateRoot, 'auth.json'), '{}', { mode: 0o600 });
      writeFileSync(
        join(stateRoot, 'model-catalog.json'),
        JSON.stringify({
          payload: {
            data: [
              {
                id: 'gpt-6-astra',
                limits: { context: 400000, output: 128000 },
                capabilities: { reasoning: true, tool_call: false, image_input: false },
              },
            ],
          },
        }),
        { mode: 0o600 },
      );
      writeFileSync(
        fakeBinary,
        `#!${process.execPath}
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
if (process.argv.includes('update')) { writeFileSync(${JSON.stringify(updateMarker)}, 'bad'); process.exit(0); }
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
const plugin = fileURLToPath(config.plugin.at(-1));
writeFileSync(join(dirname(plugin), 'events.ndjson'), JSON.stringify({ part: { id: 'tool-1', type: 'tool' } }) + '\\n');
process.stdout.write('partial\\n');
setTimeout(() => { process.stderr.write('omnirush 2.4.12 is required — this version can no longer send requests. Updating now…\\n'); process.stderr.write('omnirush 2.4.13 is installed. This run was not started again.\\n'); process.exit(1); }, 25);
`,
        { mode: 0o700 },
      );
      chmodSync(fakeBinary, 0o700);
      process.env.PATH = testRoot;
      process.env.OMNIRUSH_DIR = stateRoot;

      const provider = new OmnirushCliProvider({ name: 'omnirush', disabled: false });
      const events = [];
      for await (const event of provider.streamResponse({
        model: 'gpt-6-astra',
        messages: [{ role: 'user', content: 'Do not duplicate this.' }],
        systemPrompt: '',
      }))
        events.push(event);
      expect(existsSync(updateMarker)).toBe(false);
      expect(events[0]).toEqual({ type: 'content_delta', content: 'partial' });
      expect(events.at(-1)?.type).toBe('error');
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousStateRoot === undefined) delete process.env.OMNIRUSH_DIR;
      else process.env.OMNIRUSH_DIR = previousStateRoot;
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('does not update or replay ordinary errors and cancellation', async () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'kory-omnirush-print-errors-'));
    const stateRoot = join(testRoot, 'state');
    const fakeBinary = join(testRoot, 'omnirush');
    const updateMarker = join(testRoot, 'updated');
    const cancelMarker = join(testRoot, 'cancel');
    const pidMarker = join(testRoot, 'cancel.pid');
    const previousPath = process.env.PATH;
    const previousStateRoot = process.env.OMNIRUSH_DIR;
    try {
      mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
      writeFileSync(join(stateRoot, 'auth.json'), '{}', { mode: 0o600 });
      writeFileSync(
        join(stateRoot, 'model-catalog.json'),
        JSON.stringify({
          payload: {
            data: [
              {
                id: 'gpt-6-astra',
                limits: { context: 400000, output: 128000 },
                capabilities: { reasoning: true, tool_call: false, image_input: false },
              },
            ],
          },
        }),
        { mode: 0o600 },
      );
      writeFileSync(
        fakeBinary,
        `#!${process.execPath}
import { writeFileSync } from 'node:fs';
if (process.argv.includes('update')) { writeFileSync(${JSON.stringify(updateMarker)}, 'bad'); process.exit(0); }
if (await import('node:fs').then(({ existsSync }) => existsSync(${JSON.stringify(cancelMarker)}))) { writeFileSync(${JSON.stringify(pidMarker)}, String(process.pid)); setInterval(() => {}, 1000); }
else { process.stderr.write('a model said: run "omnirush update"\\n'); process.exit(1); }
`,
        { mode: 0o700 },
      );
      chmodSync(fakeBinary, 0o700);
      process.env.PATH = testRoot;
      process.env.OMNIRUSH_DIR = stateRoot;
      const provider = new OmnirushCliProvider({ name: 'omnirush', disabled: false });
      const ordinary = [];
      for await (const event of provider.streamResponse({
        model: 'gpt-6-astra',
        messages: [{ role: 'user', content: 'ordinary' }],
        systemPrompt: '',
      }))
        ordinary.push(event);
      expect(existsSync(updateMarker)).toBe(false);
      expect(ordinary.at(-1)?.type).toBe('error');

      writeFileSync(cancelMarker, 'cancel');
      const controller = new AbortController();
      const cancelled = (async () => {
        const values = [];
        for await (const event of provider.streamResponse({
          model: 'gpt-6-astra',
          messages: [{ role: 'user', content: 'cancel' }],
          systemPrompt: '',
          signal: controller.signal,
        }))
          values.push(event);
        return values;
      })();
      const childDeadline = Date.now() + 1_000;
      while (!existsSync(pidMarker) && Date.now() < childDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(existsSync(pidMarker)).toBe(true);
      setTimeout(() => controller.abort(), 25);
      expect(await cancelled).toEqual([]);
      expect(existsSync(updateMarker)).toBe(false);
      const pid = Number(readFileSync(pidMarker, 'utf8'));
      let alive = true;
      const deadline = Date.now() + 1_000;
      while (alive && Date.now() < deadline) {
        try {
          process.kill(pid, 0);
          await new Promise((resolve) => setTimeout(resolve, 10));
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousStateRoot === undefined) delete process.env.OMNIRUSH_DIR;
      else process.env.OMNIRUSH_DIR = previousStateRoot;
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('returns the real print answer when Kory supplies its tool catalog', async () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'kory-omnirush-print-tools-'));
    const stateRoot = join(testRoot, 'state');
    const fakeBinary = join(testRoot, 'omnirush');
    const previousPath = process.env.PATH;
    const previousStateRoot = process.env.OMNIRUSH_DIR;
    try {
      mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
      writeFileSync(join(stateRoot, 'auth.json'), '{}', { mode: 0o600 });
      writeFileSync(
        join(stateRoot, 'model-catalog.json'),
        JSON.stringify({
          payload: {
            data: [
              {
                id: 'gpt-6-astra',
                display_name: 'GPT 6 Astra',
                reasoning_levels: ['low', 'high'],
                limits: { context: 400_000, output: 128_000 },
                capabilities: { reasoning: true, tool_call: true, image_input: false },
              },
            ],
          },
        }),
        { mode: 0o600 },
      );
      writeFileSync(
        fakeBinary,
        `#!${process.execPath}
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';
if (process.argv.includes('--print')) {
  const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
  const plugin = fileURLToPath(config.plugin[0]);
  writeFileSync(join(dirname(plugin), 'ready.json'), JSON.stringify({ tools: ['kory__read_file'] }));
  process.stdout.write('KORY_PRINT_WITH_TOOLS_OK\\n');
}
else process.exit(1);
`,
        { mode: 0o700 },
      );
      chmodSync(fakeBinary, 0o700);
      process.env.PATH = testRoot;
      process.env.OMNIRUSH_DIR = stateRoot;

      const provider = new OmnirushCliProvider({ name: 'omnirush', disabled: false });
      const events = [];
      for await (const event of provider.streamResponse({
        model: 'gpt-6-astra',
        messages: [{ role: 'user', content: 'Say KORY_PRINT_WITH_TOOLS_OK.' }],
        systemPrompt: '',
        tools: [
          {
            name: 'kory__read_file',
            description: 'Read a file through Koryphaios.',
            inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
          },
        ],
        sessionId: 'omnirush-print-tools-test',
      })) {
        events.push(event);
      }
      expect(events).toEqual([
        { type: 'content_delta', content: 'KORY_PRINT_WITH_TOOLS_OK' },
        { type: 'complete', finishReason: 'end_turn' },
      ]);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousStateRoot === undefined) delete process.env.OMNIRUSH_DIR;
      else process.env.OMNIRUSH_DIR = previousStateRoot;
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('forwards a generated custom tool through the signed Kory bridge without project state', async () => {
    const lease = createKoryBridgeGrantLease('omnirush-plugin-test', 'manager');
    const grant = lease.grant(['mcp:execute']);
    const requests: Array<{ body: Record<string, unknown>; verified: boolean }> = [];
    const server = createServer(async (request, response) => {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw) as Record<string, unknown>;
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const verified =
        verifySignedBridgeRequest(
          new Headers(request.headers as Record<string, string>),
          'mcp',
          request.method ?? 'POST',
          path,
          body,
        ) !== null;
      requests.push({ body, verified });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ output: 'KORY_PLUGIN_RESULT', isError: false }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test bridge did not bind');
    const artifact = createOmnirushKoryToolsArtifact(
      [
        {
          name: 'kory__read_file',
          description: 'Read a file through Koryphaios.',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      ],
      grant.path,
      `http://127.0.0.1:${address.port}`,
    );
    try {
      const plugin = artifact.artifact.path;
      const script = `const plugin = (await import(${JSON.stringify(pathToFileURL(plugin).href)})).default; const definitions = []; await plugin.setup({ tool: { transform: async (callback) => callback({ add: (definition) => definitions.push(definition) }), hook: async () => {} }, session: { hook: async () => {} } }); const result = await definitions.find((definition) => definition.name === 'kory__read_file').execute({ path: 'backend/src/providers/omnirush-cli.ts' }, {}); process.stdout.write(result.content);`;
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolve) => {
          const child = spawn(process.execPath, ['-e', script], {
            env: {
              ...process.env,
              KORY_BACKEND_URL: `http://127.0.0.1:${address.port}`,
              KORY_BRIDGE_AUTH_FILE: grant.path,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (chunk) => (stdout += chunk));
          child.stderr.on('data', (chunk) => (stderr += chunk));
          child.once('close', (code) => resolve({ code, stdout, stderr }));
        },
      );
      expect(result).toMatchObject({ code: 0, stdout: 'KORY_PLUGIN_RESULT', stderr: '' });
      expect(requests).toEqual([
        {
          verified: true,
          body: {
            sessionId: 'omnirush-plugin-test',
            toolName: 'read_file',
            input: { path: 'backend/src/providers/omnirush-cli.ts' },
            role: 'manager',
            target: { kind: 'local', backendId: 'local' },
          },
        },
      ]);
      expect(readFileSync(artifact.artifact.path, 'utf8')).not.toContain('mcpServers');

      const invalidResult = await new Promise<{ code: number | null }>((resolve) => {
        const child = spawn(
          process.execPath,
          [
            '-e',
            `const plugin = (await import(${JSON.stringify(pathToFileURL(plugin).href)})).default; const definitions = []; await plugin.setup({ tool: { transform: async (callback) => callback({ add: (definition) => definitions.push(definition) }), hook: async () => {} }, session: { hook: async () => {} } }); await definitions.find((definition) => definition.name === 'kory__read_file').execute({ path: 42 }, {});`,
          ],
          {
            env: {
              ...process.env,
              KORY_BACKEND_URL: `http://127.0.0.1:${address.port}`,
              KORY_BRIDGE_AUTH_FILE: grant.path,
            },
            stdio: ['ignore', 'ignore', 'ignore'],
          },
        );
        child.once('close', (code) => resolve({ code }));
      });
      expect(invalidResult.code).not.toBe(0);
      expect(requests).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      artifact.artifact.cleanup();
      lease.cleanup();
    }
  });

  it('keeps sandbox enforcement on the Kory MCP execution path', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'omnirush-cli.ts'), 'utf8');
    expect(source).toContain("'--no-builtin-tools'");
    expect(source).toContain('authenticated MCP bridge');
    expect(source).not.toContain('wrapCommand(');
    expect(source).not.toContain('inferenceSandboxPolicy(');
  });
});
