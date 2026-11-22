import { describe, expect, test } from 'bun:test';
import { parseDevinModelsOutput } from '../devin-capabilities';
import { DevinProvider } from '../devin';
import type { FusionSelection } from '@koryphaios/shared';

describe('parseDevinModelsOutput', () => {
  test('keeps every selectable row and excludes family headings and aliases', () => {
    const models = parseDevinModelsOutput(`Available models (2 families)

Claude Opus 5 (claude-opus-5)
  aliases: opus
  claude-opus-5-medium                   Claude Opus 5 Medium  [1M context, $5 / MTok In]
  claude-opus-5-max                      Claude Opus 5 Max  [1M context, $5 / MTok In]

GPT-5.2 (gpt-5.2)
  MODEL_GPT_5_2_LOW                      GPT-5.2 Low Thinking  [384K context]
  MODEL_GPT_5_2_XHIGH                    GPT-5.2 XHigh Thinking  [384K context]
`);

    expect(models).toEqual([
      { id: 'claude-opus-5-medium', name: 'Claude Opus 5 Medium', contextWindow: 1_000_000 },
      { id: 'claude-opus-5-max', name: 'Claude Opus 5 Max', contextWindow: 1_000_000 },
      { id: 'MODEL_GPT_5_2_LOW', name: 'GPT-5.2 Low Thinking', contextWindow: 384_000 },
      { id: 'MODEL_GPT_5_2_XHIGH', name: 'GPT-5.2 XHigh Thinking', contextWindow: 384_000 },
    ]);
  });

  test('does not mistake the models command help for a catalog', () => {
    expect(
      parseDevinModelsOutput(`List the models available to your account

Usage: devin models <COMMAND>

Commands:
  list  List available models, organized by model family
  help  Print this message or the help of the given subcommand(s)
`),
    ).toEqual([]);
  });

  test('strips price brackets so entries keep just the model name', () => {
    const models = parseDevinModelsOutput(`Available models (53 families)

Claude Opus 5.5 (claude-opus-5.5)
  aliases: opus
  aliases:  opus-duplicate-spacing
  claude-opus-5-5-medium                                                   Claude Opus 5.5 Medium  [$4 / 1M Input · $0.2 / 1M Cached input · $20 / 1M Output, new]
  claude-opus-5-5-max-fast                                                 Claude Opus 5.5 Max Fast  [$8 / 1M Input · $0.4 / 1M Cached input · $40 / 1M Output, new]

GPT-6 Sol (gpt-6-sol)
  aliases: gpt
  gpt-6-sol-none                                                           GPT-6 Sol No Thinking  [$2 / 1M Input · $0.2 / 1M Cached input · $10 / 1M Output, new]
`);

    expect(models).toEqual([
      { id: 'claude-opus-5-5-medium', name: 'Claude Opus 5.5 Medium', contextWindow: undefined },
      {
        id: 'claude-opus-5-5-max-fast',
        name: 'Claude Opus 5.5 Max Fast',
        contextWindow: undefined,
      },
      { id: 'gpt-6-sol-none', name: 'GPT-6 Sol No Thinking', contextWindow: undefined },
    ]);
  });
});

import {
  collapseDevinReasoningTiers,
  matchDevinModel,
  resolveDevinSlug,
  resolveDevinVariant,
  splitDevinModelSlug,
} from '../devin-capabilities';
import type { ModelDef } from '@koryphaios/shared';

const def = (id: string, name: string, contextWindow = 0): ModelDef => ({
  id,
  name,
  provider: 'devin',
  apiModelId: id,
  contextWindow,
  maxOutputTokens: 0,
});

describe('parseDevinModelsOutput context windows', () => {
  test('parses decimal megabyte contexts without inflating them 100x', () => {
    const models = parseDevinModelsOutput(`Available models (1 families)

Gemini 4 Carbon (gemini-4-carbon)
  gemini-4-carbon-medium                  Gemini 4 Carbon Medium  [1.05M context]
  glm-5-2                                 GLM-5.2 High  [200K context]
  gpt-5-2                                 GPT-5.2  [384K context]
`);
    expect(models.find((m) => m.id === 'gemini-4-carbon-medium')?.contextWindow).toBe(1_050_000);
    expect(models.find((m) => m.id === 'glm-5-2')?.contextWindow).toBe(200_000);
    expect(models.find((m) => m.id === 'gpt-5-2')?.contextWindow).toBe(384_000);
  });
});

