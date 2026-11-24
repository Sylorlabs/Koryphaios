import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { writeFixtureFile } from './skill-eval-fixture-helpers';
import { hostOS, openssl3ExecutableCandidates } from '../../runtime/platform';

export const DENO_PERMISSION_SCENARIO = 'bun-deno-runtime-full-task-2-individual';
export const DENO_PERMISSION_VERSION = '2.9.6';
const localBinary = resolve(
  import.meta.dir,
  '../../../../.koryphaios/eval-tools/deno',
  DENO_PERMISSION_VERSION,
  'deno',
);
export function denoEvalBinary(): string {
  return process.env.KORY_EVAL_DENO ?? (existsSync(localBinary) ? localBinary : 'deno');
}
/** Select only an observed OpenSSL 3 executable; no version-label substitution. */
function denoOpenSSL3(): string {
  for (const binary of openssl3ExecutableCandidates()) {
    const observed = spawnSync(binary, ['version'], {
      encoding: 'utf8',
      timeout: 2_000,
      env: environment(),
    });
    if (observed.status === 0 && observed.stdout.startsWith('OpenSSL 3.')) return binary;
  }
  return 'openssl'; // Readiness will reject a missing or incompatible executable.
}
let loopbackProbe: { key: string; at: number; error: string | null } | null = null;

/** Actual HTTPS controls need a bindable loopback socket, not only binaries. */
function loopbackAvailability(): string | null {
  const key = JSON.stringify([process.execPath, process.env.PATH]);
  if (loopbackProbe?.key === key && Date.now() - loopbackProbe.at < 60_000)
    return loopbackProbe.error;
  const probe = spawnSync(
    process.execPath,
    [
      '-e',
      `
    const net = require('node:net');
    const server = net.createServer();
    server.once('error', (error) => { console.error(error.code || error.message); process.exit(2); });
    server.listen(0, '127.0.0.1', () => server.close(() => process.exit(0)));
  `,
    ],
    { encoding: 'utf8', timeout: 2_000, env: environment() },
  );
  const error =
    probe.status === 0
      ? null
      : `Deno permission fixture requires bindable local loopback HTTPS: ${(probe.error?.message ?? probe.stderr ?? probe.signal ?? `exit ${probe.status}`).trim().slice(0, 160)}`;
  loopbackProbe = { key, at: Date.now(), error };
  return error;
}
const environment = () => ({
  PATH: process.env.PATH ?? '',
  LANG: 'C',
  NO_COLOR: '1',
  DENO_NO_UPDATE_CHECK: '1',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
});
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const failure = (evidence: string[], integrityFailure = false): SkillEvalDeterministicScore => ({
  passed: false,
  quality: 0,
  verification: 0,
  integrityFailure,
  evidence,
});

/** Runtime pins are experiment inputs, not a recommendation for every project. */
export function denoPermissionReadiness(
  probe?: (tool: string) => string,
  platform: string = hostOS(),
): string[] {
  const live = !probe;
  const observed =
    probe ??
    ((tool: string) => {
      const result = spawnSync(
        tool === 'deno' ? denoEvalBinary() : tool === 'openssl' ? denoOpenSSL3() : tool,
        tool === 'openssl' ? ['version'] : ['--version'],
        { encoding: 'utf8', timeout: 2_000, env: environment() },
      );
      return result.status === 0 ? result.stdout.trim().split('\n')[0]! : 'unavailable';
    });
  const reasons: string[] = [];
  if (!['darwin', 'linux'].includes(platform))
    reasons.push('Deno permission fixture currently requires POSIX paths and local Git.');
  const version = observed('deno');
  if (!version.startsWith(`deno ${DENO_PERMISSION_VERSION} `))
    reasons.push(
      `Deno permission fixture requires Deno ${DENO_PERMISSION_VERSION}; observed ${version}.`,
    );
  if (!observed('git').startsWith('git version '))
    reasons.push('Deno permission fixture requires Git for actual read-only subprocess checks.');
  if (!observed('openssl').startsWith('OpenSSL 3.'))
    reasons.push(
      'Deno permission fixture requires OpenSSL 3 for an ephemeral loopback TLS certificate.',
    );
  if (live && reasons.length === 0) {
    const loopbackError = loopbackAvailability();
    if (loopbackError) reasons.push(loopbackError);
  }
  return reasons;
}

