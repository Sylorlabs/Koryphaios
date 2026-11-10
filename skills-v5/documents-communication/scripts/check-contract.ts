#!/usr/bin/env bun

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

type RoutingCase = {
  id: string;
  category: 'positive' | 'negative' | 'ambiguous' | 'adversarial';
  expectedSelection: boolean;
  prompt: string;
};

type Task = {
  id: string;
  falsifiableChecks: Array<{ id: string; assertion: string }>;
  scorers: Array<{
    id: string;
    kind: 'deterministic' | 'blind-semantic';
    weight: number;
    blindTo?: string[];
  }>;
  requiredEvidence: string[];
};

const packageRoot = resolve(import.meta.dir, '..');
const read = (relativePath: string) => readFileSync(join(packageRoot, relativePath), 'utf8');
const sidecar = JSON.parse(read('kory.json')) as {
  name: string;
  version: string;
  activation: string[];
  routing: {
    positive: string[];
    negative: string[];
    ambiguous: Array<{ prompt: string; expectedSelection: boolean }>;
    adversarial: Array<{ prompt: string; expectedSelection: boolean }>;
  };
  sources: Array<{ url: string }>;
};
const skill = read('SKILL.md');
const sources = read('references/sources.md');
const workflows = read('references/document-workflows.md');
const routing = read('evals/routing.jsonl')
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((line, index) => {
    try {
      return JSON.parse(line) as RoutingCase;
    } catch (error) {
      throw new Error(`routing.jsonl line ${index + 1} is not valid JSON: ${String(error)}`);
    }
  });
const taskFiles = readdirSync(join(packageRoot, 'evals/tasks'))
  .filter((name) => name.endsWith('.json'))
  .sort();
const tasks = taskFiles.map(
  (name) => JSON.parse(readFileSync(join(packageRoot, 'evals/tasks', name), 'utf8')) as Task,
);

const failures: string[] = [];
const check = (condition: boolean, message: string) => {
  if (!condition) failures.push(message);
};
const unique = (values: string[]) => new Set(values).size === values.length;
const counts = (rows: RoutingCase[]) =>
  Object.fromEntries(
    ['positive', 'negative', 'ambiguous', 'adversarial'].map((category) => [
      category,
      rows.filter((row) => row.category === category).length,
    ]),
  ) as Record<RoutingCase['category'], number>;

const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/u)?.[1] ?? '';
const frontmatterName = frontmatter.match(/^name:\s*(.+)$/mu)?.[1]?.trim();
const frontmatterDescription = frontmatter.match(/^description:\s*(.+)$/mu)?.[1]?.trim() ?? '';
const expectedCheckIds = new Set([
  'scope-and-hierarchy',
  'operating-contract',
  'execution-invariant',
  'verification-discipline',
  'anti-pattern-resistance',
  'evidence-and-uncertainty',
]);

check(frontmatterName === sidecar.name, 'SKILL.md and kory.json names differ');
check(
  frontmatterDescription.includes('Use when '),
  'SKILL.md description has no concrete “Use when” trigger',
);
check(
  /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(sidecar.version),
  'sidecar version is not SemVer-shaped',
);
check(
  sidecar.activation.length >= 5 && unique(sidecar.activation),
  'activation phrases must be unique and substantive',
);
check(
  sidecar.routing.positive.length >= 5,
  'sidecar needs at least five positive routing examples',
);
check(
  sidecar.routing.negative.length >= 5,
  'sidecar needs at least five negative routing examples',
);
check(
  sidecar.routing.ambiguous.length >= 3,
  'sidecar needs at least three ambiguous routing examples',
);
check(
  sidecar.routing.adversarial.length >= 3,
  'sidecar needs at least three adversarial routing examples',
);
check(unique(routing.map((row) => row.id)), 'held-out routing IDs are duplicated');
check(unique(routing.map((row) => row.prompt)), 'held-out routing prompts are duplicated');

const routingCounts = counts(routing);
check(routingCounts.positive >= 5, 'held-out routing needs at least five positive cases');
check(routingCounts.negative >= 5, 'held-out routing needs at least five negative cases');
check(routingCounts.ambiguous >= 3, 'held-out routing needs at least three ambiguous cases');
check(routingCounts.adversarial >= 3, 'held-out routing needs at least three adversarial cases');
check(
  routing
    .filter((row) => row.category === 'positive' || row.category === 'ambiguous')
    .every((row) => row.expectedSelection),
  'positive and ambiguous held-out cases must expect selection',
);
check(
  routing
    .filter((row) => row.category === 'negative' || row.category === 'adversarial')
    .every((row) => !row.expectedSelection),
  'negative and adversarial held-out cases must reject selection',
);
const publicPrompts = new Set([
  ...sidecar.routing.positive,
  ...sidecar.routing.negative,
  ...sidecar.routing.ambiguous.map((row) => row.prompt),
  ...sidecar.routing.adversarial.map((row) => row.prompt),
]);
check(
  !routing.some((row) => publicPrompts.has(row.prompt)),
  'held-out prompt leaks a public routing prompt',
);

check(taskFiles.length === 2, 'package must contain exactly two task fixtures');
check(unique(tasks.map((task) => task.id)), 'task IDs are duplicated');
for (const task of tasks) {
  const ids = task.falsifiableChecks.map((checkItem) => checkItem.id);
  check(ids.length === expectedCheckIds.size, `${task.id} must contain six falsifiable checks`);
  check(new Set(ids).size === ids.length, `${task.id} falsifiable check IDs are duplicated`);
  check(
    ids.every((id) => expectedCheckIds.has(id)),
    `${task.id} contains an unknown or missing contract check ID`,
  );
  check(
    task.falsifiableChecks.every(
      (checkItem) =>
        checkItem.assertion.length >= 80 &&
        !/^Format and factual review$/iu.test(checkItem.assertion) &&
        /\bmust\b/iu.test(checkItem.assertion),
    ),
    `${task.id} has a non-falsifiable or underspecified assertion`,
  );
  const weight = task.scorers.reduce((sum, scorer) => sum + scorer.weight, 0);
  check(Math.abs(weight - 1) < 0.000001, `${task.id} scorer weights do not sum to 1`);
  check(
    task.scorers.some((scorer) => scorer.kind === 'deterministic'),
    `${task.id} lacks a deterministic scorer`,
  );
  check(
    task.scorers.some(
      (scorer) =>
        scorer.kind === 'blind-semantic' &&
        scorer.blindTo?.includes('skill-variant') &&
        scorer.blindTo?.includes('expected-outcome'),
    ),
    `${task.id} lacks a scorer blind to skill variant and expected outcome`,
  );
  check(task.requiredEvidence.length >= 4, `${task.id} requires too little evidence`);
}

check(
  skill.includes('[the release note and handoff playbook](references/document-workflows.md)'),
  'SKILL.md does not link the workflow reference',
);
check(skill.includes('(references/sources.md)'), 'SKILL.md does not link the source map');
check(
  workflows.includes('## Contract card before drafting'),
  'workflow reference lacks the contract card',
);
check(
  workflows.includes('## Local contract check'),
  'workflow reference lacks local check documentation',
);
for (const source of sidecar.sources) {
  check(sources.includes(source.url), `source map is missing ${source.url}`);
}

if (failures.length) {
  console.error(JSON.stringify({ package: sidecar.name, status: 'fail', failures }, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      package: sidecar.name,
      status: 'pass',
      version: sidecar.version,
      heldOutRouting: routingCounts,
      tasks: tasks.map((task) => task.id),
      sourceCount: sidecar.sources.length,
    },
    null,
    2,
  ),
);
