import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = import.meta.dir;

/** Event names declared in the `WSEventType` union. */
function eventTypeNames(): string[] {
  const source = readFileSync(join(dir, 'WSEvents.ts'), 'utf8');
  const start = source.indexOf('export type WSEventType =');
  // Strip line comments first: some comments contain semicolons.
  const body = source.slice(start).replace(/\/\/[^\n]*/g, '');
  const end = body.indexOf(';');
  return [...body.slice(0, end).matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]!);
}

describe('WebSocket event payload map', () => {
  test('the event union is non-trivial', () => {
    expect(eventTypeNames().length).toBeGreaterThan(40);
  });

  test('api-contract docs list every event type', () => {
    const doc = readFileSync(join(dir, '..', '..', '..', 'docs', 'api-contract.md'), 'utf8');
    const missing = eventTypeNames().filter((name) => !doc.includes(`\`${name}\``));
    expect(missing).toEqual([]);
  });
});
