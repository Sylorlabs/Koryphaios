import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const DRY = process.argv.includes('--dry-run');
const TODAY = '2026-11-07';
const root = new URL('../..', import.meta.url).pathname;
const stale = JSON.parse(readFileSync(new URL('./stale-sources.json', import.meta.url), 'utf8'));

const bySkill = new Map();
for (const item of stale) {
  if (!bySkill.has(item.skill)) bySkill.set(item.skill, []);
  bySkill.get(item.skill).push(item);
}

const changed = [];
const unresolved = [];

for (const [skill, items] of bySkill) {
  const path = `${root}skills-v5/${skill}/references/sources.md`;
  if (!existsSync(path)) {
    unresolved.push({ skill, why: 'missing sources.md' });
    continue;
  }
  const sidecar = JSON.parse(readFileSync(`${root}skills-v5/${skill}/kory.json`, 'utf8'));
  const refreshed = new Set(
    sidecar.sources.filter((source) => source.verifiedAt === TODAY).map((source) => source.url),
  );
  const originalUrls = new Map(items.map((item) => [item.url, item.verifiedAt]));
  const lines = readFileSync(path, 'utf8').split('\n');
  let edits = 0;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const date = [...originalUrls.values()].find((value) => line.includes(value));
    if (!date) continue;

    // Identify the source this line belongs to: nearest URL above (or on) the line.
    let owner = null;
    for (let cursor = index; cursor >= 0 && cursor > index - 40; cursor--) {
      const found = [...refreshed].find((url) => lines[cursor].includes(url));
      if (found) {
        owner = found;
        break;
      }
      const original = [...originalUrls.keys()].find((url) => lines[cursor].includes(url));
      if (original) {
        owner = original;
        break;
      }
    }

    const isPackageSentence = /reopened on|refreshed |Applied curation/.test(line);
    const ownerRefreshed = owner && refreshed.has(owner);

    if (ownerRefreshed || (isPackageSentence && owner === null && items.length > 0)) {
      lines[index] = line.split(date).join(TODAY);
      edits++;
    }
  }

  if (edits) {
    changed.push({ skill, edits });
    if (!DRY) writeFileSync(path, lines.join('\n'));
  }

  const remaining = lines
    .map((line, index) => ({ line, index }))
    .filter((item) => [...originalUrls.values()].some((value) => item.line.includes(value)));
  if (remaining.length) {
    unresolved.push({
      skill,
      remaining: remaining.map((item) => `${item.index + 1}: ${item.line.trim().slice(0, 120)}`),
    });
  }
}

console.log(JSON.stringify({ dryRun: DRY, changed, unresolved }, null, 2));
