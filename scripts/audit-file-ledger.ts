import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readlink, rename, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';

import { getSafeSubprocessEnv } from '../backend/src/runtime/safe-env';

interface FileAuditRow {
  path: string;
  tracked: boolean;
  gitStatus: string;
  kind: 'file' | 'symlink' | 'deleted';
  category:
    | 'runtime'
    | 'test'
    | 'tooling'
    | 'configuration'
    | 'documentation'
    | 'skill'
    | 'asset'
    | 'generated'
    | 'other';
  bytes: number;
  lines?: number;
  sha256: string;
  disposition: string;
  signals: Record<string, number>;
}

const root = process.cwd();
const outputArgument = process.argv.find((argument) => argument.startsWith('--output='));
const runIdEqualsArgument = process.argv.find((argument) => argument.startsWith('--run-id='));
const runIdFlagIndex = process.argv.indexOf('--run-id');
const runId =
  runIdEqualsArgument?.slice('--run-id='.length) ??
  (runIdFlagIndex >= 0 ? process.argv[runIdFlagIndex + 1] : undefined);
if (runId && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
  throw new Error(`Invalid evidence run id: ${runId}`);
}
const outputDirectory = outputArgument
  ? outputArgument.slice('--output='.length)
  : runId
    ? join('.koryphaios', 'evidence', runId, 'audit', 'current')
    : join('.koryphaios', 'evidence', new Date().toISOString().replace(/[:.]/g, '-'), 'audit');
const outputRelativePath = relative(root, resolve(root, outputDirectory)).replaceAll('\\', '/');

async function writeEvidenceFile(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, path);
}

function git(...args: string[]): Buffer {
  const result = Bun.spawnSync(['git', ...args], {
    cwd: root,
    env: getSafeSubprocessEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(
      new TextDecoder().decode(result.stderr).trim() || `git ${args.join(' ')} failed`,
    );
  }
  return Buffer.from(result.stdout);
}

const trackedFiles = new Set(git('ls-files', '-z').toString('utf8').split('\0').filter(Boolean));
const files = git('ls-files', '-co', '--exclude-standard', '-z')
  .toString('utf8')
  .split('\0')
  .filter(Boolean)
  // The ledger is itself generated output. Excluding its destination avoids
  // an impossible self-hash fixed point while leaving every product/source
  // path in the inventory.
  .filter(
    (path) =>
      path !== outputRelativePath && !path.startsWith(`${outputRelativePath.replace(/\/$/, '')}/`),
  )
  .sort((left, right) => left.localeCompare(right));

function statusByPath(): Map<string, string> {
  const fields = git('status', '--porcelain=v1', '-z', '--untracked-files=all')
    .toString('utf8')
    .split('\0');
  const statuses = new Map<string, string>();
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (!field) continue;
    const status = field.slice(0, 2);
    const path = field.slice(3);
    if (status[0] === 'R' || status[0] === 'C') index++;
    statuses.set(path, status);
  }
  return statuses;
}

const statuses = statusByPath();
const assetExtensions = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.png',
  '.webp',
  '.svg',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.mp3',
  '.wav',
  '.ogg',
  '.zip',
  '.gz',
  '.appimage',
  '.deb',
  '.rpm',
]);
const codeExtensions = new Set([
  '.c',
  '.cpp',
  '.css',
  '.html',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.rs',
  '.scss',
  '.svelte',
  '.ts',
  '.tsx',
  '.zig',
  '.sql',
]);

