import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { packageJson, readJsonArtifact, writeFixtureFile } from './skill-eval-fixture-helpers';

const FUNCTIONAL_IMPORT = 'functional-verification-full-task-1';
const FUNCTIONAL_EDITOR = 'functional-verification-full-task-2';
const PERFORMANCE_API = 'performance-verification-full-task-1';
const PERFORMANCE_EXPORT = 'performance-verification-full-task-2';

function normalized(value: unknown): string {
  return JSON.stringify(value ?? '').toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function containsDiagnosisClaim(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => containsDiagnosisClaim(item));
  const record = asRecord(value);
  if (!record) return false;
  return Object.entries(record).some(([key, nested]) => {
    const normalizedKey = key.toLowerCase().replace(/[^a-z]/gu, '');
    if (normalizedKey === 'diagnosisattempted') return nested === true;
    if (
      ['diagnosis', 'rootcause', 'fix', 'proposedfix', 'remediation'].includes(normalizedKey)
    ) {
      return nested !== null && nested !== false && nested !== '';
    }
    return containsDiagnosisClaim(nested);
  });
}

function run(
  root: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bun', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 1_000_000,
    env: { ...process.env, ...env },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

const IMPORT_CLI = `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

interface Database { sequence: number; rows: Array<{ id: number; name: string; email: string }> }

function paths() {
  return {
    db: process.env.KORY_IMPORT_DB ?? 'state/db.json',
    out: process.env.KORY_IMPORT_OUT ?? 'state/output',
  };
}

function parseCsv(path: string): Array<{ name: string; email: string }> {
  const lines = readFileSync(path, 'utf8').trim().split(/\\r?\\n/);
  const rows = lines.slice(1).map((line, index) => {
    const [name = '', email = ''] = line.split(',');
    if (!name.trim() || !email.includes('@')) throw new Error('invalid required field at row ' + (index + 2));
    return { name: name.trim(), email: email.trim() };
  });
  return rows;
}

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const file = argv.find((item) => item.endsWith('.csv'));
if (argv[0] !== 'import' || !file) {
  console.error('usage: import [--dry-run] <csv>');
  process.exit(2);
}

try {
  const rows = parseCsv(file);
  const target = paths();
  const db = JSON.parse(readFileSync(target.db, 'utf8')) as Database;
  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, wouldCreate: rows }));
  } else {
    for (const row of rows) db.rows.push({ id: db.sequence++, ...row });
    writeFileSync(target.db, JSON.stringify(db, null, 2) + '\\n');
    mkdirSync(target.out, { recursive: true });
    writeFileSync(join(target.out, 'import-summary.json'), JSON.stringify({ created: rows.length }) + '\\n');
    console.log(JSON.stringify({ dryRun: false, created: rows.length }));
  }
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(3);
}
`;

const IMPORT_DB = `${JSON.stringify({ sequence: 17, rows: [] }, null, 2)}\n`;
const IMPORT_VALID = `name,email
Ada,ada@example.test
Grace,grace@example.test
Linus,linus@example.test
`;
const IMPORT_INVALID = `name,email
Ada,ada@example.test
Broken,
`;

const functionalImportMaterializer: SkillEvalFixtureMaterializer = {
  id: 'functional-verification/import-dry-run@1',
  matches: (scenario) => scenario.id === FUNCTIONAL_IMPORT,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-functional-import'));
    writeFixtureFile(destination, 'src/cli.ts', IMPORT_CLI);
    writeFixtureFile(destination, 'state/db.json', IMPORT_DB);
    writeFixtureFile(destination, 'fixture/valid.csv', IMPORT_VALID);
    writeFixtureFile(destination, 'fixture/invalid.csv', IMPORT_INVALID);
    writeFixtureFile(
      destination,
      'README.md',
      `# Functional verification — import dry-run

Use the supported command \`bun run src/cli.ts import [--dry-run] <csv>\`. The starting database has zero rows and sequence 17. Independently inspect \`state/db.json\` and \`state/output\`; command success text is not a persistence oracle.

Verify valid dry-run (exactly three would-create rows, success, no mutation), invalid dry-run (documented required-field diagnostic, nonzero exit, no mutation), then one normal valid import proving dry-run did not poison state. Write \`.kory-eval/functional-import.json\` with a claim matrix, exact exit/stdout/stderr, independent pre/post DB + output observations, and bounded verdict. This is a synthetic harness; label that evidence boundary.
`,
    );
  },
};

