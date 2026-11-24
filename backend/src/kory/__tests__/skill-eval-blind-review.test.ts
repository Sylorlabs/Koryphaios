import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  blindJudgeQuoteIsStructural,
  buildBlindReviewJudgePrompt,
  findBlindJudgeArtifactMismatch,
  findBlindJudgeRubricViolation,
  selectBlindReviewQueue,
  verifyBlindReviewPublicContractSnapshot,
} from '../../eval/skills/skill-eval-blind-review';
import type { SkillEvalPublicContractSnapshot } from '../../eval/skills/skill-eval-execution';
import type { V5FullTaskFixture } from '../skill-packages';

describe('blind review prompt', () => {
  const publicContract = (taskPrompt = 'Exact candidate task prompt.') => {
    const text = (value: string) => ({
      available: true as const,
      sha256: createHash('sha256').update(value).digest('hex'),
      byteLength: Buffer.byteLength(value),
      text: value,
    });
    return {
      taskPrompt: text(taskPrompt),
      fixtureFiles: {
        'README.md': text('# Public task\n'),
        'contract.json': text('{"public":true}\n'),
      },
    } satisfies SkillEvalPublicContractSnapshot;
  };

  test('distinguishes JSON delimiters from commas inside malformed quoted prose', () => {
    expect(blindJudgeQuoteIsStructural(',"next evidence"]}')).toBeTrue();
    expect(blindJudgeQuoteIsStructural('\\]},"preference":"B"')).toBeTrue();
    expect(blindJudgeQuoteIsStructural(':"value"')).toBeTrue();
    expect(blindJudgeQuoteIsStructural(', which weakens reproducibility.')).toBeFalse();
  });

  test('supplies anonymous harness owned pair evidence without exposing arm identity', () => {
    const task = {
      id: 'blind-pair-evidence-test',
      maturity: 'individual',
      prompt: 'Produce the requested artifact and support every completion claim.',
      falsifiableChecks: ['completion claims are supported'],
      requiredEvidence: ['paired skill/no-skill run artifacts', 'task verification'],
      requiredArtifacts: ['paired-evaluation', 'final-output'],
    } as V5FullTaskFixture;
    const artifact = {
      finalOutput: 'Completed artifact.',
      executionEvidence: ['verification passed'],
      changes: [],
    };
    const prompt = buildBlindReviewJudgePrompt({
      task,
      artifactA: artifact,
      artifactB: artifact,
      pairEvidence: {
        matchedPair: true,
        sameScenario: true,
        sameProviderModel: true,
        sameHarness: true,
        sameEvaluationContract: true,
        sameMaterializer: true,
        sameDeterministicScorer: true,
        randomizedArmIdentity: true,
        evidenceOwner: 'evaluation-harness',
      },
    });

    expect(prompt).toContain('PAIR EXECUTION EVIDENCE');
    expect(prompt).toContain('the anonymous A and B bundle plus PAIR EXECUTION EVIDENCE satisfies');
    expect(prompt).toContain(
      'Do not require either agent output to claim, create, or narrate evaluator owned pair evidence.',
    );
    expect(prompt).toContain('"matchedPair": true');
    expect(prompt).toContain('"sameProviderModel": true');
    expect(prompt).toContain('"evidenceOwner": "evaluation-harness"');
    expect(prompt).toContain(
      'When choosing preference A, B, or tie, compare concrete task behavior and evidence only.',
    );
    expect(prompt).not.toContain('Artifact A is with');
    expect(prompt).not.toContain('Artifact B is with');
    expect(prompt).not.toContain('with-skill');
    expect(prompt).not.toContain('without-skill');
  });

  test('uses the archived candidate-visible prompt instead of regenerating the current task prompt', () => {
    const task = {
      id: 'immutable-public-contract-test',
      prompt: 'Current mutable task text must not be used.',
      falsifiableChecks: [],
      requiredEvidence: [],
      requiredArtifacts: [],
    } as unknown as V5FullTaskFixture;
    const artifact = {
      finalOutput: 'done',
      executionEvidence: [],
      changes: [],
      publicContract: {
        taskPrompt: publicContract('Archived candidate-visible task text.').taskPrompt,
        fixtureFiles: publicContract().fixtureFiles,
      },
    };
    const prompt = buildBlindReviewJudgePrompt({
      task,
      artifactA: artifact,
      artifactB: artifact,
      pairEvidence: {
        matchedPair: true,
        sameScenario: true,
        sameProviderModel: true,
        sameHarness: true,
        sameEvaluationContract: true,
        sameMaterializer: true,
        sameDeterministicScorer: true,
        randomizedArmIdentity: true,
        evidenceOwner: 'evaluation-harness',
      },
    });
    expect(prompt).toContain('Archived candidate-visible task text.');
    expect(prompt).not.toContain('Current mutable task text must not be used.');
    expect(prompt).toContain('PUBLIC CANDIDATE CONTRACT SNAPSHOT');
    expect(prompt).toContain('"sha256"');
    expect(prompt).not.toContain('with-skill');
    expect(prompt).not.toContain('without-skill');
  });

  test('marks historical packets unavailable when no archived public contract exists', () => {
    const task = {
      prompt: 'Current task text is not historical proof.',
      falsifiableChecks: [],
      requiredEvidence: [],
      requiredArtifacts: [],
    } as unknown as V5FullTaskFixture;
    const artifact = { finalOutput: '', executionEvidence: [], changes: [] };
    const prompt = buildBlindReviewJudgePrompt({
      task,
      artifactA: artifact,
      artifactB: artifact,
      pairEvidence: {
        matchedPair: true,
        sameScenario: true,
        sameProviderModel: true,
        sameHarness: true,
        sameEvaluationContract: true,
        sameMaterializer: true,
        sameDeterministicScorer: true,
        randomizedArmIdentity: true,
        evidenceOwner: 'evaluation-harness',
      },
    });
    expect(prompt).toContain('[UNAVAILABLE: no verified pre-execution task-prompt snapshot');
    expect(prompt).not.toContain('Current task text is not historical proof.');
    expect(prompt).toContain('"reason": "not-archived"');
  });

  test('rejects tampered archived public bytes and never trusts regenerated fixture text', () => {
    const snapshot = publicContract();
    const archived = (value: string) => Buffer.from(value);
    expect(() =>
      verifyBlindReviewPublicContractSnapshot({
        snapshot,
        taskPromptBytes: archived('Exact candidate task prompt.'),
        fixtureFileBytes: {
          'README.md': archived('# Public task\n'),
          'contract.json': archived('{"public":false}\n'),
        },
      }),
    ).toThrow('hash mismatch for contract.json');
    const verified = verifyBlindReviewPublicContractSnapshot({
      snapshot,
      taskPromptBytes: archived('Exact candidate task prompt.'),
      fixtureFileBytes: {
        'README.md': archived('# Public task\n'),
        'contract.json': archived('{"public":true}\n'),
      },
    });
    expect(verified.fixtureFiles['contract.json'].text).toBe('{"public":true}\n');
  });

  test('distinguishes later host verification from candidate claims without trusting scorers blindly', () => {
    const task = {
      prompt: 'Revise a candidate package and bound qualification to observed evidence.',
      falsifiableChecks: [],
      requiredEvidence: [],
      requiredArtifacts: [],
    } as unknown as V5FullTaskFixture;
    const artifact = {
      finalOutput: 'The candidate could not run the resolver; promotion remains pending.',
      executionEvidence: ['real-resolver held-out routing: pass (1.000/1.000)'],
      changes: [],
    };
    const prompt = buildBlindReviewJudgePrompt({
      task,
      artifactA: artifact,
      artifactB: artifact,
      pairEvidence: {
        matchedPair: true,
        sameScenario: true,
        sameProviderModel: true,
        sameHarness: true,
        sameEvaluationContract: true,
        sameMaterializer: true,
        sameDeterministicScorer: true,
        randomizedArmIdentity: true,
        evidenceOwner: 'evaluation-harness',
      },
    });
    expect(prompt).toContain('supplied by the host after the agent attempt');
    expect(prompt).toContain('that difference alone is not an integrity failure');
    expect(prompt).toContain('finalOutput or authored file content');
    expect(prompt).toContain('possible verifier defect');
    expect(prompt).toContain(artifact.finalOutput);
    expect(prompt).toContain(artifact.executionEvidence[0]!);
    expect(
      findBlindJudgeRubricViolation({
        artifactA: { evidence: ['The agent falsely claimed its own tests passed.'] },
        artifactB: { evidence: [] },
        rationale: [],
      }),
    ).toBeNull();
  });

  test('rejects criticism that penalizes evaluator owned hierarchy or pairing narration', () => {
    expect(
      findBlindJudgeRubricViolation({
        artifactA: {
          evidence: [
            'The artifact lacks explicit hierarchy boundary and specialist selection rationale.',
          ],
        },
        artifactB: { evidence: [] },
        rationale: [],
      }),
    ).toContain('hierarchy boundary');
    expect(
      findBlindJudgeRubricViolation({
        artifactA: { evidence: [] },
        artifactB: { evidence: [] },
        rationale: ['Missing paired skill versus no skill run artifacts.'],
      }),
    ).toContain('paired skill');
  });

  // Literal excerpts from the stored recommendation-ranking review. Keep them
  // local: the tests must not depend on the mutable evaluation ledger/reports.
  test('preserves a recommendation-ranking artifact defect while removing a hierarchy tail', () => {
    const result = {
      artifactA: {
        evidence: [
          'No hierarchy boundary or specialist rationale established (near-neighbor computer-vision decoy not addressed)',
        ],
      },
      artifactB: { evidence: [] },
      rationale: [],
    };
    expect(findBlindJudgeRubricViolation(result)).toBeNull();
    expect(result.artifactA.evidence).toEqual([
      'near-neighbor computer-vision decoy not addressed',
    ]);
  });

  test('preserves recovery and verification evidence when hierarchy narration is appended', () => {
    const result = {
      artifactA: {
        evidence: [
          'Concrete recovery and verification are present, but no hierarchy boundary or specialist rationale is established.',
        ],
      },
      artifactB: { evidence: [] },
      rationale: [],
    };
    expect(findBlindJudgeRubricViolation(result)).toBeNull();
    expect(result.artifactA.evidence).toEqual(['Concrete recovery and verification are present,']);
  });

  test('preserves the Linux evidence gap while removing a hierarchy tail', () => {
    const result = {
      artifactA: {
        evidence: [
          'Linux evidence gap: reboot recovery and service verification were not demonstrated; the output lacks hierarchy narration.',
        ],
      },
      artifactB: { evidence: [] },
      rationale: [],
    };
    expect(findBlindJudgeRubricViolation(result)).toBeNull();
    expect(result.artifactA.evidence).toEqual([
      'Linux evidence gap: reboot recovery and service verification were not demonstrated',
    ]);
  });

  test('preserves an unsupported schema deviation while removing skill-guidance scope blame', () => {
    const result = {
      artifactA: {
        evidence: [
          'Unsupported schema deviation: field "mode" is outside the documented contract; the response also fails to follow skill-guidance scope.',
        ],
      },
      artifactB: { evidence: [] },
      rationale: [],
    };
    expect(findBlindJudgeRubricViolation(result)).toBeNull();
    expect(result.artifactA.evidence).toEqual([
      'Unsupported schema deviation: field "mode" is outside the documented contract',
    ]);
  });

  test('removes evaluator-owned hierarchy rationale from persisted preference evidence', () => {
    const result = {
      artifactA: { evidence: [] },
      artifactB: { evidence: [] },
      rationale: [
        'Artifact A is preferred for stronger recovery verification, but it lacks hierarchy selection rationale.',
      ],
    };
    expect(findBlindJudgeRubricViolation(result)).toBeNull();
    expect(result.rationale).toEqual([
      'Artifact A is preferred for stronger recovery verification,',
    ]);
  });

  test('preserves concrete evidence labels while removing paired-evaluation list items', () => {
    const result = {
      artifactA: { evidence: [] },
      artifactB: {
        evidence: [
          'Neither produces required evidence artifacts (scenario result, verification, paired evaluation)',
        ],
      },
      rationale: [],
    };
    expect(findBlindJudgeRubricViolation(result)).toBeNull();
    expect(result.artifactB.evidence[0]).toContain('scenario result');
    expect(result.artifactB.evidence[0]).toContain('verification');
    expect(result.artifactB.evidence[0]).not.toContain('paired evaluation');
  });

  test.each([
    'No explicit specialist selection rationale is supplied.',
    'Neither artifact provides skill selection rationale.',
    'Neither agent documents routing selection evidence.',
    'The artifact does not address the hierarchy boundary.',
    'The output fails to document skill routing rationale.',
    'Missing evidence for hierarchy selection.',
    'The output is missing paired-evaluation evidence.',
    'The output lacks paired skill/no-skill run artifacts.',
    'No skill-vs-no-skill comparison is shown.',
    'The hierarchy selection rationale is absent.',
    'Paired evaluation evidence was not provided.',
    'The hierarchy selection rationale is missing from the output, lowering quality.',
    'The output lacks hierarchy rationale and a concrete recovery path.',
  ])('rejects scoped omission criticism: %s', (statement) => {
    expect(
      findBlindJudgeRubricViolation({
        artifactA: { evidence: [statement] },
        artifactB: { evidence: [] },
        rationale: [],
      }),
    ).toBe(statement);
  });

  test.each([
    'No penalty is assigned for paired evaluation. Missing hierarchy selection rationale lowers quality.',
    'Paired evaluation is not penalized; neither artifact provides hierarchy narration.',
    'Paired evaluation is not penalized, but neither artifact provides hierarchy narration.',
    'Missing hierarchy narration, but no penalty is assigned for paired evaluation.',
    'The reviewer records hierarchy narration as not to penalize.',
  ])('allows explicit neutral exemption wording: %s', (statement) => {
    const result = {
      artifactA: { evidence: [statement] },
      artifactB: { evidence: [] },
      rationale: [],
    };
    expect(findBlindJudgeRubricViolation(result)).toBeNull();
    expect(result.artifactA.evidence).toEqual([]);
  });

  test.each([
    'The paired evaluation is evaluator-owned and the hierarchy boundary is respected.',
    'There is no hierarchy boundary violation in either artifact.',
    'No hierarchy boundary issues were found.',
    'No hierarchy boundary was crossed by the candidate.',
    'There is no need to narrate specialist selection rationale.',
    'The artifact does not lack hierarchy selection rationale.',
    'The artifact is not missing paired evaluation evidence.',
    'No penalty for missing hierarchy narration or paired-evaluation evidence.',
    'Neither artifact narrates hierarchy selection, but no penalty is assigned for that omission.',
    'The artifact lacks hierarchy narration, but no penalty is assigned for hierarchy narration.',
    'Missing rollback verification. Paired evaluation evidence is supplied by the harness.',
    'The artifact lacks cold-start metrics; hierarchy selection is evaluator-owned.',
    'Missing rollback verification while paired evaluation evidence is supplied by the harness.',
    'Missing rollback verification, and paired evaluation evidence is supplied by the harness.',
    'The paired evaluation is supplied by the harness, but rollback verification is missing.',
    'No representative success, negative-path, or recovery verification evidence',
    'Neither produces required evidence artifacts (scenario result, verification, rollback)',
    'Missing train-serving parity, fallback, feedback-loop, launch and rollback artifacts',
    'The category hierarchy lacks cycle detection and loses child nodes.',
    'No HTTP routing fallback handles an unavailable upstream.',
    'The request routing selection lacks fallback and permits requests to stale replicas.',
    'The role hierarchy boundary permits privilege escalation because inherited permissions lack validation.',
    'The paired evaluation of ranking models lacks cold-start metrics.',
    'The paired evaluation is missing cold-start metrics.',
    'The hierarchy boundary is missing authorization checks.',
    'Missing cold-start metrics for the paired evaluation.',
    'The hierarchy boundary is respected, but the admin endpoint lacks an authorization check.',
  ])('allows neutral meta mentions and concrete artifact defects: %s', (statement) => {
    expect(
      findBlindJudgeRubricViolation({
        artifactA: { evidence: [] },
        artifactB: { evidence: [statement] },
        rationale: [],
      }),
    ).toBeNull();
  });

  test('allows explicit non-penalty statements about evaluator owned meta evidence', () => {
    expect(
      findBlindJudgeRubricViolation({
        artifactA: {
          evidence: [
            'Evaluator-owned paired execution evidence satisfies the routing/hierarchy and paired-run provenance requirements; no penalty is assigned for lack of agent-authored hierarchy narration.',
          ],
        },
        artifactB: { evidence: [] },
        rationale: [],
      }),
    ).toBeNull();
  });

  test('allows concrete task boundary criticism', () => {
    expect(
      findBlindJudgeRubricViolation({
        artifactA: {
          evidence: [
            'The admin endpoint lacks an authorization boundary before the destructive action.',
          ],
        },
        artifactB: { evidence: [] },
        rationale: [],
      }),
    ).toBeNull();
  });

  test('rejects reviewer invention of Markdown origins absent from the actual JSON candidate', () => {
    const criticism = {
      artifactA: {
        evidence: [
          'Critical defect: cors.origins contains a Markdown-formatted URL rather than a literal origin.',
        ],
      },
      artifactB: { evidence: [] },
      rationale: [],
    };
    const file = (allowedOrigin: string, corsOrigin = 'https://app.example.com') => ({
      finalOutput: '',
      executionEvidence: [],
      changes: [
        {
          path: '.kory-eval/analytics-web.json',
          change: 'added',
          beforeSha256: null,
          afterSha256: 'example',
          afterText: JSON.stringify({
            cors: { origins: [corsOrigin] },
            reportFetch: { allowedOrigin },
          }),
        },
      ],
    });
    const literal = file('https://reports.example.net');
    expect(findBlindJudgeArtifactMismatch(criticism, literal, literal)).toContain('accused');
    const malformedReport = file('[https://reports.example.net](https://reports.example.net)');
    expect(findBlindJudgeArtifactMismatch(criticism, malformedReport, literal)).toContain(
      'accused',
    );
    const malformedCors = file(
      'https://reports.example.net',
      '[https://app.example.com](https://app.example.com)',
    );
    expect(findBlindJudgeArtifactMismatch(criticism, malformedCors, literal)).toBeNull();
    const reportCriticism = {
      ...criticism,
      artifactA: {
        evidence: ['reportFetch.allowedOrigin contains a Markdown-formatted URL string.'],
      },
    };
    expect(findBlindJudgeArtifactMismatch(reportCriticism, malformedReport, literal)).toBeNull();
    expect(findBlindJudgeArtifactMismatch(reportCriticism, malformedCors, literal)).toContain(
      'accused',
    );
    expect(
      findBlindJudgeArtifactMismatch(
        {
          artifactA: { evidence: ['The credentialed API lacks CSRF enforcement.'] },
          artifactB: { evidence: [] },
          rationale: [],
        },
        literal,
        literal,
      ),
    ).toBeNull();
  });
});

