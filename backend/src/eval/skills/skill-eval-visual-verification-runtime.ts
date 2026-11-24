import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from './skill-eval-real-web-runtime';
import {
  BROWSER_EVAL_CONSTANTS,
  BROWSER_SKILL_EVAL_MATERIALIZERS,
} from './skill-eval-browser-fixtures';
import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
} from './skill-eval-execution';
import { readJsonArtifact, readFixtureText, writeFixtureFile } from './skill-eval-fixture-helpers';
import type { SkillEvalScenarioV3 } from './skill-eval-harness';

/** Browser-only evidence for V5 task 1. Task 2 requires a native macOS inspector. */
export const VISUAL_VERIFICATION_BROWSER_SCENARIO = 'visual-verification-full-task-1';

const {
  dashboardViewports: VIEWPORTS,
  dashboardThemes: THEMES,
  dashboardStates: STATES,
} = BROWSER_EVAL_CONSTANTS;
const FIXED_ASSETS = [
  ['index.html', 'text/html; charset=utf-8'],
  ['src/styles.css', 'text/css; charset=utf-8'],
  ['src/app.js', 'text/javascript; charset=utf-8'],
  ['assets/inter.woff2', 'font/woff2'],
  ['evidence/reference.json', 'application/json; charset=utf-8'],
] as const;
const PNG_HEADER = Buffer.from('89504e470d0a1a0a', 'hex');

export interface BrowserVisualCapture {
  captureId: string;
  width: number;
  height: number;
  theme: 'light' | 'dark';
  state: 'loading' | 'empty' | 'normal' | 'dense';
  screenshot: string;
  screenshotSha256: string;
  horizontalOverflow: boolean;
  chartClipped: boolean;
  legendClipped: boolean;
  stickyOverlap: boolean;
  primaryActionDistinct: boolean;
  stateConfirmed: boolean;
  environmentConfirmed: boolean;
  /** This is the browser's accessibility tree representation, NOT a screen reader test. */
  ariaSnapshot: string;
  keyboardFocus: string;
  semanticEvidence: {
    mainCount: number;
    headingCount: number;
    primaryActionCount: number;
  };
}

export interface HumanVisualInspection {
  captureId: string;
  screenshotSha256: string;
  reviewerId: string;
  reviewedAt: string;
  simulated: false;
  verdict: 'pass' | 'fail';
  observation: string;
}

export interface LiveScreenReaderInspection {
  captureId: string;
  screenshotSha256: string;
  sessionId: string;
  assistiveTechnology: string;
  assistiveTechnologyVersion: string;
  browserVersion: string;
  simulated: false;
  announcement: string;
  interaction: string;
}

export interface IndependentVisualInspection {
  human: readonly HumanVisualInspection[];
  screenReader: readonly LiveScreenReaderInspection[];
}

/**
 * Evaluator-owned authority ONLY. The candidate workspace, a model assertion,
 * an ARIA snapshot, and an automated a11y scanner cannot attest human or AT use.
 * The caller must authenticate this authority and its underlying review records.
 */
export type IndependentVisualReviewAuthority = (
  captures: readonly BrowserVisualCapture[],
  browserVersion: string,
) => Promise<IndependentVisualInspection>;

export interface BrowserVisualVerificationResult {
  score: SkillEvalDeterministicScore;
  browserVersion: string | null;
  captures: readonly BrowserVisualCapture[];
  artifactDirectory: string | null;
  observedFailures: readonly string[];
  humanReviewVerified: boolean;
  screenReaderVerified: boolean;
}

const sha256 = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');
const detail = (error: unknown): string =>
  error instanceof Error ? error.message.slice(0, 600) : String(error).slice(0, 600);