const functionalImportScorer: SkillEvalDeterministicScorer = {
  id: 'functional-verification/import-dry-run-scorer@1',
  scenarioIds: [FUNCTIONAL_IMPORT],
  score: ({ workingDirectory }) => {
    const sourcePreserved =
      readFileSync(join(workingDirectory, 'src/cli.ts'), 'utf8') === IMPORT_CLI;
    const hiddenRoot = join(workingDirectory, '.kory-eval', '__functional-import');
    rmSync(hiddenRoot, { recursive: true, force: true });
    mkdirSync(join(hiddenRoot, 'output'), { recursive: true });
    const dbPath = join(hiddenRoot, 'db.json');
    const outPath = join(hiddenRoot, 'output');
    writeFileSync(dbPath, IMPORT_DB);
    const env = { KORY_IMPORT_DB: dbPath, KORY_IMPORT_OUT: outPath };
    const before = readFileSync(dbPath, 'utf8');
    const validDry = run(
      workingDirectory,
      ['run', 'src/cli.ts', 'import', '--dry-run', 'fixture/valid.csv'],
      env,
    );
    const afterValidDry = readFileSync(dbPath, 'utf8');
    const invalidDry = run(
      workingDirectory,
      ['run', 'src/cli.ts', 'import', '--dry-run', 'fixture/invalid.csv'],
      env,
    );
    const afterInvalidDry = readFileSync(dbPath, 'utf8');
    const normal = run(workingDirectory, ['run', 'src/cli.ts', 'import', 'fixture/valid.csv'], env);
    const finalDb = JSON.parse(readFileSync(dbPath, 'utf8')) as {
      sequence: number;
      rows: Array<{ id: number; name: string; email: string }>;
    };
    const outputFiles = (() => {
      try {
        return require('node:fs').readdirSync(outPath) as string[];
      } catch {
        return [];
      }
    })();
    const behavior =
      validDry.status === 0 &&
      /"dryRun":true/u.test(validDry.stdout) &&
      /Ada/u.test(validDry.stdout) &&
      /Grace/u.test(validDry.stdout) &&
      /Linus/u.test(validDry.stdout) &&
      invalidDry.status === 3 &&
      /invalid required field at row 3/u.test(invalidDry.stderr) &&
      before === afterValidDry &&
      before === afterInvalidDry &&
      normal.status === 0 &&
      finalDb.sequence === 20 &&
      finalDb.rows.map((row) => row.id).join(',') === '17,18,19' &&
      outputFiles.join(',') === 'import-summary.json';
    rmSync(hiddenRoot, { recursive: true, force: true });
    const artifact = readJsonArtifact<unknown>(
      workingDirectory,
      '.kory-eval/functional-import.json',
    );
    const body = normalized(artifact);
    const report =
      /dry-run|dry run/u.test(body) &&
      /sequence/u.test(body) &&
      /17/u.test(body) &&
      /20/u.test(body) &&
      /invalid required field/u.test(body) &&
      /independent|db|database|persist/u.test(body) &&
      /output/u.test(body) &&
      /synthetic|fixture/u.test(body);
    const passed = sourcePreserved && behavior && Boolean(artifact) && report;
    return {
      passed,
      quality: passed ? 1 : sourcePreserved && behavior ? 0.75 : behavior ? 0.5 : 0,
      verification: behavior ? 1 : 0,
      integrityFailure: !sourcePreserved,
      evidence: [
        `product source remained read-only: ${sourcePreserved ? 'yes' : 'no'}`,
        `valid+invalid dry-run nonmutation + normal follow-up: ${behavior ? 'pass' : 'fail'}`,
        `claim matrix uses independent persisted-state evidence: ${report ? 'yes' : 'no'}`,
      ],
    };
  },
};

