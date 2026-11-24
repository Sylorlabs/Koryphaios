import { afterAll, describe, expect, test } from 'bun:test';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  collectCurrentV5SkillEvaluationContracts,
  currentV5SkillEvaluationContractsPlugin,
} from '../../../scripts/build-current-v5-contracts';
import { currentV5SkillEvaluationContracts } from '../../eval/skills/skill-eval-current-contract';
import { EMBEDDED_CURRENT_V5_SKILL_EVALUATION_CONTRACTS } from '../../eval/skills/skill-eval-embedded-contracts';
import { currentEmbeddedV5SkillEvaluationContracts } from '../../eval/skills/skill-eval-embedded-contract-validation';
import { BUILTIN_SKILL_EVAL_SCORERS } from '../../eval/skills/skill-eval-fixtures';
import { CURRENT_SKILL_EVAL_CONTRACT_VERSION } from '../skill-evaluations';
import { loadV5SkillPackages } from '../skill-packages';
import { directoryLinkType } from '../../runtime/platform';

const backendRoot = resolve(import.meta.dir, '../../..');
// Keep this scratch directory on the same filesystem as backend/build. The
// genuine-build test temporarily moves that directory and must work when the
// repository and the system temp directory are mounted separately.
const scratch = mkdtempSync(join(backendRoot, '.embedded-contract-tests-'));
const pkg = loadV5SkillPackages(resolve(backendRoot, '../skills-v5')).packages.find(
  (item) => item.sidecar.name === 'debugging',
)!;
const epoch = CURRENT_SKILL_EVAL_CONTRACT_VERSION;
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function bundledHelper(label: string, embedded: boolean) {
  const directory = join(scratch, label);
  mkdirSync(directory);
  const entry = join(directory, 'entry.ts');
  writeFileSync(
    entry,
    `export { currentV5SkillEvaluationContracts } from ${JSON.stringify(resolve(import.meta.dir, '../../eval/skills/skill-eval-current-contract.ts'))};\nexport { EMBEDDED_CURRENT_V5_SKILL_EVALUATION_CONTRACTS } from ${JSON.stringify(resolve(import.meta.dir, '../../eval/skills/skill-eval-embedded-contracts.ts'))};\n`,
  );
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: join(directory, 'output'),
    target: 'bun',
    plugins: embedded ? [currentV5SkillEvaluationContractsPlugin()] : [],
  });
  expect(result.success).toBe(true);
  const output = result.outputs[0]!.path;
  return { module: await import(output), output };
}

function assertEmbeddedMatchesSource(embedded: unknown) {
  const source = collectCurrentV5SkillEvaluationContracts();
  expect(embedded).toEqual(source);
  const contracts = currentEmbeddedV5SkillEvaluationContracts(pkg, epoch, embedded);
  expect([...contracts]).toEqual([...currentV5SkillEvaluationContracts(pkg, epoch)]);
  expect(contracts.size).toBeGreaterThan(0);
}

