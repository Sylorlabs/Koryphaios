import { describe, it, expect } from 'bun:test';
import {
  OpenCodeCliProvider,
  opencodeCapabilityBoundary,
  parseModelCatalogJson,
  parseOpenCodeModelsOutput,
  isKoryBridgeMetaExec,
} from '../opencode-cli';
import type { ProviderConfig } from '@koryphaios/shared';

/** Synthetic catalog shaped like `opencode api model.list` 2.0.32 output.
 *  Values are illustrative, not copied from any release manifest. */
const CATALOG_JSON = JSON.stringify({
  location: { directory: '/repo' },
  data: [
    {
      id: 'pulse-alpha-free',
      modelID: 'pulse-alpha-free',
      providerID: 'opencode',
      name: 'Pulse Alpha Free',
      package: '@opencode/ai/providers/openai-compatible',
      capabilities: {
        tools: true,
        input: ['text', 'image', 'pdf'],
        output: ['text'],
        temperature: true,
      },
      variants: [
        { id: 'low', settings: { reasoningEffort: 'low' } },
        { id: 'high', settings: { reasoningEffort: 'High' } },
        { id: 'high-dup', settings: { reasoningEffort: 'high' } },
        { id: 'default', settings: {} },
      ],
      time: { released: 1793664000000 },
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      status: 'active',
      enabled: true,
      limit: { context: 1048576, output: 270000 },
    },
    {
      id: 'glm-5',
      modelID: 'glm-5',
      providerID: 'logfare',
      name: 'GLM 5',
      capabilities: { tools: true, input: ['text'], output: ['text'] },
      variants: [],
      time: { released: 1 },
      cost: [{ input: 3, output: 9, cache: { read: 0.5, write: 2 } }],
      status: 'active',
      enabled: true,
      limit: { context: 200000, output: 65536 },
    },
    {
      id: 'tiered-model',
      modelID: 'tiered-model',
      providerID: 'openrouter',
      name: 'Context Tiered',
      capabilities: { tools: true, input: ['text'], output: ['text'] },
      variants: [{ id: 'max', settings: { reasoningEffort: 'MAX' } }],
      time: { released: 1 },
      cost: [
        { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
        {
          tier: { type: 'context', size: 200000 },
          input: 10,
          output: 37.5,
          cache: { read: 1, write: 12.5 },
        },
      ],
      status: 'active',
      enabled: true,
      limit: { context: 1000000, output: 128000 },
    },
    {
      id: 'disabled-model',
      modelID: 'disabled-model',
      providerID: 'opencode',
      name: 'Disabled',
      capabilities: {},
      variants: [],
      time: { released: 1 },
      cost: [],
      status: 'active',
      enabled: false,
      limit: { context: 1000, output: 100 },
    },
    {
      id: 'no-limit',
      modelID: 'no-limit',
      providerID: 'opencode',
      name: 'No Limit',
      capabilities: { tools: false, input: ['text'], output: ['text'] },
      variants: [],
      time: { released: 1 },
      cost: [],
      status: 'active',
      enabled: true,
    },
  ],
});

describe('OpenCode model catalog parsing', () => {
  it('parses the model.list catalog with real context limits', () => {
    const models = parseModelCatalogJson(CATALOG_JSON);
    const byId = new Map(models.map((m) => [m.id, m]));

    // Disabled models never appear; everything else is kept with its own limits.
    expect(byId.has('opencode/disabled-model')).toBe(false);
    expect(models.length).toBe(4);

    const pulse = byId.get('opencode/pulse-alpha-free')!;
    expect(pulse.contextWindow).toBe(1048576);
    expect(pulse.contextVerified).toBe(true);
    expect(pulse.maxOutputTokens).toBe(270000);
    expect(pulse.provider).toBe('opencode');
    expect(pulse.apiModelId).toBe('opencode/pulse-alpha-free');
    expect(pulse.name).toBe('Pulse Alpha Free');
    // Reasoning ladder comes from variants carrying reasoningEffort, deduped + lowercased.
    expect(pulse.reasoningLevels).toEqual(['low', 'high']);
    expect(pulse.canReason).toBe(true);
    expect(pulse.supportsAttachments).toBe(true);
    expect(pulse.vision).toBe(true);
    expect(pulse.costPerMInputTokens).toBe(0);

    // Pricing comes from the base tier (per-1M-token values), never from context tiers.
    const tiered = byId.get('openrouter/tiered-model')!;
    expect(tiered.costPerMInputTokens).toBe(5);
    expect(tiered.costPerMOutputTokens).toBe(25);
    expect(tiered.costPerMInputCached).toBe(0.5);
    expect(tiered.reasoningLevels).toEqual(['max']);

    const glm = byId.get('logfare/glm-5')!;
    expect(glm.costPerMInputTokens).toBe(3);
    expect(glm.costPerMOutputTokens).toBe(9);
    expect(glm.contextWindow).toBe(200000);

    // A model with no limit block keeps context unknown rather than invented.
    const noLimit = byId.get('opencode/no-limit')!;
    expect(noLimit.contextWindow).toBe(0);
    expect(noLimit.contextVerified).toBe(false);

    // Ids are unique and round-trip as ACP model values.
    const ids = models.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('rejects malformed catalog payloads', () => {
    expect(parseModelCatalogJson('not json')).toEqual([]);
    expect(parseModelCatalogJson('{}')).toEqual([]);
    expect(parseModelCatalogJson('{"data":"nope"}')).toEqual([]);
  });

  it('parses bare catalog id output as a last resort without inventing limits', () => {
    const raw = [
      'opencode/pulse-alpha-free',
      'logfare/auto',
      'openrouter/~anthropic/claude-opus-latest',
      'not a model',
      'has space/model',
      'opencode/pulse-alpha-free', // duplicate
      '',
    ].join('\n');
    const models = parseOpenCodeModelsOutput(raw);
    const ids = models.map((m) => m.id);
    expect(ids).toContain('opencode/pulse-alpha-free');
    expect(ids).toContain('logfare/auto');
    expect(ids).toContain('openrouter/~anthropic/claude-opus-latest');
    expect(ids).not.toContain('not a model');
    expect(new Set(ids).size).toBe(ids.length);
    for (const model of models) {
      expect(model.contextWindow).toBe(0);
      expect(model.provider).toBe('opencode');
    }
  });
});

describe('OpenCode kory bridge meta-exec detection', () => {
  const metaExec = (tools: string[]) => ({
    metadata: { truncated: false, toolCalls: tools.map((tool) => ({ tool, status: 'completed' })) },
  });

  it('recognizes code-mode execute calls that only carried kory__ tools', () => {
    expect(isKoryBridgeMetaExec(metaExec(['kory.read_file', 'kory.edit_file']))).toBe(true);
    expect(isKoryBridgeMetaExec(metaExec(['kory_run']))).toBe(true);
  });

  it('does not swallow non-kory tool calls', () => {
    expect(isKoryBridgeMetaExec(metaExec(['kory.read_file', 'playwright.screenshot']))).toBe(false);
    expect(isKoryBridgeMetaExec(metaExec(['koryprobe.probe_ping']))).toBe(false);
  });

  it('fails open (treats as a normal tool) when the shape is missing', () => {
    expect(isKoryBridgeMetaExec(undefined)).toBe(false);
    expect(isKoryBridgeMetaExec({})).toBe(false);
    expect(isKoryBridgeMetaExec({ metadata: { toolCalls: [] } })).toBe(false);
    expect(isKoryBridgeMetaExec({ metadata: 'junk' })).toBe(false);
  });
});

describe('OpenCode capability boundary', () => {
  it('keeps research-only turns away from the MCP bridge and the workspace', () => {
    expect(opencodeCapabilityBoundary('research-only')).toEqual({
      researchOnly: true,
      wireKoryMcp: false,
      exposeWorkspace: false,
      readOnly: true,
    });
    expect(opencodeCapabilityBoundary(undefined)).toEqual({
      researchOnly: false,
      wireKoryMcp: true,
      exposeWorkspace: true,
      readOnly: false,
    });
  });
});

describe('OpenCode provider availability', () => {
  const cfg = (over: Partial<ProviderConfig> = {}): ProviderConfig =>
    ({
      name: 'opencode',
      disabled: false,
      selectedModels: [],
      authToken: 'cli:opencode:test',
      ...over,
    }) as ProviderConfig;

  it('is available with a connection marker', () => {
    expect(new OpenCodeCliProvider(cfg()).isAvailable()).toBe(true);
  });

  it('is never available when the provider is disabled', () => {
    expect(new OpenCodeCliProvider(cfg({ disabled: true })).isAvailable()).toBe(false);
  });
});

describe('OpenCode CLI commands surface', () => {
  it('advertises only commands verified on the installed CLI', () => {
    const commands = new OpenCodeCliProvider({
      name: 'opencode',
      disabled: false,
      selectedModels: [],
    } as ProviderConfig).getCliCommands();
    expect(commands.map((command) => command.name)).toEqual(['init', 'review', 'compact']);
  });
});
