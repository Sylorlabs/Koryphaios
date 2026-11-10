import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromiumBlockers } from '../skill-eval-real-web-runtime';
import { browserControlTest } from './browser-runtime-test-policy';
import {
  BROWSER_EVAL_CONSTANTS,
  BROWSER_SKILL_EVAL_MATERIALIZERS,
  dashboardAssetBlockers,
} from '../skill-eval-browser-fixtures';
import { BUILTIN_SKILL_EVAL_SCORERS } from '../skill-eval-fixtures';
import { readJsonArtifact, writeFixtureFile } from '../skill-eval-fixture-helpers';
import type { SkillEvalScenarioV3 } from '../skill-eval-harness';
import {
  runVisualVerificationBrowserScenario,
  VISUAL_VERIFICATION_BROWSER_RUNTIME_SCORER,
  VISUAL_VERIFICATION_BROWSER_SCENARIO,
  type BrowserVisualCapture,
  type IndependentVisualInspection,
} from '../skill-eval-visual-verification-runtime';

const roots: string[] = [];
const PNG_HEADER = Buffer.from('89504e470d0a1a0a', 'hex');
const browserTest = browserControlTest('Visual Chromium', [...chromiumBlockers(), ...dashboardAssetBlockers()]);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'kory-visual-runtime-'));
  roots.push(root);
  const materializer = BROWSER_SKILL_EVAL_MATERIALIZERS.find((item) =>
    item.matches({ id: VISUAL_VERIFICATION_BROWSER_SCENARIO } as SkillEvalScenarioV3),
  );
  if (!materializer) throw new Error('Real dashboard materializer not registered');
  await materializer.materialize(root, {
    id: VISUAL_VERIFICATION_BROWSER_SCENARIO,
  } as SkillEvalScenarioV3);
  return root;
}

function writeMeasuredCandidateAudit(
  root: string,
  captures: readonly BrowserVisualCapture[],
  browserVersion: string,
  failures: readonly string[],
): void {
  const fields = [
    'captureId', 'width', 'height', 'theme', 'state', 'horizontalOverflow',
    'chartClipped', 'legendClipped', 'stickyOverlap', 'primaryActionDistinct',
  ] as const;
  const entries = captures.map((capture) => Object.fromEntries(
    fields.map((field) => [field, capture[field]]),
  ));
  writeFixtureFile(root, 'verification/visual-verification-scenario-1-capture-matrix.json',
    `${JSON.stringify({
      environment: {
        browserVersion,
        dpr: 1,
        font: BROWSER_EVAL_CONSTANTS.dashboardFont,
        animations: 'disabled',
        dataset: 'fixture-v1',
      },
      entries,
    }, null, 2)}\n`);
  writeFixtureFile(root, 'verification/visual-verification-scenario-1-claim-audit.json',
    `${JSON.stringify({
      failures,
      renderingNoisePolicy: 'Control browser runtime, font, DPR, animation and dataset before comparing rendering noise.',
    }, null, 2)}\n`);
  writeFixtureFile(root, 'verification/visual-verification-scenario-1-verdict.md',
    '# Visual verification verdict\n\n390px dense state overflows in light and dark. Control browser runtime, DPR, fonts, and animation before classifying rendering noise.\n');
}

