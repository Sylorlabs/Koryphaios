import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AI_PROTOCOL_CONCEPTS,
  AI_PROTOCOL_SKILL_EVAL_MATERIALIZERS,
  AI_PROTOCOL_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-ai-protocol-concept-fixtures';

const aclScenario = 'rag-retrieval-systems-full-task-1-individual';
const fusionScenario = 'rag-retrieval-systems-full-task-2-individual';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(scenarioId: string) {
  const definition = AI_PROTOCOL_CONCEPTS.find((entry) => entry.id === scenarioId)!;
  const materializer = AI_PROTOCOL_SKILL_EVAL_MATERIALIZERS.find(
    (entry) => entry.id === `${scenarioId}/concept@2`,
  )!;
  const scorer = AI_PROTOCOL_SKILL_EVAL_SCORERS.find(
    (entry) => entry.id === `${scenarioId}/concept-scorer@2`,
  )!;
  const root = mkdtempSync(join(tmpdir(), 'kory-rag-contract-'));
  roots.push(root);
  await materializer.materialize(root, { id: scenarioId } as never);
  const score = async (source: string) => {
    writeFileSync(join(root, 'candidate.ts'), source);
    return scorer.score({
      scenario: { id: scenarioId } as never,
      experiment: {} as never,
      workingDirectory: root,
      observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
    });
  };
  return { definition, root, score };
}

const joinedAclCandidate = `
export function solve(input: any) {
  const docs = new Map(input.docs.map((doc: any) => [doc.id, doc]));
  const allowed = new Set(input.userAcl);
  const eligible = input.candidates.flatMap((candidate: any, position: number) => {
    const doc: any = docs.get(candidate.docId);
    return doc?.current === true && doc.status === 'active'
      && doc.acl != null && allowed.has(doc.acl)
      ? [{ doc, score: candidate.score, position }] : [];
  });
  eligible.sort((a: any, b: any) => b.score - a.score || a.position - b.position);
  const selected = eligible.slice(0, input.k);
  return {
    ids: selected.map((item: any) => item.doc.id),
    citations: selected.map((item: any) =>
      item.doc.id + '@' + item.doc.revision + ':' + item.doc.locator),
    noAnswer: selected.length === 0,
  };
}
`;

// Reproduces the archived candidate's mistaken assumption that ACL and revision
// metadata live directly on retrieval candidates instead of authoritative docs.
const inlineAclCandidate = `
export function solve(input: any) {
  const selected = input.candidates.filter((candidate: any) =>
    candidate.current === true && candidate.status === 'active'
    && candidate.acl != null && input.userAcl.includes(candidate.acl))
    .sort((a: any, b: any) => b.score - a.score).slice(0, input.k);
  return {
    ids: selected.map((candidate: any) => candidate.id),
    citations: selected.map((candidate: any) =>
      candidate.id + '@' + candidate.revision + ':' + candidate.locator),
    noAnswer: selected.length === 0,
  };
}
`;

const inlineFusionCandidate = `
export function solve(input: any) {
  const selected = input.chunks.filter((chunk: any) => chunk.current === true)
    .map((chunk: any) => ({ ...chunk, score: chunk.lexical + chunk.semantic }))
    .sort((a: any, b: any) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, input.k);
  return {
    ids: selected.map((chunk: any) => chunk.id),
    citations: selected.map((chunk: any) =>
      chunk.id + '@' + chunk.revision + ':' + chunk.locator),
    scores: selected.map((chunk: any) => Math.round(chunk.score * 1_000) / 1_000),
  };
}
`;

// Reproduces the archived assumption that score signals arrive as two
// independent top-level arrays rather than per-chunk fields.
const separateFusionCandidate = `
export function solve(input: any) {
  const scores = new Map();
  for (const item of input.lexical) scores.set(item.id, item.score);
  for (const item of input.semantic)
    scores.set(item.id, (scores.get(item.id) ?? 0) + item.score);
  return { ids: [], citations: [], scores: [] };
}
`;

describe('RAG concept fixture contract regressions', () => {
  test('ACL materializer explicitly declares the authoritative document join', async () => {
    const { definition, root } = await fixture(aclScenario);
    expect(definition.generation).toBe(2);
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    expect(readme).toContain('candidates:Array<{docId:string,score:number}>');
    expect(readme).toContain('join each candidate.docId to docs[].id');
    expect(readme).toContain('An absent document or missing ACL fails closed');
    for (const vector of definition.vectors()) {
      const input = vector.input as {
        docs: Array<Record<string, unknown>>;
        candidates: Array<Record<string, unknown>>;
      };
      expect(input.docs.every((doc) => 'acl' in doc && 'revision' in doc)).toBe(true);
      expect(
        input.candidates.every(
          (hit) => 'docId' in hit && 'score' in hit && !('acl' in hit) && !('revision' in hit),
        ),
      ).toBe(true);
    }
  });

  test('ACL scorer accepts document metadata join and rejects archived inline-field mistake', async () => {
    const { score } = await fixture(aclScenario);
    const correct = await score(joinedAclCandidate);
    expect(correct).toMatchObject({ passed: true, quality: 1, verification: 1 });
    const incorrect = await score(inlineAclCandidate);
    expect(incorrect).toMatchObject({ passed: false, quality: 0.5, verification: 0 });
    expect(incorrect.evidence).toContain(
      'Failed: ACL revoked stale and missing ACL candidates are removed before top k',
    );
  });

  test('fusion materializer explicitly declares per-chunk scores and current revisions', async () => {
    const { definition, root } = await fixture(fusionScenario);
    expect(definition.generation).toBe(2);
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    expect(readme).toContain('lexical:number,semantic:number');
    expect(readme).toContain('there are no top-level lexical or semantic arrays');
    for (const vector of definition.vectors()) {
      const input = vector.input as Record<string, unknown>;
      expect(Object.keys(input).sort()).toEqual(['chunks', 'k']);
      const chunks = input.chunks as Array<Record<string, unknown>>;
      expect(
        chunks.every((chunk) => 'lexical' in chunk && 'semantic' in chunk && 'current' in chunk),
      ).toBe(true);
    }
  });

  test('fusion scorer accepts inline scores and rejects archived top-level-array mistake', async () => {
    const { score } = await fixture(fusionScenario);
    const correct = await score(inlineFusionCandidate);
    expect(correct).toMatchObject({ passed: true, quality: 1, verification: 1 });
    const incorrect = await score(separateFusionCandidate);
    expect(incorrect).toMatchObject({ passed: false, quality: 0, verification: 0 });
    expect(incorrect.evidence.join(' ')).toContain('Candidate process did not succeed: 1');
  });
});
