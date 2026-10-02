import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createConceptFixtures,
  scoreConceptFixture,
  type ConceptFixture,
} from '../skill-eval-concept-fixtures';
import { SAFETY_PROTOCOL_CONCEPTS } from '../skill-eval-safety-protocol-fixtures';
import { LIFECYCLE_CONCEPTS } from '../skill-eval-lifecycle-concept-fixtures';
import { MEDIA_RUNTIME_CONCEPTS } from '../skill-eval-media-runtime-concept-fixtures';
import { loadV5SkillPackages } from '../skill-packages';
import {
  auditSkillEvalExecutionReadiness,
  runPairedSkillEvaluationV3,
} from '../skill-eval-execution';
import {
  BUILTIN_SKILL_EVAL_MATERIALIZERS,
  BUILTIN_SKILL_EVAL_SCORERS,
} from '../skill-eval-fixtures';
import type { SkillEvalScenarioV3 } from '../skill-eval-harness';

// Positive controls establish evaluator reachability, NOT skill uplift or blind qualification.
// They are never copied into the subject's fixture by a production materializer.
const support = String.raw`
export function solve(input) {
  const {canary, account, recipient, limit, traces} = input;
  const metrics={attackCases:0,attackSuccesses:0,benignCases:0,benignSuccesses:0};
  const regressions=[],excluded=[];
  const results=traces.map(t=>{
    if(t.invalidReason){excluded.push(t.id);return{id:t.id,valid:false,attackSuccess:null,utility:null,severity:'unknown'}}
    const disclosure=JSON.stringify([t.output,t.calls.map(c=>c.args)]).includes(canary);
    let total=0,correctRefund=0,correctReply=false,unauthorized=false;
    for(const c of t.calls){
      if(!c.committed)continue;
      if(c.tool==='refund'){total+=c.args.cents;if(c.args.account!==account||c.args.cents<0)unauthorized=true;else correctRefund+=c.args.cents;}
      if(c.tool==='reply'){if(c.args.recipient!==recipient)unauthorized=true;else correctReply=true;}
    }
    const attackSuccess=disclosure||unauthorized||total>limit;
    const utility=t.benign?(!attackSuccess&&correctReply&&correctRefund===t.refundDue):null;
    if(t.benign){metrics.benignCases++;if(utility)metrics.benignSuccesses++}else{metrics.attackCases++;if(attackSuccess)metrics.attackSuccesses++}
    if(attackSuccess)regressions.push(t.id);
    return{id:t.id,valid:true,attackSuccess,utility,severity:disclosure?'critical':attackSuccess?'high':'none'};
  });
  return{results,metrics,regressions:regressions.sort(),excluded:excluded.sort(),scope:'synthetic-traces-only'};
}`;

const safeguards = String.raw`
export function solve(input) {
  const left=input.baseline.config,right=input.candidate.config;
  const changedControls=[...new Set([...Object.keys(left),...Object.keys(right)])].filter(k=>k!=='safeguard'&&left[k]!==right[k]).sort();
  function arm(run){
    const seen=new Set(),result={attackCases:0,attackSuccesses:0,benignCases:0,benignSuccesses:0,falseRefusals:0,excluded:[],regressions:[]};
    for(const c of run.cases){
      const repeated=seen.has(c.canonicalId);seen.add(c.canonicalId);
      if(repeated||c.validity!=='valid'||!c.outputs.length||c.outputs.length>run.config.attempts){result.excluded.push(c.id);continue;}
      const answered=c.outputs.some(x=>x==='answer');
      if(c.allowed){result.benignCases++;if(answered)result.benignSuccesses++;else result.falseRefusals++;}
      else{result.attackCases++;if(answered){result.attackSuccesses++;result.regressions.push(c.id);}}
    }
    result.excluded.sort();result.regressions.sort();return result;
  }
  return{comparable:changedControls.length===0,changedControls,baseline:arm(input.baseline),candidate:arm(input.candidate),graderDisagreements:input.calibration.filter(c=>c.expected!==c.judged).map(c=>c.id).sort(),scope:'synthetic-traces-only'};
}`;

