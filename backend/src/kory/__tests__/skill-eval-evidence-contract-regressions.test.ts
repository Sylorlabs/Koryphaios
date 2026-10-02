import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACCESSIBILITY_SKILL_EVAL_MATERIALIZERS,
  ACCESSIBILITY_SKILL_EVAL_SCORERS,
} from '../skill-eval-accessibility-fixtures';
import {
  DATA_ENGINEERING_SKILL_EVAL_MATERIALIZERS,
  DATA_ENGINEERING_SKILL_EVAL_SCORERS,
} from '../skill-eval-data-engineering-fixtures';
import { buildSkillEvalSuiteV3 } from '../skill-eval-harness';
import { loadV5SkillPackages } from '../skill-packages';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function accessibilityFixture(skill: string, scenarioId: string) {
  const skillPackage = loadV5SkillPackages().packages.find((item) => item.sidecar.name === skill)!;
  const scenario = buildSkillEvalSuiteV3(skillPackage).scenarios.find(
    (item) => item.id === scenarioId,
  )!;
  const root = mkdtempSync(join(tmpdir(), 'kory-accessibility-contract-'));
  roots.push(root);
  const materializer = ACCESSIBILITY_SKILL_EVAL_MATERIALIZERS.find((item) =>
    item.matches(scenario),
  )!;
  const scorer = ACCESSIBILITY_SKILL_EVAL_SCORERS.find((item) =>
    item.scenarioIds.includes(scenarioId),
  )!;
  await materializer.materialize(root, scenario);
  mkdirSync(join(root, '.kory-eval'), { recursive: true });
  return { root, scenario, scorer };
}