const EDITOR_SOURCE = `export interface PersistedDocument { revision: number; content: string }
export type CloseChoice = 'save' | 'discard' | 'cancel';

export class DocumentStore {
  constructor(public persisted: PersistedDocument) {}
  rejectNextSave = false;
  save(content: string): PersistedDocument {
    if (this.rejectNextSave) {
      this.rejectNextSave = false;
      throw new Error('save rejected by fixture');
    }
    this.persisted = { revision: this.persisted.revision + 1, content };
    return this.persisted;
  }
  read(): PersistedDocument { return { ...this.persisted }; }
}

export class DraftEditor {
  open = true;
  dirty = false;
  error: string | null = null;
  content: string;
  constructor(private readonly store: DocumentStore) { this.content = store.read().content; }
  edit(content: string): void { this.content = content; this.dirty = true; this.error = null; }
  close(choice: CloseChoice): void {
    if (!this.dirty) { this.open = false; return; }
    if (choice === 'cancel') return;
    if (choice === 'discard') { this.open = false; this.dirty = false; return; }
    try {
      this.store.save(this.content);
      this.open = false;
      this.dirty = false;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.open = true;
      this.dirty = true;
    }
  }
}

export function reopen(store: DocumentStore): DraftEditor { return new DraftEditor(store); }
`;

const functionalEditorMaterializer: SkillEvalFixtureMaterializer = {
  id: 'functional-verification/dirty-close-branches@1',
  matches: (scenario) => scenario.id === FUNCTIONAL_EDITOR,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-functional-editor'));
    writeFixtureFile(destination, 'src/editor.ts', EDITOR_SOURCE);
    writeFixtureFile(
      destination,
      'contract.md',
      `# Dirty-close contract

Starting persisted state: revision 4, content \`Baseline αβ\`.

- Save exact edited Unicode content and close; fresh-process reopen sees the new persisted revision/content.
- Discard closes without changing the last persisted revision/content.
- Cancel keeps the editor open and dirty, with no persistence.
- Injected save rejection exposes \`save rejected by fixture\`, keeps editor open+dirty, and leaves persistence unchanged.
`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Functional verification — dirty close

Use the exported fixture application boundary in \`src/editor.ts\`; do not change product code. Exercise Save, Discard, Cancel, and one injected save rejection. Independently read \`DocumentStore.read()\` and create a fresh editor with \`reopen()\` after every state-changing branch.

Write \`.kory-eval/functional-editor.json\` with a branch-by-branch acceptance matrix, live editor state, independent persisted revision/content, fresh-reopen observations, rejection evidence, and a bounded synthetic-fixture verdict.
`,
    );
  },
};