describe('independent V5 browser visual verification runtime', () => {
  browserTest('collects 24 real viewport PNGs, browser semantics, keyboard evidence, and known layout failures', async () => {
    const root = await fixture();
    const result = await runVisualVerificationBrowserScenario(root);

    expect(result.score.integrityFailure, result.score.evidence.join('\n')).toBe(false);
    expect(result.browserVersion).toMatch(/\d+\.\d+/u);
    expect(result.captures).toHaveLength(24);
    expect(new Set(result.captures.map((capture) => capture.captureId)).size).toBe(24);
    expect(result.artifactDirectory).toMatch(/^evaluation\/visual-verification\/runtime\//u);
    expect(result.score.evidence).toContainEqual(expect.stringContaining('keyboard focus: pass'));

    for (const capture of result.captures) {
      const png = readFileSync(join(root, capture.screenshot));
      expect(png.subarray(0, 8)).toEqual(PNG_HEADER);
      expect(png.length).toBeGreaterThan(1_000);
      expect(png.readUInt32BE(16)).toBe(capture.width);
      expect(png.readUInt32BE(20)).toBe(capture.height);
      expect(createHash('sha256').update(png).digest('hex')).toBe(capture.screenshotSha256);
      expect(capture.stateConfirmed).toBe(true);
      expect(capture.environmentConfirmed).toBe(true);
      expect(capture.semanticEvidence).toEqual({
        mainCount: 1,
        headingCount: 1,
        primaryActionCount: 1,
      });
      expect(capture.ariaSnapshot).toContain('main');
      expect(capture.ariaSnapshot).toContain('Investigate');
      expect(capture.keyboardFocus.length).toBeGreaterThan(0);
    }

    const expected = BROWSER_EVAL_CONSTANTS.dashboardViewports.flatMap(({ width, height }) =>
      BROWSER_EVAL_CONSTANTS.dashboardThemes.flatMap((theme) =>
        BROWSER_EVAL_CONSTANTS.dashboardStates.map((state) => `${width}x${height}-${theme}-${state}`),
      ),
    );
    expect(result.captures.map((capture) => capture.captureId)).toEqual(expected);
    for (const viewport of BROWSER_EVAL_CONSTANTS.dashboardViewports) {
      const images = result.captures.filter((capture) =>
        capture.width === viewport.width && capture.height === viewport.height,
      );
      expect(new Set(images.map((capture) => capture.screenshotSha256)).size).toBe(8);
    }
    for (const theme of BROWSER_EVAL_CONSTANTS.dashboardThemes) {
      expect(result.observedFailures).toContain(`390x844-${theme}-dense:horizontal-overflow`);
    }

    const receipt = readJsonArtifact<{
      browserVersion: string;
      captures: Array<{ screenshotSha256: string }>;
      passed: boolean;
      humanReviewVerified: boolean;
      screenReaderVerified: boolean;
      limitations: string[];
    }>(root, `${result.artifactDirectory}/receipt.json`);
    expect(receipt?.browserVersion).toBe(result.browserVersion);
    expect(receipt?.captures.map((capture) => capture.screenshotSha256))
      .toEqual(result.captures.map((capture) => capture.screenshotSha256));
    expect(receipt?.limitations.join(' ')).toContain('not live screen-reader evidence');
    expect(receipt?.passed).toBe(false);
    expect(receipt?.humanReviewVerified).toBe(false);
    expect(receipt?.screenReaderVerified).toBe(false);
    expect(result.humanReviewVerified).toBe(false);
    expect(result.screenReaderVerified).toBe(false);
    expect(result.score.passed).toBe(false);
    expect(result.score.verification).toBe(0);
  }, 90_000);

  browserTest('does not promote matching candidate evidence or forged human and assistive technology reviews', async () => {
    const root = await fixture();
    const initial = await runVisualVerificationBrowserScenario(root);
    expect(initial.captures, initial.score.evidence.join('\n')).toHaveLength(24);
    expect(initial.browserVersion).not.toBeNull();
    writeMeasuredCandidateAudit(root, initial.captures, initial.browserVersion!, initial.observedFailures);
    writeFixtureFile(root, 'verification/claimed-human-review.json',
      JSON.stringify({ status: 'approved', reviewer: 'invented candidate approval' }));
    writeFixtureFile(root, 'verification/claimed-screen-reader.json',
      JSON.stringify({ status: 'approved', assistiveTechnology: 'simulated only' }));

    // Pretend a provider submitted reviews: one is marked simulated, another has
    // an incorrect capture hash. Neither is independent evidence of interaction.
    const forgedAuthority = async (captures: readonly BrowserVisualCapture[], browser: string) => {
      const human = captures.map((capture, index) => ({
        captureId: capture.captureId,
        screenshotSha256: capture.screenshotSha256,
        reviewerId: 'not-a-real-reviewer',
        reviewedAt: new Date().toISOString(),
        simulated: index === 0,
        verdict: 'fail',
        observation: 'Automated assertion cannot substitute for inspection.',
      }));
      const screenReader = captures.filter((capture) =>
        (capture.captureId.startsWith('390x844-light-') ||
          capture.captureId.startsWith('1440x900-dark-')),
      ).map((capture, index) => ({
        captureId: capture.captureId,
        screenshotSha256: index === 0 ? '0'.repeat(64) : capture.screenshotSha256,
        sessionId: 'synthetic-session',
        assistiveTechnology: 'invented AT',
        assistiveTechnologyVersion: '0',
        browserVersion: browser,
        simulated: false,
        announcement: 'Generated by fixture',
        interaction: 'Simulated keyboard path',
      }));
      return { human, screenReader } as unknown as IndependentVisualInspection;
    };

    const result = await runVisualVerificationBrowserScenario(root, forgedAuthority);
    expect(result.score.integrityFailure, result.score.evidence.join('\n')).toBe(false);
    expect(result.captures, result.score.evidence.join('\n')).toHaveLength(24);
    expect(result.score.evidence).toContain('Candidate state matrix: pass');
    expect(result.score.evidence).toContain('Candidate measured-failure audit: pass');
    expect(result.score.evidence).toContain('Candidate visual verdict: pass');
    expect(result.humanReviewVerified).toBe(false);
    expect(result.screenReaderVerified).toBe(false);
    expect(result.score.passed).toBe(false);
    expect(result.score.verification).toBe(0);
  }, 90_000);

  test('rejects edited pinned input before the browser opens', async () => {
    const root = await fixture();
    writeFixtureFile(root, 'src/styles.css', '/* candidate modified fixed CSS */\n');
    const result = await runVisualVerificationBrowserScenario(root);
    expect(result.score.passed).toBe(false);
    expect(result.score.integrityFailure).toBe(true);
    expect(result.captures).toHaveLength(0);
    expect(result.browserVersion).toBeNull();
    expect(result.artifactDirectory).toBeNull();
    expect(result.score.evidence.join('\n')).toContain('Fixed dashboard input changed: src/styles.css');
  });

  test('is an opt-in scorer scoped to the browser fixture, never the native inspector', () => {
    expect(VISUAL_VERIFICATION_BROWSER_RUNTIME_SCORER.scenarioIds).toEqual([
      VISUAL_VERIFICATION_BROWSER_SCENARIO,
    ]);
    expect(VISUAL_VERIFICATION_BROWSER_RUNTIME_SCORER.scenarioIds)
      .not.toContain('visual-verification-full-task-2');
    expect(BUILTIN_SKILL_EVAL_SCORERS.map((scorer) => scorer.id))
      .not.toContain(VISUAL_VERIFICATION_BROWSER_RUNTIME_SCORER.id);
  });
});
