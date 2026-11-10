import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import {
  ACCESSIBILITY_SKILL_EVAL_MATERIALIZERS,
  ACCESSIBILITY_SKILL_EVAL_SCORERS,
} from '../skill-eval-accessibility-fixtures';
import { writeFixtureFile } from '../skill-eval-fixture-helpers';
import type { SkillEvalScenarioV3 } from '../skill-eval-harness';

const WEB_SCENARIO = 'accessibility-verification-full-task-1';
const ANDROID_SCENARIO = 'accessibility-verification-full-task-2';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(scenarioId: string) {
  const root = mkdtempSync(join(tmpdir(), 'kory-accessibility-infrastructure-'));
  roots.push(root);
  const scenario = { id: scenarioId } as SkillEvalScenarioV3;
  const materializer = ACCESSIBILITY_SKILL_EVAL_MATERIALIZERS.find((item) =>
    item.matches(scenario),
  );
  if (!materializer) throw new Error(`Missing materializer for ${scenarioId}`);
  await materializer.materialize(root, scenario);
  return { root, scenario, materializer };
}

describe('V5 accessibility verification infrastructure', () => {
  test('pins both live runtime blockers and identifies evidence the synthetic fixtures cannot supply', async () => {
    const web = await fixture(WEB_SCENARIO);
    const android = await fixture(ANDROID_SCENARIO);
    const webBlockers = web.materializer.readinessBlockers?.join(' ') ?? '';
    const androidBlockers = android.materializer.readinessBlockers?.join(' ') ?? '';

    expect(webBlockers).toMatch(/real supported browser.*NVDA 2026\.2/u);
    expect(webBlockers).toContain('visible focus');
    expect(webBlockers).toContain('actual 200% browser zoom/reflow');
    expect(androidBlockers).toMatch(/real Android device or emulator.*TalkBack 17\.0/u);
    expect(androidBlockers).toContain('Switch Access');

    expect(JSON.parse(readFileSync(join(web.root, 'evidence/web.json'), 'utf8'))).toMatchObject({
      browser: 'Chromium 140',
      screenReader: 'NVDA 2026.2',
    });
    expect(readFileSync(join(web.root, 'README.md'), 'utf8'))
      .toContain('A Chromium accessibility-tree snapshot, Playwright assertion');
    expect(readFileSync(join(android.root, 'README.md'), 'utf8'))
      .toContain('Accessibility semantics dumps and synthetic events cannot demonstrate');
  });

  test('rejects self-attested live results and macOS AT substituted for pinned NVDA', async () => {
    const { root, scenario } = await fixture(WEB_SCENARIO);
    const scorer = ACCESSIBILITY_SKILL_EVAL_SCORERS.find((item) =>
      item.scenarioIds.includes(WEB_SCENARIO),
    );
    if (!scorer) throw new Error('Missing web scorer');
    const corpus = JSON.parse(readFileSync(join(root, 'evidence/web.json'), 'utf8')) as {
      browser: string;
      screenReader: string;
      requiredTasks: string[];
    };
    const candidate = {
      environment: {
        platformVersion: 'Windows 11',
        appBuild: 'synthetic fixture',
        assistiveTechnology: corpus.screenReader,
        browser: corpus.browser,
      },
      rows: corpus.requiredTasks.map((task) => ({
        task,
        input: 'keyboard-only',
        platform: 'Windows 11',
        at: corpus.screenReader,
        manual: true,
        simulated: true,
        passed: true,
        observations: [],
      })),
      automation: { tool: 'synthetic fixture', passed: true, findings: [] },
      manualVerdict: 'pass',
      automationControlsVerdict: false,
      liveRuntimeVerified: false,
      untested: ['Real Windows/NVDA session'],
    };
    const score = async () => scorer.score({
      workingDirectory: root,
      scenario,
      observation: {} as never,
      experiment: {} as never,
    });

    writeFixtureFile(root, '.kory-eval/web-verification.json', JSON.stringify(candidate));
    const simulated = await score();
    expect(simulated.passed, simulated.evidence.join('\n')).toBe(true);
    expect(simulated.evidence.join(' ')).toMatch(/simulation: pass/u);

    candidate.liveRuntimeVerified = true;
    writeFixtureFile(root, '.kory-eval/web-verification.json', JSON.stringify(candidate));
    expect((await score()).passed).toBe(false);

    candidate.liveRuntimeVerified = false;
    candidate.environment.assistiveTechnology = 'VoiceOver (macOS)';
    writeFixtureFile(root, '.kory-eval/web-verification.json', JSON.stringify(candidate));
    expect((await score()).passed).toBe(false);
  }, 30_000);

  test('rejects an Android synthetic result labeled as live TalkBack/switch access', async () => {
    const { root, scenario } = await fixture(ANDROID_SCENARIO);
    const scorer = ACCESSIBILITY_SKILL_EVAL_SCORERS.find((item) =>
      item.scenarioIds.includes(ANDROID_SCENARIO),
    );
    if (!scorer) throw new Error('Missing Android scorer');
    const corpus = JSON.parse(readFileSync(join(root, 'evidence/android.json'), 'utf8')) as {
      platformVersion: string;
      talkBack: string;
      requiredTasks: string[];
    };
    const candidate = {
      environment: {
        platformVersion: corpus.platformVersion,
        appBuild: 'synthetic fixture',
        assistiveTechnology: corpus.talkBack,
      },
      rows: corpus.requiredTasks.map((task) => ({
        task,
        input: 'switch input',
        platform: corpus.platformVersion,
        at: corpus.talkBack,
        manual: true,
        simulated: true,
        passed: true,
        observations: [],
      })),
      automation: { tool: 'synthetic fixture', passed: true, findings: [] },
      manualVerdict: 'pass',
      automationControlsVerdict: false,
      liveRuntimeVerified: false,
      untested: ['Real Android/TalkBack/Switch Access session'],
    };
    const score = async () => scorer.score({
      workingDirectory: root,
      scenario,
      observation: {} as never,
      experiment: {} as never,
    });

    writeFixtureFile(root, '.kory-eval/android-verification.json', JSON.stringify(candidate));
    const simulated = await score();
    expect(simulated.passed, simulated.evidence.join('\n')).toBe(true);

    candidate.liveRuntimeVerified = true;
    writeFixtureFile(root, '.kory-eval/android-verification.json', JSON.stringify(candidate));
    expect((await score()).passed).toBe(false);
  }, 30_000);

  // Instrumentation probe only: these controls intentionally contain defects.
  // The browser's AX tree, focus style, and viewport evidence are real browser
  // observations, but none of them constitute an AT announcement or live verdict.
  test.skipIf(!existsSync(chromium.executablePath()))(
    'measures real Chromium AX semantics, keyboard-visible focus, and narrow-viewport overflow',
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
        const page = await context.newPage();
        await page.setContent(`<!doctype html><html lang="en"><head><style>
          #visible:focus-visible { outline: 3px solid black; }
          #missing:focus-visible { outline: none; }
          .wide { width: 980px; }
        </style></head><body>
          <button id="visible">Visible focus</button>
          <button id="missing">Missing focus</button>
          <section role="dialog" aria-labelledby="dialog-title">
            <h1 id="dialog-title">Remove item</h1>
          </section>
          <div class="wide">Long localized name that requires reflow</div>
        </body></html>`);

        expect(browser.version()).toMatch(/^\d+\.\d+/u);
        await page.keyboard.press('Tab');
        const visible = await page.evaluate(() => ({
          id: document.activeElement?.id,
          focusVisible: document.activeElement?.matches(':focus-visible'),
          outlineWidth: getComputedStyle(document.activeElement!).outlineWidth,
        }));
        expect(visible).toEqual({ id: 'visible', focusVisible: true, outlineWidth: '3px' });

        await page.keyboard.press('Tab');
        const missing = await page.evaluate(() => ({
          id: document.activeElement?.id,
          focusVisible: document.activeElement?.matches(':focus-visible'),
          outlineStyle: getComputedStyle(document.activeElement!).outlineStyle,
        }));
        expect(missing).toEqual({ id: 'missing', focusVisible: true, outlineStyle: 'none' });

        const snapshot = await page.getByRole('dialog').ariaSnapshot();
        expect(snapshot).toContain('dialog "Remove item"');
        const cdp = await context.newCDPSession(page);
        await cdp.send('Accessibility.enable');
        const tree = await cdp.send('Accessibility.getFullAXTree');
        expect(tree.nodes.some((node) =>
          node.role?.value === 'dialog' && node.name?.value === 'Remove item',
        )).toBe(true);

        await page.setViewportSize({ width: 320, height: 768 });
        const reflow = await page.evaluate(() => ({
          viewport: document.documentElement.clientWidth,
          content: document.documentElement.scrollWidth,
        }));
        expect(reflow.viewport).toBe(320);
        expect(reflow.content).toBeGreaterThan(reflow.viewport);
        expect((await page.screenshot()).subarray(0, 8))
          .toEqual(Buffer.from('89504e470d0a1a0a', 'hex'));
      } finally {
        await browser.close();
      }
    },
    30_000,
  );
});
