import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTaskContract } from '../backend/src/kory/prompts';
import {
  BUNDLED_SKILL_DEFINITIONS,
  isDirectSkillSelection,
  resolveSkills,
  V5_SKILL_PACKAGE_CATALOG,
} from '../backend/src/kory/skills';

interface IndependentRoutingCase {
  id: string;
  skill: string;
  prompt: string;
  /** Explicit host pins test personal skills without pretending they are keyword-routed. */
  pins: string[];
  expectedSelection: boolean;
  expectedSkills: string[];
  forbiddenSkills: string[];
  activePaths: string[];
  tags: string[];
}

const projectRoot = resolve(import.meta.dir, '..');
const corpusPath = join(projectRoot, 'skills-v5', 'independent-routing.jsonl');

function parseStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value as string[];
}

function parseCase(line: string, lineNumber: number): IndependentRoutingCase {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error: unknown) {
    throw new Error(
      `independent-routing.jsonl line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`independent-routing.jsonl line ${lineNumber}: expected an object`);
  }
  const row = value as Record<string, unknown>;
  for (const key of ['id', 'skill', 'prompt'] as const) {
    if (typeof row[key] !== 'string' || !row[key].trim()) {
      throw new Error(`independent-routing.jsonl line ${lineNumber}: ${key} is required`);
    }
  }
  if (typeof row.expectedSelection !== 'boolean') {
    throw new Error(
      `independent-routing.jsonl line ${lineNumber}: expectedSelection must be boolean`,
    );
  }
  return {
    id: row.id as string,
    skill: row.skill as string,
    prompt: row.prompt as string,
    expectedSelection: row.expectedSelection,
    expectedSkills: parseStringList(row.expectedSkills, `line ${lineNumber} expectedSkills`),
    forbiddenSkills: parseStringList(row.forbiddenSkills, `line ${lineNumber} forbiddenSkills`),
    pins: row.pins === undefined ? [] : parseStringList(row.pins, `line ${lineNumber} pins`),
    activePaths: parseStringList(row.activePaths, `line ${lineNumber} activePaths`),
    tags: parseStringList(row.tags, `line ${lineNumber} tags`),
  };
}

function loadCorpus(): IndependentRoutingCase[] {
  if (!existsSync(corpusPath)) throw new Error(`Missing ${corpusPath}`);
  return readFileSync(corpusPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => parseCase(line, index + 1));
}

const cases = loadCorpus();
const knownSkills = new Set(BUNDLED_SKILL_DEFINITIONS.map((definition) => definition.name));
const ids = new Set<string>();
const coveredSkills = new Set<string>();
const validationErrors: string[] = [];
for (const testCase of cases) {
  if (ids.has(testCase.id)) validationErrors.push(`duplicate id ${testCase.id}`);
  ids.add(testCase.id);
  if (!knownSkills.has(testCase.skill)) validationErrors.push(`unknown skill ${testCase.skill}`);
  coveredSkills.add(testCase.skill);
  if (!testCase.tags.includes('independent')) {
    validationErrors.push(`${testCase.id} must be tagged independent`);
  }
  if (testCase.expectedSelection && !testCase.expectedSkills.includes(testCase.skill)) {
    validationErrors.push(`${testCase.id} must include its target skill in expectedSkills`);
  }
  for (const related of [
    ...testCase.expectedSkills,
    ...testCase.forbiddenSkills,
    ...testCase.pins,
  ]) {
    if (!knownSkills.has(related))
      validationErrors.push(`${testCase.id} references unknown ${related}`);
  }
}
const missingCoverage = [...knownSkills].filter((skill) => !coveredSkills.has(skill)).sort();
if (missingCoverage.length) {
  validationErrors.push(`missing independent cases for: ${missingCoverage.join(', ')}`);
}
if (validationErrors.length) throw new Error(validationErrors.join('\n'));

const failures: Array<{
  id: string;
  skill: string;
  prompt: string;
  missing: string[];
  forbiddenPresent: string[];
  selected: string[];
  directReasons: Record<string, string>;
  activation: string[];
}> = [];
let expectedSkillChecks = 0;
let expectedSkillHits = 0;
let forbiddenSkillChecks = 0;
let forbiddenSkillAvoided = 0;

const requestedSkill = process.argv
  .find((argument) => argument.startsWith('--skill='))
  ?.slice('--skill='.length);
if (requestedSkill && !knownSkills.has(requestedSkill)) {
  throw new Error(`Unknown independent routing skill ${requestedSkill}`);
}
const evaluatedCases = requestedSkill
  ? cases.filter((testCase) => testCase.skill === requestedSkill)
  : cases;

for (const testCase of evaluatedCases) {
  const contract = createTaskContract(testCase.prompt);
  const resolution = resolveSkills(projectRoot, testCase.prompt, contract, {
    activePaths: testCase.activePaths,
    pins: testCase.pins,
    contextBudget: 60_000,
  });
  const selected = resolution.selected.map((item) => item.skill.name);
  const selectedSet = new Set(selected);
  const directSelected = new Set(
    resolution.selected.filter(isDirectSkillSelection).map((item) => item.skill.name),
  );
  const directReasons = Object.fromEntries(
    resolution.selected
      .filter((item) => directSelected.has(item.skill.name))
      .map((item) => [item.skill.name, item.reason]),
  );
  const missing = testCase.expectedSkills.filter((skill) => !directSelected.has(skill));
  const forbiddenPresent = testCase.forbiddenSkills.filter((skill) => directSelected.has(skill));
  if (!testCase.expectedSelection && directSelected.has(testCase.skill)) {
    forbiddenPresent.push(testCase.skill);
  }
  expectedSkillChecks += testCase.expectedSkills.length;
  expectedSkillHits += testCase.expectedSkills.length - missing.length;
  const forbiddenChecks = new Set(testCase.forbiddenSkills);
  if (!testCase.expectedSelection) forbiddenChecks.add(testCase.skill);
  forbiddenSkillChecks += forbiddenChecks.size;
  forbiddenSkillAvoided += [...forbiddenChecks].filter(
    (skill) => !directSelected.has(skill),
  ).length;
  if (missing.length || forbiddenPresent.length) {
    failures.push({
      id: testCase.id,
      skill: testCase.skill,
      prompt: testCase.prompt,
      activation:
        V5_SKILL_PACKAGE_CATALOG.packages.find(
          (skillPackage) => skillPackage.sidecar.name === testCase.skill,
        )?.sidecar.activation ?? [],
      missing,
      forbiddenPresent: [...new Set(forbiddenPresent)],
      selected,
      directReasons,
    });
  }
}

const result = {
  schemaVersion: 1,
  corpus: 'skills-v5/independent-routing.jsonl',
  cases: evaluatedCases.length,
  corpusCases: cases.length,
  coveredSkills: coveredSkills.size,
  passedCases: evaluatedCases.length - failures.length,
  failedCases: failures.length,
  expectedSkillRecall:
    expectedSkillChecks > 0 ? Number((expectedSkillHits / expectedSkillChecks).toFixed(4)) : 1,
  forbiddenSkillAvoidance:
    forbiddenSkillChecks > 0
      ? Number((forbiddenSkillAvoided / forbiddenSkillChecks).toFixed(4))
      : 1,
  failures,
};

const summaryOnly = process.argv.includes('--summary');
console.log(
  JSON.stringify(
    summaryOnly
      ? {
          ...result,
          failureIds: failures.map((failure) => failure.id),
          failures: failures.slice(0, 20).map((failure) => ({
            id: failure.id,
            missing: failure.missing,
            forbiddenPresent: failure.forbiddenPresent,
          })),
        }
      : result,
    null,
    2,
  ),
);
if (failures.length) process.exitCode = 1;
