import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createConceptFixtures,
  scoreConceptFixture,
} from '../../eval/skills/skill-eval-concept-fixtures';
import { SYSTEMS_PROTOCOL_CONCEPTS } from '../../eval/skills/skill-eval-systems-protocol-concept-fixtures';

const definition = SYSTEMS_PROTOCOL_CONCEPTS.find(
  (item) => item.id === 'llm-application-engineering-full-task-2-individual',
)!;
const fixture = createConceptFixtures([definition]);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function materialize(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'kory-llm-refund-contract-test-'));
  roots.push(root);
  await fixture.materializers[0]!.materialize(root, {} as never);
  return root;
}

const validDecision = String.raw`
export function solve(input: any) {
  const {sessionUser, accountUser, confirmed, order, proposal, priorReceipts} = input;
  const reject = (reason: string, audit: string[]) => ({decision:'reject',idempotencyKey:null,audit,reason});
  if (sessionUser !== accountUser) return reject('unauthorized', []);
  const audit = ['authorized'];
  const key = 'refund:' + proposal.orderId + ':' + proposal.expectedVersion + ':' + proposal.amount;
  if (priorReceipts.includes(key)) {
    return {decision:'already-complete',idempotencyKey:key,audit:['authorized','receipt-found'],reason:null};
  }
  if (!order.refundable || order.refunded || proposal.orderId !== order.id) {
    return reject('ineligible', audit);
  }
  audit.push('eligible');
  if (confirmed !== true) return reject('confirmation-required', audit);
  audit.push('confirmed');
  if (proposal.expectedVersion !== order.version) return reject('stale-state', audit);
  audit.push('fresh');
  return {decision:'execute',idempotencyKey:key,audit,reason:null};
}`;

describe('LLM application refund fixture contract', () => {
  test('documents its actual input/output schema and versions the semantic change', async () => {
    expect(definition.generation).toBe(2);
    expect(fixture.materializers[0]!.id).toEndWith('/concept@2');
    expect(fixture.scorers[0]!.id).toEndWith('/concept-scorer@2');
    const root = await materialize();
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    for (const term of [
      'Input is exactly {sessionUser,accountUser,confirmed,order,proposal,priorReceipts}',
      'Return exactly {decision,idempotencyKey,audit,reason}',
      'These are top-level fields',
      "reason:'unauthorized'",
      "decision:'already-complete'",
      "reason:'stale-state'",
      "decision:'execute'",
    ]) {
      expect(readme).toContain(term);
    }
  });

  test('accepts 4/4 valid decisions but rejects archived-style shape and receipt regressions', async () => {
    const root = await materialize();
    const candidate = join(root, 'candidate.ts');
    expect(scoreConceptFixture(definition, root).passed).toBe(false);

    writeFileSync(candidate, validDecision);
    expect(scoreConceptFixture(definition, root)).toMatchObject({
      passed: true,
      quality: 1,
      verification: 1,
      integrityFailure: false,
    });

    // Archived 2026-09-26 candidates emitted `status` and `key` rather than the
    // oracle's `decision` and `idempotencyKey`; the scorer must keep rejecting it.
    writeFileSync(
      candidate,
      validDecision.replaceAll('decision:', 'status:').replaceAll('idempotencyKey:', 'key:'),
    );
    expect(scoreConceptFixture(definition, root)).toMatchObject({
      passed: false,
      quality: 0,
      verification: 0,
      integrityFailure: false,
    });

    writeFileSync(
      candidate,
      validDecision.replace('if (priorReceipts.includes(key))', 'if (false)'),
    );
    expect(scoreConceptFixture(definition, root)).toMatchObject({
      passed: false,
      quality: 0.75,
      verification: 0,
      integrityFailure: false,
    });
  });
});
