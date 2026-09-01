import { describe, expect, it } from 'bun:test';
import {
  buildFreebuffPtyTurn,
  freebuffImageBasename,
  freebuffUsageFromLogRow,
  FreebuffProvider,
  FREEBUFF_PTY_UNAVAILABLE_ERROR,
} from '../freebuff-cli';
import { parseFreebuffBundledCatalog } from '../freebuff-bundled-catalog';
import { CodebuffProvider, CODEBUFF_BASE_AGENT } from '../codebuff';
import { FreebuffCliBridge, FREEBUFF_PTY_HARNESS_NOTE } from '../cli-bridges';
import { toolsForRole } from '../kory-mcp-bridge';

describe('Freebuff PTY provider contract', () => {
  it('advertises the real MCP and sandbox levers without claiming native tools are disabled', () => {
    const capabilities = new FreebuffCliBridge().getCapabilities();
    expect(capabilities.supportsMcp).toBe(true);
    expect(capabilities.supportsSandbox).toBe(true);
    expect(FREEBUFF_PTY_HARNESS_NOTE).toContain('disposable transport workspace');
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
    expect(config?.allowedTools).toEqual(toolsForRole('manager').map((tool) => tool.name));
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
