export const DOUBLE_ESCAPE_WINDOW_MS = 500;

export function registerEligibleEscape(
  previousAt: number,
  now: number,
  windowMs = DOUBLE_ESCAPE_WINDOW_MS,
): { open: boolean; nextAt: number } {
  if (previousAt > 0 && now >= previousAt && now - previousAt <= windowMs) {
    return { open: true, nextAt: 0 };
  }
  return { open: false, nextAt: now };
}
