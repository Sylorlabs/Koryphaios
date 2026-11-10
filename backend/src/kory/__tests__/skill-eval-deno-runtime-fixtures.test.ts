import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DENO_PERMISSION_SCENARIO,
  DENO_PERMISSION_VERSION,
  DENO_RUNTIME_SKILL_EVAL_MATERIALIZERS,
  denoPermissionReadiness,
  scoreDenoPermissions,
} from '../skill-eval-deno-runtime-fixtures';
import { loadV5SkillPackages } from '../skill-packages';
import { auditSkillEvalExecutionReadiness } from '../skill-eval-execution';
import {
  BUILTIN_SKILL_EVAL_MATERIALIZERS,
  BUILTIN_SKILL_EVAL_SCORERS,
} from '../skill-eval-fixtures';
import type { SkillEvalScenarioV3 } from '../skill-eval-harness';

// Author-owned controls validate the evaluator; they are not model runs or blind qualification.
// Never materialize the positive control into an evaluation subject's workspace.
const control = String.raw`import {resolve} from 'node:path';
export function permissions(c){
  return ['--no-prompt','--allow-read='+c.configRoot+','+c.outputRoot,'--allow-write='+c.outputRoot,'--allow-net='+new URL(c.apiOrigin).host,'--allow-run='+c.git];
}
function inside(path,root){return path===root||path.startsWith(root+'/');}
function requireAllowed(allowed){if(!allowed)throw new Error('Outside the declared capability');}
export async function execute(request,c){try{
  if(request.kind==='read'){
    const logical=resolve(request.path);requireAllowed(inside(logical,c.configRoot));
    const canonical=await Deno.realPath(logical);requireAllowed(inside(canonical,c.configRoot));
    return {ok:true,value:await Deno.readTextFile(canonical)};
  }
  if(request.kind==='write'){
    const path=resolve(request.path);requireAllowed(inside(path,c.outputRoot));
    await Deno.writeTextFile(path,request.text);return {ok:true,value:null};
  }
  if(request.kind==='fetch'){
    let url=new URL(request.url);
    for(let hop=0;hop<5;hop++){
      requireAllowed(url.protocol==='https:'&&url.origin===c.apiOrigin&&!url.username&&!url.password);
      const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(1000)});
      if([301,302,303,307,308].includes(response.status)){
        const location=response.headers.get('location');await response.body?.cancel();
        requireAllowed(!!location);url=new URL(location,url);continue;
      }
      requireAllowed(response.ok);return {ok:true,value:await response.text()};
    }
    throw new Error('Redirect limit exceeded');
  }
  if(request.kind==='git'){
    requireAllowed(['["status","--porcelain"]','["rev-parse","HEAD"]'].includes(JSON.stringify(request.args)));
    const result=await new Deno.Command(c.git,{args:request.args,cwd:c.repoRoot,clearEnv:true,env:{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0'},stdout:'piped',stderr:'piped'}).output();
    requireAllowed(result.success);return {ok:true,value:new TextDecoder().decode(result.stdout)};
  }
  throw new Error('Unsupported request');
}catch(error){return {ok:false,error:(error.message||String(error))+(error.cause?' / '+String(error.cause):'')};}}
`;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const packages = loadV5SkillPackages().packages;
const task = packages
  .find((p) => p.sidecar.name === 'bun-deno-runtime')!
  .evaluation.tasks.find((t) => t.id === DENO_PERMISSION_SCENARIO)!;
const scenario: SkillEvalScenarioV3 = {
  ...task,
  skill: 'bun-deno-runtime',
  category: 'full-task',
  expectedSelection: true,
  expectedSkills: [],
  forbiddenSkills: [],
  heldOut: true,
  adjacentSkills: [],
  tags: [],
};
const prerequisites = denoPermissionReadiness();
const runtimeTest = test.skipIf(prerequisites.length > 0);
async function fixture(source?: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'kory-deno-control-'));
  roots.push(root);
  await DENO_RUNTIME_SKILL_EVAL_MATERIALIZERS[0]!.materialize(root, scenario);
  if (source) writeFileSync(join(root, 'candidate.mjs'), source);
  return root;
}

