import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildFreebuffTurnSettings,
  discoverFreebuffBundledCatalog,
  FREEBUFF_CLI_DEFAULT_MODEL_ID,
  freebuffSelectedModelFromLogRow,
  parseFreebuffBundledCatalog,
  resetFreebuffBundledCatalogCacheForTests,
} from '../freebuff-bundled-catalog';

// Public schema/settings markers inspected in native Freebuff 0.2.12. No
// credentials, account payloads, catalog handles, or actual provider IDs.
const dynamicSource = `
  CODEBUFF_CLI_VERSION:"0.2.12";
  var protocol="x-freebuff-catalog-protocol",url="/api/v1/freebuff/models",
    stale="freebuff_catalog_stale";
  schema={recommendedKey:f.string().optional(),fallbackKey:f.string().optional()};
  settings.freebuffModelKey;settings.freebuffCatalogReasoningEfforts;
`;
const obsoletePicker = `
  function modelsForTier(tier,paid=!1){if(tier!=="limited")return picker;if(!paid)return limited;return picker}
  var old={id:"example/obsolete",displayName:"Obsolete fallback",multimodal:!0},picker=[old],limited=[old];
`;
const directories: string[] = [];
afterEach(async () => {
  resetFreebuffBundledCatalogCacheForTests();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Freebuff modern bundled model discovery', () => {
  it('uses native embedded version and exposes only CLI default for dynamic catalogs', () => {
    const native = Buffer.concat([
      Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0]),
      Buffer.from(dynamicSource),
    ]);
    expect(parseFreebuffBundledCatalog(native)).toEqual({
      cliVersion: '0.2.12',
      selectionMode: 'cli-managed',
      models: [
        { id: FREEBUFF_CLI_DEFAULT_MODEL_ID, name: 'Freebuff CLI default', multimodal: false },
      ],
    });
  });

  it('never advertises obsolete embedded picker IDs/vision/context for dynamic account catalogs', () => {
    const catalog = parseFreebuffBundledCatalog(Buffer.from(dynamicSource + obsoletePicker));
    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0]?.id).toBe(FREEBUFF_CLI_DEFAULT_MODEL_ID);
    expect(catalog.models[0]?.multimodal).toBe(false);
    expect(catalog.models[0]?.contextWindow).toBeUndefined();
  });

  it('fails closed on a changed dynamic protocol rather than falling back to obsolete models', () => {
    expect(() =>
      parseFreebuffBundledCatalog(
        Buffer.from(
          dynamicSource.replace('freebuffCatalogReasoningEfforts', 'futureSettings') +
            obsoletePicker,
        ),
      ),
    ).toThrow('dynamic catalog protocol is not recognized');
  });

  it('retains the legacy picker output shape and capabilities', () => {
    expect(
      parseFreebuffBundledCatalog(Buffer.from('CODEBUFF_CLI_VERSION:"0.0.162";' + obsoletePicker)),
    ).toEqual({
      cliVersion: '0.0.162',
      models: [{ id: 'example/obsolete', name: 'Obsolete fallback', multimodal: true }],
    });
  });

  it('does not turn arbitrary new version strings into a successful default catalog', () => {
    expect(() =>
      parseFreebuffBundledCatalog(Buffer.from('CODEBUFF_CLI_VERSION:"10.0.0";')),
    ).toThrow('access-tier catalog was not found');
  });

  it('discovers from binary bytes without executing the CLI or reading account files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freebuff-catalog-'));
    directories.push(directory);
    const binary = join(directory, 'not-executable');
    await writeFile(binary, dynamicSource, { mode: 0o600 });
    const catalog = await discoverFreebuffBundledCatalog(binary);
    expect(catalog.cliVersion).toBe('0.2.12');
    expect(await discoverFreebuffBundledCatalog(binary)).toBe(catalog);
    await writeFile(binary, 'CODEBUFF_CLI_VERSION:"0.0.162";' + obsoletePicker);
    expect((await discoverFreebuffBundledCatalog(binary)).models[0]?.id).toBe('example/obsolete');
  });
});

