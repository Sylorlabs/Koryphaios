import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { writeFixtureFile } from './skill-eval-fixture-helpers';

export const BUN_MIGRATION_SCENARIO = 'bun-deno-runtime-full-task-1-individual';
export const BUN_MIGRATION_VERSIONS = { bun: '1.3.14', node: 'v26.8.1', npm: '11.19.0' } as const;
const PACKAGE_NAME = '@kory-eval/migration-cli';
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const environment = () => ({ PATH: process.env.PATH ?? '', LANG: 'C', NO_COLOR: '1', CI: '1' });

/** The pins belong to this experiment, not to the reusable skill's preferred versions. */
export function bunMigrationReadiness(
  probe = (runtime: string): string => {
    const result = spawnSync(runtime, ['--version'], {
      encoding: 'utf8',
      timeout: 2_000,
      env: environment(),
    });
    return result.status === 0 ? result.stdout.trim() : 'unavailable';
  },
  platform: string = process.platform,
): string[] {
  const reasons: string[] = [];
  if (!['darwin', 'linux'].includes(platform))
    reasons.push('Bun migration fixture requires POSIX process-group and SIGINT verification.');
  for (const [runtime, expected] of Object.entries(BUN_MIGRATION_VERSIONS)) {
    const actual = probe(runtime);
    if (actual !== expected)
      reasons.push(`Bun migration fixture requires ${runtime} ${expected}; observed ${actual}.`);
  }
  return reasons;
}

const manifest = {
  name: PACKAGE_NAME,
  version: '1.0.0',
  private: true,
  type: 'module',
  packageManager: `bun@${BUN_MIGRATION_VERSIONS.bun}`,
  scripts: {
    postinstall: 'node scripts/generate.mjs',
    build: 'node scripts/build.mjs',
    test: 'bun test',
  },
  exports: { '.': './dist/api.mjs', './timer': './dist/timer.mjs' },
  bin: { 'migration-cli': './dist/cli.mjs' },
  dependencies: { '@kory-eval/config-source': 'file:vendor/config' },
};
const npmLock = json({
  name: PACKAGE_NAME,
  version: '1.0.0',
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': {
      name: PACKAGE_NAME,
      version: '1.0.0',
      hasInstallScript: true,
      bin: { 'migration-cli': './dist/cli.mjs' },
      dependencies: manifest.dependencies,
    },
    'node_modules/@kory-eval/config-source': { resolved: 'vendor/config', link: true },
    'vendor/config': { name: '@kory-eval/config-source', version: '1.0.0' },
  },
});

