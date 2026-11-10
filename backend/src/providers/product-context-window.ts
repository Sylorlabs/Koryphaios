// Context budgets from the model catalogs shipped in the CodeBuddy CLI and the
// WorkBuddy Desktop app bundle (product*.json).
//
// A product entry can report `maxInputTokens` (the hard ceiling) and a
// `contextWindow` object with `supportedLengths` and `defaultLength`. The
// vendor's own `resolveEffectiveContextBudget` does NOT use the ceiling by
// default: it uses `defaultLength` (e.g. 300K on a 1M model) unless a session
// override is set. Koryphaios shows that choice instead of silently inheriting
// the smaller vendor default, and defaults the selection to the maximum tier.

export interface ProductContextWindowEntry {
  contextWindow?: {
    supportedLengths?: unknown;
    defaultLength?: unknown;
  } | null;
  maxInputTokens?: unknown;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Mirror the vendor's normalization: positive integers, capped by the
 *  reported hard ceiling, de-duplicated and ascending. Never invent a tier. */
export function supportedProductContextWindows(
  entry: ProductContextWindowEntry,
): number[] {
  const raw = entry.contextWindow?.supportedLengths;
  if (!Array.isArray(raw)) return [];
  const ceiling = positiveSafeInteger(entry.maxInputTokens) ? entry.maxInputTokens : undefined;
  return Array.from(
    new Set(
      raw.filter(
        (value): value is number =>
          positiveSafeInteger(value) && (ceiling === undefined || value <= ceiling),
      ),
    ),
  ).sort((a, b) => a - b);
}

/** The vendor's own default tier, only when it is one of its real options. */
export function vendorDefaultContextWindow(
  entry: ProductContextWindowEntry,
  options: readonly number[],
): number | undefined {
  const value = entry.contextWindow?.defaultLength;
  return positiveSafeInteger(value) && options.includes(value) ? value : undefined;
}

/**
 * Resolve the budget for a turn. The maximum reported tier is the default;
 * a configured value is honored only when the live model actually reports
 * that tier. An unknown/invalid value fails closed to the maximum instead of
 * sending the CLI a number it would reject.
 *
 * Returns undefined when the model has fewer than two real tiers, because in
 * that case neither the vendor nor Koryphaios offers a context choice.
 */
export function resolveProductContextBudget(
  configured: number | undefined,
  options: readonly number[],
): number | undefined {
  if (options.length < 2) return undefined;
  const maximum = options[options.length - 1];
  return positiveSafeInteger(configured) && options.includes(configured)
    ? configured
    : maximum;
}