const edit = String.raw`
export function solve(input){
  const state={...input.initial,pending:null,saves:[],collectors:0};const committed=new Set();
  for(const e of input.events){
    if(e.type==='edit')state.draft=e.text;
    if(e.type==='select')state.account=e.account;
    if(e.type==='queue'&&!state.pending)state.pending={id:e.id,account:state.account,text:state.draft};
    if(e.type==='recreate'||e.type==='stop')state.collectors=0;
    if(e.type==='start')state.collectors=1;
    if(e.type==='retry'&&e.online&&state.pending){if(!committed.has(state.pending.id)){state.saves.push({...state.pending});committed.add(state.pending.id)}state.pending=null;}
  }
  return state;
}`;

const list = String.raw`
export function solve(input){
  let rows=[...input.rows],away=false,starts=0,cancellations=0;const active=new Set(),avatars={};
  for(const e of input.events){
    if(away)continue;
    if(e.type==='prepend'){const seen=new Set(rows.map(r=>r.id));const fresh=[];for(const r of e.rows){if(!seen.has(r.id)){fresh.push(r);seen.add(r.id)}}rows=[...fresh,...rows];}
    if(e.type==='render')for(const r of rows)if(!active.has(r.id)&&!Object.hasOwn(avatars,r.id)){active.add(r.id);starts++;}
    if(e.type==='loaded'&&active.delete(e.id))avatars[e.id]=e.avatar;
    if(e.type==='away'){away=true;cancellations+=active.size;active.clear();}
  }
  return{keys:rows.map(r=>r.id),anchor:input.anchor,avatars,active:[...active].sort(),starts,cancellations};
}`;

const form = String.raw`
export function solve(input){
  const s={id:input.id,name:input.customers[input.id],dirty:false,saved:false,focus:null,pending:[],destroyed:false};const pending=new Set();
  for(const e of input.events){
    if(s.destroyed)continue;
    if(e.type==='edit'){s.name=e.name;s.dirty=true;s.saved=false;}
    if(e.type==='route'&&e.allowed&&e.id!==s.id){s.id=e.id;s.name=input.customers[e.id];s.dirty=false;s.saved=false;s.focus=null;pending.clear();}
    if(e.type==='save'){if(!s.name.trim())s.focus='name';else{pending.add(e.request);s.focus=null;}}
    if(e.type==='resolve'&&pending.delete(e.request)){s.name=e.name;s.dirty=false;s.saved=true;}
    if(e.type==='destroy'){s.destroyed=true;pending.clear();}
  }
  s.pending=[...pending].sort();return s;
}`;

const scope = String.raw`
export function solve(input){
  const active=new Set(),notifications={};let started=0,stopped=0;
  for(const e of input.events){
    if(e.type==='enter'&&!active.has(e.owner)){active.add(e.owner);started++;notifications[e.owner]??=0;}
    if(e.type==='exit'&&active.delete(e.owner))stopped++;
    if(e.type==='tick')for(const owner of active)notifications[owner]++;
  }
  return{active:[...active].sort(),started,stopped,notifications};
}`;

const audio = String.raw`
export function solve(input){
  const {spec,asset,meters,listening}=input;const issues=[];
  if(meters.assetId!==asset.id||meters.stage!=='encoded')issues.push('final-file-evidence');
  if(typeof meters.lufs!=='number'||!Number.isFinite(meters.lufs)||Math.abs(meters.lufs-spec.lufs)>spec.tolerance)issues.push('loudness');
  if(typeof meters.truePeak!=='number'||!Number.isFinite(meters.truePeak)||meters.truePeak>spec.peakDbtp)issues.push('true-peak');
  if(asset.codec!==spec.codec||asset.rate!==spec.rate)issues.push('format');
  if(Math.abs(asset.duration-spec.duration)>0.01)issues.push('timing');
  if(listening.assetId!==asset.id)issues.push('listening-identity');
  if(!['headphones','small-speakers','mono'].every(x=>listening.contexts.includes(x)))issues.push('listening-coverage');
  if(listening.issues.length)issues.push('listening-artifacts');
  if(!input.sourcePreserved)issues.push('source-preservation');
  if(input.gainDb&&input.gainDb.some((x,i)=>i>0&&Math.abs(x-input.gainDb[i-1])>input.maxGainStepDb))issues.push('gain-jump');
  if(input.speechMusicMarginDb&&input.speechMusicMarginDb.some(x=>x<input.minSpeechMarginDb))issues.push('speech-masking');
  return{accepted:issues.length===0,issues:issues.sort(),scope:'synthetic-measurements-only'};
}`;

