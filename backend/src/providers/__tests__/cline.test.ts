import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SANDBOX_PRESETS, type ProviderConfig } from '@koryphaios/shared';
import { detectClineCLILogin } from '../auth-utils';
import { ClineProvider, shouldUseClinePlanMode } from '../cline';
import type { ProviderEvent, StreamRequest } from '../types';

type MapResult = {
  recognized: boolean;
  completed: boolean;
  events: ProviderEvent[];
};

type ClineParser = {
  mapEvent: (event: Record<string, unknown>, lastLegacyText: string) => MapResult;
};

function makeProvider(): ClineProvider {
  return new ClineProvider({ name: 'cline', disabled: false } as ProviderConfig);
}

function makeRequest(overrides: Partial<StreamRequest> = {}): StreamRequest {
  return {
    model: 'cline-default',
    messages: [{ role: 'user', content: 'test' }],
    systemPrompt: '',
    ...overrides,
  };
}

function parse(
  provider: ClineProvider,
  event: Record<string, unknown>,
  lastLegacyText = '',
): MapResult {
  return (provider as unknown as ClineParser).mapEvent(event, lastLegacyText);
}

describe('Cline CLI configuration detection', () => {
  let home = '';
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'kory-cline-auth-'));
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    rmSync(home, { recursive: true, force: true });
  });

  it('detects modern provider settings without requiring a plaintext secret', () => {
    const settings = join(home, '.cline', 'data', 'settings');
    mkdirSync(settings, { recursive: true });
    writeFileSync(
      join(settings, 'providers.json'),
      JSON.stringify({ selectedProvider: 'openrouter', model: 'anthropic/claude-sonnet' }),
    );

    expect(detectClineCLILogin()).toBe(true);
  });

  it('retains legacy secrets.json detection', () => {
    const data = join(home, '.cline', 'data');
    mkdirSync(data, { recursive: true });
    writeFileSync(
      join(data, 'secrets.json'),
      JSON.stringify({ apiKey: 'synthetic-cline-secret-value-123456' }),
    );

    expect(detectClineCLILogin()).toBe(true);
  });

  it('does not treat an empty settings object as a configured account', () => {
    const settings = join(home, '.cline', 'data', 'settings');
    mkdirSync(settings, { recursive: true });
    writeFileSync(join(settings, 'providers.json'), '{}');

    expect(detectClineCLILogin()).toBe(false);
  });
});

describe('Cline CLI execution policy', () => {
  it('uses Plan for research, critics, and explicit Plan turns', () => {
    expect(shouldUseClinePlanMode(makeRequest(), true, true)).toBe(true);
    expect(
      shouldUseClinePlanMode(makeRequest({ harnessRole: 'critic' }), false, true),
    ).toBe(true);
    expect(
      shouldUseClinePlanMode(makeRequest({ permissionMode: 'plan' }), false, true),
    ).toBe(true);
  });

  it('allows non-YOLO Act only with filesystem isolation and a real kernel jail', () => {
    const guarded = makeRequest({
      permissionMode: 'guarded',
      sandbox: SANDBOX_PRESETS.balanced,
    });
    expect(shouldUseClinePlanMode(guarded, false, true)).toBe(false);
    expect(shouldUseClinePlanMode(guarded, false, false)).toBe(true);
    expect(
      shouldUseClinePlanMode(makeRequest({ permissionMode: 'guarded' }), false, true),
    ).toBe(true);
  });

  it('keeps explicit YOLO as the only unsandboxed Act escape hatch', () => {
    expect(
      shouldUseClinePlanMode(makeRequest({ permissionMode: 'yolo' }), false, false),
    ).toBe(false);
  });
});

describe('Cline CLI event compatibility', () => {
  it('maps current agent_event text chunks', () => {
    const result = parse(makeProvider(), {
      type: 'agent_event',
      event: { type: 'content_start', contentType: 'text', text: 'hello' },
    });

    expect(result).toEqual({
      recognized: true,
      completed: false,
      events: [{ type: 'content_delta', content: 'hello' }],
    });
  });

  it('maps current tool completion and preserves structured evidence', () => {
    const result = parse(makeProvider(), {
      type: 'agent_event',
      event: {
        type: 'content_end',
        contentType: 'tool',
        toolCallId: 'tool-1',
        toolName: 'read_file',
        input: { path: 'README.md' },
        output: 'contents',
      },
    });

    expect(result.recognized).toBe(true);
    expect(result.events[0]).toMatchObject({
      type: 'tool_executed',
      toolCallId: 'tool-1',
      toolName: 'read_file',
      toolOutput: 'contents',
      isError: false,
    });
    expect(result.events[0]?.toolInput).toContain('README.md');
  });

  it('maps current done records to usage and completion', () => {
    const result = parse(makeProvider(), {
      type: 'agent_event',
      event: {
        type: 'done',
        usage: { inputTokens: 12, outputTokens: 4 },
      },
    });

    expect(result.completed).toBe(true);
    expect(result.events).toEqual([
      { type: 'usage_update', tokensIn: 12, tokensOut: 4 },
      { type: 'complete', finishReason: 'end_turn' },
    ]);
  });

  it('keeps legacy cumulative say records compatible', () => {
    const result = parse(
      makeProvider(),
      { type: 'say', say: 'text', text: 'hello world' },
      'hello ',
    );

    expect(result.events).toEqual([{ type: 'content_delta', content: 'world' }]);
  });

  it('does not silently accept an unknown protocol frame', () => {
    const result = parse(makeProvider(), { type: 'future_protocol', payload: {} });
    expect(result).toEqual({ recognized: false, completed: false, events: [] });
  });
});
