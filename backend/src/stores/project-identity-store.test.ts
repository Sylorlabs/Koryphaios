import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectIdentityConflictError, ProjectIdentityStore } from './project-identity-store';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = join(tmpdir(), `kory-project-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  const database = new Database(':memory:');
  return { root, database, store: new ProjectIdentityStore(database) };
}

describe('ProjectIdentityStore', () => {
  test('creates and reloads a durable automatic identity', () => {
    const { root, database, store } = fixture();
    const first = store.get(root, 'Design Lab');
    const second = new ProjectIdentityStore(database).get(root, 'ignored');
    expect(second).toEqual(first);
    expect(first.id).toMatch(/^project_[a-f0-9]{32}$/);
    expect(first.icon).toEqual({ mode: 'automatic' });
    database.close();
  });

  test('updates icon/name with optimistic revision and rejects stale writes', () => {
    const { root, database, store } = fixture();
    const first = store.get(root, 'Project');
    const updated = store.update(root, {
      name: '🧪 Lab',
      icon: { mode: 'monogram', value: '🧪' },
      expectedRevision: 1,
    });
    expect(updated.revision).toBe(2);
    expect(updated.name).toBe('🧪 Lab');
    expect(store.get(root).icon).toEqual({ mode: 'monogram', value: '🧪' });
    expect(() => store.update(root, { expectedRevision: first ? 1 : 0 })).toThrow(
      ProjectIdentityConflictError,
    );
    database.close();
  });

  test('invalid image data safely falls back to automatic', () => {
    const { root, database, store } = fixture();
    const updated = store.update(root, { icon: { mode: 'image', assetId: '/tmp/icon.png' } });
    expect(updated.icon).toEqual({ mode: 'automatic' });
    database.close();
  });

  test('persists custom colors and shapes without changing the identity contract', () => {
    const { root, database, store } = fixture();
    const updated = store.update(root, {
      icon: {
        mode: 'monogram',
        value: 'DL',
        customColor: '#36c',
        shape: 'circle',
      },
      expectedRevision: 1,
    });
    expect(updated.icon).toEqual({
      mode: 'monogram',
      value: 'DL',
      customColor: '#3366CC',
      shape: 'circle',
    });
    expect(new ProjectIdentityStore(database).get(root).icon).toEqual(updated.icon);
    database.close();
  });

  test('persists transparent shape and coerces it away for color tiles', () => {
    const { root, database, store } = fixture();
    const transparent = store.update(root, {
      icon: { mode: 'monogram', value: 'DL', shape: 'transparent' },
      expectedRevision: 1,
    });
    expect(transparent.icon.shape).toBe('transparent');
    const colorTile = store.update(root, {
      icon: { mode: 'color', color: 'accent', shape: 'transparent' },
      expectedRevision: 2,
    });
    expect(colorTile.icon).toEqual({ mode: 'color', color: 'accent', shape: 'rounded-square' });
    database.close();
  });
});