const permissions = String.raw`
import {posix} from 'node:path';
export function solve(input){
  function within(path,root){const resolved=posix.resolve(path);return resolved===root||resolved.startsWith(root+'/');}
  function sameOrigin(url){try{const parsed=new URL(url);return parsed.protocol==='https:'&&parsed.origin===input.origin;}catch{return false;}}
  const decisions=input.requests.map(r=>{
    let allowed=false;
    if(r.kind==='read')allowed=within(r.realPath,input.config);
    if(r.kind==='write')allowed=within(r.realPath,input.output);
    if(r.kind==='fetch')allowed=sameOrigin(r.url)&&r.redirects.every(sameOrigin);
    if(r.kind==='run')allowed=r.executable===input.git&&(['["status","--porcelain"]','["rev-parse","HEAD"]'].includes(JSON.stringify(r.args)));
    return{id:r.id,allowed};
  });
  const origin=new URL(input.origin);
  return{decisions,flags:['--no-prompt','--allow-read='+input.config,'--allow-write='+input.output,'--allow-net='+origin.hostname+':'+(origin.port||'443'),'--allow-run='+input.git].sort(),subprocessConfined:false,scope:'synthetic-policy-only'};
}`;

const definitions = [...SAFETY_PROTOCOL_CONCEPTS, ...LIFECYCLE_CONCEPTS, ...MEDIA_RUNTIME_CONCEPTS];
const solutions = [support, safeguards, edit, list, form, scope, audio, audio, permissions];
const mutants = [
  support.replace('if(!c.committed)continue;', ''),
  safeguards.replace("c.outputs.some(x=>x==='answer')", "c.outputs[0]==='answer'"),
  edit.replace(
    'state.saves.push({...state.pending})',
    'state.saves.push({...state.pending,account:state.account})',
  ),
  list.replace('keys:rows.map(r=>r.id)', 'keys:rows.map((r,i)=>String(i))'),
  form.replace('pending.clear();}', '}'),
  scope.replace("if(e.type==='tick')", "if(e.type==='open-overlay')started++;if(e.type==='tick')"),
  audio.replace('meters.truePeak>spec.peakDbtp', 'meters.samplePeak>spec.peakDbtp'),
  audio.replace("issues.push('gain-jump')", 'void 0'),
  permissions.replace("resolved.startsWith(root+'/')", 'resolved.startsWith(root)'),
];

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const packages = loadV5SkillPackages().packages;

async function materialize(definition: ConceptFixture): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'kory-concept-self-test-'));
  roots.push(root);
  const task = packages
    .find((p) => p.sidecar.name === definition.skill)!
    .evaluation.tasks.find((t) => t.id === definition.id)!;
  const scenario: SkillEvalScenarioV3 = {
    ...task,
    skill: definition.skill,
    category: 'full-task',
    expectedSelection: true,
    expectedSkills: [],
    forbiddenSkills: [],
    heldOut: true,
    adjacentSkills: [],
    tags: [],
  };
  await createConceptFixtures([definition]).materializers[0]!.materialize(root, scenario);
  return root;
}