describe('splitDevinModelSlug', () => {
  test('reads trailing effort, speed and context tokens', () => {
    expect(splitDevinModelSlug('claude-opus-5-5-high')).toMatchObject({
      family: 'claude-opus-5-5',
      base: 'claude-opus-5-5',
      effort: 'high',
      speed: null,
      context: null,
    });
    expect(splitDevinModelSlug('gpt-6-2-astra-low-priority')).toMatchObject({
      family: 'gpt-6-2-astra-priority',
      effort: 'low',
      speed: 'priority',
    });
    expect(splitDevinModelSlug('swe-2-medium-lightning')).toMatchObject({
      family: 'swe-2-lightning',
      effort: 'medium',
      speed: 'lightning',
    });
    expect(splitDevinModelSlug('glm-5-2-none-1m')).toMatchObject({
      family: 'glm-5-2-1m',
      effort: 'none',
      context: '1m',
    });
  });

  test('keeps untiered and context-only slugs as their own families', () => {
    expect(splitDevinModelSlug('adaptive')).toMatchObject({ family: 'adaptive', effort: null });
    expect(splitDevinModelSlug('kimi-k2-7')).toMatchObject({
      family: 'kimi-k2-7',
      effort: null,
    });
    expect(splitDevinModelSlug('glm-5-2-1m')).toMatchObject({
      family: 'glm-5-2-1m',
      effort: null,
      context: '1m',
    });
    expect(splitDevinModelSlug('claude-sonnet-4-6-thinking-1m')).toMatchObject({
      family: 'claude-sonnet-4-6-thinking-1m',
      effort: null,
    });
    // A speed token without a preceding effort is a name token, not a tier.
    expect(splitDevinModelSlug('foo-priority')).toMatchObject({ effort: null });
  });

  test('reads underscore/uppercase rows like the CLI emits', () => {
    expect(splitDevinModelSlug('MODEL_GPT_5_2_LOW')).toMatchObject({
      family: 'MODEL_GPT_5_2',
      base: 'MODEL_GPT_5_2',
      effort: 'low',
    });
    expect(splitDevinModelSlug('MODEL_GPT_5_2_XHIGH').effort).toBe('xhigh');
  });

  test('parses fusion lead effort and keeps the sidekick in the family key', () => {
    expect(splitDevinModelSlug('fusion-gpt-6-sol-low-fast-sidekick-glm-5-2')).toMatchObject({
      family: 'fusion-gpt-6-sol-fast-sidekick-glm-5-2',
      base: 'fusion-gpt-6-sol',
      effort: 'low',
      speed: 'fast',
      sidekick: '-sidekick-glm-5-2',
    });
    // The sidekick's own effort token is identity, not the lead tier.
    expect(splitDevinModelSlug('fusion-claude-opus-5-5-medium-sidekick-swe-2-medium')).toMatchObject(
      {
        family: 'fusion-claude-opus-5-5-sidekick-swe-2-medium',
        effort: 'medium',
      },
    );
  });
});