const api = String.raw`import { readFileSync } from 'node:fs';
const config = JSON.parse(readFileSync(new URL('../generated/config.json', import.meta.url), 'utf8'));
export function describe(value) { return { value, schema: config.schema, prefix: config.prefix }; }
`;
const timer = String.raw`export function defer(callback, milliseconds, clock = globalThis) {
  const handle = clock.setTimeout(callback, milliseconds);
  return () => clock.clearTimeout(handle);
}
`;
const cli = String.raw`import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe } from './api.mjs';
const args = process.argv.slice(2);
if (args[0] === '--version' && args.length === 1) console.log('1.0.0');
else if (args[0] === '--echo' && args.length === 2) console.log(JSON.stringify(describe(args[1])));
else if (args[0] === '--fail' && args.length === 2 && /^[1-9][0-9]?$/.test(args[1])) {
  console.error('Requested failure'); process.exitCode = Number(args[1]);
} else if (args[0] === '--watch' && args.length === 1) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'inherit'] });
  let stopping = false;
  const interrupt = () => {
    if (stopping) return;
    stopping = true;
    child.kill('SIGTERM');
  };
  process.on('SIGINT', interrupt);
  child.stdout.on('data', chunk => { if (chunk.toString().includes('WORKER_READY')) process.stdout.write('READY\n'); });
  child.on('error', error => { console.error(error.message); process.off('SIGINT', interrupt); process.exitCode = 1; });
  child.on('close', code => { process.off('SIGINT', interrupt); process.exitCode = stopping ? 130 : (code || 1); });
} else { console.error('Unknown option'); process.exitCode = 2; }
`;
const worker = String.raw`import { appendFileSync } from 'node:fs';
const file = process.env.KORY_EVAL_WORKER_LOG;
const record = event => { if (file) appendFileSync(file, JSON.stringify({ event, pid: process.pid, runtime: process.versions.bun ? 'bun' : 'node' }) + '\n'); };
const heartbeat = setInterval(() => {}, 1000);
process.once('SIGTERM', () => { record('stopped'); clearInterval(heartbeat); });
record('started');
process.stdout.write('WORKER_READY\n');
`;
const clock = String.raw`export class FakeClock {
  now = 0; next = 0; jobs = new Map();
  setTimeout(callback, delay) { const id = ++this.next; this.jobs.set(id, { at: this.now + delay, callback }); return id; }
  clearTimeout(id) { this.jobs.delete(id); }
  advance(milliseconds) {
    this.now += milliseconds;
    for (const [id, job] of [...this.jobs].sort((a,b) => a[1].at-b[1].at)) {
      if (job.at <= this.now && this.jobs.delete(id)) job.callback();
    }
  }
}
`;
const publicTests = String.raw`import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describe } from '@kory-eval/migration-cli';
import { defer } from '@kory-eval/migration-cli/timer';
import { FakeClock } from '../support/fake-clock.mjs';
test('published exports consume install-generated data', () => {
  assert.deepEqual(describe('Ada'), { value: 'Ada', schema: 3, prefix: 'published' });
});
test('cancellation removes only the owned timer', () => {
  const clock = new FakeClock(), called = [];
  const cancel = defer(() => called.push('cancelled'), 10, clock);
  defer(() => called.push('kept'), 20, clock);
  cancel(); cancel(); clock.advance(30);
  assert.deepEqual(called, ['kept']); assert.equal(clock.jobs.size, 0);
});
`;
const fixedFiles: Record<string, string> = {
  'package-lock.json': npmLock,
  '.bun-version': `${BUN_MIGRATION_VERSIONS.bun}\n`,
  '.node-version': `${BUN_MIGRATION_VERSIONS.node.slice(1)}\n`,
  'bunfig.toml': '[install]\nregistry = "http://127.0.0.1:9"\n',
  'schema.json': json({ schema: 3, prefix: 'published' }),
  'vendor/config/package.json': json({
    name: '@kory-eval/config-source',
    version: '1.0.0',
    type: 'module',
    exports: './index.mjs',
  }),
  'vendor/config/index.mjs':
    'export function normalize(schema) { return { schema: schema.schema, prefix: schema.prefix }; }\n',
  'scripts/generate.mjs': String.raw`import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { normalize } from '@kory-eval/config-source';
mkdirSync('generated', { recursive: true });
writeFileSync('generated/config.json', JSON.stringify(normalize(JSON.parse(readFileSync('schema.json', 'utf8'))), null, 2) + '\n');
`,
  'scripts/build.mjs': String.raw`import { mkdirSync, copyFileSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
for (const name of ['api', 'cli', 'timer', 'worker']) copyFileSync('src/' + name + '.mjs', 'dist/' + name + '.mjs');
`,
  'src/worker.mjs': worker,
  'support/fake-clock.mjs': clock,
  'tests/compat.test.mjs': publicTests,
  'reference/api.mjs': api,
  'reference/cli.mjs': cli,
  'reference/timer.mjs': timer,
  'README.md': `# Node-to-Bun observable compatibility\n\nMigrate this small package at the versions in .bun-version and .node-version. The reference package manager is npm ${BUN_MIGRATION_VERSIONS.npm}. reference/ is the preserved working Node source; src/ is an incomplete migration with broken timer cancellation and interruption behavior. Preserve the public CLI and exports, install-generated data, source assets, and npm lockfile. Keep the one local dependency unchanged. No registry dependency or network access is needed.\n\nUse bun install with its existing postinstall hook, build, and tests. Commit the resulting bun.lock; the explicit package-manager migration is authorized, but never overwrite package-lock.json or bypass a frozen-lockfile mismatch. Do not hand-create generated/config.json or ship stale dist files instead of repairing source.\n\nCLI contracts: --version prints 1.0.0; --echo VALUE serializes describe(VALUE); --fail N (1–99) reports Requested failure on stderr and exits N; invalid options exit 2. --watch starts the supplied worker and acknowledges READY only after worker readiness; SIGINT must stop/reap it, remove the handler, and exit 130. defer(callback,ms,clock=globalThis) returns an idempotent cancellation function affecting only that timer. Internal implementation is unrestricted within those interfaces.\n\nFixed reference, tests, worker, build/generator scripts, schema and runtime pins are evaluation evidence; do not edit them. Add regression tests if needed. Report compatibility deviations and runtime evidence, not merely a success declaration. The evaluator rebuilds clean copies and compares real Node/Bun behavior, including varied inputs and OS signals. Disposable workspaces and sanitized environments are not a hostile-code OS sandbox.\n`,
};

