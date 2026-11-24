import { describe, expect, test } from 'bun:test';
import { scheduleFromToolInput } from './monitors';

describe('schedule_monitor input', () => {
  test('defaults to a five-minute interval and accepts each clock kind', () => {
    expect(scheduleFromToolInput({})).toEqual({ kind: 'interval', intervalMs: 300_000 });
    expect(scheduleFromToolInput({ kind: 'daily', time: '07:30' })).toEqual({
      kind: 'daily',
      time: '07:30',
    });
    expect(scheduleFromToolInput({ kind: 'weekdays', time: '08:00' })).toEqual({
      kind: 'daily',
      time: '08:00',
      weekdays: [1, 2, 3, 4, 5],
    });
    expect(scheduleFromToolInput({ kind: 'cron', cron: '0 9 * * 1-5' })).toEqual({
      kind: 'cron',
      expression: '0 9 * * 1-5',
    });
    expect(scheduleFromToolInput({ kind: 'once', at: '2030-01-02 10:15' })).toMatchObject({
      kind: 'once',
    });
  });

  test('rejects malformed fields with a readable reason', () => {
    expect(() => scheduleFromToolInput({ kind: 'daily', time: '9am' })).toThrow('HH:MM');
    expect(() => scheduleFromToolInput({ kind: 'cron' })).toThrow('cron is required');
    expect(() => scheduleFromToolInput({ kind: 'once', at: 'someday' })).toThrow('YYYY-MM-DD');
    expect(() => scheduleFromToolInput({ kind: 'hourly' })).toThrow('kind must be');
  });
});
