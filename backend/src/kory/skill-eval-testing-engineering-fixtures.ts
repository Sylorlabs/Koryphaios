import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { packageJson, writeFixtureFile } from './skill-eval-fixture-helpers';

const RETRY = 'testing-engineering-full-task-1';
const CLI_JSON = 'testing-engineering-full-task-2';

const CLOCK_SOURCE = `export class FakeClock {
  private nowMs = 0;
  private nextId = 1;
  private jobs = new Map<number,{at:number,run:()=>void}>();
  setTimeout(run:()=>void, delayMs:number): number {
    const id=this.nextId++; this.jobs.set(id,{at:this.nowMs+Math.max(0,delayMs),run}); return id;
  }
  clearTimeout(id:number): void { this.jobs.delete(id); }
  async advance(ms:number): Promise<void> {
    const target=this.nowMs+ms;
    while(true){ const next=[...this.jobs.entries()].sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0]; if(!next||next[1].at>target) break; this.nowMs=next[1].at; this.jobs.delete(next[0]); next[1].run(); await Promise.resolve(); }
    this.nowMs=target; await Promise.resolve();
  }
  pending(): number { return this.jobs.size; }
}
`;

const CLIENT_FIXED = `import type { FakeClock } from './fake-clock';
export interface ResponseLike { status:number; headers?:Record<string,string>; body?:string }
export type Send = (attempt:number, signal:AbortSignal)=>Promise<ResponseLike>;
export async function requestWithRetry(send:Send, signal:AbortSignal, clock:FakeClock):Promise<ResponseLike>{
  let attempt=1;
  while(true){
    if(signal.aborted) throw signal.reason ?? new Error('aborted');
    const response=await send(attempt,signal);
    if(response.status!==429) return response;
    const delay=Number(response.headers?.['retry-after-ms']??'100');
    await new Promise<void>((resolve,reject)=>{
      let settled=false;
      const finish=(fn:()=>void)=>{ if(settled)return; settled=true; signal.removeEventListener('abort',onAbort); fn(); };
      const timer=clock.setTimeout(()=>finish(resolve),delay);
      const onAbort=()=>finish(()=>{clock.clearTimeout(timer);reject(signal.reason??new Error('aborted'));});
      signal.addEventListener('abort',onAbort,{once:true});
      if(signal.aborted) onAbort();
    });
    attempt++;
  }
}
`;

const CLIENT_ABORT_BUG = `import type { FakeClock } from './fake-clock';
export interface ResponseLike { status:number; headers?:Record<string,string>; body?:string }
export type Send = (attempt:number, signal:AbortSignal)=>Promise<ResponseLike>;
export async function requestWithRetry(send:Send, signal:AbortSignal, clock:FakeClock):Promise<ResponseLike>{
  let attempt=1;
  while(true){
    const response=await send(attempt,signal);
    if(response.status!==429) return response;
    const delay=Number(response.headers?.['retry-after-ms']??'100');
    await new Promise<void>(resolve=>{ clock.setTimeout(resolve,delay); });
    attempt++;
  }
}
`;

const CLIENT_NO_RETRY = `import type { FakeClock } from './fake-clock';
export interface ResponseLike { status:number; headers?:Record<string,string>; body?:string }
export type Send = (attempt:number, signal:AbortSignal)=>Promise<ResponseLike>;
export async function requestWithRetry(send:Send, signal:AbortSignal, _clock:FakeClock):Promise<ResponseLike>{
  if(signal.aborted) throw signal.reason ?? new Error('aborted');
  return await send(1,signal);
}
`;

const ARGS_FIXED = `export type Format='text'|'json';
export function normalizeArgs(argv:string[]):{format:Format;values:string[]}{
  let format:Format='text'; const values:string[]=[];
  for(let i=0;i<argv.length;i++){
    if(argv[i]==='--format'){
      const value=argv[++i]; if(value!=='text'&&value!=='json') throw new Error('INVALID_FORMAT'); format=value;
    } else values.push(argv[i]!);
  }
  return {format,values};
}
`;