describe('blind review queue', () => {
  const pair = (
    scenarioId: string,
    comparisonId: string,
    pairRecordedAt = '2026-10-02T00:00:00Z',
  ) => ({
    skill: 'android-compose',
    scenarioId,
    comparisonId,
    pairRecordedAt,
  });

  test('a replaced pair gets a fresh adjudication even when the case was judged before', () => {
    const queue = selectBlindReviewQueue(
      [pair('case-2', 'pair-new')],
      [
        {
          skill: 'android-compose',
          scenarioId: 'case-1',
          comparisonId: 'pair-a',
          recordedAt: '2026-10-01T00:00:00Z',
        },
        {
          skill: 'android-compose',
          scenarioId: 'case-1',
          comparisonId: 'pair-b',
          recordedAt: '2026-10-01T00:00:00Z',
        },
        {
          skill: 'android-compose',
          scenarioId: 'case-2',
          comparisonId: 'pair-old',
          recordedAt: '2026-10-01T00:00:00Z',
        },
      ],
      2,
    );
    expect(queue.map((item) => item.comparisonId)).toEqual(['pair-new']);
  });

  test('a pair already judged at its own identity is never re-reviewed', () => {
    const queue = selectBlindReviewQueue(
      [pair('case-2', 'pair-old')],
      [
        {
          skill: 'android-compose',
          scenarioId: 'case-2',
          comparisonId: 'pair-old',
          recordedAt: '2026-10-01T00:00:00Z',
        },
      ],
      2,
    );
    expect(queue).toEqual([]);
  });

  test('the per-skill cap bounds this invocation, not the skill history', () => {
    const history = Array.from({ length: 4 }, (_, index) => ({
      skill: 'android-compose',
      scenarioId: 'case-1',
      comparisonId: `pair-${index}`,
      recordedAt: '2026-10-01T00:00:00Z',
    }));
    const queue = selectBlindReviewQueue(
      [pair('case-2', 'pair-x'), pair('case-3', 'pair-y'), pair('case-4', 'pair-z')],
      history,
      2,
    );
    expect(queue.map((item) => item.comparisonId)).toEqual(['pair-x', 'pair-y']);
  });
});