describe('lightweight current V5 embedded identities', () => {
  test('source stub is null and dev resolves the actual current source registry', () => {
    expect(EMBEDDED_CURRENT_V5_SKILL_EVALUATION_CONTRACTS).toBeNull();
    assertEmbeddedMatchesSource(collectCurrentV5SkillEvaluationContracts());
  });

  test('raw unsupported bundle without registry stays empty and does not throw', async () => {
    const { module } = await bundledHelper('raw', false);
    expect(module.EMBEDDED_CURRENT_V5_SKILL_EVALUATION_CONTRACTS).toBeNull();
    expect(module.currentV5SkillEvaluationContracts(pkg, epoch).size).toBe(0);
  });

  test('real plugin embeds immutable current identities, not the execution graph', async () => {
    const { module, output } = await bundledHelper('embedded', true);
    assertEmbeddedMatchesSource(module.EMBEDDED_CURRENT_V5_SKILL_EVALUATION_CONTRACTS);
    expect([...module.currentV5SkillEvaluationContracts(pkg, epoch)]).toEqual([
      ...currentV5SkillEvaluationContracts(pkg, epoch),
    ]);
    const embedded = module.EMBEDDED_CURRENT_V5_SKILL_EVALUATION_CONTRACTS;
    expect(Object.isFrozen(embedded)).toBe(true);
    expect(Object.isFrozen(embedded.packages)).toBe(true);
    expect(Object.isFrozen(embedded.packages[0].tasks)).toBe(true);
    expect(
      Object.isFrozen(
        embedded.packages.find(
          (item: { packageName: string }) => item.packageName === pkg.sidecar.name,
        ).tasks[0].scorerIds,
      ),
    ).toBe(true);
    const contents = readFileSync(output, 'utf8');
    expect(contents).not.toContain('BUILTIN_SKILL_EVAL_SCORERS');
    expect(contents).not.toContain('playwright');
    expect(contents.length).toBeLessThan(250_000);
  });

  test.each([
    'null',
    'schema',
    'epoch',
    'package-name',
    'package-version',
    'task-id',
    'hash',
    'scorer',
    'materializer',
    'empty-ids',
    'duplicate-task',
    'duplicate-package',
  ])('rejects missing, malformed, or stale %s metadata', (change) => {
    const embedded = structuredClone(collectCurrentV5SkillEvaluationContracts());
    const selected = embedded.packages.find((item) => item.packageName === pkg.sidecar.name)!;
    const task = selected.tasks[0]!;
    let value: unknown = embedded;
    if (change === 'null') value = null;
    if (change === 'schema') value = { ...embedded, schemaVersion: 2 };
    if (change === 'epoch') value = { ...embedded, contractVersion: epoch - 1 };
    if (change === 'package-name')
      value = { ...embedded, packages: [{ ...selected, packageName: 'obsolete-package' }] };
    if (change === 'package-version')
      value = { ...embedded, packages: [{ ...selected, packageVersion: '0.0.0' }] };
    if (change === 'task-id')
      value = {
        ...embedded,
        packages: [{ ...selected, tasks: [{ ...task, taskId: 'obsolete-task' }] }],
      };
    if (change === 'hash')
      value = {
        ...embedded,
        packages: [
          { ...selected, tasks: [{ ...task, evaluationContractHash: '0000000000000000' }] },
        ],
      };
    if (change === 'scorer')
      value = {
        ...embedded,
        packages: [{ ...selected, tasks: [{ ...task, scorerIds: ['obsolete-scorer@1'] }] }],
      };
    if (change === 'materializer')
      value = {
        ...embedded,
        packages: [
          { ...selected, tasks: [{ ...task, materializerIds: ['obsolete-materializer@1'] }] },
        ],
      };
    if (change === 'empty-ids')
      value = { ...embedded, packages: [{ ...selected, tasks: [{ ...task, scorerIds: [] }] }] };
    if (change === 'duplicate-task')
      value = { ...embedded, packages: [{ ...selected, tasks: [task, task] }] };
    if (change === 'duplicate-package') value = { ...embedded, packages: [selected, selected] };
    expect(currentEmbeddedV5SkillEvaluationContracts(pkg, epoch, value).size).toBe(0);
  });

  test('recomputes against the complete current task shape', () => {
    const embedded = collectCurrentV5SkillEvaluationContracts();
    const edited = structuredClone(pkg);
    edited.evaluation.tasks[0]!.prompt += '\nChanged current source task requirement.';
    expect(currentEmbeddedV5SkillEvaluationContracts(edited, epoch, embedded).size).toBe(0);
  });

  test('fresh generation observes an actual source-registry scorer bump', async () => {
    const before = collectCurrentV5SkillEvaluationContracts();
    const current = currentV5SkillEvaluationContracts(pkg, epoch).get(pkg.evaluation.tasks[0]!.id)!;
    const scorer = BUILTIN_SKILL_EVAL_SCORERS.find((item) => item.id === current.scorerIds[0])!;
    const oldId = scorer.id;
    try {
      scorer.id = `${oldId}-fresh-build-bump`;
      const { module } = await bundledHelper('scorer-bump', true);
      const bumped = module
        .currentV5SkillEvaluationContracts(pkg, epoch)
        .get(pkg.evaluation.tasks[0]!.id);
      expect(bumped.scorerIds).toContain(scorer.id);
      expect(bumped.scorerIds).not.toContain(oldId);
      expect(bumped.evaluationContractHash).not.toBe(current.evaluationContractHash);
      expect(module.EMBEDDED_CURRENT_V5_SKILL_EVALUATION_CONTRACTS).not.toEqual(before);
      assertEmbeddedMatchesSource(module.EMBEDDED_CURRENT_V5_SKILL_EVALUATION_CONTRACTS);
    } finally {
      scorer.id = oldId;
    }
  });

  test('existing registry initialization failure cannot fall back to embedded authority', async () => {
    const { module, output } = await bundledHelper('broken-source', true);
    writeFileSync(
      join(resolve(output, '..'), 'skill-eval-fixtures.js'),
      "throw new Error('source registry initialization failed');\n",
    );
    expect(module.currentV5SkillEvaluationContracts(pkg, epoch).size).toBe(0);
  });

  test.each(['empty', 'nested-dependency'])(
    'existing %s source registry cannot borrow embedded identities',
    async (failure) => {
      const { module, output } = await bundledHelper(`source-${failure}`, true);
      const contents =
        failure === 'empty'
          ? 'module.exports = { BUILTIN_SKILL_EVAL_MATERIALIZERS: [], BUILTIN_SKILL_EVAL_SCORERS: [] };\n'
          : "require('./missing-source-registry-dependency');\n";
      // A negative-only source fixture, never a production build input.
      writeFileSync(join(resolve(output, '..'), 'skill-eval-fixtures.js'), contents);
      expect(module.currentV5SkillEvaluationContracts(pkg, epoch).size).toBe(0);
    },
  );

  test('genuine backend package build carries freshly collected identities', async () => {
    // Preserve any stale/user build without claiming it as this test's artifact.
    const target = join(backendRoot, 'build');
    const saved = join(scratch, 'previous-build');
    const output = join(scratch, 'genuine-build');
    const hadTarget = lstatSync(target, { throwIfNoEntry: false }) !== undefined;
    mkdirSync(output);
    if (hadTarget) renameSync(target, saved);
    try {
      symlinkSync(output, target, directoryLinkType());
      const process = Bun.spawn(['bun', 'run', 'build'], {
        cwd: backendRoot,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [code, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ]);
      expect({ code, diagnostics: code === 0 ? '' : `${stdout}\n${stderr}` }).toEqual({
        code: 0,
        diagnostics: '',
      });
      const contents = readFileSync(join(output, 'server.js'), 'utf8');
      // Inspect the real production bundle without executing server startup.
      const marker = [
        '// src/eval/skills/skill-eval-embedded-contracts.ts\n',
        '// backend/src/eval/skills/skill-eval-embedded-contracts.ts\n',
        '// src/kory/skill-eval-embedded-contracts.ts\n',
        '// backend/src/kory/skill-eval-embedded-contracts.ts\n',
      ].find((candidate) => contents.includes(candidate));
      expect(marker).toBeDefined();
      const section = contents.split(marker!)[1]!;
      const literal = section.match(/var contracts = (\{[^\n]+\});\n/)?.[1];
      expect(literal).toBeDefined();
      // Bun may print the generated JSON object as a JavaScript object literal
      // with bare identifier keys. Normalize only those keys before parsing;
      // values remain the generated source metadata and are never executed.
      const jsonLiteral = literal!.replace(/([\{,])\s*([A-Za-z_$][\w$]*):/g, '$1"$2":');
      assertEmbeddedMatchesSource(JSON.parse(jsonLiteral));
      // Bun renames local identifiers when bundling the full backend (for
      // example `value` -> `value2`). Verify the recursive freeze still acts
      // on its own argument and wraps the actual embedded contracts.
      const freeze = section.match(
        /function (freeze\w*)\((\w+)\) \{[\s\S]{0,250}?Object\.freeze\(\2\);[\s\S]{0,80}?\}/,
      );
      expect(freeze).toBeDefined();
      expect(section).toContain(`${freeze![1]}(contracts)`);
      expect(contents).not.toContain('var BUILTIN_SKILL_EVAL_SCORERS');
      expect(contents).not.toContain('var BUILTIN_SKILL_EVAL_MATERIALIZERS');
    } finally {
      rmSync(target, { force: true });
      if (hadTarget) renameSync(saved, target);
    }
  }, 180_000);
});
