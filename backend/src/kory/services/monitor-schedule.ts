/**
 * Schedule definitions and next-occurrence arithmetic for monitors.
 *
 * Clock schedules are expressed in the host's local time zone, the way a user
 * reads "every weekday at 09:00". They are computed on calendar days, never as
 * "now + 24h", so the result is right across daylight-saving changes:
 *
 *   - A local time that does not exist (the spring-forward gap, e.g. 02:30 on
 *     the day clocks jump from 02:00 to 03:00) runs at the instant JavaScript
 *     maps it to (03:30 here). It runs once, at that instant.
 *   - A local time that occurs twice (the fall-back hour) runs once, at its
 *     first occurrence. Searching is strictly after the previous firing, so the
 *     second occurrence never fires again.
 *
 * Missed-run policy: `nextRunAfter` is always computed from the moment of the
 * call, never from the scheduled time that was missed. A machine that slept
 * through three daily runs fires once on wake and then waits for the next
 * occurrence. Nothing is backfilled.
 */

export type MonitorSchedule =
  | { kind: 'interval'; intervalMs: number }
  | { kind: 'daily'; time: string; weekdays?: number[] }
  | { kind: 'cron'; expression: string }
  | { kind: 'once'; at: number };

export const MIN_SCHEDULE_INTERVAL_MS = 1_000;

/** How far ahead a clock schedule is searched before giving up (covers leap-year cron). */
const SEARCH_DAYS = 366 * 5;

interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** Standard cron: when both day fields are restricted, either may match. */
  domRestricted: boolean;
  dowRestricted: boolean;
}

