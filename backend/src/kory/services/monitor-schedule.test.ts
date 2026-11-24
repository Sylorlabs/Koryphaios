import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  assertValidSchedule,
  nextRunAfter,
  parseCron,
  parseLocalDateTime,
  type MonitorSchedule,
} from './monitor-schedule';

const MODULE_PATH = join(import.meta.dir, 'monitor-schedule.ts');

/**
 * Daylight-saving cases depend on the host time zone, which Bun reads at
 * startup. Each zone runs in a child process so the assertions are exact.
 */
function inZone(timeZone: string, expression: string): unknown {
  const script = `
    const { nextRunAfter, parseLocalDateTime } = await import(${JSON.stringify(MODULE_PATH)});
    const iso = (value) => (value === null ? null : new Date(value).toISOString());
    console.log(JSON.stringify((${expression})));
  `;
  const result = Bun.spawnSync([process.execPath, '-e', script], {
    env: { ...process.env, TZ: timeZone },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(`zone check failed: ${result.stderr.toString()}`);
  }
  return JSON.parse(result.stdout.toString().trim());
}

describe('clock schedules in America/New_York', () => {
  test('a daily time after the spring-forward day uses the new offset', () => {
    // 2026-03-07 is a Saturday in EST (UTC-5). 09:00 on 2026-03-08 is EDT (UTC-4).
    const value = inZone(
      'America/New_York',
      `iso(nextRunAfter({ kind: 'daily', time: '09:00' }, new Date(2026, 2, 7, 12, 0).getTime()))`,
    );
    expect(value).toBe('2026-03-08T13:00:00.000Z');
  });

  test('a time inside the spring-forward gap runs once at the instant JavaScript maps it to', () => {
    // 02:30 does not exist on 2026-03-08; the clocks jump 02:00 -> 03:00, so it runs at 03:30 EDT.
    const value = inZone(
      'America/New_York',
      `iso(nextRunAfter({ kind: 'daily', time: '02:30' }, new Date(2026, 2, 7, 12, 0).getTime()))`,
    );
    expect(value).toBe('2026-03-08T07:30:00.000Z');
  });

  test('a time in the repeated fall-back hour fires once, then waits for the next day', () => {
    // 2026-11-01 01:30 happens twice (EDT 05:30Z, then EST 06:30Z).
    const firstOccurrence = inZone(
      'America/New_York',
      `iso(nextRunAfter({ kind: 'daily', time: '01:30' }, new Date(2026, 10, 1, 0, 0).getTime()))`,
    );
    expect(firstOccurrence).toBe('2026-11-01T05:30:00.000Z');

    const afterFirstFire = inZone(
      'America/New_York',
      `iso(nextRunAfter({ kind: 'daily', time: '01:30' }, Date.parse('2026-11-01T05:30:00.000Z')))`,
    );
    expect(afterFirstFire).toBe('2026-11-02T06:30:00.000Z');
  });

  test('a cron minute inside the repeated hour does not fire a second time in that slot', () => {
    // Every 15 minutes, 01:00-01:59. After the EDT 01:30 run, the next run is 01:45 EDT
    // (05:45Z), not the repeated 01:00 or 01:30 EST instants.
    const value = inZone(
      'America/New_York',
      `iso(nextRunAfter({ kind: 'cron', expression: '*/15 1 * * *' }, Date.parse('2026-11-01T05:30:00.000Z')))`,
    );
    expect(value).toBe('2026-11-01T05:45:00.000Z');
  });
});

describe('clock schedules are local, not UTC', () => {
  test('a daily schedule is computed from the local calendar day', () => {
    const value = inZone(
      'Europe/London',
      `iso(nextRunAfter({ kind: 'daily', time: '08:00' }, Date.parse('2026-06-01T09:00:00.000Z')))`,
    );
    // 08:00 BST on 2026-06-02 is 07:00Z.
    expect(value).toBe('2026-06-02T07:00:00.000Z');
  });
});

describe('next occurrence (host zone)', () => {
  const at = (y: number, mo: number, d: number, h = 0, mi = 0) =>
    new Date(y, mo, d, h, mi).getTime();

  test('an interval is "after + interval"', () => {
    expect(nextRunAfter({ kind: 'interval', intervalMs: 90_000 }, 1_000)).toBe(91_000);
  });

  test('weekday schedules skip weekends', () => {
    // 2026-11-27 is a Friday.
    const schedule: MonitorSchedule = { kind: 'daily', time: '09:00', weekdays: [1, 2, 3, 4, 5] };
    expect(nextRunAfter(schedule, at(2026, 10, 27, 10))).toBe(at(2026, 10, 30, 9));
  });

  test('a cron expression matches its weekday list and minute list', () => {
    // 0 9 * * 1-5: weekdays at 09:00.
    expect(nextRunAfter({ kind: 'cron', expression: '0 9 * * 1-5' }, at(2026, 10, 27, 10))).toBe(
      at(2026, 10, 30, 9),
    );
    // */20 steps within an hour.
    expect(
      nextRunAfter({ kind: 'cron', expression: '*/20 14 * * *' }, at(2026, 10, 24, 14, 5)),
    ).toBe(at(2026, 10, 24, 14, 20));
  });

  test('day-of-month and day-of-week are OR-ed when both are restricted (standard cron)', () => {
    // The 13th, or any Friday, at midnight. From 2026-11-24 (Tuesday): Friday 27th comes first.
    expect(nextRunAfter({ kind: 'cron', expression: '0 0 13 * 5' }, at(2026, 10, 24, 12))).toBe(
      at(2026, 10, 27, 0),
    );
  });

  test('a one-time schedule runs once and never again', () => {
    const when = at(2026, 11, 1, 8, 30);
    expect(nextRunAfter({ kind: 'once', at: when }, when - 1)).toBe(when);
    expect(nextRunAfter({ kind: 'once', at: when }, when)).toBeNull();
  });

  test('a missed run is not backfilled: the next run is computed from the moment of the call', () => {
    // The host slept from Monday 08:00 through Thursday 12:00 and wakes at Thursday 12:00.
    const wake = at(2026, 10, 26, 12);
    expect(nextRunAfter({ kind: 'daily', time: '09:00' }, wake)).toBe(at(2026, 10, 27, 9));
  });

  test('an invalid cron expression is rejected with a readable error', () => {
    expect(() => parseCron('0 9 * *')).toThrow('five fields');
    expect(() => parseCron('61 9 * * *')).toThrow('Invalid minute');
    expect(() => parseCron('0 9 * * 9')).toThrow('Invalid weekday');
    expect(() => parseCron('*/0 9 * * *')).toThrow('step');
  });

  test('validation refuses past one-time runs, bad clock times, and sub-second intervals', () => {
    const now = at(2026, 10, 24, 12);
    expect(() => assertValidSchedule({ kind: 'once', at: now - 1 }, now)).toThrow('future');
    expect(() => assertValidSchedule({ kind: 'daily', time: '25:00' }, now)).toThrow('HH:MM');
    expect(() => assertValidSchedule({ kind: 'interval', intervalMs: 10 }, now)).toThrow(
      'one second',
    );
    expect(() => assertValidSchedule({ kind: 'cron', expression: '0 9 31 2 *' }, now)).toThrow(
      'never fires',
    );
  });

  test('local date-time input accepts naive local times and ISO instants', () => {
    expect(parseLocalDateTime('2026-11-24 15:30')).toBe(at(2026, 10, 24, 15, 30));
    expect(parseLocalDateTime('2026-11-24T15:30')).toBe(at(2026, 10, 24, 15, 30));
    expect(parseLocalDateTime('2026-11-24T15:30:00Z')).toBe(Date.parse('2026-11-24T15:30:00Z'));
    expect(parseLocalDateTime('tomorrow-ish')).toBeNull();
  });
});