const ARGS_REJECT_JSON = `export type Format='text'|'json';
export function normalizeArgs(argv:string[]):{format:Format;values:string[]}{
  let format:Format='text'; const values:string[]=[];
  for(let i=0;i<argv.length;i++){
    if(argv[i]==='--format'){
      const value=argv[++i]; if(value!=='text') throw new Error('INVALID_FORMAT'); format='text';
    } else values.push(argv[i]!);
  }
  return {format,values};
}
`;

const SERIALIZE_FIXED = `import type { Format } from './args';
export function serialize(values:string[], format:Format):string{
  if(format==='json') return JSON.stringify({values})+'\\n';
  return values.join('\\n')+(values.length?'\\n':'');
}
`;

const SERIALIZE_BUG = `import type { Format } from './args';
export function serialize(values:string[], format:Format):string{
  if(format==='json') return JSON.stringify({values:values.filter(Boolean).map(v=>v.replace(/[^\\x00-\\x7F]/g,''))})+'\\n';
  return values.join('\\n')+(values.length?'\\n':'');
}
`;

const CLI_FIXED = `import { normalizeArgs } from './args'; import { serialize } from './serialize';
export function run(argv:string[]):number{
  try { const parsed=normalizeArgs(argv); process.stdout.write(serialize(parsed.values,parsed.format)); return 0; }
  catch(error){ process.stderr.write((error instanceof Error?error.message:String(error))+'\\n'); return 2; }
}
if(import.meta.main) process.exitCode=run(process.argv.slice(2));
`;

const CLI_STDOUT_BUG = `import { normalizeArgs } from './args'; import { serialize } from './serialize';
export function run(argv:string[]):number{
  try { const parsed=normalizeArgs(argv); process.stdout.write(serialize(parsed.values,parsed.format)); return 0; }
  catch(error){ process.stdout.write((error instanceof Error?error.message:String(error))+'\\n'); return 2; }
}
if(import.meta.main) process.exitCode=run(process.argv.slice(2));
`;