const functionalEditorScorer: SkillEvalDeterministicScorer = {
  id: 'functional-verification/dirty-close-branches-scorer@1',
  scenarioIds: [FUNCTIONAL_EDITOR],
  score: ({ workingDirectory }) => {
    const sourcePreserved =
      readFileSync(join(workingDirectory, 'src/editor.ts'), 'utf8') === EDITOR_SOURCE;
    const hidden = run(workingDirectory, [
      '-e',
      `import { DocumentStore, DraftEditor, reopen } from './src/editor.ts';
const baseline = { revision: 4, content: 'Baseline αβ' };
const results:any = {};
{
  const store = new DocumentStore({ ...baseline }); const editor = new DraftEditor(store);
  editor.edit('Edited 🚀 café 漢字'); editor.close('save');
  results.save = { open: editor.open, dirty: editor.dirty, persisted: store.read(), reopen: reopen(store).content };
}
{
  const store = new DocumentStore({ ...baseline }); const editor = new DraftEditor(store);
  editor.edit('Discard me'); editor.close('discard');
  results.discard = { open: editor.open, persisted: store.read(), reopen: reopen(store).content };
}
{
  const store = new DocumentStore({ ...baseline }); const editor = new DraftEditor(store);
  editor.edit('Keep dirty'); editor.close('cancel');
  results.cancel = { open: editor.open, dirty: editor.dirty, persisted: store.read() };
}
{
  const store = new DocumentStore({ ...baseline }); store.rejectNextSave = true; const editor = new DraftEditor(store);
  editor.edit('Rejected'); editor.close('save');
  results.reject = { open: editor.open, dirty: editor.dirty, error: editor.error, persisted: store.read(), reopen: reopen(store).content };
}
console.log(JSON.stringify(results));`,
    ]);
    let observed: any = null;
    try {
      observed = JSON.parse(hidden.stdout.trim());
    } catch {
      observed = null;
    }
    const behavior =
      hidden.status === 0 &&
      observed?.save?.open === false &&
      observed?.save?.dirty === false &&
      observed?.save?.persisted?.revision === 5 &&
      observed?.save?.persisted?.content === 'Edited 🚀 café 漢字' &&
      observed?.save?.reopen === 'Edited 🚀 café 漢字' &&
      observed?.discard?.persisted?.revision === 4 &&
      observed?.discard?.reopen === 'Baseline αβ' &&
      observed?.cancel?.open === true &&
      observed?.cancel?.dirty === true &&
      observed?.cancel?.persisted?.revision === 4 &&
      observed?.reject?.open === true &&
      observed?.reject?.dirty === true &&
      /save rejected/u.test(observed?.reject?.error ?? '') &&
      observed?.reject?.persisted?.revision === 4 &&
      observed?.reject?.reopen === 'Baseline αβ';
    const artifact = readJsonArtifact<unknown>(
      workingDirectory,
      '.kory-eval/functional-editor.json',
    );
    const body = normalized(artifact);
    const report =
      /save/u.test(body) &&
      /discard/u.test(body) &&
      /cancel/u.test(body) &&
      /reject/u.test(body) &&
      /revision/u.test(body) &&
      /edited.*café|漢字|🚀/u.test(body) &&
      /reopen/u.test(body) &&
      /independent|persist/u.test(body) &&
      /synthetic|fixture/u.test(body);
    const passed = sourcePreserved && behavior && Boolean(artifact) && report;
    return {
      passed,
      quality: passed ? 1 : sourcePreserved && behavior ? 0.75 : behavior ? 0.5 : 0,
      verification: behavior ? 1 : 0,
      integrityFailure: !sourcePreserved,
      evidence: [
        `product source remained read-only: ${sourcePreserved ? 'yes' : 'no'}`,
        `Save/Discard/Cancel/rejection + fresh reopen: ${behavior ? 'pass' : 'fail'}`,
        `branch acceptance matrix: ${report ? 'complete' : 'incomplete'}`,
      ],
    };
  },
};

