import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { hasRegressionText, writeFixtureFile } from './skill-eval-fixture-helpers';

const RENAME = 'shell-cli-engineering-full-task-1-individual';
const PIPELINE = 'shell-cli-engineering-full-task-2-individual';

const RENAME_STARTER = `#!/bin/bash
set -u
dry=0
if [[ \${1:-} == --dry-run ]]; then dry=1; shift; fi
mapping=\${1:?mapping required}
root=\${2:?root required}
while IFS=, read -r src dst; do
  [[ -z \${src:-} ]] && continue
  if (( dry )); then
    printf 'mv %s %s\\n' "$src" "$dst"
  else
    # BUG: no preflight, collision/cycle handling, or rollback.
    mv "$root/$src" "$root/$dst"
  fi
done < "$mapping"
`;

const PIPELINE_STARTER = `#!/bin/bash
set -u
producer=\${1:?producer required}
parser=\${2:?parser required}
consumer=\${3:?consumer required}
# BUG: only the final pipeline status is observed.
"$producer" | "$parser" | "$consumer"
`;

function executable(root: string, path: string): boolean {
  try {
    const stat = lstatSync(join(root, path));
    return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function run(root: string, args: string[], input?: string) {
  return spawnSync('/bin/bash', args, {
    cwd: root,
    input,
    encoding: 'utf8',
    timeout: 8_000,
    maxBuffer: 512_000,
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: root,
      TMPDIR: root,
      LANG: 'C',
      LC_ALL: 'C',
      NO_COLOR: '1',
    },
  });
}

function tree(root: string): string[] {
  const walk = (current: string, prefix = ''): string[] =>
    readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry) => {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) return walk(join(current, entry.name), rel);
        if (entry.isSymbolicLink())
          return [`${rel}->${readFileSync(join(current, entry.name), 'utf8')}`];
        return [`${rel}:${readFileSync(join(current, entry.name), 'utf8')}`];
      });
  return walk(root);
}