function runTests(root: string): { passed: boolean; output: string } {
  const result = spawnSync(process.execPath, ['test', '--no-env-file', 'tests'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 1_000_000,
    env: { PATH: process.env.PATH ?? '', HOME: root, NO_COLOR: '1' },
  });
  return {
    passed: result.status === 0,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`.slice(-5000),
  };
}

function mutationRun(
  root: string,
  replacements: Record<string, string>,
): { passed: boolean; output: string } {
  const copy = mkdtempSync(join(tmpdir(), 'kory-testing-mutation-'));
  try {
    cpSync(root, copy, { recursive: true });
    for (const [path, source] of Object.entries(replacements))
      writeFileSync(join(copy, path), source);
    return runTests(copy);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

function fixedFilesIntact(root: string, files: Record<string, string>): boolean {
  try {
    return Object.entries(files).every(
      ([path, source]) => readFileSync(join(root, path), 'utf8') === source,
    );
  } catch {
    return false;
  }
}

function candidateTestText(root: string): string {
  try {
    return readFileSync(join(root, 'tests/regression.test.ts'), 'utf8');
  } catch {
    return '';
  }
}

function scoreRetry(root: string): SkillEvalDeterministicScore {
  const fixedFiles = {
    'src/fake-clock.ts': CLOCK_SOURCE,
    'src/client.ts': CLIENT_FIXED,
    'mutations/client-abort-bug.ts': CLIENT_ABORT_BUG,
    'mutations/client-no-retry.ts': CLIENT_NO_RETRY,
  };
  const intact = fixedFilesIntact(root, fixedFiles);
  if (!intact)
    return {
      passed: false,
      quality: 0,
      verification: 0,
      integrityFailure: true,
      evidence: ['fixed client/mutation corpus modified'],
    };
  const fixed = runTests(root);
  const abortMutation = mutationRun(root, { 'src/client.ts': CLIENT_ABORT_BUG });
  const noRetryMutation = mutationRun(root, { 'src/client.ts': CLIENT_NO_RETRY });
  const text = candidateTestText(root);
  const publicBoundary =
    /requestWithRetry/u.test(text) && !/pending\(\)|jobs|nextId|private/u.test(text);
  const passed = fixed.passed && !abortMutation.passed && !noRetryMutation.passed && publicBoundary;
  return {
    passed,
    quality:
      [fixed.passed, !abortMutation.passed, !noRetryMutation.passed, publicBoundary].filter(Boolean)
        .length / 4,
    verification: fixed.passed && !abortMutation.passed && !noRetryMutation.passed ? 1 : 0,
    integrityFailure: false,
    evidence: [
      `fixed suite: ${fixed.passed ? 'pass' : 'fail'}`,
      `abort mutation killed: ${!abortMutation.passed ? 'yes' : 'no'}`,
      `ordinary-retry mutation killed: ${!noRetryMutation.passed ? 'yes' : 'no'}`,
      `public API boundary: ${publicBoundary ? 'yes' : 'no'}`,
      fixed.output,
      abortMutation.output,
      noRetryMutation.output,
    ],
  };
}

function scoreCli(root: string): SkillEvalDeterministicScore {
  const fixedFiles = {
    'src/args.ts': ARGS_FIXED,
    'src/serialize.ts': SERIALIZE_FIXED,
    'src/cli.ts': CLI_FIXED,
    'mutations/args-reject-json.ts': ARGS_REJECT_JSON,
    'mutations/serialize-empty-unicode.ts': SERIALIZE_BUG,
    'mutations/cli-stderr.ts': CLI_STDOUT_BUG,
  };
  const intact = fixedFilesIntact(root, fixedFiles);
  if (!intact)
    return {
      passed: false,
      quality: 0,
      verification: 0,
      integrityFailure: true,
      evidence: ['fixed CLI/mutation corpus modified'],
    };
  const fixed = runTests(root);
  const argsMutation = mutationRun(root, { 'src/args.ts': ARGS_REJECT_JSON });
  const serializeMutation = mutationRun(root, { 'src/serialize.ts': SERIALIZE_BUG });
  const stderrMutation = mutationRun(root, { 'src/cli.ts': CLI_STDOUT_BUG });
  const text = candidateTestText(root);
  const layered =
    /normalizeArgs/u.test(text) &&
    /serialize/u.test(text) &&
    /(spawn|Bun\.spawn|subprocess|cli\.ts)/u.test(text) &&
    !/toMatchSnapshot/u.test(text);
  const passed =
    fixed.passed &&
    !argsMutation.passed &&
    !serializeMutation.passed &&
    !stderrMutation.passed &&
    layered;
  return {
    passed,
    quality:
      [
        fixed.passed,
        !argsMutation.passed,
        !serializeMutation.passed,
        !stderrMutation.passed,
        layered,
      ].filter(Boolean).length / 5,
    verification:
      fixed.passed && !argsMutation.passed && !serializeMutation.passed && !stderrMutation.passed
        ? 1
        : 0,
    integrityFailure: false,
    evidence: [
      `fixed suite: ${fixed.passed ? 'pass' : 'fail'}`,
      `argument mutation killed: ${!argsMutation.passed ? 'yes' : 'no'}`,
      `serialization mutation killed: ${!serializeMutation.passed ? 'yes' : 'no'}`,
      `stdout/stderr mutation killed: ${!stderrMutation.passed ? 'yes' : 'no'}`,
      `layered semantic tests: ${layered ? 'yes' : 'no'}`,
      fixed.output,
      argsMutation.output,
      serializeMutation.output,
      stderrMutation.output,
    ],
  };
}

export const TESTING_ENGINEERING_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] =
  [
    {
      id: 'testing-engineering/abort-retry-mutation-suite@1',
      matches: (s) => s.id === RETRY,
      materialize: (root) => {
        writeFixtureFile(root, 'package.json', packageJson('kory-eval-testing-retry'));
        writeFixtureFile(root, 'src/fake-clock.ts', CLOCK_SOURCE);
        writeFixtureFile(root, 'src/client.ts', CLIENT_FIXED);
        writeFixtureFile(root, 'mutations/client-abort-bug.ts', CLIENT_ABORT_BUG);
        writeFixtureFile(root, 'mutations/client-no-retry.ts', CLIENT_NO_RETRY);
        writeFixtureFile(
          root,
          'tests/existing.test.ts',
          `import{expect,test}from'bun:test';import{FakeClock}from'../src/fake-clock';import{requestWithRetry}from'../src/client';test('ordinary success',async()=>{const c=new FakeClock();const r=await requestWithRetry(async()=>({status:200,body:'ok'}),new AbortController().signal,c);expect(r.status).toBe(200);});\n`,
        );
        writeFixtureFile(
          root,
          'tests/regression.test.ts',
          `// Add public-API regression tests for abort during Retry-After and a non-aborted 429 retry. Use FakeClock; do not assert its private bookkeeping.\n`,
        );
        writeFixtureFile(
          root,
          'README.md',
          '# Retry cancellation regression\n\nThe implementation is already fixed. Add durable tests only. The evaluator restores two independent known-bad implementations: one ignores abort during Retry-After; one stops retrying 429 entirely. Your tests must pass the fixed implementation and kill both mutations using requestWithRetry observable behavior with FakeClock.\n',
        );
      },
    },
    {
      id: 'testing-engineering/cli-json-layered-mutation-suite@1',
      matches: (s) => s.id === CLI_JSON,
      materialize: (root) => {
        writeFixtureFile(root, 'package.json', packageJson('kory-eval-testing-cli-json'));
        writeFixtureFile(root, 'src/args.ts', ARGS_FIXED);
        writeFixtureFile(root, 'src/serialize.ts', SERIALIZE_FIXED);
        writeFixtureFile(root, 'src/cli.ts', CLI_FIXED);
        writeFixtureFile(root, 'mutations/args-reject-json.ts', ARGS_REJECT_JSON);
        writeFixtureFile(root, 'mutations/serialize-empty-unicode.ts', SERIALIZE_BUG);
        writeFixtureFile(root, 'mutations/cli-stderr.ts', CLI_STDOUT_BUG);
        writeFixtureFile(
          root,
          'tests/existing.test.ts',
          `import{expect,test}from'bun:test';import{normalizeArgs}from'../src/args';test('legacy text default',()=>expect(normalizeArgs(['a'])).toEqual({format:'text',values:['a']}));\n`,
        );
        writeFixtureFile(
          root,
          'tests/regression.test.ts',
          `// Add complementary normalizeArgs, serialize, and one real CLI subprocess test for JSON format, invalid values, empty/Unicode fields, and stdout/stderr separation. Avoid snapshots.\n`,
        );
        writeFixtureFile(
          root,
          'README.md',
          '# CLI JSON regression suite\n\nThe feature implementation is complete. Add fast layered tests: direct argument normalization, direct JSON serialization including empty and Unicode fields, and one subprocess path that verifies the assembled CLI plus stdout/stderr/exit status. The evaluator restores independent argument, serializer, and stderr routing bugs; all must be killed while the fixed implementation stays green.\n',
        );
      },
    },
  ];

export const TESTING_ENGINEERING_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  {
    id: 'testing-engineering/abort-retry-mutation-scorer@1',
    scenarioIds: [RETRY],
    score: ({ workingDirectory }) => scoreRetry(workingDirectory),
  },
  {
    id: 'testing-engineering/cli-json-layered-mutation-scorer@1',
    scenarioIds: [CLI_JSON],
    score: ({ workingDirectory }) => scoreCli(workingDirectory),
  },
];