const API_PERF_DATA = {
  candidate: {
    build: 'search-cache@sha256:candidate-91f',
    runtime: 'bun-1.3.14-release',
    host: { cpuLimit: '8 cores', memoryLimit: '8GiB' },
  },
  baseline: {
    build: 'search-cache@v4.7.2',
    runtime: 'bun-1.3.14-release',
    host: { cpuLimit: '8 cores', memoryLimit: '8GiB' },
  },
  workload: {
    records: 1_000_000,
    mix: { search: 70, detail: 20, facet: 10 },
    targetRps: 400,
    concurrency: 40,
    warmupSeconds: 120,
    measuredRunSeconds: 300,
    measuredRuns: 3,
    datasetSeed: 'dataset-v12-fixed',
    cachePreparation: 'cold-seed then declared warmup',
  },
  warmup: { p95Ms: 212, note: 'excluded from measurement' },
  runs: [
    {
      run: 1,
      p50Ms: 71,
      p95Ms: 161,
      p99Ms: 382,
      throughputRps: 399,
      errorRatePct: 0.18,
      cpuPctOfLimit: 72,
      queueSaturated: false,
      generatorCpuPct: 43,
      correctness: true,
    },
    {
      run: 2,
      p50Ms: 73,
      p95Ms: 166,
      p99Ms: 371,
      throughputRps: 398,
      errorRatePct: 0.22,
      cpuPctOfLimit: 74,
      queueSaturated: false,
      generatorCpuPct: 45,
      correctness: true,
    },
    {
      run: 3,
      p50Ms: 70,
      p95Ms: 159,
      p99Ms: 365,
      throughputRps: 400,
      errorRatePct: 0.17,
      cpuPctOfLimit: 71,
      queueSaturated: false,
      generatorCpuPct: 42,
      correctness: true,
    },
  ],
  gates: {
    p95MsMax: 180,
    p99MsMax: 350,
    errorRatePctMaxExclusive: 0.5,
    throughputRpsMin: 395,
    cpuPctOfLimitMax: 80,
    correctnessRequired: true,
  },
};

const EXPORT_PERF_DATA = {
  candidate: {
    build: 'exporter@candidate-a31',
    runtime: 'node-24-release',
    host: 'perf-standard-8',
    corpus: '20GiB-corpus-r6',
    concurrency: 8,
  },
  equivalentBaseline: {
    build: 'exporter@v8.2.1',
    runtime: 'node-24-release',
    host: 'perf-standard-8',
    corpus: '20GiB-corpus-r6',
    concurrency: 8,
    medianThroughputMiBs: 158,
  },
  decoyBaseline: {
    build: 'exporter@v8.1.0',
    runtime: 'node-24-release',
    host: 'perf-large-32',
    corpus: '20GiB-corpus-r6',
    concurrency: 8,
    medianThroughputMiBs: 210,
  },
  warmup: { throughputMiBs: 171, measured: false },
  referenceHash: 'sha256:fixture-reference-77',
  runs: [
    {
      run: 1,
      throughputMiBs: 193,
      p50Ms: 42,
      p95Ms: 88,
      p99Ms: 127,
      failedRecords: 0,
      peakRssGiB: 1.42,
      cpuPct: 72,
      storagePct: 64,
      outputHash: 'sha256:fixture-reference-77',
    },
    {
      run: 2,
      throughputMiBs: 194,
      p50Ms: 43,
      p95Ms: 89,
      p99Ms: 130,
      failedRecords: 0,
      peakRssGiB: 1.61,
      cpuPct: 73,
      storagePct: 65,
      outputHash: 'sha256:fixture-reference-77',
    },
    {
      run: 3,
      throughputMiBs: 192,
      p50Ms: 42,
      p95Ms: 87,
      p99Ms: 128,
      failedRecords: 0,
      peakRssGiB: 1.58,
      cpuPct: 71,
      storagePct: 63,
      outputHash: 'sha256:fixture-reference-77',
    },
    {
      run: 4,
      throughputMiBs: 195,
      p50Ms: 44,
      p95Ms: 90,
      p99Ms: 132,
      failedRecords: 0,
      peakRssGiB: 1.47,
      cpuPct: 74,
      storagePct: 66,
      outputHash: 'sha256:fixture-reference-77',
    },
    {
      run: 5,
      throughputMiBs: 194,
      p50Ms: 43,
      p95Ms: 89,
      p99Ms: 129,
      failedRecords: 0,
      peakRssGiB: 1.63,
      cpuPct: 73,
      storagePct: 65,
      outputHash: 'sha256:fixture-reference-77',
    },
  ],
  gates: {
    medianThroughputMiBsMin: 180,
    p95MsMax: 95,
    p99MsMax: 140,
    failedRecordsMax: 0,
    peakRssGiBMax: 1.5,
    relativeImprovementPctMin: 20,
  },
};

