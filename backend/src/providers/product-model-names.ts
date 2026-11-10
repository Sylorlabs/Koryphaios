// Display names for the model catalogs shipped in the CodeBuddy CLI and the
// WorkBuddy Desktop app bundle (product*.json).
//
// Those catalogs are vendor-owned and reuse display names for genuinely
// different model ids. For example WorkBuddy AI 5.9.4 ships two entries named
// "Deepseek-V4.1-Flash": `deepseek-v4.1-flash` at "x0.00 credits" and
// `deepseek-v4.1-flash-sg` at "x0.03 credits". Both report the same context
// window, output cap, capabilities and descriptions, so a picker that renders
// only the name offers two visually identical rows and no way to tell what the
// choice means.
//
// This helper keeps the vendor's name but appends the real distinguishing
// fact, taken verbatim from the same catalog entry. Nothing is guessed.

export interface ProductModelLabelInput {
  /** Raw vendor model id, unique within a catalog. */
  id: string;
  /** Vendor display name, not guaranteed to be unique. */
  name: string;
  /** Vendor per-request price label, e.g. "x0.03 credits". */
  credits?: string;
}

/** Normalize a vendor credit label for display. "x0.00 credits" reads better
 *  as "free"; every other label is kept exactly as the vendor wrote it. */
export function productModelCreditLabel(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  if (!text) return undefined;
  const match = text.match(/^x?\s*(\d+(?:\.\d+)?)\s*credits?$/i);
  if (match && Number(match[1]) === 0) return 'free';
  return text;
}

/**
 * Return one display name per input entry, preserving catalog order.
 *
 * A name used once stays untouched. For a name used more than once, each entry
 * gains a parenthesized suffix. When the group reports distinct credit prices
 * that is the suffix, because price is the difference the user is actually
 * choosing between. Otherwise the raw model id is used, which is always
 * unique. A final ordinal guard keeps names distinct even for a malformed
 * catalog that repeats ids.
 */
export function productModelDisplayNames(entries: readonly ProductModelLabelInput[]): string[] {
  const groups = new Map<string, number[]>();
  entries.forEach((entry, index) => {
    const indexes = groups.get(entry.name) ?? [];
    indexes.push(index);
    groups.set(entry.name, indexes);
  });

  const names = entries.map((entry) => entry.name);
  for (const indexes of groups.values()) {
    if (indexes.length < 2) continue;
    const credits = indexes.map((index) => productModelCreditLabel(entries[index].credits));
    const creditsDistinguish =
      credits.every((label) => label !== undefined) && new Set(credits).size === indexes.length;
    const candidates = indexes.map((index, position) => {
      const suffix = creditsDistinguish ? credits[position]! : entries[index].id;
      return `${entries[index].name} (${suffix})`;
    });
    const unique = new Set(candidates).size === candidates.length;
    indexes.forEach((index, position) => {
      names[index] = unique
        ? candidates[position]
        : `${entries[index].name} (${entries[index].id} #${position + 1})`;
    });
  }
  return names;
}
