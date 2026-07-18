import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { nanoid } from 'nanoid';

export type BrowserAction =
  | { type: 'click'; selector: string }
  | { type: 'fill'; selector: string; value: string }
  | { type: 'press'; selector: string; key: string }
  | { type: 'wait-for'; selector: string };

export interface BrowserVerificationRequest {
  url: string;
  actions?: BrowserAction[];
  artifactRoot: string;
  timeoutMs?: number;
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

/** Provider-neutral runtime evidence. No model or provider participates in pass/fail collection. */
export class BrowserVerificationService {
  async verify(request: BrowserVerificationRequest): Promise<BrowserVerificationReport> {
    const timeoutMs = request.timeoutMs ?? 15_000;
    const runDirectory = join(request.artifactRoot, `browser-${nanoid(8)}`);
    mkdirSync(runDirectory, { recursive: true });
    const consoleErrors: string[] = [];
    const runtimeErrors: string[] = [];
    const journeys: BrowserVerificationReport['journeys'] = [];
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
        artifacts: journeys.map((journey) => journey.screenshot),
        reasons: [error instanceof Error ? error.message : String(error)],
      };
    } finally {
      await browser?.close();
    }

    const reasons = [
      ...consoleErrors.map((error) => `Console error: ${error}`),
      ...runtimeErrors.map((error) => `Runtime error: ${error}`),
    ];
    return {
      verdict: reasons.length === 0 ? 'passed' : 'failed',
      journeys,
      consoleErrors,
      runtimeErrors,
      artifacts: journeys.map((journey) => journey.screenshot),
      reasons,
    };
  }
}
