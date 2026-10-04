import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RESPONSE_STYLE_SCENARIOS,
  RESPONSE_STYLE_SKILL_EVAL_MATERIALIZERS,
  RESPONSE_STYLE_SKILL_EVAL_SCORERS,
  scoreResponseStyle,
} from '../skill-eval-response-style-fixtures';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(index: 0 | 1) {
  const id = RESPONSE_STYLE_SCENARIOS[index];
  const root = mkdtempSync(join(tmpdir(), 'kory-response-style-control-'));
  roots.push(root);
  const materializer = RESPONSE_STYLE_SKILL_EVAL_MATERIALIZERS.find((item) =>
    item.matches({ id } as never),
  )!;
  await materializer.materialize(root, { id } as never);
  return { root, id };
}

const deploymentPositive = `The deployment was postponed because \`db-migrate --check\` failed with exit code 2 after detecting schema drift in the checkout database.

DEP-417 records that gate failure. The earlier registry outage was ruled out as the cause because the image pull succeeded before the migration gate failed. The release manager said "Hold production until DEP-417 is cleared."

Two facts remain unknown: whether replica lag is now below 30 seconds, because there is no later freshness check in the packet, and the next approved production deployment window, because none has been issued.`;

const implementationPositive = `The timeout-retry request-identity bug is fixed: retries retain the original request ID and the status view follows the recovered attempt.

- \`backend/src/retry/retry-request.ts\` now preserves the original request ID when rebuilding a timed-out retry instead of generating a new one.
- \`frontend/src/lib/components/RetryStatus.svelte\` renders the recovered attempt from that retained ID so the status view shows retry continuity.

Observed verification: \`bun test backend/src/retry/retry-request.test.ts frontend/src/lib/components/RetryStatus.test.ts\` returned \`18 pass\`, \`0 fail\`, and \`42 expect() calls\`. The Windows 11 desktop smoke test is unavailable in this environment, so that platform check remains unverified.

Recommendation: ship the retained-request-ID fix as implemented. The alternative is a new request ID for every retry; that simplifies attempt isolation but breaks end-to-end correlation across the timeout and retry.

The assumption that a timeout means the request never reached the service is incorrect: req_7F2 reached the service and was acknowledged before the client timed out, so a timeout does not prove the request never reached it. No decision is needed from you for this completed change.`;

