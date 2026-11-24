import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { API_ROUTE_PLUGINS } from './route-plugins';

const serverSource = readFileSync(join(import.meta.dir, '..', 'server.ts'), 'utf8');

/** `.use(...)` arguments of the server's base app, in mount order. */
function serverMounts(): string[] {
  const start = serverSource.indexOf('const baseApp = new Elysia()');
  const end = serverSource.indexOf('export type App');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return [...serverSource.slice(start, end).matchAll(/\.use\(([^;]*?)\)(?=\s*\n|\s*;|\s*\.)/g)].map(
    (m) => m[1]!.trim(),
  );
}

describe('API route plugin list', () => {
  test('mirrors the server .use chain in mount order', () => {
    expect(API_ROUTE_PLUGINS.map((p) => p.name)).toEqual(serverMounts());
  });

  test('every entry names a module that exists', () => {
    for (const entry of API_ROUTE_PLUGINS) {
      const file = join(import.meta.dir, '..', `${entry.module}.ts`);
      expect(readFileSync(file, 'utf8')).toContain(
        `export const ${entry.export}`.replace(
          'export const',
          entry.factory ? 'export function' : 'export const',
        ),
      );
    }
  });
});
