import type {
  FusionCatalog,
  FusionPairingMeta,
  FusionSelection,
  FusionSlotOption,
} from './ModelDefs';

/**
 * Devin's Fusion is ONE model with two editable slots: a lead and a sidekick.
 * The CLI publishes the pairing matrix as one slug per cell —
 * `fusion-<lead>-<leadEffort>[-fast]-sidekick-<sidekick>[-<effort>][-priority]`
 * — so this module collapses those rows into a catalog the composer edits
 * per-slot, and resolves a slot selection back to the exact vendor slug.
 * Nothing about the matrix is hard-coded: leads, sidekicks, efforts and the
 * fast/priority coupling all come from the rows the CLI reported.
 */

/** Effort words Devin bakes into slugs, least to most thinking. `fast`/`slow`
 *  are valid lead-effort tokens on some families, so both parse here. */
const FUSION_EFFORT_WORDS = [
  'none',
  'minimal',
  'low',
  'fast',
  'medium',
  'high',
  'xhigh',
  'ultra',
  'max',
  'slow',
] as const;

const FUSION_EFFORT_SET = new Set<string>(FUSION_EFFORT_WORDS);

const FUSION_SLUG_RE =
  /^fusion-(.+?)-(none|minimal|low|fast|medium|high|xhigh|ultra|max|slow)(?:-(fast))?-sidekick-(.+)$/i;
const FUSION_SIDEKICK_RE =
  /^(.+?)(?:-(none|minimal|low|medium|high|xhigh|ultra|max|slow))?(?:-(priority))?$/i;

export interface FusionSlugParts extends FusionSelection {
  /** The sidekick tail ended in `-priority` — the speed token GPT sidekicks
   *  gain automatically when the lead is fast. */
  sidekickPriority: boolean;
}

/** Split a fusion slug into its editable selection plus the sidekick's own
 *  speed marker. Returns undefined for non-fusion slugs. */
export function splitFusionSlug(slug: string): FusionSlugParts | undefined {
  const m = slug.match(FUSION_SLUG_RE);
  if (!m) return undefined;
  const tail = m[4].match(FUSION_SIDEKICK_RE);
  if (!tail) return undefined;
  const sidekickPriority = tail[3] !== undefined;
  return {
    lead: m[1],
    leadEffort: m[2].toLowerCase(),
    // `-priority` in the sidekick tail only ever rides a `-fast` lead.
    leadFast: m[3] !== undefined || sidekickPriority,
    sidekick: tail[1],
    sidekickEffort: tail[2]?.toLowerCase() ?? null,
    sidekickPriority,
  };
}

/** Parse a (possibly legacy) fusion slug into a slot selection. */
export function parseFusionSlug(slug: string): FusionSelection | undefined {
  const parts = splitFusionSlug(slug);
  if (!parts) return undefined;
  const { sidekickPriority: _ignored, ...selection } = parts;
  return selection;
}

/** Pairing-matrix cell key: lead + lead speed + sidekick family + the
 *  sidekick's effort token (empty when the family has none, e.g. GLM). */
export function fusionPairingKey(
  lead: string,
  leadFast: boolean,
  sidekick: string,
  sidekickEffort: string | null,
): string {
  return `${lead}|${leadFast ? 'fast' : 'std'}|${sidekick}|${sidekickEffort ?? ''}`;
}

/** The exact Devin slug for a slot selection, or undefined when the vendor
 *  doesn't offer that pairing/lead-effort combination. */
export function resolveFusionSlug(
  catalog: FusionCatalog,
  sel: FusionSelection,
): string | undefined {
  const key = fusionPairingKey(sel.lead, sel.leadFast, sel.sidekick, sel.sidekickEffort);
  return catalog.pairings[key]?.[sel.leadEffort];
}

/** Whether the vendor lists this exact pairing (lead effort included). */
export function isFusionPairingAvailable(
  catalog: FusionCatalog,
  sel: FusionSelection,
): boolean {
  return resolveFusionSlug(catalog, sel) !== undefined;
}

/** 'Priority' when a fast lead puts this sidekick on the `-priority` serving
 *  tier (the GPT sidekicks), otherwise null. */
export function fusionSidekickSpeedLabel(
  sidekickId: string,
  leadFast: boolean,
  catalog: FusionCatalog,
): 'Priority' | null {
  if (!leadFast) return null;
  for (const [key, efforts] of Object.entries(catalog.pairings)) {
    const [, speed, sidekick] = key.split('|');
    if (speed !== 'fast' || sidekick !== sidekickId) continue;
    const slug = Object.values(efforts)[0];
    if (slug && /-priority$/i.test(slug)) return 'Priority';
  }
  return null;
}

/** Sidekick ids that have at least one pairing with this lead at this speed,
 *  in catalog order. */
