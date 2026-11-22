import { describe, expect, test } from 'bun:test';
import { skillEvaluationV5ContractHash } from '../../eval/skills/skill-eval-contract-hash';
import type { V5FullTaskFixture } from '../skill-packages';

describe('V5 qualification/blind review contract identity', () => {
  const base = {
    contractVersion: 3,
    skill: 'factual-research',
    packageVersion: '5.0.0',
    materializerIds: ['materializer/z@1', 'materializer/a@1'],
    scorerIds: ['scorer/z@1', 'scorer/a@1'],
  };

  test('retains the established public-web contract including execution authority', () => {
    const scenario = {
      id: 'factual-research-fixture',
      environment: { kind: 'public-web' },
    } as V5FullTaskFixture;
    expect(skillEvaluationV5ContractHash({ ...base, scenario })).toBe('42bb2690963c9d24');
    expect(
      skillEvaluationV5ContractHash({
        ...base,
        scenario,
        materializerIds: base.materializerIds.toReversed(),
        scorerIds: base.scorerIds.toReversed(),
      }),
    ).toBe('42bb2690963c9d24');
  });

  test('retains the local contract hash without a public-web network policy', () => {
    const scenario = {
      id: 'factual-research-fixture',
      environment: { kind: 'synthetic' },
    } as V5FullTaskFixture;
    expect(skillEvaluationV5ContractHash({ ...base, scenario })).toBe('d58ad6324d7a2b95');
  });
});
