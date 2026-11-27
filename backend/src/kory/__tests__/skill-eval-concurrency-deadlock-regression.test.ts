import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTRACT_CONCURRENCY_SKILL_EVAL_MATERIALIZERS,
  CONTRACT_CONCURRENCY_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-contract-concurrency-fixtures';
import { runPairedSkillEvaluationV3 } from '../../eval/skills/skill-eval-execution';
import { writeFixtureFile } from '../../eval/skills/skill-eval-fixture-helpers';
import type { SkillEvalScenarioV3 } from '../../eval/skills/skill-eval-harness';
import { loadV5SkillPackages } from '../skill-packages';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(number: 1 | 2, captureBeforeDispatch = true) {
  const scenario = { id: `concurrency-debugging-full-task-${number}` } as SkillEvalScenarioV3;
  const root = mkdtempSync(join(tmpdir(), 'kory-concurrency-regression-'));
  roots.push(root);
  const materializer = CONTRACT_CONCURRENCY_SKILL_EVAL_MATERIALIZERS.find((item) =>
    item.matches(scenario),
  )!;
  const scorer = CONTRACT_CONCURRENCY_SKILL_EVAL_SCORERS.find((item) =>
    item.scenarioIds.includes(scenario.id),
  )!;
  expect(materializer.readinessBlockers ?? []).toEqual([]);
  expect(materializer.captureBeforeCandidateDispatch).toBeDefined();
  await materializer.materialize(root, scenario);
  const publicCapture = captureBeforeDispatch
    ? await materializer.captureBeforeCandidateDispatch!(root, scenario)
    : undefined;
  const preDispatchCapture = publicCapture
    ? Object.freeze({
        relativePath: publicCapture.relativePath,
        sha256: createHash('sha256').update(publicCapture.text).digest('hex'),
        text: publicCapture.text,
      })
    : undefined;
  if (preDispatchCapture) {
    expect(JSON.parse(preDispatchCapture.text)).toMatchObject({
      scenarioId: scenario.id,
      exitStatus: 0,
      provenance: 'evaluator executed before candidate dispatch; not an agent action',
      sourcePath: number === 1 ? 'src/document-store.ts' : 'src/worker-pool.ts',
    });
  }
  const sourcePath = number === 1 ? 'src/document-store.ts' : 'src/worker-pool.ts';
  const artifactPath =
    number === 1 ? '.kory-eval/concurrency-save.json' : '.kory-eval/concurrency-deadlock.json';
  const original = readFileSync(join(root, sourcePath), 'utf8');
  const repaired =
    number === 1
      ? original.replace(
          'const next={...update.snapshot,revision:current.revision+1};',
          'const next={...current,revision:current.revision+1};',
        )
      : original.replace(
          "export const flushOrder: Lock[]=['queueLock','sessionLock'];",
          "export const flushOrder: Lock[]=['sessionLock','queueLock'];",
        );
  expect(repaired).not.toBe(original);
  // These observations really occur on the starting source before any repair.
  const before = await import(join(root, sourcePath));
  const preFix =
    number === 1
      ? {
          'title-first': before.runOverlap('title-first'),
          'tags-first': before.runOverlap('tags-first'),
        }
      : {
          conflicting: before.simulateConflictingSchedule(3),
          'normal-shutdown': before.simulateNormalShutdown(2),
        };
  if (number === 1) {
    expect(preFix['title-first']).toEqual({
      id: 'doc-1',
      revision: 9,
      title: 'Old',
      tags: ['base', 'x'],
    });
    expect(preFix['tags-first']).toEqual({
      id: 'doc-1',
      revision: 9,
      title: 'New',
      tags: ['base'],
    });
    const sequential = new before.DocumentStore();
    sequential.commit(sequential.beginTitle('New'));
    sequential.commit(sequential.beginTags(['base', 'x']));
    expect(sequential.read()).toEqual({
      id: 'doc-1',
      revision: 9,
      title: 'New',
      tags: ['base', 'x'],
    });
  } else {
    expect(preFix.conflicting).toMatchObject({
      deadlocked: true,
      pendingFlushes: 3,
      drained: false,
    });
    expect(preFix['normal-shutdown']).toMatchObject({
      deadlocked: false,
      pendingFlushes: 2,
      drained: true,
    });
  }
  const artifact = {
    preFix: {
      evidenceKind: 'simulated',
      observed: true,
      observer: 'controlled test fixture',
      source: sourcePath,
      command: 'Bun test fixture import before repair',
      exitStatus: 0,
      outcomes: preFix,
      timeline:
        'Both actors read revision 7 before either commit; title-first and tags-first lose an independent field delta. Shutdown holds sessionLock and waits queueLock held by flush; flush holds queueLock and waits sessionLock held by shutdown: wait-for cycle.',
    },
    invariant:
      'stale snapshot overwrites an independent delta; per-document ownership invariant. One shared shutdown/flush lock order preserves pending work.',
    limits:
      'Fixed two-phase simulated repeatability, not real async scheduling or varied stress. No native race detector or production recovery; no real worker completion acknowledgments, cleanup or injected failure/recovery are verified.',
  };
  writeFixtureFile(root, sourcePath, repaired);
  writeFixtureFile(root, artifactPath, JSON.stringify(artifact));
  const score = (capture = preDispatchCapture) =>
    scorer.score({
      scenario,
      workingDirectory: root,
      observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
      preDispatchCapture: capture,
    });
  return {
    number,
    root,
    sourcePath,
    artifactPath,
    original,
    repaired,
    artifact,
    score,
    preDispatchCapture,
  };
}