async function analyticsOrdersFixture() {
  const skillPackage = loadV5SkillPackages().packages.find(
    (item) => item.sidecar.name === 'analytics-engineering',
  )!;
  const scenario = buildSkillEvalSuiteV3(skillPackage).scenarios.find(
    (item) => item.id === 'analytics-engineering-full-task-1-individual',
  )!;
  const root = mkdtempSync(join(tmpdir(), 'kory-analytics-contract-'));
  roots.push(root);
  const materializer = DATA_ENGINEERING_SKILL_EVAL_MATERIALIZERS.find((item) =>
    item.matches(scenario),
  )!;
  const scorer = DATA_ENGINEERING_SKILL_EVAL_SCORERS.find((item) =>
    item.scenarioIds.includes(scenario.id),
  )!;
  await materializer.materialize(root, scenario);
  mkdirSync(join(root, '.kory-eval'), { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  return { root, scenario, scorer };
}

const observation = { output: '', evidence: [], artifacts: [], durationMs: 0 };

describe('evidence contract regressions', () => {
  test('game accessibility accepts semantic compounds across JSON naming separators', async () => {
    const { root, scenario, scorer } = await accessibilityFixture(
      'accessibility-practice',
      'accessibility-practice-full-task-game-system',
    );
    writeFileSync(
      join(root, '.kory-eval/game-accessibility.json'),
      `${JSON.stringify(
        {
          tasks: [
            'menu',
            'tutorial',
            'combat',
            'online co-op communication',
            'pause/settings',
            'recovery',
          ],
          channels: [
            'dialogue',
            'non_speech_audio',
            'visual_events',
            'combat_status',
            'communication',
          ],
          controls: 'controller remapping and alternate input',
          presentation:
            'redundant configurable channels, theme contrast, and long text readability',
          motion: 'camera motion controls',
          assurance: 'unverified runtime combinations; not compliance',
        },
        null,
        2,
      )}\n`,
    );

    const score = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation,
    });
    expect(score.passed).toBe(true);
  });

  test('web verification preserves the exact assistive-technology identity without label padding', async () => {
    const { root, scenario, scorer } = await accessibilityFixture(
      'accessibility-verification',
      'accessibility-verification-full-task-1',
    );
    const tasks = [
      'focus-entry',
      'focus-trap',
      'cancel',
      'confirm',
      'escape',
      'focus-return',
      'semantic-title',
      'busy-state',
      'server-error-announcement',
      'zoom-200-long-name',
    ];
    writeFileSync(
      join(root, '.kory-eval/web-verification.json'),
      `${JSON.stringify(
        {
          environment: {
            platformVersion: 'Windows 11',
            appBuild: 'fixture',
            assistiveTechnology: 'NVDA 2026.2',
            browser: 'Chromium 140',
          },
          rows: tasks.map((task, index) => ({
            task,
            input: index === 0 ? 'keyboard-only' : 'keyboard',
            platform: 'Windows 11',
            at: 'NVDA 2026.2',
            manual: true,
            simulated: true,
            passed: true,
            observations: [],
          })),
          automation: { tool: 'fixture scanner', passed: true, findings: [] },
          manualVerdict: 'pass',
          automationControlsVerdict: false,
          liveRuntimeVerified: false,
          untested: ['real browser and assistive-technology combinations'],
        },
        null,
        2,
      )}\n`,
    );

    const score = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation,
    });
    expect(score.passed).toBe(true);
  });

  test('analytics evidence accepts structured snake-case metric and reconciliation fields', async () => {
    const { root, scenario, scorer } = await analyticsOrdersFixture();
    writeFileSync(
      join(root, 'src/orders-mart.ts'),
      `export interface OrderMartRow { orderId:string; createdDate:string; status:'confirmed'|'cancelled'; netRevenueCents:number }
export function buildOrdersMart(source:any):OrderMartRow[]{
  const status=new Map<string,any>(); for(const change of source.statusChanges){const prior=status.get(change.orderId);if(!prior||change.effectiveAt>=prior.effectiveAt)status.set(change.orderId,change)}
  const events=new Map<string,any>(); for(const event of source.paymentEvents)if(!events.has(event.eventId))events.set(event.eventId,event);
  return source.orders.map((order:any)=>{const current=status.get(order.orderId)?.status??'confirmed';let total=0;for(const event of events.values())if(event.orderId===order.orderId)total+=event.kind==='refund'?-event.amountCents:event.amountCents;return{orderId:order.orderId,createdDate:order.createdDate,status:current,netRevenueCents:current==='cancelled'?0:total}})
}
export function dailyNetRevenue(rows:OrderMartRow[]):Record<string,number>{const out:Record<string,number>={};for(const row of rows)out[row.createdDate]=(out[row.createdDate]??0)+row.netRevenueCents;return out}
export function applyIncremental(existing:OrderMartRow[],source:any,changedOrderIds:string[]):OrderMartRow[]{const changed=new Set(changedOrderIds),fresh=new Map(buildOrdersMart(source).map(row=>[row.orderId,row])),prior=new Map(existing.map(row=>[row.orderId,row]));return source.orders.map((order:any)=>changed.has(order.orderId)||!prior.has(order.orderId)?fresh.get(order.orderId):prior.get(order.orderId))}
`,
    );
    writeFileSync(
      join(root, 'tests/orders-mart.test.ts'),
      `import{expect,test}from'bun:test';import data from'../data/orders-source.json';import{applyIncremental,buildOrdersMart,dailyNetRevenue}from'../src/orders-mart';
test('eventId duplicate dedup and latest effectiveAt late correction',()=>{const rows=buildOrdersMart(data.corrected);expect(rows.find(row=>row.orderId==='o-2')?.status).toBe('cancelled')});
test('incremental path reconciles with full refresh',()=>{const incremental=applyIncremental(buildOrdersMart(data.base),data.corrected,['o-2']);const full=buildOrdersMart(data.corrected);expect(incremental).toEqual(full);expect(dailyNetRevenue(incremental)).toEqual(dailyNetRevenue(full))});
`,
    );
    writeFileSync(
      join(root, '.kory-eval/analytics-orders.json'),
      `${JSON.stringify({
        grain: 'one order per order_id',
        keys: { orderId: 'orderid', payment: 'eventid' },
        status_semantics: 'latest effectiveAt',
        metric: { name: 'net_revenue', owner: 'orders-mart' },
        lineage: ['source to mart lineage'],
        hierarchy_boundary: {
          broader: 'data-analysis',
          'product-analytics': 'out of scope',
        },
        reconciliation: {
          incremental_equals_full_rows: true,
          full_refresh: true,
          daily_net_revenue: { '2026-08-01': 10000, '2026-08-02': 4500 },
        },
      })}\n`,
    );

    const score = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation,
    });
    expect(score.passed).toBe(true);
  });
});