function fixedIntact(root: string): boolean {
  return Object.entries(fixedFiles).every(([path, text]) => regularText(root, path) === text);
}
function regularText(root: string, path: string): string | null {
  try {
    if (!lstatSync(root).isDirectory()) return null;
    let current = root;
    for (const segment of path.split('/')) {
      current = join(current, segment);
      if (lstatSync(current).isSymbolicLink()) return null;
    }
    return lstatSync(current).isFile() ? readFileSync(current, 'utf8') : null;
  } catch {
    return null;
  }
}
function reportPathSafe(root: string): boolean {
  for (const path of ['.kory-eval', '.kory-eval/bun-runtime-evidence.json']) {
    try {
      const stat = lstatSync(join(root, path));
      if (path === '.kory-eval' ? !stat.isDirectory() : !stat.isFile()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
  }
  return true;
}
const fail = (evidence: string[], integrityFailure = false): SkillEvalDeterministicScore => ({
  passed: false,
  quality: 0,
  verification: 0,
  integrityFailure,
  evidence,
});
interface RunRecord {
  phase: string;
  code: number | null;
  stdout: string;
  stderr: string;
}
function run(
  root: string,
  runtime: 'node' | 'bun' | 'npm',
  args: string[],
  phase: string,
): RunRecord {
  const result = spawnSync(runtime, args, {
    cwd: root,
    env: { ...environment(), BUN_INSTALL_CACHE_DIR: join(root, '.cache') },
    encoding: 'utf8',
    timeout: 3_000,
    killSignal: 'SIGKILL',
    maxBuffer: 128_000,
  });
  return {
    phase,
    code: result.status,
    stdout: (result.stdout ?? '').slice(-4_000),
    stderr: (result.stderr ?? result.error?.message ?? '').slice(-4_000),
  };
}
const comparable = ({ code, stdout, stderr }: RunRecord) => ({ code, stdout, stderr });

/** Only the process group created by this invocation is signalled during cleanup. */
async function interruptProbe(
  root: string,
  runtime: 'node' | 'bun',
): Promise<{
  code: number | null;
  ready: boolean;
  ownedLiveWorker: boolean;
  stopped: boolean;
  timedOut: boolean;
}> {
  const logPath = join(root, `${runtime}-worker.jsonl`);
  return await new Promise((resolveProbe) => {
    const child = spawn(runtime, ['dist/cli.mjs', '--watch'], {
      cwd: root,
      detached: true,
      env: { ...environment(), KORY_EVAL_WORKER_LOG: logPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let ready = false,
      ownedLiveWorker = false,
      timedOut = false,
      settled = false,
      output = '';
    const records = (): Array<{ event: string; pid: number; runtime: string }> => {
      try {
        return readFileSync(logPath, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    };
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const cleanup = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* Already reaped. */
        }
      }
    };
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      const rows = records(),
        first = rows[0];
      const stopped =
        !!first &&
        rows.length === 2 &&
        rows[1]?.event === 'stopped' &&
        rows[1]?.pid === first.pid &&
        !alive(first.pid);
      cleanup();
      resolveProbe({ code, ready, ownedLiveWorker, stopped, timedOut });
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      cleanup();
      finish(null);
    }, 2_000);
    child.on('error', () => finish(null));
    child.on('exit', (code) => finish(code));
    child.stderr.on('data', () => {});
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.length > 16_000) {
        timedOut = true;
        cleanup();
        finish(null);
        return;
      }
      if (!ready && output.includes('READY\n')) {
        ready = true;
        const first = records()[0];
        if (
          first &&
          first.event === 'started' &&
          first.runtime === runtime &&
          first.pid !== child.pid &&
          Number.isSafeInteger(first.pid) &&
          first.pid > 0
        ) {
          const group = spawnSync('ps', ['-o', 'pgid=', '-p', String(first.pid)], {
            encoding: 'utf8',
            timeout: 500,
            env: environment(),
          });
          ownedLiveWorker =
            group.status === 0 && Number(group.stdout.trim()) === child.pid && alive(first.pid);
        }
        child.kill('SIGINT');
      }
    });
  });
}

