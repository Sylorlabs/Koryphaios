import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { normalizeSkillTokens } from '../backend/src/kory/skills';

const projectRoot = resolve(import.meta.dir, '..');
const skillsRoot = join(projectRoot, 'skills-v5');
const stopWords = new Set(
  'and are for from into our please that the their this with your use when request specifically requires prefer narrower child only boundary established design engineer engineering build create implement implementation improve review test testing verify verification actual current existing system task work help make using used needs need can should would could want wants based around through across about before after without not no just than then also where which while under over all any each every one two new real relevant correct explicit professional evidence behavior change changes result results support handling handle user users application service services project code data interface workflow process state model models skill skills'.split(
    ' ',
  ),
);

const skillNames = readdirSync(skillsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const vocabularies = new Map<string, string[]>();
const documentFrequency = new Map<string, number>();

for (const name of skillNames) {
  const sidecar = JSON.parse(readFileSync(join(skillsRoot, name, 'kory.json'), 'utf8')) as {
    activation?: string[];
    domains?: string[];
    routing?: { positive?: string[] };
  };
  const markdown = readFileSync(join(skillsRoot, name, 'SKILL.md'), 'utf8');
  const description = markdown.match(/^description:\s*(.*)$/m)?.[1] ?? '';
  const vocabulary = [
    ...new Set(
      normalizeSkillTokens(
        `${name.replaceAll('-', ' ')} ${description} ${(sidecar.activation ?? []).join(' ')} ${(sidecar.domains ?? []).join(' ')} ${markdown}`,
      ).filter((token) => token.length > 2 && !stopWords.has(token)),
    ),
  ];
  vocabularies.set(name, vocabulary);
  for (const token of vocabulary) {
    documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  }
}

const rows = readFileSync(join(skillsRoot, 'independent-routing.jsonl'), 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => JSON.parse(line) as { skill: string; prompt: string });

const diagnostics = rows.map((row) => {
  const promptTokens = new Set(
    normalizeSkillTokens(row.prompt).filter((token) => token.length > 2 && !stopWords.has(token)),
  );
  const scores = [...vocabularies].map(([name, vocabulary]) => {
    const hits = vocabulary
      .filter((token) => promptTokens.has(token))
      .map((token) => ({
        token,
        weight: Math.log((skillNames.length + 1) / ((documentFrequency.get(token) ?? 0) + 1)) + 1,
      }));
    return {
      name,
      score: hits.reduce((sum, hit) => sum + hit.weight, 0),
      hits,
    };
  });
  scores.sort((left, right) => right.score - left.score);
  const target = scores.find((score) => score.name === row.skill)!;
  return {
    skill: row.skill,
    score: Number(target.score.toFixed(2)),
    rank: scores.findIndex((score) => score.name === row.skill) + 1,
    hits: target.hits.slice(0, 8).map((hit) => hit.token),
    top: scores.slice(0, 3).map((score) => ({
      skill: score.name,
      score: Number(score.score.toFixed(2)),
      hits: score.hits.slice(0, 5).map((hit) => hit.token),
    })),
  };
});

console.log(
  JSON.stringify(
    {
      cases: diagnostics.length,
      rank1: diagnostics.filter((item) => item.rank === 1).length,
      rank3: diagnostics.filter((item) => item.rank <= 3).length,
      rank5: diagnostics.filter((item) => item.rank <= 5).length,
      scoreAtLeast5: diagnostics.filter((item) => item.score >= 5).length,
      scoreAtLeast8: diagnostics.filter((item) => item.score >= 8).length,
      weak: diagnostics.filter((item) => item.score < 5 || item.rank > 5),
    },
    null,
    2,
  ),
);