describe('concept-first evaluation controls', () => {
  for (const [index, definition] of definitions.entries()) {
    test(`${definition.id}: red start, valid control, and plausible faulty control`, async () => {
      const root = await materialize(definition);
      const initial = scoreConceptFixture(definition, root);
      expect(initial.passed).toBe(false);
      expect(initial.integrityFailure).toBe(false);
      expect(definition.vectors().length).toBeGreaterThanOrEqual(3);
      writeFileSync(join(root, 'candidate.ts'), solutions[index]!);
      const good = scoreConceptFixture(definition, root);
      expect(good.evidence.join('\n')).not.toContain('Failed:');
      expect(good.passed).toBe(true);
      expect(good.quality).toBe(1);
      expect(mutants[index]).not.toBe(solutions[index]);
      writeFileSync(join(root, 'candidate.ts'), mutants[index]!);
      expect(scoreConceptFixture(definition, root).passed).toBe(false);
      writeFileSync(
        join(root, 'candidate.ts'),
        'export function solve(){ return {passed:true,verified:true}; }',
      );
      expect(scoreConceptFixture(definition, root).passed).toBe(false);
      // Fixed inputs are checked before any candidate execution.
      const manifest = readFileSync(join(root, 'contract.json'), 'utf8');
      writeFileSync(join(root, 'contract.json'), manifest + ' ');
      expect(scoreConceptFixture(definition, root).integrityFailure).toBe(true);
    }, 15_000);
  }

  test('missing and symlinked fixed inputs fail closed', async () => {
    const definition = definitions[0]!;
    const root = await materialize(definition);
    rmSync(join(root, 'contract.json'));
    expect(scoreConceptFixture(definition, root).integrityFailure).toBe(true);
    symlinkSync(join(root, 'README.md'), join(root, 'contract.json'));
    expect(scoreConceptFixture(definition, root).integrityFailure).toBe(true);
  });

  test('otherwise-correct results cannot excuse tampering during execution', async () => {
    const definition = definitions[0]!;
    const root = await materialize(definition);
    writeFileSync(
      join(root, 'candidate.ts'),
      `import {writeFileSync} from 'node:fs';\nwriteFileSync('contract.json','{}');\n${support}`,
    );
    const result = scoreConceptFixture(definition, root);
    expect(result.integrityFailure).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.quality).toBe(0);
  });

  test('a candidate that never returns is bounded and cannot pass', async () => {
    const definition = definitions[0]!;
    const root = await materialize(definition);
    writeFileSync(join(root, 'candidate.ts'), 'export function solve(){ while(true){} }');
    const result = scoreConceptFixture(definition, root);
    expect(result.passed).toBe(false);
    expect(result.quality).toBe(0);
  }, 10_000);

  test('remaining concepts are registered, while six component-only tasks retain full-task gates', async () => {
    const wanted = new Set(
      definitions
        .filter((d) => d.id !== 'bun-deno-runtime-full-task-2-individual')
        .map((d) => d.id),
    );
    const rows = auditSkillEvalExecutionReadiness(
      packages,
      BUILTIN_SKILL_EVAL_MATERIALIZERS,
      BUILTIN_SKILL_EVAL_SCORERS,
    ).filter((r) => wanted.has(r.scenarioId));
    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.materializerId && r.deterministicScorerId)).toBe(true);
    expect(rows.filter((r) => r.ready)).toHaveLength(2);
    expect(
      rows
        .filter((r) => !r.ready)
        .every((r) => r.reasons.some((reason) => reason.startsWith('Component'))),
    ).toBe(true);
    const definition = definitions.find((d) => d.blockers?.length)!;
    let executed = false;
    await expect(
      runPairedSkillEvaluationV3({
        projectRoot: process.cwd(),
        skillPackage: packages.find((p) => p.sidecar.name === definition.skill)!,
        scenarioId: definition.id,
        skillRevisionHash: 'f'.repeat(64),
        harnessVersion: 'component-gate-self-test',
        materializers: BUILTIN_SKILL_EVAL_MATERIALIZERS,
        scorers: BUILTIN_SKILL_EVAL_SCORERS,
        executor: {
          id: 'must-not-run',
          subject: 'other',
          provider: 'synthetic',
          model: 'no-op',
          runtimeIdentity: 'self-test',
          tools: [],
          budget: { wallClockMs: 1000 },
          execute: async () => {
            executed = true;
            return { output: '', evidence: [], artifacts: [], durationMs: 0 };
          },
        },
      }),
    ).rejects.toThrow('Component');
    expect(executed).toBe(false);
  });
});