export function availableSidekicks(
  catalog: FusionCatalog,
  lead: string,
  leadFast: boolean,
): string[] {
  return catalog.sidekicks
    .filter((sk) => {
      if (sk.efforts.length === 0) {
        return Boolean(catalog.pairings[fusionPairingKey(lead, leadFast, sk.id, null)]);
      }
      return sk.efforts.some(
        (effort) => catalog.pairings[fusionPairingKey(lead, leadFast, sk.id, effort)],
      );
    })
    .map((sk) => sk.id);
}

/** Whether any pairing puts this lead on the fast tier with this sidekick. */
export function leadFastAvailable(
  catalog: FusionCatalog,
  lead: string,
  sidekick: string,
  sidekickEffort: string | null,
): boolean {
  return Boolean(catalog.pairings[fusionPairingKey(lead, true, sidekick, sidekickEffort)]);
}

/** Whether any lead effort exists for a pairing cell — cell-level
 *  availability independent of the selected leadEffort. */
function fusionCellAvailable(
  catalog: FusionCatalog,
  sel: Omit<FusionSelection, 'leadEffort'>,
): boolean {
  const cell = catalog.pairings[
    fusionPairingKey(sel.lead, sel.leadFast, sel.sidekick, sel.sidekickEffort)
  ];
  return cell !== undefined && Object.keys(cell).length > 0;
}

export interface FusionAdjustment {
  selection: FusionSelection;
  /** Short human sentence describing an automatic repair, when one ran. */
  adjustedNote?: string;
}

function titleCase(token: string): string {
  return token.replace(/(^|\s)\w/g, (c) => c.toUpperCase());
}

function slotName(option: FusionSlotOption | undefined, id: string): string {
  return option?.name ?? id;
}

/** Repair a slot selection after one field changed, keeping the user's latest
 *  choice and fixing the pairing in a deterministic order:
 *  a. A non-Fast change whose pairing only exists at standard speed turns
 *     Fast off.
 *  b. Otherwise keep the same sidekick family on another of its efforts.
 *  c. Otherwise take the first sidekick the vendor lists for this lead+speed.
 *  d. Last resort: the catalog's default selection. */
export function adjustFusionSelection(
  catalog: FusionCatalog,
  sel: FusionSelection,
  changed: 'lead' | 'leadFast' | 'sidekick' | 'sidekickEffort' | 'leadEffort',
): FusionAdjustment {
  if (
    isFusionPairingAvailable(catalog, sel) ||
    fusionCellAvailable(catalog, sel)
  ) {
    return { selection: { ...sel } };
  }

  // (a) The user's change left Fast on but the pairing only exists at
  // standard speed — keep the choice, drop the speed.
  if (changed !== 'leadFast' && sel.leadFast) {
    const std = { ...sel, leadFast: false };
    if (fusionCellAvailable(catalog, std)) {
      return {
        selection: std,
        adjustedNote: "Fast isn't offered for this pairing — turned Fusion 1 Fast off.",
      };
    }
  }

  // (b) Same sidekick family, another of its effort tokens.
  const sameFamily = catalog.sidekicks.find((sk) => sk.id === sel.sidekick);
  if (sameFamily) {
    for (const effort of sameFamily.efforts) {
      if (effort === sel.sidekickEffort) continue;
      const candidate = { ...sel, sidekickEffort: effort };
      if (fusionCellAvailable(catalog, candidate)) {
        return {
          selection: candidate,
          adjustedNote: `${sameFamily.name} is offered at ${titleCase(effort)} in this pairing — adjusted Fusion 2.`,
        };
      }
    }
  }

  // (c) First available sidekick in the vendor's catalog order.
  const leadOption = catalog.leads.find((l) => l.id === sel.lead);
  const leadLabel = `${sel.leadFast ? 'Fast ' : ''}${slotName(leadOption, sel.lead)}`;
  const sidekickOption = catalog.sidekicks.find((sk) => sk.id === sel.sidekick);
  for (const option of catalog.sidekicks) {
    if (option.id === sel.sidekick) continue;
    const efforts: (string | null)[] = option.efforts.length
      ? option.efforts
      : [null];
    for (const effort of efforts) {
      const candidate = { ...sel, sidekick: option.id, sidekickEffort: effort };
      if (fusionCellAvailable(catalog, candidate)) {
        return {
          selection: candidate,
          adjustedNote: `${slotName(sidekickOption, sel.sidekick)} isn't offered with ${leadLabel} — switched Fusion 2 to ${option.name}.`,
        };
      }
    }
  }

  // (d) Nothing salvages it — restore the vendor's own default pairing.
  return {
    selection: { ...catalog.defaultSelection },
    adjustedNote: "That pairing isn't offered — restored the default Fusion pairing.",
  };
}
