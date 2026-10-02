import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadV5SkillPackages } from '../skill-packages';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function isolatedCatalog() {
  const catalog = loadV5SkillPackages();
  const root = mkdtempSync(join(tmpdir(), 'kory-graph-control-'));
  roots.push(root);
  for (const name of ['task-routing', 'plan-mode', 'planning']) {
    const source = catalog.packages.find((p) => p.sidecar.name === name)!;
    cpSync(source.directory, join(root, name), { recursive: true });
  }
  return root;
}
function change(root: string, name: string, values: Record<string, unknown>) {
  const path = join(root, name, 'kory.json');
  const value = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...value, ...values }));
}
describe('complete package composition validation', () => {
  test('rejects missing parent, requirement, facet and conflict targets', () => {
    const root = isolatedCatalog();
    for (const kind of ['broader', 'requires', 'facets', 'conflicts']) {
      change(root, 'plan-mode', {
        broader: [],
        requires: [],
        facets: [],
        conflicts: [],
        [kind]: ['missing-skill'],
      });
      expect(loadV5SkillPackages(root).errors).toContain(
        `plan-mode: missing ${kind} skill missing-skill`,
      );
    }
  });
  test('rejects a combined parent and requirement cycle', () => {
    const root = isolatedCatalog();
    change(root, 'task-routing', { requires: ['plan-mode'] });
    change(root, 'plan-mode', { broader: ['task-routing'] });
    const errors = loadV5SkillPackages(root).errors;
    expect(errors.some((e) => e.startsWith('V5 composition cycle:'))).toBe(true);
    expect(errors).toContain(
      'task-routing: model-invoked composition cannot implicitly depend on user-invoked skill plan-mode',
    );
  });
  test('permits a directed explicit orchestrator dependency without a cycle', () => {
    const root = isolatedCatalog();
    change(root, 'plan-mode', {
      broader: [],
      requires: ['task-routing'],
      facets: [],
      conflicts: [],
    });
    expect(loadV5SkillPackages(root).errors).toEqual([]);
  });
  test('rejects self references while the full deployed graph remains valid', () => {
    const root = isolatedCatalog();
    change(root, 'plan-mode', { conflicts: ['plan-mode'] });
    expect(loadV5SkillPackages(root).errors).toContain('plan-mode: self reference in conflicts');
    expect(loadV5SkillPackages().errors).toEqual([]);
  });
  test('does not let an explicit skill implicitly invoke a second explicit skill', () => {
    const root = isolatedCatalog();
    const communication = loadV5SkillPackages().packages.find(
      (skill) => skill.sidecar.name === 'documents-communication',
    )!;
    cpSync(communication.directory, join(root, 'documents-communication'), { recursive: true });
    change(root, 'plan-mode', { requires: ['documents-communication'] });
    expect(loadV5SkillPackages(root).errors).toEqual([]);
    change(root, 'documents-communication', { invocationMode: 'user-invoked' });
    expect(loadV5SkillPackages(root).errors).toEqual([
      'plan-mode: user-invoked composition cannot implicitly depend on user-invoked skill documents-communication',
    ]);
  });
});