describe('collapseDevinReasoningTiers', () => {
  test('collapses per-effort slugs into one model with native reasoning mapping', () => {
    const out = collapseDevinReasoningTiers([
      def('claude-opus-5-5-low', 'Claude Opus 5.5 Low', 1_000_000),
      def('claude-opus-5-5-medium', 'Claude Opus 5.5 Medium', 1_000_000),
      def('claude-opus-5-5-high', 'Claude Opus 5.5 High', 1_000_000),
      def('claude-opus-5-5-max', 'Claude Opus 5.5 Max', 1_000_000),
      def('adaptive', 'Adaptive', 262_000),
    ]);
    expect(out).toHaveLength(2);
    const family = out.find((m) => m.id === 'claude-opus-5-5')!;
    expect(family).toMatchObject({
      name: 'Claude Opus 5.5',
      apiModelId: 'claude-opus-5-5-medium',
      canReason: true,
      reasoningLevels: ['low', 'medium', 'high', 'max', 'auto'],
      reasoningVariants: {
        low: 'claude-opus-5-5-low',
        medium: 'claude-opus-5-5-medium',
        high: 'claude-opus-5-5-high',
        max: 'claude-opus-5-5-max',
      },
    });
    expect(family.aliases).toEqual(
      expect.arrayContaining([
        'claude-opus-5-5-low',
        'claude-opus-5-5-medium',
        'claude-opus-5-5-high',
        'claude-opus-5-5-max',
      ]),
    );
    expect(out.find((m) => m.id === 'adaptive')?.reasoningLevels).toBeUndefined();
  });

  test('keeps speed variants as separate families with their own tiers', () => {
    const out = collapseDevinReasoningTiers([
      def('swe-2-medium', 'SWE-2 Medium'),
      def('swe-2-high', 'SWE-2 High'),
      def('swe-2-medium-lightning', 'SWE-2 Medium Lightning'),
      def('swe-2-high-lightning', 'SWE-2 High Lightning'),
    ]);
    expect(out.map((m) => m.id).sort()).toEqual(['swe-2', 'swe-2-lightning']);
    const lightning = out.find((m) => m.id === 'swe-2-lightning')!;
    expect(lightning.name).toBe('SWE-2 Lightning');
    expect(lightning.reasoningVariants).toEqual({
      medium: 'swe-2-medium-lightning',
      high: 'swe-2-high-lightning',
    });
  });

  test('prefers a bare slug as the default apiModelId when present', () => {
    const out = collapseDevinReasoningTiers([
      def('glm-5-2-1m', 'GLM-5.2 High 1M'),
      def('glm-5-2-none-1m', 'GLM-5.2 No Thinking 1M'),
      def('glm-5-2-max-1m', 'GLM-5.2 Max 1M'),
    ]);
    const family = out.find((m) => m.id === 'glm-5-2-1m')!;
    expect(family.apiModelId).toBe('glm-5-2-1m');
    expect(family.reasoningLevels).toEqual(['none', 'max', 'auto']);
    expect(family.reasoningVariants).toEqual({
      none: 'glm-5-2-none-1m',
      max: 'glm-5-2-max-1m',
    });
  });

  test('does not collapse single-tier families or invent levels', () => {
    const out = collapseDevinReasoningTiers([
      def('swe-1-7', 'SWE-1.7 Max'),
      def('swe-1-7-medium', 'SWE-1.7 Medium'),
    ]);
    expect(out.map((m) => m.id).sort()).toEqual(['swe-1-7', 'swe-1-7-medium']);
    expect(out.every((m) => !m.reasoningLevels)).toBe(true);
  });

  test('collapses every fusion pairing into ONE `fusion` model with a slot catalog', () => {
    const out = collapseDevinReasoningTiers([
      def('fusion-a-low-sidekick-b', 'Fusion (A Low + B)'),
      def('fusion-a-medium-sidekick-b', 'Fusion (A Medium + B)'),
      def('fusion-a-high-sidekick-b', 'Fusion (A High + B)'),
      def('fusion-a-low-fast-sidekick-b', 'Fusion (A Low Fast + B)'),
      def('fusion-a-high-fast-sidekick-b', 'Fusion (A High Fast + B)'),
      def('fusion-c-medium-sidekick-gpt-d-high', 'Fusion (C Medium + D High)'),
      def('fusion-c-high-sidekick-gpt-d-high', 'Fusion (C High + D High)'),
      def(
        'fusion-c-medium-fast-sidekick-gpt-d-high-priority',
        'Fusion (C Medium Fast + D High Fast)',
      ),
      def(
        'fusion-c-high-fast-sidekick-gpt-d-high-priority',
        'Fusion (C High Fast + D High Fast)',
      ),
    ]);
    // Exactly one model — no per-pairing `fusion-*` ids survive.
    expect(out.map((m) => m.id)).toEqual(['fusion']);
    const fusion = out[0];
    expect(fusion.name).toBe('Fusion');
    expect(fusion.canReason).toBe(false);
    expect(fusion.reasoningVariants).toBeUndefined();
    expect(fusion.speedTiers).toBeUndefined();
    expect(fusion.apiModelId).toBe('fusion-a-low-sidekick-b');
    const catalog = fusion.fusion!;
    expect(catalog.leads.map((l) => l.id)).toEqual(['a', 'c']);
    expect(catalog.leads[0].name).toBe('A');
    expect(catalog.leads[0].efforts).toEqual(['low', 'medium', 'high']);
    expect(catalog.sidekicks.map((sk) => sk.id)).toEqual(['b', 'gpt-d']);
    expect(catalog.sidekicks[1].name).toBe('D');
    expect(catalog.sidekicks[1].efforts).toEqual(['high']);
    // std cell resolves bare slugs; fast cell resolves the -priority twin.
    expect(catalog.pairings['a|std|b|']?.medium).toBe('fusion-a-medium-sidekick-b');
    expect(catalog.pairings['a|fast|b|']?.high).toBe('fusion-a-high-fast-sidekick-b');
    expect(catalog.pairings['c|fast|gpt-d|high']?.high).toBe(
      'fusion-c-high-fast-sidekick-gpt-d-high-priority',
    );
    expect(catalog.defaultSelection).toEqual({
      lead: 'a',
      leadEffort: 'low',
      leadFast: false,
      sidekick: 'b',
      sidekickEffort: null,
    });
    // Every raw slug AND every previously-emitted family id stays an alias.
    expect(fusion.aliases).toEqual(
      expect.arrayContaining([
        'fusion-a-low-sidekick-b',
        'fusion-c-high-fast-sidekick-gpt-d-high-priority',
        'fusion-a-sidekick-b',
        'fusion-a-fast-sidekick-b',
        'fusion-c-sidekick-gpt-d-high',
        'fusion-c-fast-sidekick-gpt-d-high-priority',
      ]),
    );
  });
});

