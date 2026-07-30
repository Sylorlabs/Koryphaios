import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { nanoid } from 'nanoid';
import type { QualityGateReport } from './prompts';

export type BrowserAction =
  | { type: 'click'; selector: string }
  | { type: 'fill'; selector: string; value: string }
  | { type: 'press'; selector: string; key: string }
  | { type: 'wait-for'; selector: string };

export interface BrowserVerificationRequest {
  url: string;
  actions?: BrowserAction[];
  /** Task-specific visual claims; never infer generic aesthetic claims from pixels. */
  claims?: BrowserVisualClaim[];
  artifactRoot: string;
  timeoutMs?: number;
}

export interface BrowserVisualClaim {
  id: string;
  criterion: string;
  selector: string;
  expectedText?: string;
}

export interface VisualClaimResult {
  id: string;
  criterion: string;
  verdict: 'passed' | 'failed';
  evidence: string[];
}

export interface VisualEvidenceBundle {
  schemaVersion: 1;
  medium: 'web';
  collectedAt: string;
  url: string;
  journeys: BrowserVerificationReport['journeys'];
  claims: VisualClaimResult[];
  artifacts: string[];
  limitations: string[];
}

export interface BrowserVerificationReport {
  verdict: 'passed' | 'failed' | 'blocked';
  journeys: Array<{
    viewport: 'desktop' | 'mobile';
    finalUrl: string;
    title: string;
    screenshot: string;
    domSummary: { headings: string[]; buttons: string[]; inputs: string[] };
  }>;
  consoleErrors: string[];
  runtimeErrors: string[];
  claimAudit: VisualClaimResult[];
  evidenceBundle: string | null;
  artifacts: string[];
  reasons: string[];
}

async function executeActions(page: Page, actions: BrowserAction[], timeoutMs: number) {
  for (const action of actions) {
    const locator = page.locator(action.selector).first();
    if (action.type === 'click') await locator.click({ timeout: timeoutMs });
    else if (action.type === 'fill') await locator.fill(action.value, { timeout: timeoutMs });
    else if (action.type === 'press') await locator.press(action.key, { timeout: timeoutMs });
    else await locator.waitFor({ state: 'visible', timeout: timeoutMs });
  }
}

async function evaluateClaims(
  page: Page,
  viewport: 'desktop' | 'mobile',
  claims: BrowserVisualClaim[],
  timeoutMs: number,
): Promise<VisualClaimResult[]> {
  const results: VisualClaimResult[] = [];
  for (const claim of claims) {
    const locator = page.locator(claim.selector).first();
    try {
      await locator.waitFor({ state: 'visible', timeout: timeoutMs });
      const text = (await locator.textContent())?.replace(/\s+/g, ' ').trim() ?? '';
      const matchesText = !claim.expectedText || text.includes(claim.expectedText);
      results.push({
        id: claim.id,
        criterion: claim.criterion,
        verdict: matchesText ? 'passed' : 'failed',
        evidence: [
          `[${viewport}] selector ${claim.selector} is visible`,
          ...(claim.expectedText
            ? [`[${viewport}] expected text ${JSON.stringify(claim.expectedText)} ${matchesText ? 'present' : 'missing'}`]
            : []),
        ],
      });
    } catch (error) {
      results.push({
        id: claim.id,
        criterion: claim.criterion,
        verdict: 'failed',
        evidence: [
          `[${viewport}] selector ${claim.selector} was not verified: ${error instanceof Error ? error.message : String(error)}`,
        ],
      });
    }
  }
  return results;
}

function mergeClaimResults(results: VisualClaimResult[]): VisualClaimResult[] {
  const grouped = new Map<string, VisualClaimResult[]>();
  for (const result of results) grouped.set(result.id, [...(grouped.get(result.id) ?? []), result]);
  return [...grouped.values()].map((group) => ({
    id: group[0].id,
    criterion: group[0].criterion,
    verdict: group.every((result) => result.verdict === 'passed') ? 'passed' : 'failed',
    evidence: group.flatMap((result) => result.evidence),
  }));
}

/** Convert runtime artifacts into the same fail-closed shape used by the workflow gate. */
export function browserReportToQualityGate(report: BrowserVerificationReport): QualityGateReport {
  const failedClaims = report.claimAudit.filter((claim) => claim.verdict === 'failed');
  const reasons = [...report.reasons, ...failedClaims.map((claim) => `${claim.id}: ${claim.criterion}`)];
  return {
    verdict: report.verdict === 'blocked' ? 'blocked' : reasons.length ? 'failed' : 'passed',
    checks: [
      {
        command: 'browser visual evidence collection',
        passed: report.verdict === 'passed' && failedClaims.length === 0,
        output: report.evidenceBundle ?? undefined,
      },
    ],
    artifacts: report.artifacts,
    criticFindings: failedClaims.map((claim) => ({
      severity: 'major' as const,
      evidence: claim.evidence.join('; '),
      criterion: claim.criterion,
      finding: `Visual claim ${claim.id} failed.`,
    })),
    unmetCriteria: failedClaims.map((claim) => claim.criterion),
    reasons,
  };
}

