import { describe, expect, it } from 'bun:test';
import type { FusionCatalog, FusionSelection, FusionSlotOption } from './ModelDefs';
import {
  adjustFusionSelection,
  availableSidekicks,
  fusionPairingKey,
  fusionSidekickSpeedLabel,
  isFusionPairingAvailable,
  leadFastAvailable,
  parseFusionSlug,
  resolveFusionSlug,
  splitFusionSlug,
} from './fusion';

// Real slugs from `devin models` (995 rows); this subset covers every shape the
// helpers must understand: SWE-2's two efforts, a no-effort sidekick (GLM), a
// GPT sidekick and its -priority fast twin, and coupling gaps (fast Fable has
// no SWE-2 pairing; Sonnet has no Sonnet sidekick).
const FIXTURE_SLUGS = [
  // Devin's own list order begins with this row — the catalog default.
  'fusion-claude-opus-5-5-medium-sidekick-swe-2-medium',
  'fusion-claude-opus-5-5-low-sidekick-swe-2-medium',
  'fusion-claude-opus-5-5-high-sidekick-swe-2-medium',
  'fusion-claude-opus-5-5-xhigh-sidekick-swe-2-medium',
  'fusion-claude-opus-5-5-max-sidekick-swe-2-medium',
  'fusion-claude-opus-5-5-medium-fast-sidekick-swe-2-medium',
  'fusion-claude-opus-5-5-low-fast-sidekick-swe-2-medium',
  'fusion-claude-opus-5-5-high-fast-sidekick-swe-2-medium',
  'fusion-claude-opus-5-5-xhigh-fast-sidekick-swe-2-medium',
  'fusion-claude-opus-5-5-max-fast-sidekick-swe-2-medium',
  'fusion-claude-opus-5-5-medium-sidekick-swe-2-high',
  'fusion-claude-opus-5-5-low-sidekick-swe-2-high',
  'fusion-claude-opus-5-5-high-sidekick-swe-2-high',
  'fusion-claude-opus-5-5-xhigh-sidekick-swe-2-high',
  'fusion-claude-opus-5-5-max-sidekick-swe-2-high',
  'fusion-claude-opus-5-5-medium-sidekick-glm-5-2',
  'fusion-claude-opus-5-5-low-sidekick-glm-5-2',
  'fusion-claude-opus-5-5-high-sidekick-glm-5-2',
  'fusion-claude-opus-5-5-xhigh-sidekick-glm-5-2',
  'fusion-claude-opus-5-5-max-sidekick-glm-5-2',
  'fusion-claude-opus-5-5-medium-sidekick-gpt-6-luna-high',
  'fusion-claude-opus-5-5-low-sidekick-gpt-6-luna-high',
  'fusion-claude-opus-5-5-high-sidekick-gpt-6-luna-high',
  'fusion-claude-opus-5-5-xhigh-sidekick-gpt-6-luna-high',
  'fusion-claude-opus-5-5-max-sidekick-gpt-6-luna-high',
  'fusion-claude-opus-5-5-medium-fast-sidekick-gpt-6-luna-high-priority',
  'fusion-claude-opus-5-5-low-fast-sidekick-gpt-6-luna-high-priority',
  'fusion-claude-opus-5-5-high-fast-sidekick-gpt-6-luna-high-priority',
  'fusion-claude-opus-5-5-xhigh-fast-sidekick-gpt-6-luna-high-priority',
  'fusion-claude-opus-5-5-max-fast-sidekick-gpt-6-luna-high-priority',
  'fusion-claude-fable-5-2-medium-sidekick-swe-2-medium',
  'fusion-claude-fable-5-2-low-sidekick-swe-2-medium',
  'fusion-claude-fable-5-2-high-sidekick-swe-2-medium',
  'fusion-claude-fable-5-2-xhigh-sidekick-swe-2-medium',
  'fusion-claude-fable-5-2-max-sidekick-swe-2-medium',
  // Fast Fable pairs only with GPT sidekicks — no swe-2 cell exists here.
  'fusion-claude-fable-5-2-medium-fast-sidekick-gpt-6-luna-high-priority',
  'fusion-claude-fable-5-2-low-fast-sidekick-gpt-6-luna-high-priority',
  'fusion-claude-fable-5-2-high-fast-sidekick-gpt-6-luna-high-priority',
  'fusion-claude-fable-5-2-xhigh-fast-sidekick-gpt-6-luna-high-priority',
  'fusion-claude-fable-5-2-max-fast-sidekick-gpt-6-luna-high-priority',
  'fusion-claude-fable-5-2-medium-fast-sidekick-gpt-5-6-luna-high-priority',
  'fusion-claude-fable-5-2-medium-fast-sidekick-gpt-6-1-terra-high-priority',
  'fusion-claude-fable-5-2-medium-fast-sidekick-gpt-5-6-sol-high-priority',
  'fusion-claude-sonnet-5-5-medium-sidekick-swe-2-medium',
  'fusion-claude-sonnet-5-5-low-sidekick-swe-2-medium',
  'fusion-claude-sonnet-5-5-high-sidekick-swe-2-medium',
  'fusion-claude-sonnet-5-5-xhigh-sidekick-swe-2-medium',
  'fusion-claude-sonnet-5-5-max-sidekick-swe-2-medium',
  'fusion-claude-sonnet-5-5-medium-sidekick-swe-2-high',
  'fusion-claude-sonnet-5-5-low-sidekick-swe-2-high',
  'fusion-claude-sonnet-5-5-high-sidekick-swe-2-high',
  'fusion-claude-sonnet-5-5-xhigh-sidekick-swe-2-high',
  'fusion-claude-sonnet-5-5-max-sidekick-swe-2-high',
];

