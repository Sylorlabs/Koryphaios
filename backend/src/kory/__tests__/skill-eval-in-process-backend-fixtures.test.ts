import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillEvalSuiteV3 } from '../../eval/skills/skill-eval-harness';
import { writeFixtureFile } from '../../eval/skills/skill-eval-fixture-helpers';
import {
  BACKEND_STATE_SKILL_EVAL_MATERIALIZERS,
  BACKEND_STATE_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-backend-state-fixtures';
import { loadV5SkillPackages } from '../skill-packages';

const SCENARIO_ID = 'in-process-backend-full-task-1-individual';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('in-process backend queue evaluation fixture', () => {
  test('accepts durable exclusive claims with deterministic bounded backoff', async () => {
    const skill = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'in-process-backend',
    )!;
    const scenario = buildSkillEvalSuiteV3(skill).scenarios.find(
      (item) => item.id === SCENARIO_ID,
    )!;
    const materializer = BACKEND_STATE_SKILL_EVAL_MATERIALIZERS.find((item) =>
      item.matches(scenario),
    )!;
    const scorer = BACKEND_STATE_SKILL_EVAL_SCORERS.find((item) =>
      item.scenarioIds.includes(SCENARIO_ID),
    )!;
    const root = mkdtempSync(join(tmpdir(), 'kory-inprocess-queue-test-'));
    roots.push(root);
    await materializer.materialize(root, scenario);

    writeFixtureFile(
      root,
      'src/job-queue.ts',
      `export type JobState='queued'|'claimed'|'running'|'done'|'cancelled'|'retry';
export interface Job{id:string;state:JobState;attempts:number;effectCommitted:boolean;availableAt:number;claimOwner?:string}
export interface DurableStore{jobs:Map<string,Job>}
export class LocalJobQueue{
 constructor(private readonly store:DurableStore,private readonly now:()=>number=Date.now){}
 enqueue(id:string){if(!this.store.jobs.has(id))this.store.jobs.set(id,{id,state:'queued',attempts:0,effectCommitted:false,availableAt:this.now()});}
 cancel(id:string){const j=this.store.jobs.get(id);if(j&&['queued','retry'].includes(j.state))j.state='cancelled';}
 claim(worker:string):Job|undefined{const j=[...this.store.jobs.values()].find(x=>(x.state==='queued'||x.state==='retry')&&x.availableAt<=this.now());if(!j)return;j.state='claimed';j.claimOwner=worker;return {...j};}
 begin(id:string,worker:string){const j=this.store.jobs.get(id);if(!j)throw new Error('missing');if(j.state!=='claimed'||j.claimOwner!==worker)throw new Error('not-owner');j.state='running';j.attempts++;}
 commitEffect(id:string){const j=this.store.jobs.get(id)!;if(j.effectCommitted)throw new Error('duplicate-effect');j.effectCommitted=true;}
 finish(id:string){const j=this.store.jobs.get(id)!;j.state='done';delete j.claimOwner;}
 transientFailure(id:string,maxAttempts=3){const j=this.store.jobs.get(id)!;if(j.attempts>=maxAttempts){j.state='cancelled';delete j.claimOwner;return;}const delay=Math.min(1000*2**Math.max(0,j.attempts-1),8000);j.state='retry';j.availableAt=this.now()+delay;delete j.claimOwner;}
 recoverAfterRestart(){for(const j of this.store.jobs.values())if(j.state==='claimed'||j.state==='running'){if(j.effectCommitted)j.state='done';else{j.state='retry';j.availableAt=this.now();}delete j.claimOwner;}}
 snapshot(){return [...this.store.jobs.values()].map(j=>({...j}));}
}
`,
    );
    writeFixtureFile(
      root,
      'tests/job-queue.test.ts',
      `import{expect,test}from'bun:test';import{LocalJobQueue}from'../src/job-queue';
test('concurrent claim ownership regression',()=>{const q=new LocalJobQueue({jobs:new Map()});q.enqueue('a');expect(q.claim('w1')?.id).toBe('a');expect(q.claim('w2')).toBeUndefined();});
test('restart crash recovery regression',()=>{const q=new LocalJobQueue({jobs:new Map()});q.enqueue('a');q.claim('w');q.begin('a','w');q.recoverAfterRestart();expect(q.snapshot()[0].state).toBe('retry');});
test('retry limit and cancellation regression',()=>{let now=0;const q=new LocalJobQueue({jobs:new Map()},()=>now);q.enqueue('a');q.claim('w');q.begin('a','w');q.transientFailure('a',1);expect(q.snapshot()[0].state).toBe('cancelled');});
`,
    );
    writeFixtureFile(
      root,
      '.kory-eval/inprocess-queue.json',
      `${JSON.stringify(
        {
          ownership: 'atomic claimed state with one owner',
          recovery: 'restart before committed effect retries; committed effect becomes done',
          retry: 'deterministic bounded exponential backoff with retry limit',
          runtime: 'bun host runtime',
          storage: 'local sqlite equivalent durable store',
          broader: 'backend-engineering',
          neighbor: 'bun-deno-runtime',
        },
        null,
        2,
      )}\n`,
    );

    const score = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
    });

    expect(materializer.id).toEndWith('@2');
    expect(scorer.id).toEndWith('@4');
    if (!score.passed) throw new Error(score.evidence.join('\n'));
    expect(score.verification).toBe(1);

    const authoredTests = readFileSync(join(root, 'tests/job-queue.test.ts'), 'utf8');
    writeFixtureFile(
      root,
      'tests/job-queue.test.ts',
      `import { expect, test } from 'bun:test';\ntest('claim concurrency restart crash retry cancellation', () => expect(true).toBe(true));\n`,
    );
    const keywordOnly = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
    });
    expect(keywordOnly.passed).toBe(false);
    expect(keywordOnly.evidence).toContain('candidate tests reject the original defect: no');
    writeFixtureFile(root, 'tests/job-queue.test.ts', authoredTests);

    const queueSource = readFileSync(join(root, 'src/job-queue.ts'), 'utf8');
    const withRestartBackoff = queueSource.replace(
      'j.availableAt=this.now();',
      'j.availableAt=this.now()+1000;',
    );
    expect(withRestartBackoff).not.toBe(queueSource);
    writeFixtureFile(root, 'src/job-queue.ts', withRestartBackoff);
    const delayedRecoveryScore = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
    });
    if (!delayedRecoveryScore.passed) {
      throw new Error(delayedRecoveryScore.evidence.join('\n'));
    }

    const lostAtomicOwnership = withRestartBackoff.replace(
      "j.state='claimed';j.claimOwner=worker;return {...j};",
      'return {...j,claimOwner:worker};',
    );
    expect(lostAtomicOwnership).not.toBe(withRestartBackoff);
    writeFixtureFile(root, 'src/job-queue.ts', lostAtomicOwnership);
    const unsafeScore = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
    });
    expect(unsafeScore.passed).toBe(false);
    expect(unsafeScore.verification).toBe(0);
  });
});
