import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const DRY = process.argv.includes('--dry-run');
const TODAY = '2026-11-07';

const root = new URL('../..', import.meta.url).pathname;
const list = JSON.parse(readFileSync(new URL('./stale-sources.json', import.meta.url), 'utf8'));
const verification = JSON.parse(
  readFileSync(new URL('./source-verification.json', import.meta.url), 'utf8'),
);
const approvals = JSON.parse(readFileSync(new URL('./approvals.json', import.meta.url), 'utf8'));
const probe = JSON.parse(readFileSync(new URL('./stale-probe.json', import.meta.url), 'utf8'));

const approved = new Map(approvals.approvals.map((item) => [item.url, item.reason]));
const rewrites = new Map(
  Object.entries(approvals.urlRewrites).map(([from, value]) => [from, value.to]),
);

// Evidence index: verified document per originally cited URL.
const evidence = new Map();
for (const item of verification) {
  evidence.set(item.originalUrl, item);
}
const probeByUrl = new Map(probe.map((item) => [item.url, item.probe]));

function evidenceFor(url) {
  const verified = evidence.get(url);
  if (verified) {
    if (verified.status !== 200) return { ok: false, why: `status ${verified.status}` };
    if (verified.keywordCoverage >= 0.4) return { ok: true, source: 'keyword-coverage' };
    if (approved.has(url)) return { ok: true, source: 'manual-approval' };
    return { ok: false, why: `low coverage ${verified.keywordCoverage}` };
  }
  const probed = probeByUrl.get(url);
  if (probed && probed.status === 200 && approved.has(url)) {
    return { ok: true, source: 'probe-and-approval' };
  }
  const target = rewrites.get(url);
  if (target) {
    const probedTarget = probeByUrl.get(url);
    const direct = verification.find((item) => item.checkedUrl === target);
    if (direct && direct.status === 200 && approved.has(target)) {
      return { ok: true, source: 'rewrite-verified' };
    }
    if (probedTarget && probedTarget.status === 200 && probedTarget.finalUrl === target) {
      return { ok: true, source: 'redirect-target-verified' };
    }
  }
  return { ok: false, why: 'no evidence record' };
}

const bySkill = new Map();
for (const entry of list) {
  if (!bySkill.has(entry.skill)) bySkill.set(entry.skill, []);
  bySkill.get(entry.skill).push(entry);
}

const decisions = [];
const skipped = [];
for (const [skill, entries] of bySkill) {
  for (const entry of entries) {
    const rewrite = rewrites.get(entry.url);
    const urlForEvidence = entry.url;
    const check = evidenceFor(urlForEvidence);
    if (!check.ok) {
      skipped.push({ skill, url: entry.url, why: check.why });
      continue;
    }
    decisions.push({
      skill,
      oldUrl: entry.url,
      newUrl: rewrite ?? entry.url,
      oldVerifiedAt: entry.verifiedAt,
      source: check.source,
      rewriteReason: rewrite ? approvals.urlRewrites[entry.url].reason : null,
    });
  }
}

const changedFiles = [];
const report = [];

for (const [skill, items] of groupBy(decisions, (item) => item.skill)) {
  const sidecarPath = `${root}skills-v5/${skill}/kory.json`;
  const sidecarText = readFileSync(sidecarPath, 'utf8');
  const sidecar = JSON.parse(sidecarText);

  for (const item of items) {
    const source = sidecar.sources.find((entry) => entry.url === item.oldUrl);
    if (!source) throw new Error(`source missing in sidecar: ${skill} ${item.oldUrl}`);
    source.url = item.newUrl;
    source.verifiedAt = TODAY;
    if (typeof source.versionScope === 'string') {
      source.versionScope = source.versionScope
        .split(item.oldVerifiedAt)
        .join(TODAY);
      source.versionScope = source.versionScope
        .split(item.oldUrl)
        .join(item.newUrl);
    }
  }

  const nextSidecar = `${JSON.stringify(sidecar, null, 2)}\n`;
  if (nextSidecar !== sidecarText) {
    changedFiles.push(sidecarPath);
    if (!DRY) writeFileSync(sidecarPath, nextSidecar);
  }

  const sourcesPath = `${root}skills-v5/${skill}/references/sources.md`;
  const before = readFileSync(sourcesPath, 'utf8');
  let after = before;
  const lingering = [];

  for (const item of items) {
    const lines = after.split('\n');
    const result = [];
    let touched = false;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const hasUrl = line.includes(item.oldUrl) || line.includes(item.newUrl);
      const isTableRow = hasUrl && line.trimStart().startsWith('|');
      const isBullet = hasUrl && /^\s*[-*]\s/.test(line);

      if (isTableRow) {
        let updated = line
          .split(item.oldVerifiedAt)
          .join(TODAY)
          .split(item.oldUrl)
          .join(item.newUrl);
        result.push(updated);
        touched = true;
        continue;
      }

      if (isBullet) {
        let updated = line
          .split(item.oldUrl)
          .join(item.newUrl)
          .split(item.oldVerifiedAt)
          .join(TODAY);
        result.push(updated);
        touched = true;
        // Continuation lines belong to the same bullet until the next bullet.
        let cursor = index + 1;
        while (cursor < lines.length && /^\s{2,}\S/.test(lines[cursor])) {
          result.push(
            lines[cursor]
              .split(item.oldUrl)
              .join(item.newUrl)
              .split(item.oldVerifiedAt)
              .join(TODAY),
          );
          lines[cursor] = '';
          cursor++;
        }
        index = cursor - 1;
        continue;
      }

      result.push(line);
    }
    after = result.join('\n');
    if (!touched) lingering.push(item.oldUrl);
  }

  if (after !== before) {
    changedFiles.push(sourcesPath);
    if (!DRY) writeFileSync(sourcesPath, after);
  }

  report.push({
    skill,
    refreshed: items.length,
    lingeringSourceDocBlocks: lingering,
    dateMentionsLeft: [...after.matchAll(/20\d\d-\d\d-\d\d/g)]
      .map((match) => match[0])
      .filter((value, index, all) => all.indexOf(value) === index)
      .filter((value) => items.some((item) => item.oldVerifiedAt === value)),
  });
}

function groupBy(items, key) {
  const map = new Map();
  for (const item of items) {
    const k = key(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

console.log(
  JSON.stringify(
    {
      dryRun: DRY,
      packagesRefreshed: report.length,
      sourcesRefreshed: decisions.length,
      sourcesSkipped: skipped,
      changedFileCount: changedFiles.length,
      report,
    },
    null,
    2,
  ),
);
if (!DRY) {
  console.log(
    execSync('git diff --stat -- skills-v5 | tail -5', { cwd: root, encoding: 'utf8' }),
  );
}
