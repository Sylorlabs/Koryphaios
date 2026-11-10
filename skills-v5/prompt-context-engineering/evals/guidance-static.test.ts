/**
 * Checks the authored guidance examples for internal consistency. These are
 * documentation fixtures, not candidate model outputs or qualification runs.
 * No evaluation ledger or benchmark fixture is read or written here.
 */
import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const skillRoot = resolve(import.meta.dir, '..');

type RecordExample = {
  id: string;
  source: string;
  tier: string;
  mode: 'instruction' | 'data';
  current: boolean;
  tokens: number;
  text?: string;
};

type DecisionExamples = {
  context: {
    requestLimit: number;
    reservedOutput: number;
    unchargedOverhead: number;
    priorityTiers: string[];
    records: RecordExample[];
    expected: {
      selected: string[];
      skipped: Array<{ id: string; reason: string }>;
      inputTokens: number;
      capacity: number;
    };
  };
  template: {
    selectedModel: string;
    guidanceModel: string;
    variables: Record<string, unknown>;
    examples: Array<{ id: string; label: string; heldOut: boolean }>;
    expected: {
      variableNames: string[];
      selectedExampleIds: string[];
      revalidate: boolean;
    };
  };
};

const examples = JSON.parse(
  readFileSync(resolve(skillRoot, 'references/decision-examples.json'), 'utf8'),
) as DecisionExamples;

test('context illustration conserves tokens, skips stale provenance first, and continues after oversize optional content', () => {
  const { context } = examples;
  const capacity = context.requestLimit - context.reservedOutput - context.unchargedOverhead;
  expect(capacity).toBe(context.expected.capacity);
  expect(capacity).toBeGreaterThan(0);

  const ids = context.records.map((record) => record.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(
    context.records.every((record) => Number.isSafeInteger(record.tokens) && record.tokens >= 0),
  ).toBe(true);

  const currentSources = new Set(
    context.records.filter((record) => record.current).map((record) => record.source),
  );
  const obsolete = context.records.filter(
    (record) => !record.current && currentSources.has(record.source),
  );
  const tier = new Map(context.priorityTiers.map((name, index) => [name, index]));
  const eligible = context.records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => !obsolete.includes(record))
    .sort((a, b) => tier.get(a.record.tier)! - tier.get(b.record.tier)! || a.index - b.index);

  expect(eligible.every(({ record }) => tier.has(record.tier))).toBe(true);
  const selected: string[] = [];
  const skips = obsolete.map((record) => ({ id: record.id, reason: 'superseded' }));
  let used = 0;

  for (const { record } of eligible) {
    if (used + record.tokens > capacity) {
      skips.push({ id: record.id, reason: 'budget' });
      continue;
    }
    selected.push(record.id);
    used += record.tokens;
  }

  expect(selected).toEqual(context.expected.selected);
  expect(skips).toEqual(context.expected.skipped);
  expect(used).toBe(context.expected.inputTokens);
  expect(used).toBeLessThanOrEqual(capacity);
  expect(
    context.records
      .filter((record) => selected.includes(record.id) && record.mode === 'instruction')
      .map((record) => record.tier),
  ).toEqual(['developer', 'user']);
  expect(context.records.find((record) => record.id === 'retrieved-command')?.mode).toBe('data');
});

test('template illustration preserves dynamic types, excludes held-out examples, and flags model change', () => {
  const { template } = examples;
  const names = Object.keys(template.variables).sort();
  expect(names).toEqual(template.expected.variableNames);
  expect(Object.prototype.hasOwnProperty.call(template.variables, '__proto__')).toBe(true);
  expect(template.variables.__proto__).toBe('ordinary literal key');
  expect(template.variables.enabled).toBe(false);
  expect(template.variables.retryCount).toBe(0);
  expect(template.variables.unset).toBeNull();
  expect(template.variables.tags).toEqual(['analysis', '${literal}']);
  expect(template.variables.account).toContain('</instructions>');

  const byLabel = new Map<string, string>();
  for (const entry of template.examples.filter((entry) => !entry.heldOut)) {
    const previous = byLabel.get(entry.label);
    if (previous === undefined || entry.id < previous) byLabel.set(entry.label, entry.id);
  }
  const selected = [...byLabel.values()].sort();
  expect(selected).toEqual(template.expected.selectedExampleIds);
  expect(template.examples.filter((entry) => entry.heldOut && selected.includes(entry.id))).toEqual(
    [],
  );
  expect(template.selectedModel !== template.guidanceModel).toBe(template.expected.revalidate);
});

test('skill and reference links resolve within the authoring directory', () => {
  for (const path of ['SKILL.md', 'references/operational-protocol.md']) {
    const absolutePath = resolve(skillRoot, path);
    const markdown = readFileSync(absolutePath, 'utf8');
    const links = [...markdown.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]*)?\)/g)]
      .map((match) => match[1]!)
      .filter((link) => !/^[a-z]+:\/\//i.test(link));
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const target = resolve(dirname(absolutePath), link);
      expect(isAbsolute(target) && !relative(skillRoot, target).startsWith('..')).toBe(true);
      expect(existsSync(target)).toBe(true);
    }
  }
});