const performanceApiMaterializer: SkillEvalFixtureMaterializer = {
  id: 'performance-verification/api-release-gate@1',
  matches: (scenario) => scenario.id === PERFORMANCE_API,
  materialize: (destination) => {
    writeFixtureFile(
      destination,
      'evidence/performance.json',
      `${JSON.stringify(API_PERF_DATA, null, 2)}\n`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# API release performance gate

Do not change product code or redesign the harness. Analyze \`evidence/performance.json\`. Warmup is excluded; all three measured runs independently face the declared gates. Establish candidate/baseline comparability before using the baseline at all. Correctness is an independent oracle.

Write \`.kory-eval/performance-api.json\` with environment/workload identity, warmup separation, all three run summaries (p50/p95/p99/throughput/errors/CPU/queue/generator/correctness), repeat variance, baseline comparability, per-gate pass/fail, and bounded release verdict. Stay in verification: do not diagnose/fix tail latency. Label this as supplied synthetic benchmark evidence.
`,
    );
  },
};

const performanceApiScorer: SkillEvalDeterministicScorer = {
  id: 'performance-verification/api-release-gate-scorer@4',
  scenarioIds: [PERFORMANCE_API],
  score: ({ workingDirectory }) => {
    const artifact = readJsonArtifact<unknown>(workingDirectory, '.kory-eval/performance-api.json');
    const body = normalized(artifact);
    const artifactRecord = asRecord(artifact);
    const releaseVerdict = asRecord(artifactRecord?.releaseVerdict ?? artifactRecord?.verdict);
    const identity =
      /candidate-91f/u.test(body) &&
      /v4\.7\.2/u.test(body) &&
      /1,?000,?000|1000000/u.test(body) &&
      /70/u.test(body) &&
      /20/u.test(body) &&
      /10/u.test(body) &&
      /400/u.test(body) &&
      /40/u.test(body) &&
      /equivalent|comparab/u.test(body);
    const warmup = /120|2 minute|warmup/u.test(body) && /exclude|not measured/u.test(body);
    const runs =
      [382, 371, 365].every((p99) => body.includes(String(p99))) &&
      [161, 166, 159].every((p95) => body.includes(String(p95))) &&
      [399, 398, 400].every((rps) => body.includes(String(rps)));
    const independent =
      /error/u.test(body) &&
      /cpu/u.test(body) &&
      /queue/u.test(body) &&
      /generator/u.test(body) &&
      /correct/u.test(body);
    const verdict =
      String(releaseVerdict?.result ?? releaseVerdict?.status ?? '').toLowerCase() === 'fail' &&
      /p99/u.test(body) &&
      /350/u.test(body) &&
      /p95/u.test(body) &&
      /variance|range|repeat/u.test(body) &&
      !containsDiagnosisClaim(artifact);
    const passed = Boolean(artifact) && identity && warmup && runs && independent && verdict;
    return {
      passed,
      quality: passed
        ? 1
        : identity && warmup && runs && verdict
          ? 0.75
          : runs && verdict
            ? 0.5
            : 0,
      verification: runs && independent && verdict ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `workload/environment comparability: ${identity ? 'established' : 'missing'}`,
        `warmup excluded: ${warmup ? 'yes' : 'no'}`,
        `three measured distributions: ${runs ? 'complete' : 'incomplete'}`,
        `throughput/errors/resources/correctness: ${independent ? 'independent' : 'incomplete'}`,
        `bounded p99 FAIL without diagnosis: ${verdict ? 'correct' : 'incorrect'}`,
      ],
    };
  },
};