function categoryFor(path: string): FileAuditRow['category'] {
  const lower = path.toLowerCase();
  const extension = extname(path).toLowerCase();
  const name = basename(path).toLowerCase();
  if (
    lower.includes('/generated/') ||
    lower.startsWith('build/') ||
    lower.includes('/build/') ||
    lower.includes('/dist/') ||
    name.endsWith('.lock') ||
    name === 'bun.lock'
  )
    return 'generated';
  if (assetExtensions.has(extension) || lower.includes('/assets/') || lower.includes('/icons/')) {
    return 'asset';
  }
  if (/(^|\/)(skills?|skill-packs?)(\/|$)/.test(lower) || lower.includes('skill-definitions')) {
    return 'skill';
  }
  if (/(^|\/)(__tests__|tests?|e2e)(\/|$)/.test(lower) || /\.(test|spec)\.[^.]+$/.test(lower)) {
    return 'test';
  }
  if (lower.startsWith('scripts/') || lower.startsWith('tools/') || lower.includes('/scripts/')) {
    return 'tooling';
  }
  if (extension === '.sh') return 'tooling';
  if (
    extension === '.md' ||
    extension === '.mdx' ||
    /^(readme|changelog|contributing|license)/.test(name) ||
    lower.startsWith('docs/')
  )
    return 'documentation';
  if (
    /(^|\/)(package\.json|tsconfig[^/]*\.json|bunfig\.toml|cargo\.toml|tauri\.conf\.json|vite\.config\.[^/]+|svelte\.config\.[^/]+)$/.test(
      lower,
    ) ||
    lower.startsWith('.github/') ||
    lower.startsWith('.vscode/') ||
    name.startsWith('.env') ||
    ['.json', '.toml', '.yaml', '.yml'].includes(extension) ||
    name === '.gitignore' ||
    name === '.prettierrc'
  )
    return 'configuration';
  if (codeExtensions.has(extension)) return 'runtime';
  return 'other';
}

function countMatches(text: string, expression: RegExp): number {
  return text.match(expression)?.length ?? 0;
}