const timerProbe = String.raw`import { readFileSync } from 'node:fs';
import { defer } from '@kory-eval/migration-cli/timer';
import { FakeClock } from './support/fake-clock.mjs';
const delays = JSON.parse(readFileSync(0, 'utf8'));
const result = delays.map(delay => {
  const clock = new FakeClock(), called = [];
  const cancel = defer(() => called.push('cancelled'), delay, clock);
  defer(() => called.push('kept'), delay + 2, clock);
  cancel(); cancel(); clock.advance(delay); const before = [...called]; clock.advance(2);
  return { before, after: called, pending: clock.jobs.size };
});
process.stdout.write(JSON.stringify(result));
`;

export async function scoreBunMigration(root: string): Promise<SkillEvalDeterministicScore> {
  const prerequisites = bunMigrationReadiness();
  if (prerequisites.length) return fail(prerequisites);
  if (!fixedIntact(root) || !reportPathSafe(root))
    return fail(['Fixed baseline, inputs or report path changed; no candidate executed.'], true);
  const packageText = regularText(root, 'package.json'),
    lockText = regularText(root, 'bun.lock');
  if (!packageText || !lockText)
    return fail(['Commit package.json and the migrated bun.lock before frozen installation.']);
  let proposed: Record<string, unknown>;
  try {
    proposed = JSON.parse(packageText);
  } catch {
    return fail(['Invalid package.json']);
  }
  // No new installation authority is implied. Source implementations may vary; the published
  // package contract, local dependency graph and reviewed hooks stay fixed in this task.
  if (!isDeepStrictEqual(proposed, manifest))
    return fail(
      ['Published package metadata, dependencies or reviewed lifecycle commands changed.'],
      true,
    );
  const candidateSources = ['api', 'cli', 'timer'].map(
    (name) => [name, regularText(root, `src/${name}.mjs`)] as const,
  );
  if (candidateSources.some(([, text]) => text === null))
    return fail(['Candidate source is missing or symlinked.'], true);
  const checkRoot = mkdtempSync(join(tmpdir(), 'kory-bun-runtime-check-'));
  const referenceRoot = join(checkRoot, 'node'),
    candidateRoot = join(checkRoot, 'bun');
  const phases: RunRecord[] = [];
  try {
    for (const destination of [referenceRoot, candidateRoot]) {
      mkdirSync(destination);
      for (const [path, text] of Object.entries(fixedFiles))
        writeFixtureFile(destination, path, text);
      writeFixtureFile(destination, 'package.json', packageText);
      writeFixtureFile(destination, 'bun.lock', lockText);
    }
    for (const [name, text] of candidateSources) {
      writeFixtureFile(candidateRoot, `src/${name}.mjs`, text!);
      writeFixtureFile(referenceRoot, `src/${name}.mjs`, fixedFiles[`reference/${name}.mjs`]!);
    }
    // Run the preserved Node baseline and the actual clean Bun install/build/test paths.
    phases.push(
      run(
        referenceRoot,
        'npm',
        [
          'ci',
          '--offline',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--cache',
          join(referenceRoot, '.cache'),
        ],
        'node-npm-ci',
      ),
    );
    phases.push(run(referenceRoot, 'node', ['scripts/generate.mjs'], 'node-generate'));
    phases.push(run(referenceRoot, 'node', ['scripts/build.mjs'], 'node-build'));
    phases.push(run(referenceRoot, 'node', ['--test', 'tests/compat.test.mjs'], 'node-tests'));
    phases.push(
      run(
        candidateRoot,
        'bun',
        [
          'install',
          '--frozen-lockfile',
          '--cache-dir',
          join(candidateRoot, '.cache'),
          '--registry',
          'http://127.0.0.1:9',
        ],
        'bun-frozen-install',
      ),
    );
    phases.push(run(candidateRoot, 'bun', ['run', 'build'], 'bun-build'));
    phases.push(run(candidateRoot, 'bun', ['test', 'tests/compat.test.mjs'], 'bun-tests'));
    const invariants = () =>
      fixedIntact(root) &&
      fixedIntact(candidateRoot) &&
      fixedIntact(referenceRoot) &&
      regularText(candidateRoot, 'bun.lock') === lockText &&
      regularText(root, 'bun.lock') === lockText &&
      regularText(candidateRoot, 'package.json') === packageText &&
      regularText(root, 'package.json') === packageText &&
      candidateSources.every(
        ([name, text]) =>
          regularText(root, `src/${name}.mjs`) === text &&
          regularText(candidateRoot, `src/${name}.mjs`) === text,
      );
    const persist = (passed: boolean, evidence: string[]) => {
      const integrity = invariants();
      if (!reportPathSafe(root))
        return fail(['Unsafe evaluator report path; no report written.'], true);
      writeFixtureFile(
        root,
        '.kory-eval/bun-runtime-evidence.json',
        json({
          evidenceKind: 'actual-local-runtime',
          versions: BUN_MIGRATION_VERSIONS,
          platform: process.platform,
          passed: passed && integrity,
          integrity,
          phases,
          checks: evidence,
          bunLockSha256: createHash('sha256').update(lockText).digest('hex'),
          npmLockSha256: createHash('sha256').update(npmLock).digest('hex'),
          limits: [
            'POSIX local fixture only',
            'Not a hostile-code OS sandbox',
            'No model uplift or blind qualification established',
          ],
        }),
      );
      return {
        passed: passed && integrity,
        quality: passed && integrity ? 1 : 0,
        verification: passed && integrity ? 1 : 0,
        integrityFailure: !integrity,
        evidence: [...evidence, ...phases.map((p) => `${p.phase}: exit ${p.code}`)],
      };
    };
    if (phases.some((p) => p.code !== 0))
      return persist(false, ['Install/build/public behavioral test failed.']);
    const generated = regularText(candidateRoot, 'generated/config.json');
    if (generated !== fixedFiles['schema.json'])
      return persist(false, ['Clean install did not produce the required generated artifact.']);
    for (const args of [
      ['--version'],
      ['--echo', 'Ada'],
      ['--echo', ''],
      ['--echo', '東京 / a;b $value'],
      ['--fail', '7'],
      ['--fail', '23'],
      ['--unknown'],
      ['--echo'],
    ]) {
      const reference = run(
        referenceRoot,
        'node',
        ['dist/cli.mjs', ...args],
        `node-cli:${JSON.stringify(args)}`,
      );
      const candidate = run(
        candidateRoot,
        'bun',
        ['dist/cli.mjs', ...args],
        `bun-cli:${JSON.stringify(args)}`,
      );
      phases.push(reference, candidate);
      if (
        reference.code === null ||
        !isDeepStrictEqual(comparable(reference), comparable(candidate))
      )
        return persist(false, ['Published CLI output/stderr/exit-code mismatch.']);
    }
    const exportProbe = `import {describe} from '${PACKAGE_NAME}'; import {defer} from '${PACKAGE_NAME}/timer'; console.log(JSON.stringify([describe('consumer'),typeof defer]));`;
    const referenceExport = run(
      referenceRoot,
      'node',
      ['--input-type=module', '--eval', exportProbe],
      'node-export-consumer',
    );
    const candidateExport = run(
      candidateRoot,
      'bun',
      ['--eval', exportProbe],
      'bun-export-consumer',
    );
    phases.push(referenceExport, candidateExport);
    if (
      referenceExport.code !== 0 ||
      !isDeepStrictEqual(comparable(referenceExport), comparable(candidateExport))
    )
      return persist(false, ['Public package exports are incompatible.']);
    const probes = [referenceRoot, candidateRoot].map((destination, index) =>
      spawnSync(
        index === 0 ? 'node' : 'bun',
        index === 0 ? ['--input-type=module', '--eval', timerProbe] : ['--eval', timerProbe],
        {
          cwd: destination,
          input: '[0,1,17,250]',
          encoding: 'utf8',
          env: environment(),
          timeout: 2_000,
          killSignal: 'SIGKILL',
          maxBuffer: 32_000,
        },
      ),
    );
    const expectedTimers = JSON.stringify(
      [0, 1, 17, 250].map(() => ({ before: [], after: ['kept'], pending: 0 })),
    );
    if (probes.some((p) => p.status !== 0 || p.stdout !== expectedTimers))
      return persist(false, ['Varied fake-clock cancellation/lifetime checks failed.']);
    const referenceSignal = await interruptProbe(referenceRoot, 'node');
    const candidateSignal = await interruptProbe(candidateRoot, 'bun');
    const expectedSignal = {
      code: 130,
      ready: true,
      ownedLiveWorker: true,
      stopped: true,
      timedOut: false,
    };
    const signalEvidence = [
      `Node SIGINT: ${JSON.stringify(referenceSignal)}`,
      `Bun SIGINT: ${JSON.stringify(candidateSignal)}`,
    ];
    if (
      ![referenceSignal, candidateSignal].every((value) => isDeepStrictEqual(value, expectedSignal))
    )
      return persist(false, signalEvidence);
    return persist(true, [
      'Clean frozen install, generated artifact, build/tests, package consumers, CLI variations and timer cleanup verified.',
      ...signalEvidence,
    ]);
  } finally {
    rmSync(checkRoot, { recursive: true, force: true });
  }
}

