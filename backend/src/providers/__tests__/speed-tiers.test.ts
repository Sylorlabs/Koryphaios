import { describe, expect, it } from 'bun:test';
import type { ModelDef } from '@koryphaios/shared';
import {
  foldVendorSpeedTiers,
  normalizeSpeedTier,
  resolveSpeedVariant,
  VENDOR_SPEED_TIER_RULES,
} from '../speed-tiers';

const model = (id: string, extra: Partial<ModelDef> = {}): ModelDef => ({
  id,
  apiModelId: id,
  name: id,
  provider: 'openrouter',
  contextWindow: 0,
  contextVerified: false,
  maxOutputTokens: 0,
  costPerMInputTokens: 0,
  costPerMOutputTokens: 0,
  canReason: false,
  supportsAttachments: false,
  supportsStreaming: true,
  ...extra,
});

describe('VENDOR_SPEED_TIER_RULES', () => {
  it('every rule carries vendor evidence and an anchored suffix', () => {
    for (const rule of VENDOR_SPEED_TIER_RULES) {
      expect(rule.evidence).toMatch(/^https?:\/\//);
      expect(rule.tier.id).toBeTruthy();
      expect(rule.suffix.source.endsWith('$')).toBe(true);
    }
  });
});

describe('foldVendorSpeedTiers', () => {
  it('folds minimax-m2.7 + minimax-m2.7-highspeed into one model', () => {
    const out = foldVendorSpeedTiers([model('minimax-m2.7'), model('minimax-m2.7-highspeed')]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('minimax-m2.7');
    expect(out[0].speedTiers).toEqual([
      expect.objectContaining({ id: 'highspeed', label: 'Highspeed' }),
    ]);
    expect(out[0].speedVariants).toEqual({ highspeed: { default: 'minimax-m2.7-highspeed' } });
    expect(out[0].speedAliases).toEqual({ 'minimax-m2.7-highspeed': 'highspeed' });
    expect(out[0].aliases).toContain('minimax-m2.7-highspeed');
  });

  it('folds xiaomi/mimo-v2.6-pro + xiaomi/mimo-v2.6-pro-ultraspeed', () => {
    const out = foldVendorSpeedTiers([
      model('xiaomi/mimo-v2.6-pro'),
      model('xiaomi/mimo-v2.6-pro-ultraspeed'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('xiaomi/mimo-v2.6-pro');
    expect(out[0].speedTiers).toEqual([expect.objectContaining({ id: 'ultraspeed' })]);
    expect(out[0].speedVariants).toEqual({
      ultraspeed: { default: 'xiaomi/mimo-v2.6-pro-ultraspeed' },
    });
  });

  it('folds the openrouter/xiaomi/ namespaced form', () => {
    const out = foldVendorSpeedTiers([
      model('openrouter/xiaomi/mimo-v2.6-pro'),
      model('openrouter/xiaomi/mimo-v2.6-pro-ultraspeed'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('openrouter/xiaomi/mimo-v2.6-pro');
    expect(out[0].speedTiers).toEqual([expect.objectContaining({ id: 'ultraspeed' })]);
  });

  it('keeps a variant whose base is absent', () => {
    const out = foldVendorSpeedTiers([model('minimax-m2.7-highspeed')]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('minimax-m2.7-highspeed');
    expect(out[0].speedTiers).toBeUndefined();
  });

  it('prefers the variant apiModelId for speedVariants.default', () => {
    const out = foldVendorSpeedTiers([
      model('minimax-m2.7'),
      model('minimax-m2.7-highspeed', { apiModelId: 'vendor/HighSpeed-Slug' }),
    ]);
    expect(out[0].speedVariants).toEqual({ highspeed: { default: 'vendor/HighSpeed-Slug' } });
  });

  it('never folds name-alike models that are not the same model', () => {
    const ids = [
      'z-ai/glm-5',
      'z-ai/glm-5-turbo',
      'veo-3.1',
      'veo-3.1-fast',
      'eleven_v4',
      'eleven_v4_turbo',
      'swe-2',
      'swe-2-lightning',
      'gpt-3.5-turbo',
      'nvidia/nemotron-3.5-lightning:free',
      'minimax-m2.7-highspeed:free',
      'morph-v3-fast',
      'grok-code-fast-1',
    ];
    const out = foldVendorSpeedTiers(ids.map((id) => model(id)));
    expect(out.map((m) => m.id).sort()).toEqual([...ids].sort());
    for (const m of out) expect(m.speedTiers).toBeUndefined();
  });

  it('does not duplicate the tier when two confirmed variants fold into one base', () => {
    const out = foldVendorSpeedTiers([
      model('minimax-m2.7'),
      model('minimax-m2.7-highspeed'),
      model('minimax-m2.7-highspeed', { apiModelId: 'minimax-m2.7-highspeed' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].speedTiers).toHaveLength(1);
  });
});

describe('resolveSpeedVariant', () => {
  const def = model('base', {
    speedVariants: {
      highspeed: { default: 'base-highspeed', high: 'base-highspeed-hi' },
      fast: { low: 'base-fast-low' },
    },
  });

  it('returns the effort-specific slug when present', () => {
    expect(resolveSpeedVariant(def, 'highspeed', 'high')).toBe('base-highspeed-hi');
  });

  it('falls back to the default slug for unknown or absent effort', () => {
    expect(resolveSpeedVariant(def, 'highspeed', 'low')).toBe('base-highspeed');
    expect(resolveSpeedVariant(def, 'highspeed')).toBe('base-highspeed');
  });

  it('returns undefined for standard speed or an unknown tier', () => {
    expect(resolveSpeedVariant(def, undefined)).toBeUndefined();
    expect(resolveSpeedVariant(def, 'nope')).toBeUndefined();
    expect(resolveSpeedVariant(undefined, 'highspeed')).toBeUndefined();
  });

  it('returns undefined when the tier has no matching variant and no default', () => {
    expect(resolveSpeedVariant(def, 'fast', 'high')).toBeUndefined();
  });
});

describe('normalizeSpeedTier', () => {
  it('keeps an explicit speedTier', () => {
    expect(normalizeSpeedTier('openai', 'ultraspeed', true)).toBe('ultraspeed');
    expect(normalizeSpeedTier('codex', 'fast', undefined)).toBe('fast');
  });

  it('maps legacy fastMode:true onto the provider tier', () => {
    expect(normalizeSpeedTier('openai', undefined, true)).toBe('priority');
    expect(normalizeSpeedTier('codex', undefined, true)).toBe('fast');
    expect(normalizeSpeedTier('devin', undefined, true)).toBe('fast');
    expect(normalizeSpeedTier(undefined, undefined, true)).toBe('fast');
  });

  it('returns undefined when nothing was requested', () => {
    expect(normalizeSpeedTier('openai', undefined, undefined)).toBeUndefined();
    expect(normalizeSpeedTier('openai', undefined, false)).toBeUndefined();
    expect(normalizeSpeedTier('openai', null, undefined)).toBeUndefined();
  });
});

describe('foldVendorSpeedTiers input isolation', () => {
  it('never mutates the input models, so shared catalog objects cannot leak a tier', () => {
    const base = model('minimax-m2.7');
    const variant = model('minimax-m2.7-highspeed');
    const out = foldVendorSpeedTiers([base, variant]);
    expect(base.speedTiers).toBeUndefined();
    expect(base.speedVariants).toBeUndefined();
    expect(base.aliases).toBeUndefined();
    expect(out).toHaveLength(1);
    expect(out[0]).not.toBe(base);
    expect(out[0]!.speedTiers?.map((t) => t.id)).toEqual(['highspeed']);
    expect(foldVendorSpeedTiers([base])[0]!.speedTiers).toBeUndefined();
  });
});