function renameScorer(root: string): SkillEvalDeterministicScore {
  if (!executable(root, 'rename.sh')) {
    return {
      passed: false,
      quality: 0,
      verification: 0,
      integrityFailure: false,
      evidence: ['rename.sh is missing, symlinked, or not executable'],
    };
  }
  const hidden = mkdtempSync(join(tmpdir(), 'kory-shell-rename-'));
  const checks: Array<[string, boolean]> = [];
  try {
    const script = join(root, 'rename.sh');
    const make = (name: string, files: Record<string, string>, mapping: string) => {
      const caseRoot = join(hidden, name);
      spawnSync('/bin/mkdir', ['-p', caseRoot]);
      for (const [path, content] of Object.entries(files))
        writeFileSync(join(caseRoot, path), content);
      const mapPath = join(hidden, `${name}.csv`);
      writeFileSync(mapPath, mapping);
      return { caseRoot, mapPath };
    };

    {
      const c = make(
        'spaces',
        { 'one file.txt': 'one', 'two.txt': 'two' },
        'one file.txt,renamed file.txt\ntwo.txt,two done.txt\n',
      );
      const r = run(root, [script, c.mapPath, c.caseRoot]);
      checks.push([
        'paths with spaces rename safely',
        r.status === 0 &&
          readFileSync(join(c.caseRoot, 'renamed file.txt'), 'utf8') === 'one' &&
          readFileSync(join(c.caseRoot, 'two done.txt'), 'utf8') === 'two',
      ]);
    }
    {
      const c = make('dry', { 'a.txt': 'a' }, 'a.txt,b.txt\n');
      const before = tree(c.caseRoot);
      const r = run(root, [script, '--dry-run', c.mapPath, c.caseRoot]);
      checks.push([
        'dry-run has no mutation',
        r.status === 0 &&
          JSON.stringify(tree(c.caseRoot)) === JSON.stringify(before) &&
          !existsSync(join(c.caseRoot, 'b.txt')),
      ]);
    }
    {
      const c = make('collision', { 'a.txt': 'a', 'b.txt': 'KEEP' }, 'a.txt,b.txt\n');
      const before = tree(c.caseRoot);
      const r = run(root, [script, c.mapPath, c.caseRoot]);
      checks.push([
        'destination collision fails before mutation',
        r.status !== 0 && JSON.stringify(tree(c.caseRoot)) === JSON.stringify(before),
      ]);
    }
    {
      const c = make('cycle', { 'a.txt': 'A', 'b.txt': 'B' }, 'a.txt,b.txt\nb.txt,a.txt\n');
      const r = run(root, [script, c.mapPath, c.caseRoot]);
      checks.push([
        'rename cycle preserves both payloads',
        r.status === 0 &&
          readFileSync(join(c.caseRoot, 'a.txt'), 'utf8') === 'B' &&
          readFileSync(join(c.caseRoot, 'b.txt'), 'utf8') === 'A',
      ]);
    }
    {
      const c = make('missing', { 'a.txt': 'A', 'b.txt': 'B' }, 'a.txt,c.txt\nmissing.txt,d.txt\n');
      const before = tree(c.caseRoot);
      const r = run(root, [script, c.mapPath, c.caseRoot]);
      checks.push([
        'missing source preflight prevents partial rename',
        r.status !== 0 && JSON.stringify(tree(c.caseRoot)) === JSON.stringify(before),
      ]);
    }
    const regression = hasRegressionText(root, [
      /dry|collision|cycle|rollback|preflight/iu,
      /space|path/iu,
    ]);
    checks.push(['candidate regression coverage present', regression]);
  } finally {
    rmSync(hidden, { recursive: true, force: true });
  }
  const passed = checks.every(([, ok]) => ok);
  return {
    passed,
    quality: checks.filter(([, ok]) => ok).length / checks.length,
    verification: passed ? 1 : 0,
    integrityFailure: false,
    evidence: checks.map(([name, ok]) => `${name}: ${ok ? 'pass' : 'fail'}`),
  };
}

function pipelineScorer(root: string): SkillEvalDeterministicScore {
  if (!executable(root, 'pipeline.sh')) {
    return {
      passed: false,
      quality: 0,
      verification: 0,
      integrityFailure: false,
      evidence: ['pipeline.sh is missing, symlinked, or not executable'],
    };
  }
  const hidden = mkdtempSync(join(tmpdir(), 'kory-shell-pipeline-'));
  const checks: Array<[string, boolean]> = [];
  try {
    const script = join(root, 'pipeline.sh');
    const helper = (name: string, body: string) => {
      const path = join(hidden, name);
      writeFileSync(path, `#!/bin/bash\nset -u\n${body}\n`, { mode: 0o700 });
      return path;
    };
    const passProducer = helper('producer-ok', "printf '%s\\n' '{\"ok\":1}' '{\"ok\":2}'");
    const failProducer = helper(
      'producer-fail',
      "printf '%s\\n' '{\"ok\":1}'; echo producer-broke >&2; exit 23",
    );
    const parser = helper(
      'parser',
      'while IFS= read -r line; do printf \'%s\' "$line" | /usr/bin/jq -c . || exit 31; done',
    );
    const consumer = helper(
      'consumer',
      'count=0; while IFS= read -r _line; do count=$((count+1)); done; printf \'%s\\n\' "$count"',
    );
    const failConsumer = helper(
      'consumer-fail',
      'IFS= read -r _line || exit 0; echo consumer-broke >&2; exit 41',
    );
    const malformed = helper('producer-malformed', "printf '%s\\n' '{bad json}'");

    const success = run(root, [script, passProducer, parser, consumer]);
    checks.push([
      'successful streaming output',
      success.status === 0 && success.stdout.trim() === '2',
    ]);
    const producerFailure = run(root, [script, failProducer, parser, consumer]);
    checks.push([
      'producer failure is not swallowed',
      producerFailure.status !== 0 && /producer-broke/u.test(producerFailure.stderr),
    ]);
    const parseFailure = run(root, [script, malformed, parser, consumer]);
    checks.push(['parser failure is not swallowed', parseFailure.status !== 0]);
    const consumerFailure = run(root, [script, passProducer, parser, failConsumer]);
    checks.push([
      'consumer early failure is nonzero',
      consumerFailure.status !== 0 && /consumer-broke/u.test(consumerFailure.stderr),
    ]);
    const emptyProducer = helper('producer-empty', 'exit 0');
    const empty = run(root, [script, emptyProducer, parser, consumer]);
    checks.push([
      'empty input remains successful',
      empty.status === 0 && empty.stdout.trim() === '0',
    ]);
    const source = readFileSync(script, 'utf8');
    checks.push(['declared shell failure semantics', /pipefail|PIPESTATUS|wait/iu.test(source)]);
    const regression = hasRegressionText(root, [
      /producer|pipe|status|failure/iu,
      /consumer|malformed|empty/iu,
    ]);
    checks.push(['candidate regression coverage present', regression]);
  } finally {
    rmSync(hidden, { recursive: true, force: true });
  }
  const passed = checks.every(([, ok]) => ok);
  return {
    passed,
    quality: checks.filter(([, ok]) => ok).length / checks.length,
    verification: passed ? 1 : 0,
    integrityFailure: false,
    evidence: checks.map(([name, ok]) => `${name}: ${ok ? 'pass' : 'fail'}`),
  };
}