// Preserved Node-origin implementation: functional happy paths, ambient authority and
// unsafe redirect/path/argument assumptions. The candidate must actually port this code.
const nodeOrigin = String.raw`import {readFile,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import process from 'node:process';
const run=promisify(execFile);
export function permissions(){return ['--allow-all'];}
export async function execute(request,context){try{
  if(process.env.MAINTENANCE_DISABLED==='1')throw new Error('Disabled by ambient environment');
  if(request.kind==='read')return {ok:true,value:await readFile(request.path,'utf8')};
  if(request.kind==='write'){await writeFile(request.path,request.text);return {ok:true,value:null};}
  if(request.kind==='fetch')return {ok:true,value:await (await fetch(request.url)).text()};
  if(request.kind==='git')return {ok:true,value:(await run(context.git,request.args,{cwd:context.repoRoot})).stdout};
  throw new Error('Unsupported request');
}catch(error){return {ok:false,error:error.message||String(error)};}}
`;
const fixedFiles: Record<string, string> = {
  'reference/node-maintenance.mjs': nodeOrigin,
  '.deno-version': `${DENO_PERMISSION_VERSION}\n`,
  'deno.json': json({ compilerOptions: { strict: true }, imports: {} }),
  'README.md': `# Deno maintenance-script permission boundary\n\nImplement permissions(context) and async execute(request, context) in candidate.mjs. Both exports are real executable code. context supplies canonical configRoot, outputRoot, repoRoot, apiOrigin and the exact Git executable. No dependency installation is needed.\n\npermissions is evaluated before any permission exists, in a process that grants no filesystem or network access, so it must build its answer purely from the supplied context strings; calling a filesystem API such as Deno.realPathSync inside it throws and fails the policy check. permissions returns --no-prompt and narrowly scoped --allow-read=configRoot and outputRoot, --allow-write=outputRoot, --allow-net=the API host:port, and --allow-run=the Git executable. Deno resolves a write target through its parent directory, so the output root must also be readable; a set without it cannot create the file. Order and spelling of equivalent grants are irrelevant: one --allow-read=configRoot,outputRoot and one flag per path grant the same access, and the evaluator compares the granted path sets. Blanket, extra and missing grants fail. The evaluator supplies --cert for its private loopback HTTPS CA; never disable TLS verification.\n\nRequests are {kind:read,path}, {kind:write,path,text}, {kind:fetch,url}, or {kind:git,args}. Return {ok:true,value} on success, or {ok:false,error} with a useful nonempty error. read returns file text. write creates the requested output file and returns null. fetch returns response text, accepts only the declared HTTPS origin, follows same-origin redirects within a finite bound, and rejects other origins and credentials. git accepts only [status,--porcelain] and [rev-parse,HEAD], runs in repoRoot with a clean environment, and returns stdout. All other requests are denied.\n\nFor this fixture outputRoot is evaluator-created and contains no pre-existing symlinks; its parent is not writable by the script. Config includes a symlink escaping its root: scoped Deno reads alone do not enforce the intended canonical-root policy. Reject that path before reading its target. Path-prefix lookalikes and parent traversal are not children. Handle denied access explicitly without widening permissions. Internal implementation is unrestricted within this interface.\n\nVerification uses actual Deno, temporary files, a disposable Git repository, ephemeral HTTPS servers, a runtime-denial probe independent of candidate code, and evaluator-owned side-effect checks. Source/config pins and this contract are fixed. Keep subprocess confinement separate: --allow-run limits executables, not Git arguments or child OS authority. This evaluates an audited maintenance script; it is NOT a hostile-code OS sandbox or a proof against concurrent filesystem replacement. Do not claim model uplift from evaluator self-tests.\n`,
};
const starter = nodeOrigin;