function candidateTests(
  f: Awaited<ReturnType<typeof fixture>>,
  mode: 'none' | 'static' | 'real' | 'false-outcome' = 'real',
) {
  const save = f.number === 1;
  const imports = save
    ? `import {DocumentStore,runOverlap} from '../src/document-store';`
    : `import {shutdownOrder,flushOrder,simulateConflictingSchedule,simulateNormalShutdown} from '../src/worker-pool';`;
  const ids = save ? ['title-first', 'tags-first'] : ['conflicting', 'normal-shutdown'];
  const calls = save
    ? `{'title-first':runOverlap('title-first'),'tags-first':runOverlap('tags-first')}`
    : `{conflicting:simulateConflictingSchedule(3),'normal-shutdown':simulateNormalShutdown(2)}`;
  const assertions = save
    ? `for(const result of Object.values(schedules)) expect(result).toEqual({id:'doc-1',revision:9,title:'New',tags:['base','x']});`
    : `expect(shutdownOrder).toEqual(flushOrder); expect(schedules.conflicting).toMatchObject({deadlocked:false,waitFor:[],pendingFlushes:3,drained:true}); expect(schedules['normal-shutdown']).toMatchObject({deadlocked:false,waitFor:[],pendingFlushes:2,drained:true});`;
  const controls = save
    ? `test('sequential unrelated-document independence and fresh update after stale attempt',()=>{
const s=new DocumentStore();const a=s.beginTitle('New');const b=s.beginTags(['base','x']);s.commit(a);s.commit(s.beginTitle('Other update','doc-2'));s.commit(b);s.commit(s.beginTitle('Fresh'));expect(s.read()).toEqual({id:'doc-1',revision:10,title:'Fresh',tags:['base','x']});expect(s.read('doc-2')).toEqual({id:'doc-2',revision:4,title:'Other update',tags:[]});
});`
    : '';
  const testBody =
    mode === 'none' || mode === 'static'
      ? `test('stress repeat iteration loop 1000, both schedules, sequential normal shutdown pending flush',()=>{const schedules=${calls};${assertions}});`
      : `test('bounded fixed-simulation repeatability',()=>{
const outcomes=[];for(let i=0;i<4;i++){const schedules=${calls};${assertions}outcomes.push({iteration:i+1,schedules});}
${mode === 'false-outcome' ? (save ? "outcomes[0].schedules['title-first'].revision=99;" : 'outcomes[0].schedules.conflicting.drained=false;') : ''}
const path=${JSON.stringify(f.artifactPath)};const artifact=JSON.parse(readFileSync(path,'utf8'));
artifact.repeatabilityRegression={name:'bounded fixed-simulation repeatability',iterations:4,scheduleIds:${JSON.stringify(ids)},scheduleCounts:Object.fromEntries(${JSON.stringify(ids)}.map(id=>[id,4])),outcomes,command:'bun test tests/concurrency.test.ts',exitStatus:0,failures:[]};writeFileSync(path,JSON.stringify(artifact));
});`;
  writeFixtureFile(
    f.root,
    'tests/concurrency.test.ts',
    `import {test,expect} from 'bun:test';import {readFileSync,writeFileSync} from 'node:fs';${imports}\n${testBody}\n${controls}`,
  );
  if (mode === 'static') {
    // A plausible static receipt still is not execution evidence.
    const good = save
      ? {
          'title-first': { id: 'doc-1', revision: 9, title: 'New', tags: ['base', 'x'] },
          'tags-first': { id: 'doc-1', revision: 9, title: 'New', tags: ['base', 'x'] },
        }
      : {
          conflicting: {
            deadlocked: false,
            waitFor: [],
            pendingFlushes: 3,
            drained: true,
            order: { shutdown: ['sessionLock', 'queueLock'], flush: ['sessionLock', 'queueLock'] },
          },
          'normal-shutdown': {
            deadlocked: false,
            waitFor: [],
            pendingFlushes: 2,
            drained: true,
            order: { shutdown: ['sessionLock', 'queueLock'], flush: ['sessionLock', 'queueLock'] },
          },
        };
    writeFixtureFile(
      f.root,
      f.artifactPath,
      JSON.stringify({
        ...f.artifact,
        repeatabilityRegression: {
          name: 'bounded fixed-simulation repeatability',
          iterations: 4,
          scheduleIds: ids,
          scheduleCounts: Object.fromEntries(ids.map((id) => [id, 4])),
          outcomes: Array.from({ length: 4 }, (_, i) => ({ iteration: i + 1, schedules: good })),
          command: 'bun test tests/concurrency.test.ts',
          exitStatus: 0,
          failures: [],
        },
      }),
    );
  }
}