const EFFORT_ORDER = ['none', 'minimal', 'low', 'fast', 'medium', 'high', 'xhigh', 'ultra', 'max', 'slow'];
const NAME_WORD =
  /\s+(No Thinking|Minimal|Low|Medium|High|XHigh|Ultra|Max|Slow|Fast|Priority)(?=\s|$)/gi;

const FIXTURE_NAMES: Record<string, string> = {
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-fable-5-2': 'Claude Fable 5.2',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
  'swe-2': 'SWE-2',
  'swe-2-flash': 'SWE-2 Flash',
  'glm-5-2': 'GLM-5.2',
  'claude-haiku-5-5': 'Claude Haiku 5.5',
  'gpt-6-luna': 'GPT-6 Luna',
  'gpt-5-6-luna': 'GPT-5.6 Luna',
  'gpt-6-1-terra': 'GPT-6.1 Terra',
  'gpt-5-6-sol': 'GPT-5.6 Sol',
};

function displayName(id: string): string {
  return FIXTURE_NAMES[id] ?? id;
}

/** Mirror of the backend's row → catalog assembly, but names come from a
 * synthesized `Fusion (… + …)` row name like the CLI emits. */
function fixtureCatalog(slugs: string[]): FusionCatalog {
  const leads = new Map<string, FusionSlotOption>();
  const sidekicks = new Map<string, FusionSlotOption>();
  const leadEfforts = new Map<string, Set<string>>();
  const sidekickEfforts = new Map<string, Set<string>>();
  const pairings: Record<string, Record<string, string>> = {};
  const meta: FusionCatalog['meta'] = {};
  let defaultSelection: FusionSelection | undefined;

  for (const slug of slugs) {
    const parts = splitFusionSlug(slug);
    if (!parts) throw new Error(`fixture slug did not parse: ${slug}`);
    const leadName = displayName(parts.lead);
    const skName = displayName(parts.sidekick);
    if (!leads.has(parts.lead)) {
      leads.set(parts.lead, { id: parts.lead, name: leadName, efforts: [], defaultEffort: null });
      leadEfforts.set(parts.lead, new Set());
    }
    leadEfforts.get(parts.lead)!.add(parts.leadEffort);
    if (!sidekicks.has(parts.sidekick)) {
      sidekicks.set(parts.sidekick, {
        id: parts.sidekick,
        name: skName,
        efforts: [],
        defaultEffort: null,
      });
      sidekickEfforts.set(parts.sidekick, new Set());
    }
    if (parts.sidekickEffort) sidekickEfforts.get(parts.sidekick)!.add(parts.sidekickEffort);
    const key = fusionPairingKey(parts.lead, parts.leadFast, parts.sidekick, parts.sidekickEffort);
    (pairings[key] ??= {})[parts.leadEffort] = slug;
    meta[key] ??= {
      contextWindow: 1_000_000,
      costPerMInputTokens: 4,
      costPerMInputCached: 0.2,
      costPerMOutputTokens: 20,
    };
    defaultSelection ??= {
      lead: parts.lead,
      leadEffort: parts.leadEffort,
      leadFast: parts.leadFast,
      sidekick: parts.sidekick,
      sidekickEffort: parts.sidekickEffort,
    };
  }
  const finish = (option: FusionSlotOption, efforts: Set<string>) => {
    option.efforts = [...efforts].sort(
      (a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b),
    );
    option.defaultEffort = option.efforts.includes('medium')
      ? 'medium'
      : (option.efforts[0] ?? null);
  };
  for (const [id, o] of leads) finish(o, leadEfforts.get(id)!);
  for (const [id, o] of sidekicks) finish(o, sidekickEfforts.get(id)!);
  return {
    leads: [...leads.values()],
    sidekicks: [...sidekicks.values()],
    pairings,
    meta,
    defaultSelection: defaultSelection!,
  };
}

