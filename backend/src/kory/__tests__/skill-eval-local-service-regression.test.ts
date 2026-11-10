import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BACKEND_STATE_SKILL_EVAL_MATERIALIZERS,
  BACKEND_STATE_SKILL_EVAL_SCORERS,
} from '../skill-eval-backend-state-fixtures';
import { readFixtureText, writeFixtureFile } from '../skill-eval-fixture-helpers';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function prepare(scenarioId: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'kory-local-service-regression-'));
  roots.push(root);
  const materializer = BACKEND_STATE_SKILL_EVAL_MATERIALIZERS.find((item) =>
    item.matches({ id: scenarioId } as never),
  );
  if (!materializer) throw new Error('Missing materializer for ' + scenarioId);
  await materializer.materialize(root, { id: scenarioId } as never);
  return root;
}

async function evaluate(scenarioId: string, workingDirectory: string) {
  const scorer = BACKEND_STATE_SKILL_EVAL_SCORERS.find((item) =>
    item.scenarioIds.includes(scenarioId),
  );
  if (!scorer) throw new Error('Missing scorer for ' + scenarioId);
  return {
    scorerId: scorer.id,
    score: await scorer.score({ workingDirectory } as never),
  };
}

const authRepair = [
  'export interface Client{clientId:string;token?:string;host:string;origin?:string;now:number}',
  'export interface TokenRecord{token:string;clientId:string;expiresAt:number;fileMode:number}',
  'export class LocalCompanionService {',
  '  private tokens = new Map<string,TokenRecord>();',
  '  bootstrap(clientId:string, now:number):TokenRecord {',
  '    const rec:TokenRecord={token:crypto.randomUUID(),clientId,expiresAt:now+60000,fileMode:0o600};',
  '    this.tokens.set(rec.token,rec);',
  '    return rec;',
  '  }',
  '  authorize(client:Client):boolean {',
  '    if(client.host!==\'127.0.0.1\' && client.host!==\'localhost\')return false;',
  '    if(client.origin && client.origin!==\'app://desktop\')return false;',
  '    if(!client.token)return false;',
  '    const stored=this.tokens.get(client.token);',
  '    return Boolean(stored && stored.clientId===client.clientId && client.now<stored.expiresAt);',
  '  }',
  '  rotate(clientId:string,now:number):TokenRecord {',
  '    for(const [key,rec] of this.tokens)if(rec.clientId===clientId)this.tokens.delete(key);',
  '    return this.bootstrap(clientId,now);',
  '  }',
  '  shutdown():void { this.tokens.clear(); }',
  '}',
].join('\n') + '\n';

const authRegressions = [
  "import { expect, test } from 'bun:test';",
  "import { LocalCompanionService } from '../src/service';",
  "test('bootstrap and rotation expiry token client origin host loopback shutdown restart', () => {",
  "  const s=new LocalCompanionService();",
  "  expect(s.authorize({clientId:'a',host:'127.0.0.1',now:0})).toBe(false);",
  "  const issued=s.bootstrap('a',100);",
  "  expect(issued.fileMode).toBe(0o600);",
  "  expect(issued.expiresAt).toBeGreaterThan(100);",
  "  expect(issued.expiresAt).toBeLessThanOrEqual(3600100);",
  "  expect(s.authorize({clientId:'a',token:issued.token,host:'localhost',origin:'app://desktop',now:101})).toBe(true);",
  "  expect(s.authorize({clientId:'b',token:issued.token,host:'localhost',now:101})).toBe(false);",
  "  expect(s.authorize({clientId:'a',token:issued.token,host:'remote',now:101})).toBe(false);",
  "  expect(s.authorize({clientId:'a',token:issued.token,host:'localhost',origin:'https://remote',now:101})).toBe(false);",
  "  expect(s.authorize({clientId:'a',token:issued.token,host:'localhost',now:issued.expiresAt})).toBe(false);",
  "  const rotated=s.rotate('a',200);",
  "  expect(rotated.token).not.toBe(issued.token);",
  "  expect(s.authorize({clientId:'a',token:issued.token,host:'localhost',now:201})).toBe(false);",
  "  expect(s.authorize({clientId:'a',token:rotated.token,host:'localhost',now:201})).toBe(true);",
  "  s.shutdown();",
  "  expect(s.authorize({clientId:'a',token:rotated.token,host:'localhost',now:202})).toBe(false);",
  "  expect(new LocalCompanionService().authorize({clientId:'a',token:rotated.token,host:'localhost',now:202})).toBe(false);",
  "});",
].join('\n') + '\n';

