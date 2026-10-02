/** Chat-surface USD formatting.
 *
 * Chat prices are routinely well under a cent, so fixed-precision output is
 * either noise (`$0.0000`) or padding (`$3.3860`). Every chat price is
 * therefore rendered with at most `USD_MAX_DECIMALS` decimals and no trailing
 * zeros, and anything that rounds to nothing is rendered as `$0` rather than
 * `-$0` / `$0.000`. */

export const USD_MAX_DECIMALS = 3;

/** Shown when a price is real but unknown (unpriced model, untracked usage). */
export const USD_UNKNOWN = '$?.??';

/** Smallest magnitude that survives `USD_MAX_DECIMALS` rounding. */
const USD_EPSILON = 0.5 * 10 ** -USD_MAX_DECIMALS;

/** True when a price is absent, non-finite, or too small to survive rounding —
 * i.e. when printing it would only add `0.000` noise. */
export function isZeroUsd(value: number | null | undefined): boolean {
  if (value == null || !Number.isFinite(value)) return true;
  return Math.abs(value) < USD_EPSILON;
}

export function formatUsd(
  value: number | null | undefined,
  maxDecimals: number = USD_MAX_DECIMALS,
): string {
  if (value == null || !Number.isFinite(value)) return USD_UNKNOWN;
  const digits = Math.max(0, Math.min(6, Math.trunc(maxDecimals)));
  const magnitude = Math.abs(value);
  if (magnitude < 0.5 * 10 ** -digits) return `${value < 0 ? '-' : ''}$0`;
  const sign = value < 0 ? '-' : '';
  const fixed = magnitude.toFixed(digits);
  const trimmed = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
  return `${sign}$${trimmed}`;
}

/** Signed price for a delta (savings, spend change). Returns `null` when the
 * delta rounds to zero so callers can omit the value entirely instead of
 * printing `+$0.000`. */
export function formatUsdDelta(value: number | null | undefined): string | null {
  if (isZeroUsd(value)) return null;
  return `${(value as number) > 0 ? '+' : '-'}${formatUsd(Math.abs(value as number))}`;
}