const catalog = fixtureCatalog(FIXTURE_SLUGS);

const sel = (patch: Partial<FusionSelection>): FusionSelection => ({
  lead: 'claude-opus-5-5',
  leadEffort: 'medium',
  leadFast: false,
  sidekick: 'swe-2',
  sidekickEffort: 'medium',
  ...patch,
});

describe('fixture catalog shape', () => {
  it('derives slot efforts and defaults from the rows', () => {
    const opus = catalog.leads.find((l) => l.id === 'claude-opus-5-5')!;
    expect(opus.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(opus.defaultEffort).toBe('medium');
    const swe2 = catalog.sidekicks.find((sk) => sk.id === 'swe-2')!;
    expect(swe2.efforts).toEqual(['medium', 'high']);
    const glm = catalog.sidekicks.find((sk) => sk.id === 'glm-5-2')!;
    expect(glm.efforts).toEqual([]);
    expect(glm.defaultEffort).toBeNull();
  });

  it('sets defaultSelection from the first row in vendor order', () => {
    expect(catalog.defaultSelection).toEqual({
      lead: 'claude-opus-5-5',
      leadEffort: 'medium',
      leadFast: false,
      sidekick: 'swe-2',
      sidekickEffort: 'medium',
    });
  });
});

describe('resolveFusionSlug / availability', () => {
  it('resolves a standard pairing to the exact slug', () => {
    expect(resolveFusionSlug(catalog, sel({}))).toBe(
      'fusion-claude-opus-5-5-medium-sidekick-swe-2-medium',
    );
    expect(resolveFusionSlug(catalog, sel({ leadEffort: 'max' }))).toBe(
      'fusion-claude-opus-5-5-max-sidekick-swe-2-medium',
    );
  });

  it('resolves a fast + GPT pairing to its -priority slug', () => {
    expect(
      resolveFusionSlug(
        catalog,
        sel({ leadFast: true, sidekick: 'gpt-6-luna', sidekickEffort: 'high' }),
      ),
    ).toBe('fusion-claude-opus-5-5-medium-fast-sidekick-gpt-6-luna-high-priority');
  });

  it('resolves the no-effort GLM sidekick', () => {
    expect(resolveFusionSlug(catalog, sel({ sidekick: 'glm-5-2', sidekickEffort: null }))).toBe(
      'fusion-claude-opus-5-5-medium-sidekick-glm-5-2',
    );
  });

  it('reports unavailable pairings', () => {
    // Fast Fable has no SWE-2 pairing.
    expect(
      isFusionPairingAvailable(
        catalog,
        sel({ lead: 'claude-fable-5-2', leadFast: true }),
      ),
    ).toBe(false);
    // Sonnet has no Sonnet sidekick at all.
    expect(
      isFusionPairingAvailable(
        catalog,
        sel({
          lead: 'claude-sonnet-5-5',
          sidekick: 'claude-sonnet-5-5',
          sidekickEffort: 'medium',
        }),
      ),
    ).toBe(false);
  });

  it('lists sidekicks per lead+speed in catalog order', () => {
    const std = availableSidekicks(catalog, 'claude-opus-5-5', false);
    expect(std).toEqual(['swe-2', 'glm-5-2', 'gpt-6-luna']);
    const fastFable = availableSidekicks(catalog, 'claude-fable-5-2', true);
    expect(fastFable).toEqual([
      'gpt-6-luna',
      'gpt-5-6-luna',
      'gpt-6-1-terra',
      'gpt-5-6-sol',
    ]);
  });

  it('detects the lead fast tier per pairing', () => {
    expect(leadFastAvailable(catalog, 'claude-opus-5-5', 'swe-2', 'medium')).toBe(true);
    expect(leadFastAvailable(catalog, 'claude-fable-5-2', 'swe-2', 'medium')).toBe(false);
    expect(leadFastAvailable(catalog, 'claude-fable-5-2', 'gpt-6-luna', 'high')).toBe(true);
  });

  it('labels the GPT sidekick Priority only on a fast lead', () => {
    expect(fusionSidekickSpeedLabel('gpt-6-luna', true, catalog)).toBe('Priority');
    expect(fusionSidekickSpeedLabel('gpt-6-luna', false, catalog)).toBeNull();
    expect(fusionSidekickSpeedLabel('swe-2', true, catalog)).toBeNull();
  });
});

describe('parseFusionSlug', () => {
  it('round-trips every fixture slug', () => {
    for (const slug of FIXTURE_SLUGS) {
      const parts = splitFusionSlug(slug);
      expect(parts, slug).toBeDefined();
      const { sidekickPriority: _p, ...selection } = parts!;
      expect(resolveFusionSlug(catalog, selection), slug).toBe(slug);
    }
  });

  it('recovers the no-effort and priority shapes', () => {
    expect(parseFusionSlug('fusion-claude-opus-5-5-medium-sidekick-glm-5-2')).toEqual({
      lead: 'claude-opus-5-5',
      leadEffort: 'medium',
      leadFast: false,
      sidekick: 'glm-5-2',
      sidekickEffort: null,
    });
    expect(
      parseFusionSlug('fusion-claude-opus-5-5-medium-fast-sidekick-gpt-6-luna-high-priority'),
    ).toEqual({
      lead: 'claude-opus-5-5',
      leadEffort: 'medium',
      leadFast: true,
      sidekick: 'gpt-6-luna',
      sidekickEffort: 'high',
    });
    expect(parseFusionSlug('claude-opus-5-5-medium')).toBeUndefined();
  });
});

describe('adjustFusionSelection', () => {
  it('returns the selection unchanged when the pairing exists', () => {
    const out = adjustFusionSelection(catalog, sel({}), 'sidekick');
    expect(out.selection).toEqual(sel({}));
    expect(out.adjustedNote).toBeUndefined();
  });

  it('rule a: a non-Fast change keeps the choice and turns Fast off when only the standard pairing exists', () => {
    // Fast Fable has no SWE-2 cell, but standard Fable does — choosing SWE-2
    // while Fast is on keeps the pick and drops the speed.
    const out = adjustFusionSelection(
      catalog,
      sel({ lead: 'claude-fable-5-2', leadFast: true }),
      'sidekick',
    );
    expect(out.selection.leadFast).toBe(false);
    expect(out.selection.sidekick).toBe('swe-2');
    expect(out.selection.sidekickEffort).toBe('medium');
    expect(out.adjustedNote).toContain('Fast');
  });

  it('rule b: keeps the same sidekick family on its other effort', () => {
    // swe-2-high has no fast pairing in this fixture but swe-2-medium does…
    // construct a gap: sonnet pairs with swe-2-medium only.
    const gap: FusionCatalog = {
      ...catalog,
      pairings: { ...catalog.pairings },
    };
    delete gap.pairings[
      fusionPairingKey('claude-sonnet-5-5', false, 'swe-2', 'medium')
    ];
    const out = adjustFusionSelection(
      gap,
      sel({ lead: 'claude-sonnet-5-5', sidekickEffort: 'medium' }),
      'lead',
    );
    expect(out.selection.sidekickEffort).toBe('high');
    expect(out.adjustedNote).toContain('SWE-2');
  });

  it('rule c: switches to the first available sidekick in catalog order', () => {
    const out = adjustFusionSelection(
      catalog,
      sel({ leadFast: true, sidekick: 'glm-5-2', sidekickEffort: null }),
      'leadFast',
    );
    // Fast Opus pairs with swe-2 and gpt-6-luna in this fixture — swe-2 wins
    // catalog order.
    expect(out.selection.sidekick).toBe('swe-2');
    expect(out.adjustedNote).toContain('GLM-5.2');
    expect(out.adjustedNote).toContain('switched Fusion 2');
  });

  it('rule c: fast Fable rejects swe-2 and lands on a GPT sidekick', () => {
    const out = adjustFusionSelection(
      catalog,
      sel({ lead: 'claude-fable-5-2', leadFast: true }),
      'leadFast',
    );
    expect(out.selection.sidekick).toBe('gpt-6-luna');
    expect(out.selection.sidekickEffort).toBe('high');
    expect(out.adjustedNote).toContain('Fast');
  });

  it('rule d: falls back to the vendor default when nothing salvages it', () => {
    const empty: FusionCatalog = {
      ...catalog,
      pairings: {
        [fusionPairingKey('claude-opus-5-5', false, 'swe-2', 'medium')]:
          catalog.pairings[fusionPairingKey('claude-opus-5-5', false, 'swe-2', 'medium')],
      },
    };
    const out = adjustFusionSelection(
      empty,
      sel({ lead: 'claude-sonnet-5-5', sidekick: 'glm-5-2', sidekickEffort: null }),
      'lead',
    );
    expect(out.selection).toEqual(empty.defaultSelection);
    expect(out.adjustedNote).toContain('default');
  });
});