describe('matchDevinModel / resolveDevinVariant', () => {
  const models = collapseDevinReasoningTiers([
    def('glm-5-2-none-1m', 'GLM-5.2 No Thinking 1M'),
    def('glm-5-2-1m', 'GLM-5.2 High 1M'),
    def('glm-5-2-max-1m', 'GLM-5.2 Max 1M'),
  ]);

  test('matches superseded tier slugs through aliases and reports their effort', () => {
    const match = matchDevinModel(models, 'glm-5-2-max-1m');
    expect(match?.model.id).toBe('glm-5-2-1m');
    expect(match?.legacyEffort).toBe('max');
    expect(resolveDevinVariant(match?.model, match?.legacyEffort)).toBe('glm-5-2-max-1m');
  });

  test('resolves an explicit level and falls through for auto/adaptive', () => {
    const family = models.find((m) => m.id === 'glm-5-2-1m')!;
    expect(resolveDevinVariant(family, 'none')).toBe('glm-5-2-none-1m');
    expect(resolveDevinVariant(family, 'auto')).toBeUndefined();
    expect(resolveDevinVariant(family, 'adaptive')).toBeUndefined();
    expect(resolveDevinVariant(family, undefined)).toBeUndefined();
    expect(resolveDevinVariant(family, 'bogus')).toBeUndefined();
  });

  test('returns undefined for unknown models', () => {
    expect(matchDevinModel(models, 'no-such-model')).toBeUndefined();
  });
});

