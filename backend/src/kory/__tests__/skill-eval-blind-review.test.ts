import { describe, expect, test } from 'bun:test';
import {
  blindJudgeQuoteIsStructural,
  buildBlindReviewJudgePrompt,
  findBlindJudgeRubricViolation,
} from '../skill-eval-blind-review';
import type { V5FullTaskFixture } from '../skill-packages';

describe('blind review prompt', () => {
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
    expect(prompt).not.toContain('Artifact A is with');
    expect(prompt).not.toContain('Artifact B is with');
    expect(prompt).not.toContain('with-skill');
    expect(prompt).not.toContain('without-skill');
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
});