function inspectText(path: string, text: string): Record<string, number> {
  const signals: Record<string, number> = {};
  const record = (name: string, expression: RegExp) => {
    const count = countMatches(text, expression);
    if (count > 0) signals[name] = count;
  };
  record('todo_fixme_hack', /\b(?:TODO|FIXME|HACK|XXX)\b/g);
  record('deprecated_markers', /@deprecated|\bdeprecated\b/gi);
  record('console_calls', /\bconsole\.(?:debug|error|info|log|warn)\s*\(/g);
  record('native_select', /<select(?:\s|>)/gi);
  record('native_checkbox', /type\s*=\s*["']checkbox["']/gi);
  record('native_number_spinner', /type\s*=\s*["']number["']/gi);
  record('hardcoded_color', /#[0-9a-f]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/gi);
  record(
    'credential_literal_shape',
    /\b(?:sk|rk)-(?:proj-)?[A-Za-z0-9_-]{12,}|\bAKIA[0-9A-Z]{16}\b/g,
  );
  record(
    'broad_recursive_delete',
    /\brmSync\s*\([^)]*recursive\s*:\s*true|\brm\s+-[a-z]*r[a-z]*f\b/g,
  );
  if (path.startsWith('scripts/')) {
    record('legacy_probe_name', /pw-test\d*|verify-fixes|probe-(?:frontend|network)/gi);
  }
  return signals;
}

function dispositionFor(row: Omit<FileAuditRow, 'disposition'>): string {
  if (row.kind === 'deleted') return 'deleted-baseline-inventoried';
  if (row.category === 'asset') return 'asset-integrity-hashed';
  if (row.category === 'generated') return 'generated-provenance-inventoried';
  if (row.category === 'test') return 'test-source-inventoried';
  if (Object.keys(row.signals).length > 0) return 'static-review-signal';
  return 'static-inventory-no-signal';
}

await mkdir(outputDirectory, { recursive: true });
const rows: FileAuditRow[] = [];
for (const path of files) {
  let kind: FileAuditRow['kind'] = 'file';
  let content: Buffer;
  try {
    const info = await lstat(path);
    kind = info.isSymbolicLink() ? 'symlink' : 'file';
    content = kind === 'symlink' ? Buffer.from(await readlink(path)) : await readFile(path);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    if (!trackedFiles.has(path)) {
      throw new Error(`Untracked file disappeared during audit: ${path}`);
    }
    kind = 'deleted';
    content = git('show', `HEAD:${path}`);
  }
  const binary = content.subarray(0, 8_192).includes(0);
  const text = binary ? undefined : content.toString('utf8');
  const base = {
    path,
    tracked: trackedFiles.has(path),
    gitStatus: statuses.get(path) ?? '  ',
    kind,
    category: categoryFor(path),
    bytes: content.byteLength,
    lines: text === undefined ? undefined : text.length === 0 ? 0 : text.split('\n').length,
    sha256: createHash('sha256').update(content).digest('hex'),
    signals: text === undefined ? {} : inspectText(path, text),
  };
  rows.push({ ...base, disposition: dispositionFor(base) });
}

const byCategory = Object.fromEntries(
  [...new Set(rows.map((row) => row.category))]
    .sort()
    .map((category) => [category, rows.filter((row) => row.category === category).length]),
);
const byDisposition = Object.fromEntries(
  [...new Set(rows.map((row) => row.disposition))]
    .sort()
    .map((disposition) => [
      disposition,
      rows.filter((row) => row.disposition === disposition).length,
    ]),
);
function summarizeSignals(sourceRows: FileAuditRow[]) {
  return Object.fromEntries(
    [...new Set(sourceRows.flatMap((row) => Object.keys(row.signals)))].sort().map((signal) => [
      signal,
      {
        files: sourceRows.filter((row) => signal in row.signals).length,
        matches: sourceRows.reduce((total, row) => total + (row.signals[signal] ?? 0), 0),
      },
    ]),
  );
}

const bySignal = summarizeSignals(rows.filter((row) => row.kind !== 'deleted'));
const byDeletedSignal = summarizeSignals(rows.filter((row) => row.kind === 'deleted'));
const summary = {
  generatedAt: new Date().toISOString(),
  head: git('rev-parse', 'HEAD').toString('utf8').trim(),
  fileCount: rows.length,
  trackedCount: rows.filter((row) => row.tracked).length,
  untrackedCount: rows.filter((row) => !row.tracked).length,
  totalBytes: rows.reduce((total, row) => total + row.bytes, 0),
  byCategory,
  byDisposition,
  bySignal,
  byDeletedSignal,
};

await writeEvidenceFile(
  join(outputDirectory, 'files.jsonl'),
  `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
);
await writeEvidenceFile(
  join(outputDirectory, 'summary.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
);
await writeEvidenceFile(
  join(outputDirectory, 'summary.md'),
  [
    '# Whole-repository file inventory and static-signal ledger',
    '',
    `- Generated: ${summary.generatedAt}`,
    `- HEAD: \`${summary.head}\``,
    `- Files inventoried: ${summary.fileCount} (${summary.trackedCount} tracked, ${summary.untrackedCount} untracked)`,
    `- Bytes hashed and classified: ${summary.totalBytes}`,
    '',
    '## Categories',
    '',
    ...Object.entries(byCategory).map(([category, count]) => `- ${category}: ${count}`),
    '',
    '## Dispositions',
    '',
    ...Object.entries(byDisposition).map(([disposition, count]) => `- ${disposition}: ${count}`),
    '',
    '## Active-file static review signals',
    '',
    ...Object.entries(bySignal).map(
      ([signal, counts]) => `- ${signal}: ${counts.matches} matches across ${counts.files} files`,
    ),
    '',
    '## Deleted-baseline static review signals',
    '',
    ...Object.entries(byDeletedSignal).map(
      ([signal, counts]) => `- ${signal}: ${counts.matches} matches across ${counts.files} files`,
    ),
    '',
    'Every row in `files.jsonl` records path, Git status, content hash, size, category, static signals, and inventory disposition. This ledger proves complete enumeration and gives reviewers reproducible inputs; it does not claim that category/hash assignment is a per-file manual audit. Static signals are review inputs, not automatic defect claims. Generated/vendor-like files and binary assets are inventoried and integrity-hashed rather than rewritten.',
    '',
  ].join('\n'),
);

console.log(JSON.stringify(summary, null, 2));