describe('Freebuff private turn model settings', () => {
  const settings = {
    mode: 'DEFAULT',
    adsEnabled: true,
    freebuffModel: 'example/legacy',
    freebuffModelKey: 'catalog-stable-key',
    freebuffModelDefaultMigration: 'cli-migration-stamp',
    freebuffReasoningEfforts: { 'example/legacy': 'high' },
    freebuffCatalogReasoningEfforts: { 'catalog-stable-key': 'ultra' },
    alwaysUseALaCarte: false,
    fallbackToALaCarte: false,
    hasSubmittedFirstPrompt: true,
    freebucksIntroSeenAt: '2026-01-01T00:00:00Z',
  };

  it('preserves exact CLI selection/migration/reasoning and billing preferences for default', () => {
    const result = buildFreebuffTurnSettings(settings, FREEBUFF_CLI_DEFAULT_MODEL_ID);
    expect(result).toEqual(settings);
    expect(result.freebuffCatalogReasoningEfforts).not.toBe(
      settings.freebuffCatalogReasoningEfforts,
    );
    expect(settings.freebuffModelKey).toBe('catalog-stable-key');
  });

  it('does not synthesize a model or migration stamp when the CLI owns the default', () => {
    expect(buildFreebuffTurnSettings({}, FREEBUFF_CLI_DEFAULT_MODEL_ID)).toEqual({});
  });

  it('removes modern key when explicitly selecting a legacy picker model, like the CLI setter', () => {
    const result = buildFreebuffTurnSettings(settings, 'example/explicit');
    expect(result.freebuffModel).toBe('example/explicit');
    expect(result.freebuffModelKey).toBeUndefined();
    expect(result.freebuffModelDefaultMigration).toBe(settings.freebuffModelDefaultMigration);
    expect(result.freebuffReasoningEfforts).toEqual(settings.freebuffReasoningEfforts);
  });

  it('does not transport arbitrary settings, authentication or environment values', () => {
    expect(
      buildFreebuffTurnSettings(
        { ...settings, apiKey: 'not-a-real-key', env: { TOKEN: 'not-real' }, theme: 'dark' },
        FREEBUFF_CLI_DEFAULT_MODEL_ID,
      ),
    ).toEqual(settings);
  });

  it('fails explicitly for BYOK rather than copying OS secrets or silently changing selection', () => {
    expect(() =>
      buildFreebuffTurnSettings(
        { byokConnection: { id: 'private-connection', revision: 1 } },
        FREEBUFF_CLI_DEFAULT_MODEL_ID,
      ),
    ).toThrow('BYOK selection cannot be transported');
  });

  it('rejects malformed settings without leaking supplied values in errors', () => {
    for (const invalid of [null, [], 'private-data']) {
      expect(() => buildFreebuffTurnSettings(invalid, FREEBUFF_CLI_DEFAULT_MODEL_ID)).toThrow(
        'must be a JSON object',
      );
    }
    expect(() =>
      buildFreebuffTurnSettings({ freebuffModelKey: {} }, FREEBUFF_CLI_DEFAULT_MODEL_ID),
    ).toThrow('must be a string');
    expect(() =>
      buildFreebuffTurnSettings({ adsEnabled: 'private-data' }, FREEBUFF_CLI_DEFAULT_MODEL_ID),
    ).toThrow('must be a boolean');
    expect(() =>
      buildFreebuffTurnSettings(
        { freebuffCatalogReasoningEfforts: [] },
        FREEBUFF_CLI_DEFAULT_MODEL_ID,
      ),
    ).toThrow('must be a string map');
    expect(() => buildFreebuffTurnSettings({}, 'not a model')).toThrow(
      'model selection is invalid',
    );
  });
});

describe('Freebuff selected root model log evidence', () => {
  it('accepts root End-agent evidence including opaque modern CLI handles', () => {
    expect(
      freebuffSelectedModelFromLogRow({
        msg: 'End agent base step 1 (run)',
        data: { agentId: 'main-agent', model: 'opaque-handle-fixture' },
      }),
    ).toBe('opaque-handle-fixture');
  });

  it('rejects nested, unidentified, Start-agent and main-completion rows as model evidence', () => {
    for (const row of [
      {
        msg: 'End agent base step 1 (run)',
        data: { agentId: 'child', model: 'example/model', shouldEndTurn: true },
      },
      { msg: 'End agent base step 1 (run)', data: { model: 'example/model' } },
      {
        msg: 'Start agent base step 1 (run)',
        data: { agentId: 'main-agent', model: 'example/model' },
      },
      {
        msg: 'Main prompt finished',
        data: { agentId: 'main-agent', model: 'example/model', outputType: 'error' },
      },
      { msg: 'End agent base step 1 (run)', data: { agentId: 'main-agent', model: '' } },
      {
        msg: 'End agent base step 1 (run)',
        data: { agentId: 'main-agent', model: 'unsafe\nmodel' },
      },
    ])
      expect(freebuffSelectedModelFromLogRow(row)).toBeNull();
  });
});