// These runners never include expected answers. Candidate output is compared in the parent.
const policyRunner = `import {permissions} from './candidate.mjs';\nconst input=JSON.parse(await new Response(Deno.stdin.readable).text());\nconsole.log(JSON.stringify(await permissions(input)));\n`;
const executeRunner = `import {execute} from './candidate.mjs';\nconst input=JSON.parse(await new Response(Deno.stdin.readable).text());\nconsole.log(JSON.stringify(await execute(input.request,input.context)));\n`;
const rawDenialRunner = `const input=JSON.parse(await new Response(Deno.stdin.readable).text());
const results=[];
for(const request of input){try{
  if(request.kind==='read')await Deno.readTextFile(request.path);
  if(request.kind==='write')await Deno.writeTextFile(request.path,'UNAUTHORIZED');
  if(request.kind==='fetch')await fetch(request.url);
  if(request.kind==='run')await new Deno.Command(request.executable,{args:['-c','exit 0']}).output();
  if(request.kind==='env')Deno.env.get('KORY_SYNTHETIC_CANARY');
  results.push({id:request.id,denied:false});
}catch(error){results.push({id:request.id,denied:error instanceof Deno.errors.NotCapable});}}
console.log(JSON.stringify(results));
`;

function regularText(root: string, path: string): string | null {
  try {
    if (!lstatSync(root).isDirectory()) return null;
    let current = root;
    for (const part of path.split('/')) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) return null;
    }
    return lstatSync(current).isFile() ? readFileSync(current, 'utf8') : null;
  } catch {
    return null;
  }
}
function reportSafe(root: string): boolean {
  for (const path of ['.kory-eval', '.kory-eval/deno-runtime-evidence.json']) {
    try {
      const stat = lstatSync(join(root, path));
      if (path === '.kory-eval' ? !stat.isDirectory() : !stat.isFile()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
  }
  return true;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
async function command(
  root: string,
  tool: string,
  args: string[],
  input = '',
  extraEnv: Record<string, string> = {},
  timeoutMs = 2_000,
): Promise<CommandResult> {
  return await new Promise((done) => {
    const child = spawn(tool, args, {
      cwd: root,
      env: { ...environment(), DENO_DIR: join(root, '.deno-cache'), ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    let stdout = '',
      stderr = '',
      timedOut = false,
      settled = false;
    const kill = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* Own group already exited. */
        }
      }
    };
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      kill();
      done({ code, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
      finish(null);
    }, timeoutMs);
    const collect = (kind: 'stdout' | 'stderr', chunk: Buffer) => {
      if (kind === 'stdout') stdout += chunk.toString();
      else stderr += chunk.toString();
      if (stdout.length + stderr.length > 128_000) {
        stderr = 'Output limit exceeded';
        kill();
        finish(null);
      }
    };
    child.stdout.on('data', (chunk) => collect('stdout', chunk));
    child.stderr.on('data', (chunk) => collect('stderr', chunk));
    child.on('error', (error) => {
      stderr = error.message;
      finish(null);
    });
    child.on('close', (code) => finish(code));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
function parsed(result: CommandResult): unknown {
  if (result.code !== 0 || result.timedOut) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}
async function listen(server: Server): Promise<string> {
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      done();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback listener address');
  return `https://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
}

export async function scoreDenoPermissions(root: string): Promise<SkillEvalDeterministicScore> {
  const prerequisites = denoPermissionReadiness();
  if (prerequisites.length) return failure(prerequisites);
  const candidate = regularText(root, 'candidate.mjs');
  const intact = () =>
    candidate !== null &&
    regularText(root, 'candidate.mjs') === candidate &&
    Object.entries(fixedFiles).every(([path, text]) => regularText(root, path) === text);
  if (!intact() || !reportSafe(root))
    return failure(
      ['Changed, missing or symlinked source/config/report path; no candidate executed.'],
      true,
    );
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'kory-deno-runtime-')));
  const servers: Server[] = [];
  const checks: Array<{ name: string; passed: boolean; detail?: string }> = [];
  let flags: string[] = [];
  const versions = { deno: DENO_PERMISSION_VERSION, git: '', openssl: '' };
  let requestLedger: string[] = [];
  const check = (name: string, passed: boolean, detail?: string) => {
    checks.push({ name, passed, ...(detail ? { detail } : {}) });
    return passed;
  };
  const persist = (): SkillEvalDeterministicScore => {
    const integrity = intact();
    if (!reportSafe(root))
      return failure(['Unsafe report path; no evaluator report written.'], true);
    const passed = integrity && checks.length > 0 && checks.every((row) => row.passed);
    writeFixtureFile(
      root,
      '.kory-eval/deno-runtime-evidence.json',
      json({
        evidenceKind: 'actual-local-runtime',
        versions,
        flags,
        checks,
        requestLedger,
        passed,
        integrity,
        sourceSha256: createHash('sha256').update(candidate!).digest('hex'),
        limits: [
          'Loopback HTTPS and disposable Git/files only',
          'Deno flags do not confine subprocess OS authority or symlink targets',
          'No hostile-code sandbox, concurrent-path-race guarantee, model uplift or blind qualification',
        ],
      }),
    );
    return {
      passed,
      quality: passed ? 1 : 0,
      verification: passed ? 1 : 0,
      integrityFailure: !integrity,
      evidence: checks.map(
        (row) =>
          `${row.name}: ${row.passed ? 'pass' : 'fail'}${row.detail ? ` (${row.detail})` : ''}`,
      ),
    };
  };
  try {
    for (const name of ['config', 'output', 'config-other', 'repository', 'tls'])
      mkdirSync(join(work, name));
    writeFixtureFile(work, 'candidate.mjs', candidate!);
    writeFixtureFile(work, 'policy.mjs', policyRunner);
    writeFixtureFile(work, 'execute.mjs', executeRunner);
    writeFixtureFile(work, 'raw-denial.mjs', rawDenialRunner);
    const git = Bun.which('git');
    if (!git) throw new Error('Git disappeared after readiness check');
    versions.git = (await command(work, git, ['--version'])).stdout.trim();
    const openssl = denoOpenSSL3();
    versions.openssl = (await command(work, openssl, ['version'])).stdout.trim();
    const cert = await command(work, openssl, [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-nodes',
      '-keyout',
      'tls/key.pem',
      '-out',
      'tls/cert.pem',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-addext',
      'basicConstraints=critical,CA:FALSE',
      '-addext',
      'extendedKeyUsage=serverAuth',
    ]);
    if (
      !check(
        'ephemeral trusted TLS certificate',
        cert.code === 0,
        cert.code === 0 ? undefined : cert.stderr,
      )
    )
      return persist();
    const tls = {
      key: readFileSync(join(work, 'tls/key.pem')),
      cert: readFileSync(join(work, 'tls/cert.pem')),
    };
    const secret = randomUUID(),
      response = `api-${randomUUID()}`,
      configText = `configuration-${randomUUID()}`;
    const second = createServer(tls, (req, res) => {
      requestLedger.push(`forbidden:${req.url}`);
      res.end(secret);
    });
    servers.push(second);
    const forbiddenOrigin = await listen(second);
    const first = createServer(tls, (req, res) => {
      requestLedger.push(`allowed:${req.url}`);
      if (req.url === '/redirect-out') {
        res.writeHead(302, { location: `${forbiddenOrigin}/secret` });
        res.end();
      } else if (req.url === '/redirect-in') {
        res.writeHead(302, { location: '/value' });
        res.end();
      } else if (req.url === '/loop') {
        res.writeHead(302, { location: '/loop' });
        res.end();
      } else {
        res.end(response);
      }
    });
    servers.push(first);
    const apiOrigin = await listen(first);
    const context = {
      configRoot: join(work, 'config'),
      outputRoot: join(work, 'output'),
      repoRoot: join(work, 'repository'),
      apiOrigin,
      git,
    };
    writeFixtureFile(work, 'config/settings.txt', configText);
    writeFixtureFile(work, 'config-other/private.txt', secret);
    symlinkSync(join(work, 'config-other/private.txt'), join(work, 'config/escape.txt'));
    for (const args of [
      ['init', '--quiet'],
      [
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'user.name=Fixture',
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '--allow-empty',
        '--quiet',
        '-m',
        'fixture',
      ],
    ]) {
      const result = await command(context.repoRoot, git, args);
      if (
        !check(
          `isolated Git ${args.at(-1)}`,
          result.code === 0,
          result.code === 0 ? undefined : result.stderr,
        )
      )
        return persist();
    }
    const revision = (await command(context.repoRoot, git, ['rev-parse', 'HEAD'])).stdout;
    const bare = [
      'run',
      '--no-config',
      '--no-lock',
      '--no-npm',
      '--cached-only',
      '--deny-import',
      '--no-prompt',
    ];
    const policyResult = await command(
      work,
      denoEvalBinary(),
      [...bare, 'policy.mjs'],
      json(context),
    );
    const proposed = parsed(policyResult);
    // Deno resolves a write target through its parent directory, so creating a file also
    // needs read access to that directory. The contract states this, and the comparison
    // below is on the granted path sets, not on flag spelling, because
    // `--allow-read=a,b` and one flag per path are equivalent grants.
    const requiredGrants = {
      read: [context.configRoot, context.outputRoot].sort(),
      write: [context.outputRoot],
      net: [new URL(apiOrigin).host],
      run: [git],
    };
    const parseGrants = (flags: readonly unknown[]) => {
      const grants: Record<string, string[]> = { read: [], write: [], net: [], run: [] };
      let sawNoPrompt = false;
      for (const flag of flags) {
        if (typeof flag !== 'string') return null;
        if (flag === '--no-prompt') {
          sawNoPrompt = true;
          continue;
        }
        const granted = /^--allow-(read|write|net|run)=(\S.*)$/u.exec(flag);
        if (!granted) return null;
        const [, kind, value] = granted as unknown as [string, string, string];
        for (const entry of value.split(','))
          if (entry.trim()) grants[kind] = [...(grants[kind] ?? []), entry.trim()];
      }
      if (!sawNoPrompt) return null;
      return {
        read: [...(grants.read ?? [])].sort(),
        write: [...(grants.write ?? [])].sort(),
        net: [...(grants.net ?? [])].sort(),
        run: [...(grants.run ?? [])].sort(),
      };
    };
    const proposedGrants = Array.isArray(proposed) ? parseGrants(proposed) : null;
    if (
      !check(
        'least-privilege invocation',
        !!proposedGrants &&
          Object.entries(requiredGrants).every(([kind, paths]) =>
            isDeepStrictEqual(proposedGrants[kind as keyof typeof requiredGrants], paths),
          ),
        policyResult.timedOut
          ? 'bounded policy timeout'
          : `proposed grants: ${JSON.stringify(proposed)?.slice(0, 400)}`,
      )
    )
      return persist();
    flags = proposed as string[];
    const invocation = [
      ...bare.filter((value) => value !== '--no-prompt'),
      ...flags,
      '--cert',
      join(work, 'tls/cert.pem'),
    ];
    const forbiddenPath = join(work, 'config-other/private.txt');
    const rawRequests = [
      { id: 'read-sibling', kind: 'read', path: forbiddenPath },
      { id: 'write-sibling', kind: 'write', path: forbiddenPath },
      { id: 'other-origin', kind: 'fetch', url: `${forbiddenOrigin}/secret` },
      { id: 'other-executable', kind: 'run', executable: '/bin/sh' },
      { id: 'environment', kind: 'env' },
    ];
    const raw = await command(
      work,
      denoEvalBinary(),
      [...invocation, 'raw-denial.mjs'],
      json(rawRequests),
    );
    if (
      !check(
        'independent runtime permission denials',
        isDeepStrictEqual(
          parsed(raw),
          rawRequests.map(({ id }) => ({ id, denied: true })),
        ),
        raw.code === 0 ? undefined : raw.stderr,
      )
    )
      return persist();
    const invoke = async (name: string, request: object, expected?: unknown, denied = false) => {
      const result = await command(
        work,
        denoEvalBinary(),
        [...invocation, 'execute.mjs'],
        json({ request, context }),
        { GIT_DIR: join(work, 'deliberately-invalid-inherited-git-dir') },
      );
      const value = parsed(result) as { ok?: unknown; error?: unknown } | null;
      return check(
        name,
        denied
          ? !!value &&
              value.ok === false &&
              typeof value.error === 'string' &&
              value.error.trim().length > 0
          : isDeepStrictEqual(value, { ok: true, value: expected }),
        result.timedOut
          ? 'bounded execution timeout'
          : result.code !== 0
            ? result.stderr.slice(-500)
            : !denied && typeof value?.error === 'string'
              ? value.error.slice(-500)
              : undefined,
      );
    };
    if (
      !(await invoke(
        'allowed config read',
        { kind: 'read', path: join(context.configRoot, 'settings.txt') },
        configText,
      ))
    )
      return persist();
    const written = `output-${randomUUID()}`;
    if (
      !(await invoke(
        'allowed output write',
        { kind: 'write', path: join(context.outputRoot, 'report.txt'), text: written },
        null,
      ))
    )
      return persist();
    if (
      !check('output independently read back', regularText(work, 'output/report.txt') === written)
    )
      return persist();
    if (
      !(await invoke(
        'actual HTTPS response',
        { kind: 'fetch', url: `${apiOrigin}/value` },
        response,
      ))
    )
      return persist();
    if (
      !(await invoke(
        'same-origin redirect',
        { kind: 'fetch', url: `${apiOrigin}/redirect-in` },
        response,
      ))
    )
      return persist();
    if (
      !(await invoke(
        'read-only Git status with clean environment',
        { kind: 'git', args: ['status', '--porcelain'] },
        '',
      ))
    )
      return persist();
    if (
      !(await invoke(
        'read-only Git revision',
        { kind: 'git', args: ['rev-parse', 'HEAD'] },
        revision,
      ))
    )
      return persist();
    const deniedCases: Array<[string, object]> = [
      ['path-prefix sibling', { kind: 'read', path: forbiddenPath }],
      [
        'parent traversal',
        { kind: 'read', path: `${context.configRoot}/../config-other/private.txt` },
      ],
      [
        'symlink target escapes root',
        { kind: 'read', path: join(context.configRoot, 'escape.txt') },
      ],
      ['write outside output', { kind: 'write', path: forbiddenPath, text: 'UNAUTHORIZED' }],
      ['second HTTPS origin', { kind: 'fetch', url: `${forbiddenOrigin}/secret` }],
      ['cross-origin redirect', { kind: 'fetch', url: `${apiOrigin}/redirect-out` }],
      ['HTTP downgrade', { kind: 'fetch', url: apiOrigin.replace('https:', 'http:') + '/value' }],
      [
        'URL credentials',
        { kind: 'fetch', url: apiOrigin.replace('https://', 'https://user:pass@') + '/value' },
      ],
      ['bounded redirect loop', { kind: 'fetch', url: `${apiOrigin}/loop` }],
      [
        'Git configuration mutation',
        { kind: 'git', args: ['config', '--local', 'kory.fixture', 'mutated'] },
      ],
      [
        'Git argument injection',
        { kind: 'git', args: ['-c', 'core.bare=true', 'status', '--porcelain'] },
      ],
      ['unknown request', { kind: 'shell', args: ['echo', 'no'] }],
    ];
    for (const [name, request] of deniedCases)
      if (!(await invoke(name, request, undefined, true))) return persist();
    check('protected file unchanged', regularText(work, 'config-other/private.txt') === secret);
    check(
      'forbidden server never contacted',
      requestLedger.every((entry) => !entry.startsWith('forbidden:')),
    );
    check(
      'allowed requests actually observed',
      requestLedger.includes('allowed:/value') && requestLedger.includes('allowed:/redirect-in'),
    );
    const gitValue = await command(context.repoRoot, git, [
      'config',
      '--local',
      '--get',
      'kory.fixture',
    ]);
    check('no Git configuration mutation', gitValue.code === 1 && gitValue.stdout === '');
    check(
      'candidate source unchanged during evaluation',
      regularText(work, 'candidate.mjs') === candidate,
    );
    return persist();
  } catch (error) {
    check(
      'runtime harness completed',
      false,
      error instanceof Error ? error.message : String(error),
    );
    return persist();
  } finally {
    for (const server of servers) await close(server);
    rmSync(work, { recursive: true, force: true });
  }
}

export const DENO_RUNTIME_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  {
    id: 'bun-deno-runtime/actual-deno-permissions@3',
    get readinessBlockers() {
      return denoPermissionReadiness();
    },
    matches: (scenario) => scenario.id === DENO_PERMISSION_SCENARIO,
    materialize: (root) => {
      for (const [path, text] of Object.entries(fixedFiles)) writeFixtureFile(root, path, text);
      writeFixtureFile(root, 'candidate.mjs', starter);
    },
  },
];
export const DENO_RUNTIME_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  {
    id: 'bun-deno-runtime/actual-deno-permissions-scorer@3',
    scenarioIds: [DENO_PERMISSION_SCENARIO],
    score: ({ workingDirectory }) => scoreDenoPermissions(workingDirectory),
  },
];
