/**
 * Freebuff reports its allowance and per-model rates in Freebucks. The account's
 * live rate table (`hours.prices`, Freebucks per session hour) is the only
 * authority for turning those numbers into hours: the cheapest paid model is
 * the account's 1x rate, so a 10x model burns ten hours for every one it runs.
 *
 * Nothing here may hardcode a rate, an hourly allowance, or a multiplier. When
 * the account has not reported a rate the number stays Freebucks, never hours.
 */

/** The cheapest provider-reported rate; the account's 1x baseline. */
export function freebuffBaseRate(prices: Record<string, number> | undefined): number | undefined {
  if (!prices) return undefined;
  let base: number | undefined;
  for (const value of Object.values(prices)) {
    if (!Number.isFinite(value) || value <= 0) continue;
    base = base === undefined ? value : Math.min(base, value);
  }
  return base;
}

/** Provider Freebucks converted into session hours at the live 1x rate. */
export function freebuffHoursFromFreebucks(
  freebucks: number | undefined,
  baseRate: number | undefined,
): number | undefined {
  if (freebucks === undefined || !Number.isFinite(freebucks) || freebucks < 0) return undefined;
  if (baseRate === undefined || !Number.isFinite(baseRate) || baseRate <= 0) return undefined;
  return freebucks / baseRate;
}

/** A model's rate as a multiple of the account's 1x rate, e.g. 1, 5, 10. */
export function freebuffRateMultiplier(
  price: number | undefined,
  baseRate: number | undefined,
): number | undefined {
  if (price === 0) return 0;
  if (price === undefined || !Number.isFinite(price) || price < 0) return undefined;
  if (baseRate === undefined || !Number.isFinite(baseRate) || baseRate <= 0) return undefined;
  return price / baseRate;
}

/** Session-hours a given Freebuck amount buys at a model rate. */
export function estimateFreebuffHoursLeft(
  dailyFreebucksRemaining: number | undefined,
  freebucksPerSessionHour: number | undefined,
): number | undefined {
  return freebuffHoursFromFreebucks(dailyFreebucksRemaining, freebucksPerSessionHour);
}
