import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  auditSkillEvalExecutionReadiness,
  type SkillEvalDeterministicScorer,
  type SkillEvalFixtureMaterializer,
} from '../skill-eval-execution';
import {
  BUILTIN_SKILL_EVAL_MATERIALIZERS,
  BUILTIN_SKILL_EVAL_SCORERS,
} from '../skill-eval-fixtures';
import type { SkillEvalScenarioV3 } from '../skill-eval-harness';
import { loadV5SkillPackages } from '../skill-packages';

const packages = loadV5SkillPackages().packages;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scenario(skill: string, scenarioId: string): SkillEvalScenarioV3 {
  const task = packages
    .find((item) => item.sidecar.name === skill)!
    .evaluation.tasks.find((item) => item.id === scenarioId)!;
  return {
    ...task,
    skill,
    category: 'full-task',
    expectedSelection: true,
    expectedSkills: [],
    forbiddenSkills: [],
    heldOut: true,
    adjacentSkills: [],
    tags: ['held-out', 'full-task'],
  };
}

function fixtureParts(s: SkillEvalScenarioV3): {
  materializer: SkillEvalFixtureMaterializer;
  scorer: SkillEvalDeterministicScorer;
} {
  return {
    materializer: BUILTIN_SKILL_EVAL_MATERIALIZERS.find((item) => item.matches(s))!,
    scorer: BUILTIN_SKILL_EVAL_SCORERS.find((item) => item.scenarioIds.includes(s.id))!,
  };
}

async function materialize(s: SkillEvalScenarioV3): Promise<{
  root: string;
  scorer: SkillEvalDeterministicScorer;
}> {
  const root = mkdtempSync(join(tmpdir(), 'kory-promotion-repair-'));
  roots.push(root);
  const { materializer, scorer } = fixtureParts(s);
  await materializer.materialize(root, s);
  return { root, scorer };
}

describe('V5 promotion repair lane evaluator contracts', () => {
  test('engine-backed and search/vector component exercises fail closed for full-task qualification', () => {
    const blockedSkills = new Set([
      'mongodb-engineering',
      'mysql-engineering',
      'postgres-engineering',
      'search-indexing',
      'vector-search-systems',
    ]);
    const rows = auditSkillEvalExecutionReadiness(
      packages,
      BUILTIN_SKILL_EVAL_MATERIALIZERS,
      BUILTIN_SKILL_EVAL_SCORERS,
    ).filter((row) => blockedSkills.has(row.skill));

    expect(rows).toHaveLength(10);
    expect(rows.every((row) => !row.ready)).toBe(true);
    expect(
      rows.every((row) =>
        row.reasons.some((reason) => /Full-task qualification requires/u.test(reason)),
      ),
    ).toBe(true);

    expect(
      rows
        .filter((row) => row.skill === 'mongodb-engineering')
        .every((row) => row.materializerId?.endsWith('@2')),
    ).toBe(true);
    expect(
      rows
        .filter((row) => row.skill === 'mysql-engineering')
        .every((row) => row.materializerId?.endsWith('@2')),
    ).toBe(true);
    expect(
      rows
        .filter((row) => row.skill === 'postgres-engineering')
        .every((row) => row.materializerId?.endsWith('@2')),
    ).toBe(true);
    expect(
      rows
        .filter((row) => row.skill === 'search-indexing' || row.skill === 'vector-search-systems')
        .every(
          (row) => row.materializerId?.endsWith('@2') && row.deterministicScorerId?.endsWith('@2'),
        ),
    ).toBe(true);
  });

  test('SQLite scorer imports materialized Python modules from the fixture root', async () => {
    const s = scenario('sqlite-engineering', 'sqlite-engineering-full-task-1-individual');
    const { root, scorer } = await materialize(s);
    expect(scorer.id).toBe('sqlite-engineering/wal-checkpoint-contention-scorer@2');

    const result = await scorer.score({
      scenario: s,
      experiment: {} as never,
      workingDirectory: root,
      observation: {} as never,
    });
    const evidence = result.evidence.join('\n');
    expect(result.passed).toBe(false);
    expect(evidence).not.toContain('ModuleNotFoundError');
    expect(evidence).not.toContain("No module named 'src'");
    expect(evidence).toContain('AssertionError');
  });

  test('stream scorer rejects bounded dedup with unbounded aggregate windows and accepts full eviction', async () => {
    const s = scenario('stream-processing', 'stream-processing-full-task-1-individual');
    const { root, scorer } = await materialize(s);
    expect(scorer.id).toBe('stream-processing/event-time-window-dedup-scorer@2');

    mkdirSync(join(root, '.kory-eval'), { recursive: true });
    writeFileSync(join(root, '.kory-eval/stream-window.json'), '{}\n');
    writeFileSync(
      join(root, 'tests/regressions.test.ts'),
      "import{expect,test}from'bun:test';test('late watermark duplicate dedup checkpoint restart',()=>expect(true).toBe(true));\n",
    );

    const shared = String.raw`
export interface StreamEvent{id:string;key:string;eventTimeMs:number;value:number}
export class WindowCounter{
  private seen=new Map<string,number>();
  private counts=new Map<number,number>();
  constructor(readonly windowMs:number,readonly allowedLatenessMs:number){}
  private prune(watermarkMs:number, pruneCounts:boolean){
    const cutoff=watermarkMs-this.allowedLatenessMs;
    for(const [id,time] of this.seen)if(time<cutoff)this.seen.delete(id);
    if(pruneCounts)for(const bucket of this.counts.keys())if(bucket+this.windowMs<cutoff)this.counts.delete(bucket);
  }
  protected pruneCounts(){return false}
  ingest(event:StreamEvent,watermarkMs:number):'applied'|'duplicate'|'too-late'{
    this.prune(watermarkMs,this.pruneCounts());
    if(event.eventTimeMs<watermarkMs-this.allowedLatenessMs)return'too-late';
    if(this.seen.has(event.id))return'duplicate';
    this.seen.set(event.id,event.eventTimeMs);
    const bucket=Math.floor(event.eventTimeMs/this.windowMs)*this.windowMs;
    this.counts.set(bucket,(this.counts.get(bucket)??0)+event.value);
    return'applied';
  }
  count(bucket:number){return this.counts.get(bucket)??0}
  retainedIds(){return this.seen.size}
  checkpoint(){return{seen:[...this.seen] as [string,number][],counts:[...this.counts] as [number,number][]}}
  restore(s:{seen:[string,number][];counts:[number,number][]}){this.seen=new Map(s.seen);this.counts=new Map(s.counts)}
}
`;
    writeFileSync(join(root, 'src/stream.ts'), shared);
    const bad = await scorer.score({
      scenario: s,
      experiment: {} as never,
      workingDirectory: root,
      observation: {} as never,
    });
    expect(bad.passed, bad.evidence.join('\n')).toBe(false);
    expect(bad.verification).toBe(0);

    writeFileSync(
      join(root, 'src/stream.ts'),
      shared.replace(
        'protected pruneCounts(){return false}',
        'protected pruneCounts(){return true}',
      ),
    );
    const good = await scorer.score({
      scenario: s,
      experiment: {} as never,
      workingDirectory: root,
      observation: {} as never,
    });
    expect(good.passed, good.evidence.join('\n')).toBe(true);
    expect(good.verification).toBe(1);
  });
});