/** Provider-neutral runtime evidence. No model or provider participates in pass/fail collection. */
export class BrowserVerificationService {
  async verify(request: BrowserVerificationRequest): Promise<BrowserVerificationReport> {
    const timeoutMs = request.timeoutMs ?? 15_000;
    const runDirectory = join(request.artifactRoot, `browser-${nanoid(8)}`);
    mkdirSync(runDirectory, { recursive: true });
    const consoleErrors: string[] = [];
    const runtimeErrors: string[] = [];
    const journeys: BrowserVerificationReport['journeys'] = [];
    const claimResults: VisualClaimResult[] = [];
    let browser: Browser | undefined;

    try {
      browser = await chromium.launch({ headless: true });
      for (const profile of [
        { name: 'desktop' as const, width: 1440, height: 1000 },
        { name: 'mobile' as const, width: 390, height: 844 },
      ]) {
        const context = await browser.newContext({
          viewport: { width: profile.width, height: profile.height },
        });
        const page = await context.newPage();
        page.on('console', (message) => {
          if (message.type() === 'error') consoleErrors.push(`[${profile.name}] ${message.text()}`);
        });
        page.on('pageerror', (error) => runtimeErrors.push(`[${profile.name}] ${error.message}`));
        await page.goto(request.url, { waitUntil: 'networkidle', timeout: timeoutMs });
        await executeActions(page, request.actions ?? [], timeoutMs);
        claimResults.push(
          ...(await evaluateClaims(page, profile.name, request.claims ?? [], timeoutMs)),
        );
        const screenshot = join(runDirectory, `${profile.name}.png`);
        await page.screenshot({ path: screenshot, fullPage: true });
        const domSummary = await page.evaluate(() => ({
          headings: [...document.querySelectorAll('h1,h2,h3')]
            .map((element) => element.textContent?.trim() ?? '')
            .filter(Boolean),
          buttons: [...document.querySelectorAll('button,[role="button"]')]
            .map(
              (element) => element.getAttribute('aria-label') || element.textContent?.trim() || '',
            )
            .filter(Boolean),
          inputs: [...document.querySelectorAll('input,textarea,select')]
            .map(
              (element) =>
                element.getAttribute('aria-label') ||
                element.getAttribute('name') ||
                element.getAttribute('placeholder') ||
                '',
            )
            .filter(Boolean),
        }));
        journeys.push({
          viewport: profile.name,
          finalUrl: page.url(),
          title: await page.title(),
          screenshot,
          domSummary,
        });
        await context.close();
      }
    } catch (error) {
      return {
        verdict: journeys.length === 0 ? 'blocked' : 'failed',
        journeys,
        consoleErrors,
        runtimeErrors,
        claimAudit: mergeClaimResults(claimResults),
        evidenceBundle: null,
        artifacts: journeys.map((journey) => journey.screenshot),
        reasons: [error instanceof Error ? error.message : String(error)],
      };
    } finally {
      await browser?.close();
    }

    const claimAudit = mergeClaimResults(claimResults);
    const artifacts = journeys.map((journey) => journey.screenshot);
    const limitations = [
      'Browser evidence verifies declared claims and runtime behavior; it does not assign a universal aesthetic score.',
    ];
    const evidenceBundle = join(runDirectory, 'visual-evidence.json');
    const bundle: VisualEvidenceBundle = {
      schemaVersion: 1,
      medium: 'web',
      collectedAt: new Date().toISOString(),
      url: request.url,
      journeys,
      claims: claimAudit,
      artifacts,
      limitations,
    };
    writeFileSync(evidenceBundle, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
    artifacts.push(evidenceBundle);
    const reasons = [
      ...consoleErrors.map((error) => `Console error: ${error}`),
      ...runtimeErrors.map((error) => `Runtime error: ${error}`),
      ...claimAudit
        .filter((claim) => claim.verdict === 'failed')
        .map((claim) => `Visual claim failed: ${claim.id}`),
    ];
    return {
      verdict: reasons.length === 0 ? 'passed' : 'failed',
      journeys,
      consoleErrors,
      runtimeErrors,
      claimAudit,
      evidenceBundle,
      artifacts,
      reasons,
    };
  }
}
