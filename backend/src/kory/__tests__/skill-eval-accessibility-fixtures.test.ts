import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import {
  ACCESSIBILITY_SKILL_EVAL_MATERIALIZERS,
  ACCESSIBILITY_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-accessibility-fixtures';
import { WEB_LIVE_SESSION } from '../../eval/skills/skill-eval-accessibility-web-live';
import { ANDROID_LIVE_SESSION } from '../../eval/skills/skill-eval-accessibility-android-live';
import { writeFixtureFile } from '../../eval/skills/skill-eval-fixture-helpers';
import type { SkillEvalScenarioV3 } from '../../eval/skills/skill-eval-harness';

const WEB_SCENARIO = 'accessibility-verification-full-task-1';
const ANDROID_SCENARIO = 'accessibility-verification-full-task-2';
const roots: string[] = [];

type RecordedWebSession = {
  browser: string;
  locale: string;
  keyboard: {
    focusOnOpen: string;
    tabStops: string[];
    closedByEscape: boolean;
    focusAfterEscape: string;
  };
  errorState: { visible: boolean; role: string; text: string };
  zoom200: {
    horizontalOverflow: boolean;
    dialogFits: boolean;
    longTextFits: boolean;
    dialogRectWidth: number;
    viewportWidth: number;
  };
};

type RecordedAndroidSession = {
  device: { model: string; sdk: number };
  assistiveTechnology: { talkBack: string; switchAccess: string; switchAccessBound: boolean };
  focusTraversal: { label: string }[];
  toggles: { label: string; checked: boolean }[];
  textScale: { defaultRowHeight: number; largeRowHeight: number };
};

async function liveFixture(scenarioId: string) {
  const root = mkdtempSync(join(tmpdir(), 'kory-accessibility-live-'));
  roots.push(root);
  const scenario = { id: scenarioId } as SkillEvalScenarioV3;
  const materializer = ACCESSIBILITY_SKILL_EVAL_MATERIALIZERS.find((item) =>
    item.matches(scenario),
  );
  if (!materializer) throw new Error(`Missing materializer for ${scenarioId}`);
  await materializer.materialize(root, scenario);
  const scorer = ACCESSIBILITY_SKILL_EVAL_SCORERS.find((item) =>
    item.scenarioIds.includes(scenarioId),
  );
  if (!scorer) throw new Error(`Missing scorer for ${scenarioId}`);
  mkdirSync(join(root, '.kory-eval'), { recursive: true });
  return { root, scenario, scorer };
}

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
  test('materializes recorded live sessions for both accessibility scenarios', async () => {
    const web = await fixture(WEB_SCENARIO);
    const android = await fixture(ANDROID_SCENARIO);
    expect(web.materializer.id).toBe('accessibility-verification/web-delete-dialog-live@4');
    expect(android.materializer.id).toBe('accessibility-verification/android-live-session@4');
    expect(web.materializer.readinessBlockers ?? []).toEqual([]);
    expect(android.materializer.readinessBlockers ?? []).toEqual([]);
    expect(readFileSync(join(web.root, 'evidence/web-live.json'), 'utf8')).toBe(WEB_LIVE_SESSION);
    expect(readFileSync(join(android.root, 'evidence/android-live.json'), 'utf8')).toBe(
      ANDROID_LIVE_SESSION,
    );
    // The recorded session, not a synthetic corpus, is the decision source:
    // the README must say so, because the recording is what outruns the
    // shipped automation report.
    expect(readFileSync(join(web.root, 'README.md'), 'utf8')).toContain('recorded session');
    expect(readFileSync(join(android.root, 'README.md'), 'utf8')).toContain('recorded session');
  });

  test('web live scorer accepts a submission reconciled with the recorded session and rejects a substituted assistive-technology identity', async () => {
    const { root, scenario, scorer } = await liveFixture(WEB_SCENARIO);
    const session = JSON.parse(WEB_LIVE_SESSION) as RecordedWebSession;
    const base = {
      environment: {
        browser: session.browser,
        locale: session.locale,
        screenReader:
          'orca 43.1 with Speech Dispatcher 0.11.4 on Debian bookworm (aarch64), Xvfb 1280x800',
      },
      keyboard: session.keyboard,
      errorState: session.errorState,
      zoom200: session.zoom200,
      rows: [
        {
          task: 'failure-alert-announcement',
          input: 'keyboard',
          platform: 'Debian bookworm',
          at: 'orca 43.1',
          manual: true,
          passed: true,
          observations: [
            'Speech Dispatcher log records "Löschen fehlgeschlagen. Erneut versuchen." for the opened dialog',
          ],
        },
        {
          task: 'focus-escape-defect',
          input: 'keyboard',
          platform: 'Debian bookworm',
          at: 'orca 43.1',
          manual: true,
          passed: true,
          observations: [
            'recorded tabStops show focus left the dialog onto the Seitenreiter (document body)',
          ],
        },
        {
          task: 'zoom-200-reflow',
          input: 'keyboard',
          platform: 'Debian bookworm',
          at: 'orca 43.1',
          manual: true,
          passed: true,
          observations: [
            'dialog fits at 200 percent zoom: no horizontal overflow at viewport width 640',
          ],
        },
      ],
      automation: {
        tool: 'axe-core 4.10.2 with @axe-core/playwright 4.10.2',
        executed: true,
        accepted: ['spoken-announcement', 'escape-returns-focus', 'zoom-200-reflow'],
        rejected: ['focus-trap'],
      },
      conflicts: [
        {
          claimId: 'focus-trap',
          evidence:
            'the recorded tabStops place one Tab stop on the document body outside the dialog',
          verdict: 'rejected',
        },
      ],
      manualVerdict: 'partial',
      automationControlsVerdict: false,
      liveRuntimeVerified: true,
      untested: ['NVDA on Windows and VoiceOver on macOS were not driven'],
    };
    const score = async () =>
      scorer.score({
        workingDirectory: root,
        scenario,
        observation: {} as never,
        experiment: {} as never,
      });

    writeFixtureFile(root, '.kory-eval/web-verification.json', JSON.stringify(base));
    const accepted = await score();
    expect(accepted.passed, accepted.evidence.join('\n')).toBe(true);

    base.environment.screenReader = 'VoiceOver (macOS)';
    writeFixtureFile(root, '.kory-eval/web-verification.json', JSON.stringify(base));
    expect((await score()).passed).toBe(false);

    base.environment.screenReader =
      'orca 43.1 with Speech Dispatcher 0.11.4 on Debian bookworm (aarch64), Xvfb 1280x800';
    base.keyboard.focusOnOpen = 'confirm';
    writeFixtureFile(root, '.kory-eval/web-verification.json', JSON.stringify(base));
    expect((await score()).passed).toBe(false);
  }, 30_000);

  test('Android live scorer accepts the exact recorded TalkBack identity and rejects capability padding', async () => {
    const { root, scenario, scorer } = await liveFixture(ANDROID_SCENARIO);
    const session = JSON.parse(ANDROID_LIVE_SESSION) as RecordedAndroidSession;
    const base = {
      environment: {
        platformVersion: 'Android 17 (API 37)',
        device: session.device.model,
        assistiveTechnology: session.assistiveTechnology.talkBack,
        switchAccess: session.assistiveTechnology.switchAccess,
      },
      focusOrder: session.focusTraversal.map((stop) => stop.label),
      toggles: session.toggles.map((toggle) => ({ label: toggle.label, checked: toggle.checked })),
      textScale: {
        largeScale: '1.5',
        defaultRowHeight: session.textScale.defaultRowHeight,
        largeRowHeight: session.textScale.largeRowHeight,
        grew: true,
      },
      rows: [
        {
          task: 'focus-traversal-order',
          input: 'keyboard',
          platform: 'Android 17 (API 37)',
          at: 'TalkBack 17.0.0.889642762',
          manual: true,
          passed: true,
          observations: ['recorded focusTraversal lists six stops in the submitted order'],
        },
        {
          task: 'toggle-checked-state',
          input: 'touch exploration',
          platform: 'Android 17 (API 37)',
          at: 'TalkBack 17.0.0.889642762',
          manual: true,
          passed: true,
          observations: ['both recorded switch controls expose checked true'],
        },
        {
          task: 'text-scale-reflow',
          input: 'touch exploration',
          platform: 'Android 17 (API 37)',
          at: 'TalkBack 17.0.0.889642762',
          manual: true,
          passed: true,
          observations: ['row height grew from 65 to 92 at text scale 1.5 without clipping'],
        },
      ],
      automation: {
        tool: 'androidx.test.espresso:espresso-core:3.6.1',
        executed: true,
        accepted: [] as string[],
        rejected: ['spoken-state-change', 'switch-traversal', 'duplicate-label'],
      },
      conflicts: [
        {
          claimId: 'spoken-state-change',
          evidence:
            'the recording captured no utterance, so the Espresso assertion cannot attest spoken output',
          verdict: 'rejected',
        },
        {
          claimId: 'switch-traversal',
          evidence: 'Switch Access is not bound in the recording (switchAccessBound false)',
          verdict: 'rejected',
        },
        {
          claimId: 'duplicate-label',
          evidence: 'the two switch controls expose resource identifiers, not human labels',
          verdict: 'rejected',
        },
      ],
      manualVerdict: 'partial',
      automationControlsVerdict: false,
      liveRuntimeVerified: true,
      untested: ['spoken output was not captured and Switch Access input was not exercised'],
    };
    const score = async () =>
      scorer.score({
        workingDirectory: root,
        scenario,
        observation: {} as never,
        experiment: {} as never,
      });

    writeFixtureFile(root, '.kory-eval/android-verification.json', JSON.stringify(base));
    const accepted = await score();
    expect(accepted.passed, accepted.evidence.join('\n')).toBe(true);

    base.environment.assistiveTechnology = 'TalkBack 18.0';
    writeFixtureFile(root, '.kory-eval/android-verification.json', JSON.stringify(base));
    expect((await score()).passed).toBe(false);

    base.environment.assistiveTechnology = session.assistiveTechnology.talkBack;
    base.rows = [
      ...base.rows,
      {
        task: 'spoken-state-change-confirmed',
        input: 'touch exploration',
        platform: 'Android 17 (API 37)',
        at: 'TalkBack 17.0.0.889642762',
        manual: true,
        passed: true,
        observations: ['claimed the spoken announcement the recording cannot show'],
      },
    ];
    writeFixtureFile(root, '.kory-eval/android-verification.json', JSON.stringify(base));
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
        expect(
          tree.nodes.some(
            (node) => node.role?.value === 'dialog' && node.name?.value === 'Remove item',
          ),
        ).toBe(true);

        await page.setViewportSize({ width: 320, height: 768 });
        const reflow = await page.evaluate(() => ({
          viewport: document.documentElement.clientWidth,
          content: document.documentElement.scrollWidth,
        }));
        expect(reflow.viewport).toBe(320);
        expect(reflow.content).toBeGreaterThan(reflow.viewport);
        expect((await page.screenshot()).subarray(0, 8)).toEqual(
          Buffer.from('89504e470d0a1a0a', 'hex'),
        );
      } finally {
        await browser.close();
      }
    },
    30_000,
  );
});