export const SHELL_CLI_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  {
    id: 'shell-cli-engineering/safe-batch-rename@1',
    matches: (scenario) => scenario.id === RENAME,
    materialize: (root) => {
      writeFixtureFile(root, 'rename.sh', RENAME_STARTER);
      chmodSync(join(root, 'rename.sh'), 0o700);
      writeFixtureFile(
        root,
        'tests/rename.test.sh',
        '# Add collision, cycle, dry-run, path, and rollback regressions here.\n',
      );
      writeFixtureFile(
        root,
        'README.md',
        '# Safe batch rename CLI\n\nFix rename.sh. Preserve --dry-run, never overwrite an existing destination, preflight all sources/destinations, handle rename cycles without data loss, and ensure a preflight failure cannot partially mutate the tree. CSV grammar is one unquoted source,destination pair per line; commas/newlines inside a filename are outside this fixture contract.\n',
      );
    },
  },
  {
    id: 'shell-cli-engineering/json-pipeline-status@1',
    matches: (scenario) => scenario.id === PIPELINE,
    materialize: (root) => {
      writeFixtureFile(root, 'pipeline.sh', PIPELINE_STARTER);
      chmodSync(join(root, 'pipeline.sh'), 0o700);
      writeFixtureFile(
        root,
        'tests/pipeline.test.sh',
        '# Add producer, parser, consumer, malformed, empty, and interruption regressions here.\n',
      );
      writeFixtureFile(
        root,
        'README.md',
        '# JSON streaming pipeline CLI\n\nFix pipeline.sh. The declared runtime is Bash 3.2+ so pipefail/PIPESTATUS are available. Preserve streaming behavior, stderr, and the semantic failure status of any pipeline stage. Do not buffer the full stream in memory.\n',
      );
    },
  },
];

export const SHELL_CLI_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  {
    id: 'shell-cli-engineering/safe-batch-rename-scorer@1',
    scenarioIds: [RENAME],
    score: ({ workingDirectory }) => renameScorer(workingDirectory),
  },
  {
    id: 'shell-cli-engineering/json-pipeline-status-scorer@1',
    scenarioIds: [PIPELINE],
    score: ({ workingDirectory }) => pipelineScorer(workingDirectory),
  },
];