describe('fast/priority speed families fold into the standard model', () => {
  const out = collapseDevinReasoningTiers([
    def('claude-opus-5-5-low', 'Claude Opus 5.5 Low'),
    def('claude-opus-5-5-medium', 'Claude Opus 5.5 Medium'),
    def('claude-opus-5-5-high', 'Claude Opus 5.5 High'),
    def('claude-opus-5-5-low-fast', 'Claude Opus 5.5 Low Fast'),
    def('claude-opus-5-5-medium-fast', 'Claude Opus 5.5 Medium Fast'),
    def('claude-opus-5-5-high-fast', 'Claude Opus 5.5 High Fast'),
    def('gpt-6-sol-low', 'GPT-6 Sol Low'),
    def('gpt-6-sol-high', 'GPT-6 Sol High'),
    def('gpt-6-sol-low-priority', 'GPT-6 Sol Low Fast'),
    def('gpt-6-sol-high-priority', 'GPT-6 Sol High Fast'),
    def('swe-2-medium', 'SWE-2 Medium'),
    def('swe-2-high', 'SWE-2 High'),
    def('swe-2-medium-lightning', 'SWE-2 Medium Lightning'),
    def('swe-2-high-lightning', 'SWE-2 High Lightning'),
    def(
      'fusion-claude-opus-5-5-medium-sidekick-swe-2-medium',
      'Fusion (Claude Opus 5.5 Medium + SWE-2 Medium)',
    ),
    def(
      'fusion-claude-opus-5-5-high-sidekick-swe-2-medium',
      'Fusion (Claude Opus 5.5 High + SWE-2 Medium)',
    ),
    def(
      'fusion-claude-opus-5-5-medium-fast-sidekick-swe-2-medium',
      'Fusion (Claude Opus 5.5 Medium Fast + SWE-2 Medium)',
    ),
    def(
      'fusion-claude-opus-5-5-high-fast-sidekick-swe-2-medium',
      'Fusion (Claude Opus 5.5 High Fast + SWE-2 Medium)',
    ),
    def('foo-low-fast', 'Foo Low Fast'),
    def('foo-high-fast', 'Foo High Fast'),
  ]);

  test('emits no fast/priority family except a fast family without a standard sibling', () => {
    expect(out.map((m) => m.id).sort()).toEqual([
      'claude-opus-5-5',
      'foo-fast',
      'fusion',
      'gpt-6-sol',
      'swe-2',
      'swe-2-lightning',
    ]);
    // Fusion carries no fast tier — the slots own the speed coupling.
    const fusion = out.find((m) => m.id === 'fusion')!;
    expect(fusion.fusion?.pairings[
      'claude-opus-5-5|std|swe-2|medium'
    ]?.medium).toBe('fusion-claude-opus-5-5-medium-sidekick-swe-2-medium');
    expect(
      fusion.fusion?.pairings['claude-opus-5-5|fast|swe-2|medium']?.high,
    ).toBe('fusion-claude-opus-5-5-high-fast-sidekick-swe-2-medium');
    expect(fusion.speedTiers).toBeUndefined();
    expect(fusion.aliases).toEqual(
      expect.arrayContaining([
        'fusion-claude-opus-5-5-fast-sidekick-swe-2-medium',
        'fusion-claude-opus-5-5-medium-fast-sidekick-swe-2-medium',
      ]),
    );
    // The fast-only family survives as its own collapsed model, not a loss.
    const fastOnly = out.find((m) => m.id === 'foo-fast')!;
    expect(fastOnly.reasoningVariants).toEqual({
      low: 'foo-low-fast',
      high: 'foo-high-fast',
    });
    expect(fastOnly.speedTiers).toBeUndefined();
  });

  test('marks the standard models fast-capable with per-effort fast slugs', () => {
    const opus = out.find((m) => m.id === 'claude-opus-5-5')!;
    expect(opus.speedTiers).toEqual([expect.objectContaining({ id: 'fast' })]);
    expect(opus.speedVariants?.fast).toEqual({
      low: 'claude-opus-5-5-low-fast',
      medium: 'claude-opus-5-5-medium-fast',
      high: 'claude-opus-5-5-high-fast',
    });
    expect(Object.keys(opus.speedAliases ?? {})).toEqual(
      expect.arrayContaining([
        'claude-opus-5-5-low-fast',
        'claude-opus-5-5-medium-fast',
        'claude-opus-5-5-high-fast',
        'claude-opus-5-5-fast',
      ]),
    );
    // Old fast slugs and the fast family key stay resolvable as plain aliases too.
    expect(opus.aliases).toEqual(
      expect.arrayContaining(['claude-opus-5-5-high-fast', 'claude-opus-5-5-fast']),
    );

    const sol = out.find((m) => m.id === 'gpt-6-sol')!;
    expect(sol.speedTiers).toEqual([expect.objectContaining({ id: 'fast' })]);
    expect(sol.speedVariants?.fast).toEqual({
      low: 'gpt-6-sol-low-priority',
      high: 'gpt-6-sol-high-priority',
    });
    expect(Object.keys(sol.speedAliases ?? {})).toEqual(
      expect.arrayContaining([
        'gpt-6-sol-low-priority',
        'gpt-6-sol-high-priority',
        'gpt-6-sol-priority',
      ]),
    );

    // Fusion is a separate concern now — one model with a slot catalog,
    // checked in the dedicated fusion describe below.
    expect(out.find((m) => m.id === 'fusion')?.fusion).toBeDefined();
  });

  test('lightning families stay separate and are not fast-capable', () => {
    const lightning = out.find((m) => m.id === 'swe-2-lightning')!;
    expect(lightning.reasoningVariants).toEqual({
      medium: 'swe-2-medium-lightning',
      high: 'swe-2-high-lightning',
    });
    expect(lightning.speedTiers).toBeUndefined();
    expect(lightning.speedVariants?.fast).toBeUndefined();
    expect(out.find((m) => m.id === 'swe-2')?.speedTiers).toBeUndefined();
  });

  test('resolveDevinSlug resolves standard, fast, auto+fast, and missing efforts', () => {
    const opus = out.find((m) => m.id === 'claude-opus-5-5')!;
    expect(resolveDevinSlug(opus, 'high')).toBe('claude-opus-5-5-high');
    expect(resolveDevinSlug(opus, 'high', 'fast')).toBe('claude-opus-5-5-high-fast');
    // auto/unset falls through to the family's default tier (medium), still fast.
    expect(resolveDevinSlug(opus, 'auto', 'fast')).toBe('claude-opus-5-5-medium-fast');
    expect(resolveDevinSlug(opus, undefined, 'fast')).toBe('claude-opus-5-5-medium-fast');
    // An effort with no fast variant falls back to the standard resolution.
    expect(resolveDevinSlug(opus, 'max', 'fast')).toBe('claude-opus-5-5-medium');
    expect(resolveDevinSlug(opus, 'max')).toBe('claude-opus-5-5-medium');
  });

  test('matchDevinModel restores a saved fast slug with its effort and Fast on', () => {
    const slug = matchDevinModel(out, 'claude-opus-5-5-high-fast');
    expect(slug?.model.id).toBe('claude-opus-5-5');
    expect(slug?.legacyEffort).toBe('high');
    expect(slug?.legacySpeedTier).toBe('fast');

    const priority = matchDevinModel(out, 'gpt-6-sol-low-priority');
    expect(priority?.model.id).toBe('gpt-6-sol');
    expect(priority?.legacyEffort).toBe('low');
    expect(priority?.legacySpeedTier).toBe('fast');
  });

  test('matchDevinModel restores an old fast family key with Fast on and no effort', () => {
    const match = matchDevinModel(out, 'claude-opus-5-5-fast');
    expect(match?.model.id).toBe('claude-opus-5-5');
    expect(match?.legacySpeedTier).toBe('fast');
    expect(match?.legacyEffort).toBeUndefined();

    const fusion = matchDevinModel(out, 'fusion-claude-opus-5-5-fast-sidekick-swe-2-medium');
    expect(fusion?.model.id).toBe('fusion');
    // The slot prefill is parsed from the alias itself (parseFusionSlug in
    // devin.ts), so no legacy speed tier flows through the generic channel.
    expect(fusion?.legacySpeedTier).toBeUndefined();
  });
});