export const BUN_RUNTIME_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  {
    id: 'bun-deno-runtime/actual-bun-migration@1',
    get readinessBlockers() {
      return bunMigrationReadiness();
    },
    matches: (scenario) => scenario.id === BUN_MIGRATION_SCENARIO,
    materialize: (root) => {
      for (const [path, text] of Object.entries(fixedFiles)) writeFixtureFile(root, path, text);
      writeFixtureFile(root, 'package.json', json(manifest));
      writeFixtureFile(root, 'src/api.mjs', api);
      writeFixtureFile(
        root,
        'src/timer.mjs',
        timer.replace(
          'return () => clock.clearTimeout(handle);',
          'return () => {}; // Incomplete migration loses cancellation.',
        ),
      );
      writeFixtureFile(
        root,
        'src/cli.mjs',
        cli.replace(
          "child.kill('SIGTERM');",
          'process.exit(0); // Incomplete migration skips child cleanup.',
        ),
      );
      // Generate once without running hooks; both evaluation arms receive the same committed lock.
      const generated = run(
        root,
        'bun',
        [
          'install',
          '--lockfile-only',
          '--ignore-scripts',
          '--cache-dir',
          join(root, '.cache'),
          '--registry',
          'http://127.0.0.1:9',
        ],
        'materialize-lock',
      );
      if (generated.code !== 0 || !existsSync(join(root, 'bun.lock')))
        throw new Error(`Cannot materialize pinned Bun lock: ${generated.stderr}`);
      // Cache content is not part of the task and must not affect paired snapshots.
      const cache = resolve(root, '.cache');
      if (existsSync(cache)) rmSync(cache, { recursive: true, force: true });
    },
  },
];
export const BUN_RUNTIME_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  {
    id: 'bun-deno-runtime/actual-bun-migration-scorer@1',
    scenarioIds: [BUN_MIGRATION_SCENARIO],
    score: ({ workingDirectory }) => scoreBunMigration(workingDirectory),
  },
];