const performanceExportMaterializer: SkillEvalFixtureMaterializer = {
  id: 'performance-verification/batch-export-gate@1',
  matches: (scenario) => scenario.id === PERFORMANCE_EXPORT,
  materialize: (destination) => {
    writeFixtureFile(
      destination,
      'evidence/performance.json',
      `${JSON.stringify(EXPORT_PERF_DATA, null, 2)}\n`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Export release performance gate

Do not profile/fix the implementation. Analyze \`evidence/performance.json\`. Reject the larger-VM decoy for the relative claim; only the tagged same-host/runtime/corpus/concurrency baseline is comparable. Exclude warmup. Evaluate all five measured runs, relative throughput improvement, latency/errors/hash correctness, RSS, and resource evidence independently.

Write \`.kory-eval/performance-export.json\` with baseline selection, identity, warmup separation, all five run summaries, variance, median throughput and relative improvement math, reference-hash correctness, separate relative-claim verdict, and absolute release-gate verdict. Label supplied synthetic benchmark evidence.
`,
    );
  },
};

const performanceExportScorer: SkillEvalDeterministicScorer = {
  id: 'performance-verification/batch-export-gate-scorer@1',
  scenarioIds: [PERFORMANCE_EXPORT],
  score: ({ workingDirectory }) => {
    const artifact = readJsonArtifact<unknown>(
      workingDirectory,
      '.kory-eval/performance-export.json',
    );
    const body = normalized(artifact);
    const baseline =
      /v8\.2\.1/u.test(body) &&
      /perf-standard-8/u.test(body) &&
      /158/u.test(body) &&
      /v8\.1\.0/u.test(body) &&
      /perf-large-32/u.test(body) &&
      /reject|not comparab|incomparable|decoy/u.test(body);
    const warmup = /warmup/u.test(body) && /exclude|not measured/u.test(body);
    const fiveRuns =
      [193, 194, 192, 195].every((value) => body.includes(String(value))) &&
      [1.42, 1.61, 1.58, 1.47, 1.63].every((value) => body.includes(String(value))) &&
      /p50/u.test(body) &&
      /p95/u.test(body) &&
      /p99/u.test(body);
    const relative =
      /20%|20 percent|>=?\s*20/u.test(body) &&
      /22\.7|22\.8|194[^.]{0,50}158|relative.*pass|speedup.*pass/u.test(body);
    const correctness =
      /fixture-reference-77/u.test(body) && /zero|0 failed|failedrecords/u.test(body);
    const absoluteFail =
      /fail/u.test(body) &&
      /rss|memory/u.test(body) &&
      /1\.5/u.test(body) &&
      /1\.61|1\.58|1\.63/u.test(body) &&
      /variance|repeat|range/u.test(body) &&
      !/profile|root cause|memory leak diagnosis/u.test(body);
    const passed =
      Boolean(artifact) &&
      baseline &&
      warmup &&
      fiveRuns &&
      relative &&
      correctness &&
      absoluteFail;
    return {
      passed,
      quality: passed
        ? 1
        : baseline && fiveRuns && relative && absoluteFail
          ? 0.75
          : fiveRuns && absoluteFail
            ? 0.5
            : 0,
      verification: fiveRuns && correctness && absoluteFail ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `equivalent baseline selected / decoy rejected: ${baseline ? 'yes' : 'no'}`,
        `warmup excluded: ${warmup ? 'yes' : 'no'}`,
        `five measured run distributions/resources: ${fiveRuns ? 'complete' : 'incomplete'}`,
        `>=20% relative throughput claim: ${relative ? 'pass' : 'unproven'}`,
        `reference hash + zero failures: ${correctness ? 'pass' : 'incomplete'}`,
        `absolute RSS gate: ${absoluteFail ? 'FAIL as required' : 'incorrect'}`,
      ],
    };
  },
};

export const VERIFICATION_CHILD_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] =
  [
    functionalImportMaterializer,
    functionalEditorMaterializer,
    performanceApiMaterializer,
    performanceExportMaterializer,
  ];

export const VERIFICATION_CHILD_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  functionalImportScorer,
  functionalEditorScorer,
  performanceApiScorer,
  performanceExportScorer,
];