/** Read only fixed fixture files; refuse symlinked files or fixture subdirectories. */
function safeAsset(root: string, path: string): Buffer {
  let current = resolve(root);
  for (const part of path.split('/')) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Symlinked fixture input: ${path}`);
  }
  const stat = lstatSync(current);
  if (!stat.isFile() || stat.size > 3_000_000)
    throw new Error(`Unsafe or oversized fixture input: ${path}`);
  return readFileSync(current);
}

/** Compare against a fresh copy of the actual pinned fixture, never candidate hashes. */
async function pinnedDashboardAssets(
  root: string,
): Promise<Map<string, { bytes: Buffer; mime: string }>> {
  const reference = mkdtempSync(join(tmpdir(), 'kory-visual-reference-'));
  try {
    const materializer = BROWSER_SKILL_EVAL_MATERIALIZERS.find((item) =>
      item.matches({ id: VISUAL_VERIFICATION_BROWSER_SCENARIO } as SkillEvalScenarioV3),
    );
    if (!materializer) throw new Error('Pinned dashboard materializer unavailable');
    await materializer.materialize(reference, {
      id: VISUAL_VERIFICATION_BROWSER_SCENARIO,
    } as SkillEvalScenarioV3);
    const assets = new Map<string, { bytes: Buffer; mime: string }>();
    for (const [path, mime] of FIXED_ASSETS) {
      const pinned = safeAsset(reference, path);
      const actual = safeAsset(root, path);
      if (!actual.equals(pinned)) throw new Error(`Fixed dashboard input changed: ${path}`);
      assets.set(`/${path}`, { bytes: pinned, mime });
    }
    return assets;
  } finally {
    rmSync(reference, { recursive: true, force: true });
  }
}

async function withPinnedBrowserPage<T>(
  assets: Map<string, { bytes: Buffer; mime: string }>,
  run: (url: string) => Promise<T>,
): Promise<T> {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const asset = assets.get(pathname === '/' ? '/index.html' : pathname);
    if (pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
    } else if (!asset || request.method !== 'GET') {
      response.writeHead(404);
      response.end('not found');
    } else {
      response.writeHead(200, {
        'content-type': asset.mime,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      response.end(asset.bytes);
    }
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.closeAllConnections();
    throw new Error('Browser fixture server did not bind');
  }
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}

/** Creates evaluator-owned, per-run artifacts without accepting symlinked parents. */
function newArtifactDirectory(root: string): { absolute: string; relative: string } {
  const relative = `evaluation/visual-verification/runtime/${randomUUID()}`;
  let absolute = resolve(root);
  for (const part of relative.split('/')) {
    absolute = join(absolute, part);
    if (!existsSync(absolute)) mkdirSync(absolute, { mode: 0o700 });
    const stat = lstatSync(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Unsafe visual-verification artifact directory');
  }
  return { absolute, relative };
}

function metricFailures(capture: BrowserVisualCapture): string[] {
  return [
    capture.horizontalOverflow && `${capture.captureId}:horizontal-overflow`,
    capture.chartClipped && `${capture.captureId}:chart-clipping`,
    capture.legendClipped && `${capture.captureId}:legend-clipping`,
    capture.stickyOverlap && `${capture.captureId}:sticky-header-overlap`,
    !capture.primaryActionDistinct && `${capture.captureId}:primary-action-not-distinct`,
  ].filter((issue): issue is string => typeof issue === 'string');
}

function candidateAuditMatches(
  root: string,
  captures: readonly BrowserVisualCapture[],
  browser: string,
) {
  const matrix = readJsonArtifact<{
    environment?: Record<string, unknown>;
    entries?: Array<Record<string, unknown>>;
  }>(root, 'verification/visual-verification-scenario-1-capture-matrix.json');
  const entries = Array.isArray(matrix?.entries) ? matrix.entries : [];
  const fields = [
    'captureId',
    'width',
    'height',
    'theme',
    'state',
    'horizontalOverflow',
    'chartClipped',
    'legendClipped',
    'stickyOverlap',
    'primaryActionDistinct',
  ] as const;
  const matrixMatches =
    entries.length === captures.length &&
    new Set(entries.map((row) => row?.captureId)).size === captures.length &&
    captures.every((capture) => {
      const candidate = entries.find((row) => row?.captureId === capture.captureId);
      return !!candidate && fields.every((field) => candidate[field] === capture[field]);
    }) &&
    matrix?.environment?.browserVersion === browser &&
    matrix.environment.dpr === 1 &&
    matrix.environment.font === BROWSER_EVAL_CONSTANTS.dashboardFont &&
    matrix.environment.animations === 'disabled' &&
    matrix.environment.dataset === 'fixture-v1';

  const audit = readJsonArtifact<{ failures?: unknown; renderingNoisePolicy?: unknown }>(
    root,
    'verification/visual-verification-scenario-1-claim-audit.json',
  );
  const expected = captures.flatMap(metricFailures).sort();
  const actual =
    Array.isArray(audit?.failures) && audit.failures.every((row) => typeof row === 'string')
      ? [...audit.failures].sort()
      : [];
  const auditMatches =
    JSON.stringify(expected) === JSON.stringify(actual) &&
    typeof audit?.renderingNoisePolicy === 'string' &&
    /noise|font|dpr|animation|runtime/iu.test(audit.renderingNoisePolicy);

  let verdict = '';
  try {
    verdict = readFixtureText(root, 'verification/visual-verification-scenario-1-verdict.md');
  } catch {
    /* Missing candidate evidence is a failed check. */
  }
  const verdictMatches =
    /390/iu.test(verdict) &&
    /dense/iu.test(verdict) &&
    /overflow/iu.test(verdict) &&
    /light/iu.test(verdict) &&
    /dark/iu.test(verdict) &&
    /noise/iu.test(verdict);
  return { matrixMatches, auditMatches, verdictMatches };
}

const SCREEN_READER_SAMPLE_IDS = [
  ...STATES.map((state) => `390x844-light-${state}`),
  ...STATES.map((state) => `1440x900-dark-${state}`),
];

function validateIndependentReview(
  report: IndependentVisualInspection | null,
  captures: readonly BrowserVisualCapture[],
  browserVersion: string,
): { human: boolean; screenReader: boolean } {
  const byId = new Map(captures.map((capture) => [capture.captureId, capture]));
  const human = report?.human;
  const humanVerified =
    Array.isArray(human) &&
    human.length === captures.length &&
    new Set(human.map((item) => item?.captureId)).size === captures.length &&
    human.every((item) => {
      const capture = byId.get(item?.captureId);
      return (
        !!capture &&
        item.simulated === false &&
        item.screenshotSha256 === capture.screenshotSha256 &&
        !!item.reviewerId?.trim() &&
        Number.isFinite(Date.parse(item.reviewedAt)) &&
        (item.verdict === 'pass' || item.verdict === 'fail') &&
        !!item.observation?.trim() &&
        (metricFailures(capture).length === 0 || item.verdict === 'fail')
      );
    });

  const screenReader = report?.screenReader;
  const screenReaderVerified =
    Array.isArray(screenReader) &&
    screenReader.length === SCREEN_READER_SAMPLE_IDS.length &&
    new Set(screenReader.map((item) => item?.captureId)).size === screenReader.length &&
    SCREEN_READER_SAMPLE_IDS.every((id) =>
      screenReader.some((item) => {
        const capture = byId.get(id);
        return (
          !!capture &&
          item.captureId === id &&
          item.simulated === false &&
          item.screenshotSha256 === capture.screenshotSha256 &&
          item.browserVersion === browserVersion &&
          !!item.assistiveTechnology?.trim() &&
          !!item.assistiveTechnologyVersion?.trim() &&
          !!item.sessionId?.trim() &&
          !!item.announcement?.trim() &&
          !!item.interaction?.trim()
        );
      }),
    );
  return { human: !!humanVerified, screenReader: !!screenReaderVerified };
}

/**
 * Actually runs Chromium, captures every V5 dashboard state, and checks DOM,
 * accessibility semantics, browser identity, screenshot bytes, and candidate audit.
 * Full verification stays red without independently authenticated human and
 * live screen-reader review supplied through an evaluator-owned authority.
 */
export async function runVisualVerificationBrowserScenario(
  root: string,
  reviewAuthority?: IndependentVisualReviewAuthority,
): Promise<BrowserVisualVerificationResult> {
  const captures: BrowserVisualCapture[] = [];
  const evidence: string[] = [];
  let browserVersion: string | null = null;
  let artifactDirectory: string | null = null;
  let integrityFailure = false;
  let humanReviewVerified = false;
  let screenReaderVerified = false;
  let observedFailures: string[] = [];
  let browserChecksPassed = false;

  try {
    let assets: Map<string, { bytes: Buffer; mime: string }>;
    try {
      assets = await pinnedDashboardAssets(root);
    } catch (error) {
      integrityFailure = true;
      throw new Error(`Pinned fixture integrity: ${detail(error)}`);
    }
    evidence.push('Pinned dashboard files and font: pass');
    const location = newArtifactDirectory(root);
    artifactDirectory = location.relative;
    await withPinnedBrowserPage(assets, async (baseUrl) => {
      const browser = await chromium.launch({
        ...chromiumLaunchOptions(),
        args: ['--disable-background-networking'],
        timeout: 30_000,
      });
      try {
        browserVersion = browser.version();
        const context = await browser.newContext({
          viewport: VIEWPORTS[0],
          deviceScaleFactor: 1,
          colorScheme: 'light',
          reducedMotion: 'reduce',
          locale: 'en-US',
        });
        try {
          await context.route('**/*', (route) => {
            const requested = new URL(route.request().url());
            return requested.origin === baseUrl ? route.continue() : route.abort();
          });
          const page = await context.newPage();
          page.setDefaultTimeout(5_000);
          const errors: string[] = [];
          let currentCaptureId = '';
          page.on('pageerror', (error) => errors.push(`${currentCaptureId}: ${error.message}`));
          page.on('console', (message) => {
            if (message.type() === 'error') errors.push(`${currentCaptureId}: ${message.text()}`);
          });
          for (const viewport of VIEWPORTS) {
            await page.setViewportSize(viewport);
            for (const theme of THEMES) {
              for (const state of STATES) {
                const captureId = `${viewport.width}x${viewport.height}-${theme}-${state}`;
                currentCaptureId = captureId;
                const url = `${baseUrl}/?theme=${theme}&state=${state}`;
                const response = await page.goto(url, { waitUntil: 'load', timeout: 5_000 });
                if (response?.status() !== 200)
                  throw new Error(`${captureId}: HTTP ${response?.status()}`);
                await page.evaluate(() => document.fonts.ready);
                const facts = await page.evaluate(
                  (input) => {
                    const header = document.querySelector('.topbar')?.getBoundingClientRect();
                    const content = document.querySelector('.content')?.getBoundingClientRect();
                    const panel = document.querySelector('.chart-panel') as HTMLElement | null;
                    const chart = document.querySelector('.chart') as HTMLElement | null;
                    const legend = document.querySelector('.legend') as HTMLElement | null;
                    const primary = document.querySelector('.primary-action') as HTMLElement | null;
                    const secondary = document.querySelector(
                      '.secondary-action',
                    ) as HTMLElement | null;
                    const primaryStyle = primary && getComputedStyle(primary);
                    const secondaryStyle = secondary && getComputedStyle(secondary);
                    const visibleCards = document.querySelectorAll('.card').length;
                    const firstBadges = document.querySelectorAll(
                      '.card:first-child .badge',
                    ).length;
                    const heading = document.querySelector('main h1');
                    const activeState =
                      input.state === 'loading'
                        ? !!document.querySelector('[aria-busy="true"]')
                        : input.state === 'empty'
                          ? !!document
                              .querySelector('.state-panel h2')
                              ?.textContent?.includes('No delivery data')
                          : visibleCards === 3 &&
                            !!panel &&
                            (input.state !== 'dense' || firstBadges === 5);
                    return {
                      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
                      chartClipped: !!chart && !!panel && chart.scrollWidth > panel.clientWidth + 1,
                      legendClipped: !!legend && legend.scrollWidth > legend.clientWidth + 1,
                      stickyOverlap: !!header && !!content && content.top < header.bottom - 1,
                      primaryActionDistinct:
                        !!primaryStyle &&
                        !!secondaryStyle &&
                        `${primaryStyle.backgroundColor}|${primaryStyle.color}|${primaryStyle.borderColor}` !==
                          `${secondaryStyle.backgroundColor}|${secondaryStyle.color}|${secondaryStyle.borderColor}`,
                      stateConfirmed:
                        activeState &&
                        !!heading &&
                        document.documentElement.dataset.theme === input.theme,
                      environmentConfirmed:
                        devicePixelRatio === 1 &&
                        document.fonts.check(`16px "${input.font}"`) &&
                        getComputedStyle(document.body).fontFamily.includes(input.font) &&
                        document.getAnimations().length === 0 &&
                        document.body.innerText.includes('Dataset: fixture-v1'),
                    };
                  },
                  { theme, state, font: BROWSER_EVAL_CONSTANTS.dashboardFont },
                );
                const ariaSnapshot = await page.locator('body').ariaSnapshot();
                const semanticEvidence = {
                  mainCount: await page.getByRole('main').count(),
                  headingCount: await page
                    .getByRole('heading', { name: 'Delivery health' })
                    .count(),
                  primaryActionCount: await page
                    .getByRole('button', { name: 'Investigate' })
                    .count(),
                };
                const screenshot = `${location.relative}/${captureId}.png`;
                const bytes = await page.screenshot({
                  type: 'png',
                  fullPage: false,
                  animations: 'disabled',
                  timeout: 5_000,
                });
                if (bytes.length < 1_000 || !bytes.subarray(0, 8).equals(PNG_HEADER))
                  throw new Error(`${captureId}: missing real PNG screenshot`);
                writeFileSync(join(location.absolute, `${captureId}.png`), bytes, {
                  flag: 'wx',
                  mode: 0o600,
                });
                await page.keyboard.press('Tab');
                const keyboardFocus = await page.evaluate(
                  () => (document.activeElement as HTMLElement | null)?.innerText?.trim() ?? '',
                );
                captures.push({
                  captureId,
                  ...viewport,
                  theme,
                  state,
                  screenshot,
                  screenshotSha256: sha256(bytes),
                  ...facts,
                  ariaSnapshot,
                  keyboardFocus,
                  semanticEvidence,
                });
              }
            }
          }
          if (errors.length)
            evidence.push(`Real browser application errors: ${errors.join(' | ').slice(0, 600)}`);
          browserChecksPassed = errors.length === 0;
        } finally {
          await context.close();
        }
      } finally {
        await browser.close();
      }
    });

    const ids = new Set(captures.map((capture) => capture.captureId));
    browserChecksPassed =
      browserChecksPassed &&
      captures.length === 24 &&
      ids.size === 24 &&
      captures.every(
        (capture) =>
          capture.stateConfirmed &&
          capture.environmentConfirmed &&
          capture.semanticEvidence.mainCount === 1 &&
          capture.semanticEvidence.headingCount === 1 &&
          capture.semanticEvidence.primaryActionCount === 1 &&
          !!capture.keyboardFocus &&
          capture.ariaSnapshot.includes('main') &&
          capture.ariaSnapshot.includes('Investigate') &&
          sha256(readFileSync(join(root, capture.screenshot))) === capture.screenshotSha256,
      );
    observedFailures = captures.flatMap(metricFailures).sort();
    evidence.push(
      `Real Playwright Chromium ${browserVersion}: ${captures.length}/24 PNG captures, accessible DOM snapshots and keyboard focus: ${browserChecksPassed ? 'pass' : 'fail'}`,
    );
    evidence.push(`Measured layout failures: ${observedFailures.join(', ') || 'none'}`);
    const audit = candidateAuditMatches(root, captures, browserVersion ?? '');
    evidence.push(`Candidate state matrix: ${audit.matrixMatches ? 'pass' : 'fail'}`);
    evidence.push(`Candidate measured-failure audit: ${audit.auditMatches ? 'pass' : 'fail'}`);
    evidence.push(`Candidate visual verdict: ${audit.verdictMatches ? 'pass' : 'fail'}`);

    if (reviewAuthority && browserChecksPassed && browserVersion) {
      try {
        const verified = validateIndependentReview(
          await reviewAuthority(captures, browserVersion),
          captures,
          browserVersion,
        );
        humanReviewVerified = verified.human;
        screenReaderVerified = verified.screenReader;
      } catch (error) {
        evidence.push(`Independent review authority failed: ${detail(error)}`);
      }
    }
    evidence.push(
      `Independent human visual inspection bound to 24 screenshot hashes: ${humanReviewVerified ? 'pass' : 'unavailable'}`,
    );
    evidence.push(
      `Live screen-reader interaction evidence for representative states: ${screenReaderVerified ? 'pass' : 'unavailable'}`,
    );
    const passed =
      browserChecksPassed &&
      audit.matrixMatches &&
      audit.auditMatches &&
      audit.verdictMatches &&
      humanReviewVerified &&
      screenReaderVerified;
    writeFixtureFile(
      root,
      `${location.relative}/receipt.json`,
      `${JSON.stringify(
        {
          scenarioId: VISUAL_VERIFICATION_BROWSER_SCENARIO,
          browserVersion,
          captures,
          observedFailures,
          humanReviewVerified,
          screenReaderVerified,
          passed,
          limitations: [
            'ARIA snapshots and keyboard focus are browser evidence, not live screen-reader evidence.',
            'Only an independently authenticated review authority can supply human and assistive-technology inspection.',
          ],
        },
        null,
        2,
      )}\n`,
    );
    return {
      score: {
        passed,
        quality: passed ? 1 : 0,
        verification: passed ? 1 : 0,
        integrityFailure: false,
        evidence,
      },
      browserVersion,
      captures,
      artifactDirectory,
      observedFailures,
      humanReviewVerified,
      screenReaderVerified,
    };
  } catch (error) {
    evidence.push(`Real browser visual verification failed: ${detail(error)}`);
    return {
      score: { passed: false, quality: 0, verification: 0, integrityFailure, evidence },
      browserVersion,
      captures,
      artifactDirectory,
      observedFailures,
      humanReviewVerified,
      screenReaderVerified,
    };
  }
}

/** Opt-in only: never registered as a substitute for the native macOS task. */
export const VISUAL_VERIFICATION_BROWSER_RUNTIME_SCORER: SkillEvalDeterministicScorer = {
  id: 'visual-verification/independent-browser-inspection@1',
  scenarioIds: [VISUAL_VERIFICATION_BROWSER_SCENARIO],
  score: async ({ workingDirectory }) =>
    (await runVisualVerificationBrowserScenario(workingDirectory)).score,
};