export function parseClockTime(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function expandField(
  field: string,
  min: number,
  max: number,
  label: string,
  { allowSeven = false }: { allowSeven?: boolean } = {},
): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid ${label} step "${part}"`);
    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart!.includes('-')) {
      const [a, b] = rangePart!.split('-');
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(rangePart);
      hi = stepPart === undefined ? lo : max;
    }
    const upper = allowSeven && hi === 7 ? 7 : max;
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > upper || lo > hi) {
      throw new Error(`Invalid ${label} "${part}"`);
    }
    for (let v = lo; v <= hi; v += step) out.add(allowSeven && v === 7 ? 0 : v);
  }
  return out;
}

/** Parse a 5-field cron expression: minute hour day-of-month month day-of-week (local time). */
export function parseCron(expression: string): CronFields {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5)
    throw new Error('A cron schedule needs five fields: minute hour day month weekday');
  const [m, h, dom, mon, dow] = fields as [string, string, string, string, string];
  return {
    minutes: expandField(m, 0, 59, 'minute'),
    hours: expandField(h, 0, 23, 'hour'),
    daysOfMonth: expandField(dom, 1, 31, 'day of month'),
    months: expandField(mon, 1, 12, 'month'),
    daysOfWeek: expandField(dow, 0, 6, 'weekday', { allowSeven: true }),
    domRestricted: dom !== '*',
    dowRestricted: dow !== '*',
  };
}

/** Local wall-clock instant for a calendar day and time; see the module note on gaps. */
function localInstant(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
): number {
  return new Date(year, monthIndex, day, hour, minute, 0, 0).getTime();
}

function dayMatchesCron(cron: CronFields, date: Date): boolean {
  const dom = date.getDate();
  const dow = date.getDay();
  if (!cron.months.has(date.getMonth() + 1)) return false;
  const domOk = cron.daysOfMonth.has(dom);
  const dowOk = cron.daysOfWeek.has(dow);
  if (cron.domRestricted && cron.dowRestricted) return domOk || dowOk;
  if (cron.domRestricted) return domOk;
  if (cron.dowRestricted) return dowOk;
  return true;
}

/** Strict next occurrence after `afterMs`, or null when none exists within the search window. */
export function nextRunAfter(schedule: MonitorSchedule, afterMs: number): number | null {
  if (!Number.isFinite(afterMs)) throw new Error('A schedule needs a finite reference time');
  switch (schedule.kind) {
    case 'interval':
      return afterMs + schedule.intervalMs;
    case 'once':
      return schedule.at > afterMs ? schedule.at : null;
    case 'daily': {
      const clock = parseClockTime(schedule.time);
      if (!clock) throw new Error(`Invalid clock time "${schedule.time}"`);
      const weekdays = schedule.weekdays?.length ? new Set(schedule.weekdays) : null;
      return searchDays(afterMs, (date) => {
        if (weekdays && !weekdays.has(date.getDay())) return [];
        return [
          localInstant(
            date.getFullYear(),
            date.getMonth(),
            date.getDate(),
            clock.hour,
            clock.minute,
          ),
        ];
      });
    }
    case 'cron': {
      const cron = parseCron(schedule.expression);
      const hours = [...cron.hours].sort((a, b) => a - b);
      const minutes = [...cron.minutes].sort((a, b) => a - b);
      return searchDays(afterMs, (date) => {
        if (!dayMatchesCron(cron, date)) return [];
        const instants: number[] = [];
        for (const hour of hours) {
          for (const minute of minutes) {
            instants.push(
              localInstant(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute),
            );
          }
        }
        return instants.sort((a, b) => a - b);
      });
    }
  }
}

/** The local wall-clock slot an instant falls in, e.g. "2026-11-01 01:30". */
function wallSlot(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Walk calendar days from the day `afterMs` falls on. `candidate` returns the
 * qualifying instants for a day, in order. Days advance by calendar date,
 * so a 23- or 25-hour day never skews the search.
 *
 * A candidate must be later than `afterMs` both as an instant and as a local
 * wall-clock slot. The second clock-face occurrence of a repeated hour is later
 * as an instant but has the same slot, so a run cannot fire twice in one slot.
 */
function searchDays(afterMs: number, candidates: (date: Date) => number[]): number | null {
  const start = new Date(afterMs);
  const afterSlot = wallSlot(afterMs);
  for (let offset = 0; offset <= SEARCH_DAYS; offset++) {
    const date = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate() + offset,
      12,
      0,
      0,
      0,
    );
    for (const at of candidates(date)) {
      if (at > afterMs && wallSlot(at) > afterSlot) return at;
    }
  }
  return null;
}

/** Validate a schedule as written by a user or the agent. Throws with a readable reason. */
export function assertValidSchedule(schedule: MonitorSchedule, nowMs: number): void {
  if (schedule.kind === 'interval') {
    if (!Number.isFinite(schedule.intervalMs) || schedule.intervalMs < MIN_SCHEDULE_INTERVAL_MS) {
      throw new Error('A monitor interval must be at least one second');
    }
    return;
  }
  if (schedule.kind === 'daily') {
    if (!parseClockTime(schedule.time)) throw new Error('Time must be HH:MM on a 24-hour clock');
    for (const day of schedule.weekdays ?? []) {
      if (!Number.isInteger(day) || day < 0 || day > 6)
        throw new Error('Weekdays are 0 (Sunday) to 6 (Saturday)');
    }
    return;
  }
  if (schedule.kind === 'cron') {
    parseCron(schedule.expression);
    if (nextRunAfter(schedule, nowMs) === null) throw new Error('This cron schedule never fires');
    return;
  }
  if (!Number.isFinite(schedule.at) || schedule.at <= nowMs) {
    throw new Error('A one-time monitor must be scheduled in the future');
  }
}

/**
 * Parse a local date-time typed by a user or the agent: "2026-11-24 15:30",
 * "2026-11-24T15:30", or an explicit ISO instant with a zone. Naive values are local.
 */
export function parseLocalDateTime(value: string): number | null {
  const trimmed = value.trim();
  const naive = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(trimmed);
  if (naive) {
    const at = localInstant(
      Number(naive[1]),
      Number(naive[2]) - 1,
      Number(naive[3]),
      Number(naive[4]),
      Number(naive[5]),
    );
    return Number.isNaN(at) ? null : at;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}