const jobsRepair = [
  "export type Status='queued'|'running'|'done'|'cancelled';",
  'export interface Job{id:string;requestKey:string;status:Status;artifact?:string}',
  'export interface DurableJobs{jobs:Map<string,Job>}',
  'export class ConversionService {',
  '  constructor(private durable:DurableJobs) {}',
  '  submit(requestKey:string):Job {',
  '    const found=[...this.durable.jobs.values()].find(j=>j.requestKey===requestKey);',
  '    if(found)return {...found};',
  "    const next=Math.max(0,...[...this.durable.jobs.keys()].map(k=>Number(k.replace('job-',''))||0))+1;",
  "    const job:Job={id:'job-'+next,requestKey,status:'queued'};",
  '    this.durable.jobs.set(job.id,job); return {...job};',
  '  }',
  '  status(id:string):Job|undefined { const j=this.durable.jobs.get(id);return j && {...j}; }',
  "  start(id:string):void { const j=this.durable.jobs.get(id);if(j&&j.status==='queued')j.status='running'; }",
  "  complete(id:string,artifact:string):void { const j=this.durable.jobs.get(id);if(j && j.status!=='cancelled'){j.status='done';j.artifact=artifact;} }",
  "  cancel(id:string):void { const j=this.durable.jobs.get(id);if(j && j.status!=='done')j.status='cancelled'; }",
  "  cleanup(id:string):void { const j=this.durable.jobs.get(id);if(j?.status==='done')this.durable.jobs.delete(id); }",
  '}',
].join('\n') + '\n';

const jobsRegressions = [
  "import { expect, test } from 'bun:test';",
  "import { ConversionService } from '../src/conversion';",
  "test('restart reconnect kill duplicate resubmit request identity and cancel cleanup persist', () => {",
  '  const durable={jobs:new Map()};',
  '  const initial=new ConversionService(durable);',
  "  const job=initial.submit('request-1');",
  '  initial.start(job.id);',
  '  const reconnect=new ConversionService(durable);',
  "  const repeated=reconnect.submit('request-1');",
  '  expect(repeated.id).toBe(job.id);',
  "  expect(reconnect.status(job.id)?.status).toBe('running');",
  "  const cancelled=reconnect.submit('cancel');",
  '  reconnect.cancel(cancelled.id);',
  '  const restarted=new ConversionService(durable);',
  "  expect(restarted.status(cancelled.id)?.status).toBe('cancelled');",
  '  restarted.complete(job.id, "artifact.bin");',
  '  const final=new ConversionService(durable);',
  "  expect(final.status(job.id)?.artifact).toBe('artifact.bin');",
  '  final.cleanup(job.id);',
  '  expect(new ConversionService(durable).status(job.id)).toBeUndefined();',
  '});',
].join('\n') + '\n';

test('local auth scorer requires tests that detect the original insecure loopback trust', async () => {
  const scenario = 'local-service-backend-full-task-1-individual';
  const root = await prepare(scenario);
  writeFixtureFile(root, 'src/service.ts', authRepair);
  writeFixtureFile(root, 'tests/service.test.ts', authRegressions);
  writeFixtureFile(root, '.kory-eval/local-auth.json', JSON.stringify({
    topology: 'local companion IPC',
    token: '0600 expiring, unique and client bound',
    broader: 'backend-engineering',
    neighbor: 'bun-deno-runtime',
  }));
  const accepted = await evaluate(scenario, root);
  expect(accepted.scorerId).toEndWith('@2');
  expect(accepted.score.passed, accepted.score.evidence.join('\n')).toBe(true);
  expect(accepted.score.evidence).toContain('candidate tests reject the original defect: yes');
  writeFixtureFile(root, 'tests/service.test.ts',
    "import { expect, test } from 'bun:test';\ntest('rotation expiry token origin host loopback shutdown restart', () => expect(true).toBe(true));\n");
  const weak = await evaluate(scenario, root);
  expect(weak.score.passed).toBe(false);
  expect(weak.score.verification).toBe(0);
  expect(weak.score.evidence).toContain('candidate tests reject the original defect: no');
  expect(readFixtureText(root, 'src/service.ts')).toBe(authRepair);
});

test('local conversion scorer requires tests that detect lost durable reconnect state', async () => {
  const scenario = 'local-service-backend-full-task-2-individual';
  const root = await prepare(scenario);
  writeFixtureFile(root, 'src/conversion.ts', jobsRepair);
  writeFixtureFile(root, 'tests/conversion.test.ts', jobsRegressions);
  writeFixtureFile(root, '.kory-eval/local-jobs.json', JSON.stringify({
    topology: 'single local process and durable job state',
    reconnect: 'resubmit idempotent across process restarts',
    hierarchy: 'backend-engineering compiler-runtime-backend',
  }));
  const accepted = await evaluate(scenario, root);
  expect(accepted.scorerId).toEndWith('@2');
  expect(accepted.score.passed, accepted.score.evidence.join('\n')).toBe(true);
  expect(accepted.score.evidence).toContain('candidate tests reject the original defect: yes');
  writeFixtureFile(root, 'tests/conversion.test.ts',
    "import { expect, test } from 'bun:test';\ntest('restart reconnect duplicate resubmit request cancel cleanup', () => expect(true).toBe(true));\n");
  const weak = await evaluate(scenario, root);
  expect(weak.score.passed).toBe(false);
  expect(weak.score.verification).toBe(0);
  expect(weak.score.evidence).toContain('candidate tests reject the original defect: no');
  expect(readFixtureText(root, 'src/conversion.ts')).toBe(jobsRepair);
});