describe('DevinProvider fusion resolution', () => {
  // A DevinProvider whose catalog is a collapsed real-shaped fixture.
  const fusionRows = [
    'fusion-claude-opus-5-5-medium-sidekick-swe-2-medium',
    'fusion-claude-opus-5-5-high-sidekick-swe-2-medium',
    'fusion-claude-opus-5-5-medium-sidekick-gpt-6-luna-high',
    'fusion-claude-opus-5-5-medium-fast-sidekick-gpt-6-luna-high-priority',
    'fusion-claude-fable-5-2-medium-sidekick-swe-2-medium',
    'fusion-claude-fable-5-2-medium-fast-sidekick-gpt-6-luna-high-priority',
  ].map((id) => def(id, `Fusion (${id})`));
  const models = collapseDevinReasoningTiers(fusionRows);

  const provider = new DevinProvider({ name: 'devin', disabled: false });
  provider.listModels = () => models;
  const resolve = (modelId: string, fusion?: FusionSelection) =>
    (
      provider as unknown as {
        resolveCliModel: (
          m: string,
          effort?: string,
          speed?: string,
          fusion?: FusionSelection,
        ) => { slug: string } | { error: string } | undefined;
      }
    ).resolveCliModel(modelId, undefined, undefined, fusion);

  test('request.fusion resolves to the exact pairing slug', () => {
    expect(
      resolve('fusion', {
        lead: 'claude-opus-5-5',
        leadEffort: 'high',
        leadFast: false,
        sidekick: 'swe-2',
        sidekickEffort: 'medium',
      }),
    ).toEqual({ slug: 'fusion-claude-opus-5-5-high-sidekick-swe-2-medium' });
    expect(
      resolve('fusion', {
        lead: 'claude-fable-5-2',
        leadEffort: 'medium',
        leadFast: true,
        sidekick: 'gpt-6-luna',
        sidekickEffort: 'high',
      }),
    ).toEqual({
      slug: 'fusion-claude-fable-5-2-medium-fast-sidekick-gpt-6-luna-high-priority',
    });
  });

  test('a legacy pairing alias resolves its own exact slug', () => {
    expect(resolve('fusion-claude-opus-5-5-high-sidekick-swe-2-medium')).toEqual({
      slug: 'fusion-claude-opus-5-5-high-sidekick-swe-2-medium',
    });
  });

  test('falls back to the vendor default when no selection is given', () => {
    expect(resolve('fusion')).toEqual({
      slug: 'fusion-claude-opus-5-5-medium-sidekick-swe-2-medium',
    });
  });

  test('an unavailable pairing is an error, never a silent substitute', () => {
    const result = resolve('fusion', {
      lead: 'claude-fable-5-2',
      leadEffort: 'medium',
      leadFast: true,
      sidekick: 'swe-2',
      sidekickEffort: 'medium',
    });
    expect(result).toEqual({
      error: "This Fusion pairing isn't offered by Devin. Pick another Fusion 2 model.",
    });
  });
});

describe('SendMessageRequestSchema fusion strictness', () => {
  test('accepts a well-formed selection and rejects unknown keys', async () => {
    const { SendMessageRequestSchema } = await import('../../validation/schemas');
    const fusion = {
      lead: 'claude-opus-5-5',
      leadEffort: 'medium',
      leadFast: false,
      sidekick: 'swe-2',
      sidekickEffort: 'medium',
    };
    const base = {
      sessionId: '11111111-1111-4111-8111-111111111111',
      content: 'hi',
      clientMessageId: 'cm_test-123',
    };
    expect(
      SendMessageRequestSchema.safeParse({ ...base, fusion }).success,
    ).toBe(true);
    expect(
      SendMessageRequestSchema.safeParse({
        ...base,
        fusion: { ...fusion, bogus: true },
      }).success,
    ).toBe(false);
    expect(
      SendMessageRequestSchema.safeParse({
        ...base,
        fusion: { ...fusion, leadFast: 'yes' },
      }).success,
    ).toBe(false);
  });
});
