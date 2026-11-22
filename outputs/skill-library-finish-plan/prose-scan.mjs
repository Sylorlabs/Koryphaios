import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { lintProse } from '../../skills-v5/dash-free-writing/scripts/check-prose.mjs';

const root = new URL('../..', import.meta.url).pathname;
const base = join(root, 'skills-v5');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.md')) out.push(full);
  }
  return out;
}

const files = walk(base);
const results = [];
for (const file of files) {
  const report = lintProse(readFileSync(file, 'utf8'));
  if (report.findings.length) {
    results.push({
      file: relative(root, file),
      findings: report.findings.map((finding) => ({
        kind: finding.kind,
        text: finding.text ?? finding.match ?? null,
        line: finding.line,
      })),
    });
  }
}

const byKind = new Map();
for (const result of results) {
  for (const finding of result.findings) {
    byKind.set(finding.kind, (byKind.get(finding.kind) ?? 0) + 1);
  }
}

console.log(
  JSON.stringify(
    {
      scanned: files.length,
      filesWithFindings: results.length,
      totalFindings: results.reduce((sum, item) => sum + item.findings.length, 0),
      byKind: Object.fromEntries([...byKind].sort((a, b) => b[1] - a[1])),
      sample: results.slice(0, 40),
    },
    null,
    2,
  ),
);
process.exitCode = results.length ? 1 : 0;