for (const number of [1, 2] as const) {
  test(`task ${number}: paired runner seals the original-source receipt before either arm executes`, async () => {
    const pkg = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'concurrency-debugging',
    )!;
    expect(pkg).toBeDefined();
    const checked: string[] = [];
    const projectRoot = mkdtempSync(join(tmpdir(), 'kory-concurrency-project-'));
    roots.push(projectRoot);
    const result = await runPairedSkillEvaluationV3({
      projectRoot,
      skillPackage: pkg,
      scenarioId: `concurrency-debugging-full-task-${number}`,
      skillRevisionHash: 'a'.repeat(64),
      harnessVersion: 'pre-dispatch-capture-regression',
      evaluationContractHash: createHash('sha256')
        .update(`concurrency-debugging-full-task-${number}-test-contract`)
        .digest('hex'),
      persist: true,
      executor: {
        id: 'capture-inspector',
        subject: 'other',
        provider: 'stub',
        model: 'stub',
        runtimeIdentity: 'test',
        tools: [],
        budget: { wallClockMs: 1000 },
        execute: async ({ workingDirectory }) => {
          const path = join(workingDirectory, '.kory-eval/original-source-observation.json');
          const receipt = JSON.parse(readFileSync(path, 'utf8'));
          expect(receipt.scenarioId).toBe(`concurrency-debugging-full-task-${number}`);
          expect(receipt.exitStatus).toBe(0);
          // The canonical pre-dispatch vector invokes the current Bun binary
          // directly, since npx can no longer resolve 'bun' from PATH.
          expect(receipt.command).toEqual([process.execPath, 'run', 'scripts/observe-original.ts']);
          checked.push(readFileSync(path, 'utf8'));
          return { output: 'inspected', evidence: [], artifacts: [], durationMs: 0 };
        },
      },
      materializers: CONTRACT_CONCURRENCY_SKILL_EVAL_MATERIALIZERS,
      scorers: CONTRACT_CONCURRENCY_SKILL_EVAL_SCORERS,
    });
    try {
      expect(checked).toHaveLength(2);
      expect(checked[0]).toBe(checked[1]);
      expect(Object.isFrozen(result.preDispatchCapture)).toBe(true);
      expect(result.preDispatchCapture?.text).toBe(checked[0]);
      expect(result.preDispatchCapture?.sha256).toBe(
        createHash('sha256').update(checked[0]!).digest('hex'),
      );
      for (const variant of ['with-skill', 'without-skill'] as const) {
        const artifactRoot = join(
          projectRoot,
          '.koryphaios',
          'skills',
          'eval-artifacts',
          result.pairId.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 180),
          variant,
        );
        const manifest = JSON.parse(readFileSync(join(artifactRoot, 'run-manifest.json'), 'utf8'));
        const archived = manifest.preDispatchCaptureArchive;
        expect(archived).toMatchObject({
          relativePath: '.kory-eval/original-source-observation.json',
          sha256: result.preDispatchCapture?.sha256,
        });
        expect(archived.location).toBe(join(artifactRoot, 'pre-dispatch-original.json'));
        expect(readFileSync(archived.location, 'utf8')).toBe(checked[0]);
        expect(createHash('sha256').update(readFileSync(archived.location)).digest('hex')).toBe(
          archived.sha256,
        );
      }
      // No repair was made. Pre-dispatch evidence alone never satisfies post-edit quality gates.
      expect(result.withSkill.score?.passed).toBe(false);
      expect(result.withoutSkill.score?.passed).toBe(false);
      expect(result.withSkill.score?.evidence).toContain(
        'trusted pre-dispatch original-source observation: verified',
      );
      expect(result.withoutSkill.score?.evidence).toContain(
        'trusted pre-dispatch original-source observation: verified',
      );
    } finally {
      result.cleanup();
    }
  });
  test(`task ${number}: missing/static repeatability counts cannot receive execution credit`, async () => {
    const f = await fixture(number);
    candidateTests(f, 'none');
    let result = await f.score();
    expect(result.passed, result.evidence.join('\n')).toBe(false);
    expect(result.verification).toBe(0);
    candidateTests(f, 'static');
    result = await f.score();
    expect(result.passed, result.evidence.join('\n')).toBe(false);
    expect(result.verification).toBe(0);
    expect(readFileSync(join(f.root, f.sourcePath), 'utf8')).toBe(f.repaired);
  });
  test(`task ${number}: regenerated candidate JSON alone cannot certify false outcomes`, async () => {
    const f = await fixture(number);
    candidateTests(f, 'false-outcome');
    const result = await f.score();
    expect(result.passed, result.evidence.join('\n')).toBe(false);
    expect(result.verification).toBe(0);
    expect(result.evidence).toContain('bounded fixed-simulation repeatability: missing or failed');
  });
  test(`task ${number}: verified original-source capture and post-edit repeatability earn full credit`, async () => {
    const f = await fixture(number);
    candidateTests(f);
    for (let i = 0; i < 2; i++) {
      const result = await f.score();
      expect(result.passed, result.evidence.join('\n')).toBe(true);
      expect(result.quality, result.evidence.join('\n')).toBe(1);
      expect(result.verification).toBe(1);
      expect(result.evidence).toContain('post-edit deterministic checks: pass');
      expect(result.evidence).toContain(
        'trusted pre-dispatch original-source observation: verified',
      );
      expect(result.evidence.join('\n')).toContain('4 completed iterations');
      expect(readFileSync(join(f.root, f.sourcePath), 'utf8')).toBe(f.repaired);
    }
  });
  test(`task ${number}: post-edit replay and candidate claims cannot replace missing pre-dispatch proof`, async () => {
    const f = await fixture(number, false);
    candidateTests(f);
    const result = await f.score();
    expect(result.passed).toBe(false);
    expect(result.quality, result.evidence.join('\n')).toBe(0.75);
    expect(result.verification).toBe(0);
    expect(result.evidence).toContain(
      'trusted pre-dispatch original-source observation: unavailable or invalid',
    );
  });
  test(`task ${number}: a candidate-modified public observation invalidates its sealed proof`, async () => {
    const f = await fixture(number);
    candidateTests(f);
    const path = f.preDispatchCapture!.relativePath;
    writeFixtureFile(
      f.root,
      path,
      JSON.stringify({ ...JSON.parse(f.preDispatchCapture!.text), exitStatus: 99 }),
    );
    const result = await f.score();
    expect(result.passed).toBe(false);
    expect(result.verification).toBe(0);
    expect(result.integrityFailure).toBe(true);
  });
  test(`task ${number}: fabricated command/status/outcomes cannot turn a public copy into trusted proof`, async () => {
    const f = await fixture(number);
    candidateTests(f);
    const receipt = JSON.parse(f.preDispatchCapture!.text);
    for (const change of [
      { command: ['bun', 'run', 'fake.ts'] },
      { exitStatus: 1 },
      { outcomes: { fabricated: true } },
      { sourceSha256: '0'.repeat(64) },
      { scriptSha256: 'f'.repeat(64) },
    ]) {
      const text = `${JSON.stringify({ ...receipt, ...change })}\n`;
      writeFixtureFile(f.root, f.preDispatchCapture!.relativePath, text);
      const forged = {
        relativePath: f.preDispatchCapture!.relativePath,
        sha256: createHash('sha256').update(text).digest('hex'),
        text,
      };
      const result = await f.score(forged);
      expect(result.passed, JSON.stringify(change)).toBe(false);
      expect(result.verification).toBe(0);
      expect(result.integrityFailure).toBe(true);
    }
  });
  test(`task ${number}: execution without honest runtime/model limits remains incomplete`, async () => {
    const f = await fixture(number);
    candidateTests(f);
    writeFixtureFile(
      f.root,
      f.artifactPath,
      JSON.stringify({
        ...f.artifact,
        limits: 'varied scheduling stress proves production recovery',
      }),
    );
    const result = await f.score();
    expect(result.passed, result.evidence.join('\n')).toBe(false);
    expect(result.verification).toBe(0);
  });
}

test('deadlock scorer still rejects a keyword-only normal-path authored test', async () => {
  const f = await fixture(2);
  writeFixtureFile(
    f.root,
    'tests/concurrency.test.ts',
    `import {test,expect} from 'bun:test';import {simulateNormalShutdown} from '../src/worker-pool';
test('deadlock conflicting schedule pending flush normal shutdown',()=>expect(simulateNormalShutdown(3)).toMatchObject({deadlocked:false,pendingFlushes:3,drained:true}));`,
  );
  const result = await f.score();
  expect(result.passed).toBe(false);
  expect(result.verification).toBe(0);
  expect(result.evidence).toContain('candidate tests fail original deadlock: no');
});