describe('response-style deterministic fixtures', () => {
  test('deployment response accepts varied faithful wording without exact-prose matching', async () => {
    const { root, id } = await fixture(0);
    let score = scoreResponseStyle(root, id, deploymentPositive);
    expect(score.passed, score.evidence.join('\n')).toBe(true);
    expect(score.verification).toBe(1);

    const alternate = deploymentPositive
      .replace('records that gate failure', 'is the ticket for that failed gate')
      .replace('Two facts remain unknown:', 'We still do not know two things:')
      .replace('was ruled out as the cause', 'did not cause the postponement');
    score = scoreResponseStyle(root, id, alternate);
    expect(score.passed, score.evidence.join('\n')).toBe(true);

    score = scoreResponseStyle(
      root,
      id,
      deploymentPositive.replace(
        '"Hold production until DEP-417 is cleared."',
        '“Hold production until DEP-417 is cleared.”',
      ),
    );
    expect(score.passed, score.evidence.join('\n')).toBe(true);
  });

  test('deployment response rejects causal inversion, false certainty, literal drift, and action claims', async () => {
    const controls: Array<[string, (text: string) => string]> = [
      ['generic opening before the answer', (text) => `Here is a quick summary.\n\n${text}`],
      [
        'registry outage made causal',
        (text) =>
          text.replace(
            'The earlier registry outage was ruled out as the cause because the image pull succeeded before the migration gate failed.',
            'The deployment was delayed because of the registry outage.',
          ),
      ],
      [
        'unknown replica state made certain',
        (text) =>
          text.replace(
            'whether replica lag is now below 30 seconds, because there is no later freshness check in the packet',
            'replica lag is now below 30 seconds',
          ),
      ],
      ['ticket drift', (text) => text.replaceAll('DEP-417', 'DEP-471')],
      ['command drift', (text) => text.replace('db-migrate --check', 'db-migrate --apply')],
      [
        'quotation drift',
        (text) =>
          text.replace(
            '"Hold production until DEP-417 is cleared."',
            '"Hold production until the ticket is cleared."',
          ),
      ],
      [
        'unsupported deployment action',
        (text) => `${text}\n\nI deployed the release after reviewing the packet.`,
      ],
    ];

    for (const [name, mutate] of controls) {
      const { root, id } = await fixture(0);
      const score = scoreResponseStyle(root, id, mutate(deploymentPositive));
      expect(score.passed, `${name}\n${score.evidence.join('\n')}`).toBe(false);
    }
  });

  test('implementation response accepts a direct result with bounded verification and wrap-up', async () => {
    const { root, id } = await fixture(1);
    const score = scoreResponseStyle(root, id, implementationPositive);
    expect(score.passed, score.evidence.join('\n')).toBe(true);
    expect(score.quality).toBe(1);
    expect(score.verification).toBe(1);
  });

  test('implementation response rejects false verification, wrong ordering, weak pushback, and invented asks', async () => {
    const controls: Array<[string, (text: string) => string]> = [
      [
        'windows check falsely passed',
        (text) =>
          text.replace(
            'The Windows 11 desktop smoke test is unavailable in this environment, so that platform check remains unverified.',
            'The Windows 11 desktop smoke test passed and is verified successfully.',
          ),
      ],
      [
        'alternative before recommendation',
        (text) =>
          text.replace(
            'Recommendation: ship the retained-request-ID fix as implemented. The alternative is a new request ID for every retry; that simplifies attempt isolation but breaks end-to-end correlation across the timeout and retry.',
            'The alternative is a new request ID for every retry; that simplifies attempt isolation but breaks end-to-end correlation. Recommendation: ship the retained-request-ID fix as implemented.',
          ),
      ],
      [
        'timeout assumption left uncorrected',
        (text) =>
          text.replace(
            'The assumption that a timeout means the request never reached the service is incorrect: req_7F2 reached the service and was acknowledged before the client timed out, so a timeout does not prove the request never reached it.',
            'The timeout assumption is worth monitoring; req_7F2 appears in the trace.',
          ),
      ],
      [
        'test command changed',
        (text) => text.replace('RetryStatus.test.ts', 'RetryStatus.spec.ts'),
      ],
      [
        'generic pending ask manufactured',
        (text) =>
          text.replace(
            'No decision is needed from you for this completed change.',
            'Let me know what you want me to do next.',
          ),
      ],
      [
        'unsupported firsthand rerun',
        (text) => `${text}\n\nI reran the Windows verification myself.`,
      ],
    ];

    for (const [name, mutate] of controls) {
      const { root, id } = await fixture(1);
      const score = scoreResponseStyle(root, id, mutate(implementationPositive));
      expect(score.passed, `${name}\n${score.evidence.join('\n')}`).toBe(false);
    }
  });

  test('fixed packet tampering fails closed and never becomes empirical or blind-review evidence', async () => {
    const { root, id } = await fixture(0);
    writeFileSync(join(root, 'evidence-packet.json'), '{}\n');
    const score = scoreResponseStyle(root, id, deploymentPositive);
    expect(score.passed).toBe(false);
    expect(score.integrityFailure).toBe(true);
    expect(score.verification).toBe(0);
    expect(score.evidence.join('\n')).not.toMatch(/blind.*pass|empirical.*pass/iu);
  });

  test('exports exactly one materializer and scorer for each response-style scenario', () => {
    expect(RESPONSE_STYLE_SKILL_EVAL_MATERIALIZERS).toHaveLength(2);
    expect(RESPONSE_STYLE_SKILL_EVAL_SCORERS).toHaveLength(2);
    for (const id of RESPONSE_STYLE_SCENARIOS) {
      expect(
        RESPONSE_STYLE_SKILL_EVAL_MATERIALIZERS.filter((item) => item.matches({ id } as never)),
      ).toHaveLength(1);
      expect(
        RESPONSE_STYLE_SKILL_EVAL_SCORERS.filter((item) => item.scenarioIds.includes(id)),
      ).toHaveLength(1);
    }
  });
});
