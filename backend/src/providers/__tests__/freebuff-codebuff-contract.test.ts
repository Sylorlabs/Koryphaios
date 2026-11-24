import { describe, expect, it } from 'bun:test';
import {
  accountCatalogModels,
  buildFreebuffPtyTurn,
  freebuffImageBasename,
  freebuffUsageFromLogRow,
  FreebuffProvider,
  FREEBUFF_PTY_UNAVAILABLE_ERROR,
} from '../freebuff-cli';
import {
  parseFreebuffBundledCatalog,
  type FreebuffBundledModel,
} from '../freebuff-bundled-catalog';
import { CodebuffProvider, CODEBUFF_BASE_AGENT } from '../codebuff';
import { FreebuffCliBridge, FREEBUFF_PTY_HARNESS_NOTE } from '../cli-bridges';
import { toolsForRole } from '../kory-mcp-bridge';

describe('Freebuff PTY provider contract', () => {
  it('advertises the real MCP and sandbox levers without claiming native tools are disabled', () => {
    const capabilities = new FreebuffCliBridge().getCapabilities();
    expect(capabilities.supportsMcp).toBe(true);
    expect(capabilities.supportsSandbox).toBe(true);
    expect(FREEBUFF_PTY_HARNESS_NOTE).toContain('disposable transport workspace');
    expect(FREEBUFF_PTY_HARNESS_NOTE).toContain('read-only');
    expect(FREEBUFF_PTY_HARNESS_NOTE).toContain('native Freebuff tools still exist');
    expect(FREEBUFF_PTY_HARNESS_NOTE).not.toContain('they are disabled');
    const config = new FreebuffCliBridge().buildAgentConfig({
      provider: 'freebuff',
      role: 'manager',
      sandbox: undefined,
      workingDirectory: '/tmp/disposable',
      systemPrompt: '',
      tools: [],
    });
    expect([...((config?.allowedTools ?? []) as string[])].sort()).toEqual(
      toolsForRole('manager')
        .map((tool) => tool.name)
        .sort(),
    );
  });

  it('fails closed when disabled instead of starting a native TUI', async () => {
    const provider = new FreebuffProvider({ name: 'freebuff', disabled: true });
    const events = [];
    for await (const event of provider.streamResponse({
      model: 'z-ai/glm-5.3-flash',
      messages: [{ role: 'user', content: 'hello' }],
      systemPrompt: '',
    })) {
      events.push(event);
    }
    expect(events).toEqual([{ type: 'error', error: FREEBUFF_PTY_UNAVAILABLE_ERROR }]);
  });

  it('discovers picker models and image capabilities from the installed-binary shape', () => {
    const fixture = Buffer.from(`
      CODEBUFF_CLI_VERSION:"9.8.7";
      var textId="example/text",catalogIds={vision:"example/vision"},visionId=catalogIds.vision,
        enabled=!0,disabled=!1;
      function modelsForTier(tier,paid=!1){if(tier!=="limited")return picker;if(!paid)return limited;return picker}
      var text={id:textId,displayName:"Text model",tagline:"Fast",availability:"always",multimodal:!1},
        vision={id:visionId,displayName:"Vision model",tagline:"Pixels",availability:"always",multimodal:!0},
        hidden={id:"example/hidden",displayName:"Hidden model",tagline:"Off",availability:"always",multimodal:!0},
        picker=[text,...enabled?[vision]:[],...disabled?[hidden]:[]],limitedIds=[visionId],
        limited=limitedIds.map((id)=>id);
      handleSteps:\`function* ({ model }) {
        const contextWindow = {
          "example/vision": 262_144
        }[model ?? ""] ?? 131072;
      }\`;
    `);
    expect(parseFreebuffBundledCatalog(fixture)).toEqual({
      cliVersion: '9.8.7',
      models: [
        {
          id: 'example/text',
          name: 'Text model',
          multimodal: false,
          contextWindow: 131_072,
        },
        {
          id: 'example/vision',
          name: 'Vision model',
          multimodal: true,
          contextWindow: 262_144,
        },
      ],
    });
  });

  it('fails closed when an upgraded binary no longer exposes a recognizable picker catalog', () => {
    expect(() =>
      parseFreebuffBundledCatalog(Buffer.from('CODEBUFF_CLI_VERSION:"10.0.0";unrelated=true;')),
    ).toThrow('access-tier catalog was not found');
  });

  it('extracts real image blocks instead of flattening them out of the PTY turn', () => {
    const turn = buildFreebuffPtyTurn('system', [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect this screenshot.' },
          {
            type: 'image',
            imageData: 'iVBORw0KGgo=',
            imageMimeType: 'image/png',
          },
        ],
      },
    ]);
    expect(turn.prompt).toContain('Inspect this screenshot.');
    expect(turn.prompt).toContain('[Attached image 1]');
    expect(turn.images).toEqual([
      { data: 'iVBORw0KGgo=', mimeType: 'image/png', extension: 'png' },
    ]);
    expect(freebuffImageBasename(0, turn.images[0]!.extension)).toBe('ki1.png');
    expect(freebuffImageBasename(0, turn.images[0]!.extension).length).toBeLessThanOrEqual(9);
  });

  it('carries the complete prior-provider transcript when switching mid-task', () => {
    // Provider switches must not drop context: every message the manager hands
    // over — user, assistant and tool-result content alike — reaches the
    // Freebuff prompt in order.
    const turn = buildFreebuffPtyTurn('system', [
      { role: 'user', content: 'first request from another provider' },
      { role: 'assistant', content: 'answer from the previous provider' },
      {
        role: 'assistant',
        content: [{ type: 'tool_result', toolName: 'read_file', toolOutput: 'file body here' }],
      },
      { role: 'user', content: 'follow-up after switching to freebuff' },
    ]);
    for (const fragment of [
      'USER: first request from another provider',
      'ASSISTANT: answer from the previous provider',
      'file body here',
      'USER: follow-up after switching to freebuff',
    ]) {
      expect(turn.prompt).toContain(fragment);
    }
    expect(turn.prompt.indexOf('first request')).toBeLessThan(
      turn.prompt.indexOf('follow-up after switching'),
    );
    expect(turn.images).toEqual([]);
  });

  it('accepts only selected-model context counts from Freebuff request logs', () => {
    expect(
      freebuffUsageFromLogRow(
        {
          msg: 'Start agent base3-free-glm-5-3-flash step 3 (run)',
          data: { model: 'z-ai/glm-5.3-flash', contextTokenCount: 42_123 },
        },
        'z-ai/glm-5.3-flash',
      ),
    ).toBe(42_123);
    expect(
      freebuffUsageFromLogRow(
        {
          msg: 'Start agent reviewer step 1 (run)',
          data: { model: 'another/model', contextTokenCount: 99_999 },
        },
        'z-ai/glm-5.3-flash',
      ),
    ).toBeNull();
    expect(
      freebuffUsageFromLogRow(
        {
          msg: 'End agent base3 step 3 (run)',
          data: { model: 'z-ai/glm-5.3-flash', contextTokenCount: 42_123 },
        },
        'z-ai/glm-5.3-flash',
      ),
    ).toBeNull();
  });

  it('labels each model with its hour-burn multiplier from the live price table', () => {
    const account = {
      id: 'acct-1',
      label: 'Primary',
      profileDir: '/tmp/fb-profile',
      authToken: '',
      fingerprintId: 'fp',
    };
    const catalog = {
      cliVersion: '0.2.36',
      models: [
        { id: 'freebuff/catalog-m-a', name: 'Alpha', multimodal: false },
        { id: 'freebuff/catalog-m-b', name: 'Beta', multimodal: true },
        { id: 'freebuff/catalog-m-free', name: 'Gratis', multimodal: false },
        { id: 'freebuff/catalog-m-unpriced', name: 'Unpriced', multimodal: false },
        // Account-catalog rows carry an opaque handle; the price table may key
        // by it. The handle resolves the price but is never serialized.
        { id: 'freebuff/catalog-m-h', name: 'Handled', multimodal: false, handle: 'h-secret' },
      ] as FreebuffBundledModel[],
    };
    const prices = { 'm-a': 100, 'm-b': 500, 'm-free': 0, 'h-secret': 200 };
    const models = accountCatalogModels(account, catalog, false, prices);
    const byId = new Map(models.map((model) => [model.apiModelId, model]));
    expect(byId.get('freebuff/catalog-m-a')?.creditsLabel).toBe('1×');
    expect(byId.get('freebuff/catalog-m-b')?.creditsLabel).toBe('5×');
    expect(byId.get('freebuff/catalog-m-free')?.creditsLabel).toBe('Free');
    expect(byId.get('freebuff/catalog-m-unpriced')?.creditsLabel).toBeUndefined();
    expect(byId.get('freebuff/catalog-m-h')?.creditsLabel).toBe('2×');
    expect(byId.get('freebuff/catalog-m-h')).not.toHaveProperty('handle');
    expect(
      accountCatalogModels(account, catalog, false).every(
        (model) => model.creditsLabel === undefined,
      ),
    ).toBe(true);
  });

  it('joins display names to legacy price keys without version or suffix false-positives', () => {
    const account = {
      id: 'acct-1',
      label: 'Primary',
      profileDir: '/tmp/fb-profile',
      authToken: '',
      fingerprintId: 'fp',
    };
    // Live-shaped rows: catalog keys are m-*, prices key by legacy vendor ids,
    // and names differ from keys in version spelling, speed suffixes and
    // promotional tails. Mirrored from the observed account payload — including
    // the real legacyDigests each row reports for the price-table join.
    const catalog = {
      cliVersion: '0.2.36',
      models: [
        { id: 'freebuff/catalog-m-1', name: 'DeepSeek V4.1 Flash', multimodal: true },
        { id: 'freebuff/catalog-m-2', name: 'DeepSeek V4.1 Flash Slow', multimodal: true },
        // 'deepseek/deepseek-v4-flash' digests to this row's legacyDigest, the
        // join the bundled picker itself performs — no 'fast' name token needed.
        {
          id: 'freebuff/catalog-m-3',
          name: 'DeepSeek V4.1 Flash Fast',
          multimodal: true,
          legacyDigests: ['1e303ac563a6f9cc'],
        },
        { id: 'freebuff/catalog-m-4', name: 'Beam 1.0', multimodal: false },
        { id: 'freebuff/catalog-m-5', name: 'Muse Spark 1.3', multimodal: false },
        { id: 'freebuff/catalog-m-6', name: 'Solar Pro 4', multimodal: false },
      ] as FreebuffBundledModel[],
    };
    const prices = {
      'deepseek/deepseek-v4-flash': 15,
      'fbc/deepseek-flash': 10,
      'fbc/deepseek-flash-slow': 5,
      'fbc/beam-free': 0,
      'meta/muse-spark-1.3-contributor': 15,
      'meta/muse-spark-1.2-contributor': 15,
      'upstage/solar-pro4': 0,
    };
    const models = accountCatalogModels(account, catalog, false, prices);
    const byName = new Map(models.map((model) => [model.name, model]));
    // 'deepseek-v4-flash' is a different version signature than V4.1, so the
    // unversioned fbc row is the only exact name match (its tooltip states a
    // session costs two hours, agreeing with 10/5 = 2x).
    expect(byName.get('DeepSeek V4.1 Flash')?.creditsLabel).toBe('2×');
    expect(byName.get('DeepSeek V4.1 Flash Slow')?.creditsLabel).toBe('1×');
    expect(byName.get('Beam 1.0')?.creditsLabel).toBe('Free');
    expect(byName.get('Muse Spark 1.3')?.creditsLabel).toBe('3×');
    expect(byName.get('Solar Pro 4')?.creditsLabel).toBe('Free');
    // Fast's name is ambiguous (no 'fast' price key), but the CLI's own
    // legacyDigest join resolves it to the 15-cost vendor row: 15/5 = 3x.
    expect(byName.get('DeepSeek V4.1 Flash Fast')?.creditsLabel).toBe('3×');
    expect(byName.get('DeepSeek V4.1 Flash Fast')).not.toHaveProperty('legacyDigests');
  });
});

describe('Codebuff SDK provider contract', () => {
  it('requires a real Codebuff API key and exposes only the documented base agent', async () => {
    const provider = new CodebuffProvider({ name: 'codebuff', disabled: false });
    expect(provider.isAvailable()).toBe(false);
    expect(provider.listModels().map((model) => model.id)).toEqual([CODEBUFF_BASE_AGENT]);
    const events = [];
    for await (const event of provider.streamResponse({
      model: CODEBUFF_BASE_AGENT,
      messages: [{ role: 'user', content: 'hello' }],
      systemPrompt: '',
    })) {
      events.push(event);
    }
    expect(events[0]).toMatchObject({ type: 'error' });
    expect(events[0]?.error).toContain('API key is missing');
  });
});