describe('actual Deno permission evaluator', () => {
  test('one runtime registration replaces the policy-only scenario', () => {
    expect(BUILTIN_SKILL_EVAL_MATERIALIZERS.filter((m) => m.matches(scenario))).toHaveLength(1);
    expect(
      BUILTIN_SKILL_EVAL_SCORERS.filter((s) => s.scenarioIds.includes(scenario.id)),
    ).toHaveLength(1);
    const row = auditSkillEvalExecutionReadiness(
      packages.filter((p) => p.sidecar.name === 'bun-deno-runtime'),
      BUILTIN_SKILL_EVAL_MATERIALIZERS,
      BUILTIN_SKILL_EVAL_SCORERS,
    ).find((r) => r.scenarioId === scenario.id)!;
    expect(row.materializerId).toBe('bun-deno-runtime/actual-deno-permissions@3');
    expect(row.ready).toBe(prerequisites.length === 0);
    expect(row.reasons).toEqual(prerequisites);
  }, 30_000);
  test('missing runtime and supporting tools remain explicit gates', () => {
    const exact = (tool: string) =>
      ({
        deno: `deno ${DENO_PERMISSION_VERSION} (stable)`,
        git: 'git version 2.50.0',
        openssl: 'OpenSSL 3.6.3',
      })[tool]!;
    expect(denoPermissionReadiness(exact, 'darwin')).toEqual([]);
    expect(denoPermissionReadiness(exact, 'win32').join(' ')).toContain('POSIX');
    expect(denoPermissionReadiness(() => 'unavailable', 'linux')).toHaveLength(3);
    expect(
      denoPermissionReadiness(
        (tool) => (tool === 'deno' ? 'deno 0.0.0 (wrong)' : exact(tool)),
        'linux',
      ),
    ).toHaveLength(1);
  });
  runtimeTest(
    'broken start rejects blanket permissions before task execution',
    async () => {
      const result = await scoreDenoPermissions(await fixture());
      expect(result.passed).toBe(false);
      expect(result.integrityFailure).toBe(false);
      expect(
        result.evidence.some((line) => line.startsWith('least-privilege invocation: fail')),
      ).toBe(true);
    },
    15_000,
  );
  runtimeTest(
    'valid control exercises actual files, HTTPS, redirects, runtime denies and Git',
    async () => {
      const root = await fixture(control);
      const result = await scoreDenoPermissions(root);
      expect(result.passed, result.evidence.join('\n')).toBe(true);
      expect(result.integrityFailure).toBe(false);
      const evidence = JSON.parse(
        readFileSync(join(root, '.kory-eval/deno-runtime-evidence.json'), 'utf8'),
      );
      expect(evidence.evidenceKind).toBe('actual-local-runtime');
      expect(evidence.versions.deno).toBe(DENO_PERMISSION_VERSION);
      expect(evidence.sourceSha256).toHaveLength(64);
      expect(evidence.requestLedger.some((entry: string) => entry.startsWith('forbidden:'))).toBe(
        false,
      );
      expect(result.evidence).toContain('independent runtime permission denials: pass');
      expect(result.evidence).toContain('symlink target escapes root: pass');
      expect(result.evidence).toContain('no Git configuration mutation: pass');
    },
    15_000,
  );
  runtimeTest(
    'semantically equivalent permission ordering is accepted',
    async () => {
      const reordered = control.replace(
        "'--allow-run='+c.git];",
        "'--allow-run='+c.git].reverse();",
      );
      expect(reordered).not.toBe(control);
      const result = await scoreDenoPermissions(await fixture(reordered));
      expect(result.passed, result.evidence.join('\n')).toBe(true);
    },
    15_000,
  );
  runtimeTest(
    'Node-compatible filesystem APIs satisfy the same behavioral contract',
    async () => {
      const alternative =
        "import {readFile,writeFile} from 'node:fs/promises';\n" +
        control
          .replace('await Deno.readTextFile(canonical)', "await readFile(canonical,'utf8')")
          .replace(
            'await Deno.writeTextFile(path,request.text)',
            'await writeFile(path,request.text)',
          );
      const result = await scoreDenoPermissions(await fixture(alternative));
      expect(result.passed, result.evidence.join('\n')).toBe(true);
    },
    15_000,
  );
  for (const [name, before, after, rejectedAt] of [
    [
      'symlink policy bypass',
      'const canonical=await Deno.realPath(logical);requireAllowed(inside(canonical,c.configRoot));',
      'const canonical=logical;',
      'symlink target escapes root',
    ],
    [
      'inherited Git environment',
      'clearEnv:true',
      'clearEnv:false',
      'read-only Git status with clean environment',
    ],
    [
      'wrong Git argument authority',
      'requireAllowed([\'["status","--porcelain"]\',\'["rev-parse","HEAD"]\'].includes(JSON.stringify(request.args)));',
      '',
      'Git configuration mutation',
    ],
    [
      'fake write success',
      'await Deno.writeTextFile(path,request.text);',
      '',
      'output independently read back',
    ],
  ]) {
    runtimeTest(
      `rejects ${name}`,
      async () => {
        expect(control).toContain(before!);
        const result = await scoreDenoPermissions(await fixture(control.replace(before!, after!)));
        expect(result.passed).toBe(false);
        expect(
          result.evidence.some((line) => line.startsWith(`${rejectedAt}: fail`)),
          result.evidence.join('\n'),
        ).toBe(true);
      },
      15_000,
    );
  }
  runtimeTest(
    'refuse-everything cannot pass utility controls',
    async () => {
      const source = control.replace(
        'export async function execute(request,c){try{',
        'export async function execute(request,c){return {ok:false,error:"Refused"};try{',
      );
      const result = await scoreDenoPermissions(await fixture(source));
      expect(result.evidence.some((line) => line.startsWith('allowed config read: fail'))).toBe(
        true,
      );
      expect(result.passed).toBe(false);
      expect(result.verification).toBe(0);
    },
    15_000,
  );
  runtimeTest(
    'nontermination is bounded and never earns verification',
    async () => {
      const source = control.replace(
        'export async function execute(request,c){try{',
        'export async function execute(request,c){while(true){};try{',
      );
      const result = await scoreDenoPermissions(await fixture(source));
      expect(result.passed).toBe(false);
      expect(result.verification).toBe(0);
      expect(result.evidence.join('\n')).toContain('bounded execution timeout');
    },
    15_000,
  );
  runtimeTest(
    'fixed-file and report-path tampering fail without following symlinks',
    async () => {
      const changed = await fixture(control);
      writeFileSync(join(changed, '.deno-version'), 'other');
      expect((await scoreDenoPermissions(changed)).integrityFailure).toBe(true);
      const root = await fixture(control),
        target = mkdtempSync(join(tmpdir(), 'kory-deno-preserve-'));
      roots.push(target);
      writeFileSync(join(target, 'deno-runtime-evidence.json'), 'preserve');
      symlinkSync(target, join(root, '.kory-eval'));
      expect((await scoreDenoPermissions(root)).integrityFailure).toBe(true);
      expect(readFileSync(join(target, 'deno-runtime-evidence.json'), 'utf8')).toBe('preserve');
      const linked = await fixture(control);
      rmSync(join(linked, 'candidate.mjs'));
      symlinkSync(join(linked, 'README.md'), join(linked, 'candidate.mjs'));
      expect((await scoreDenoPermissions(linked)).integrityFailure).toBe(true);
    },
    15_000,
  );
});
