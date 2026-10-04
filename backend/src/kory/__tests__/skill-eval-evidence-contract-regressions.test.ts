import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACCESSIBILITY_SKILL_EVAL_MATERIALIZERS,
  ACCESSIBILITY_SKILL_EVAL_SCORERS,
} from '../skill-eval-accessibility-fixtures';
import { auditSkillEvalExecutionReadiness } from '../skill-eval-execution';
import {
  PILOT_SKILL_EVAL_MATERIALIZERS,
  PILOT_SKILL_EVAL_SCORERS,
} from '../skill-eval-pilot-fixtures';
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

async function appsecImportFixture() {
  const skillPackage = loadV5SkillPackages().packages.find(
    (item) => item.sidecar.name === 'application-security',
  )!;
  const scenario = buildSkillEvalSuiteV3(skillPackage).scenarios.find(
    (item) => item.id === 'application-security-full-task-1',
  )!;
  const root = mkdtempSync(join(tmpdir(), 'kory-appsec-contract-'));
  roots.push(root);
  const materializer = PILOT_SKILL_EVAL_MATERIALIZERS.find((item) => item.matches(scenario))!;
  const scorer = PILOT_SKILL_EVAL_SCORERS.find((item) => item.scenarioIds.includes(scenario.id))!;
  await materializer.materialize(root, scenario);
  return { root, scenario, scorer };
}

const observation = { output: '', evidence: [], artifacts: [], durationMs: 0 };

describe('evidence contract regressions', () => {
  test('api contract tasks require only scenario-applicable verification categories', () => {
    const skillPackage = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'api-contract-design',
    )!;
    const scenarios = buildSkillEvalSuiteV3(skillPackage).scenarios;
    const exportCheck = scenarios
      .find((item) => item.id === 'api-contract-design-full-task-1-individual')!
      .falsifiableChecks.find((item) => item.id === 'verification-discipline')!;
    const cursorCheck = scenarios
      .find((item) => item.id === 'api-contract-design-full-task-2-individual')!
      .falsifiableChecks.find((item) => item.id === 'verification-discipline')!;

    expect(exportCheck.assertion).toContain('same-key replay');
    expect(exportCheck.assertion).toContain('Do not invent unrelated pagination');
    expect(cursorCheck.assertion).toContain('stable cursor traversal under concurrent inserts');
    expect(cursorCheck.assertion).toContain('Do not invent unrelated authorization-denial');
  });

  test('accessibility verification remains blocked until representative live runtimes exist', () => {
    const skillPackage = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'accessibility-verification',
    )!;
    const readiness = auditSkillEvalExecutionReadiness(
      [skillPackage],
      ACCESSIBILITY_SKILL_EVAL_MATERIALIZERS,
      ACCESSIBILITY_SKILL_EVAL_SCORERS,
    );

    expect(readiness).toHaveLength(2);
    expect(readiness.every((row) => row.ready === false)).toBe(true);
    expect(readiness[0]?.reasons.join(' ')).toMatch(/real supported browser/i);
    expect(readiness[1]?.reasons.join(' ')).toMatch(/real Android device or emulator/i);
  });

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

  test('Android verification preserves the exact TalkBack identity without capability padding', async () => {
    const { root, scenario, scorer } = await accessibilityFixture(
      'accessibility-verification',
      'accessibility-verification-full-task-2',
    );
    const tasks = [
      'row-label-role-state',
      'disabled-reason',
      'switch-spoken-state',
      'no-duplicate-label',
      'detail-focus-return',
      'alternate-switch-input',
      'max-text-scale-long-name',
    ];
    writeFileSync(
      join(root, '.kory-eval/android-verification.json'),
      `${JSON.stringify(
        {
          environment: {
            platformVersion: 'Android API 37',
            appBuild: 'fixture',
            assistiveTechnology: 'TalkBack 17.0',
          },
          rows: tasks.map((task) => ({
            task,
            input: task === 'alternate-switch-input' ? 'switch input' : 'touch exploration',
            platform: 'Android API 37',
            at: 'TalkBack 17.0',
            manual: true,
            simulated: true,
            passed: true,
            observations: [],
          })),
          automation: { tool: 'fixture scanner', passed: true, findings: [] },
          manualVerdict: 'pass',
          automationControlsVerdict: false,
          liveRuntimeVerified: false,
          untested: ['real Android device and assistive-technology combinations'],
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

  test('application-security scorer accepts canonical roots and safe option allowlisting', async () => {
    const { root, scenario, scorer } = await appsecImportFixture();
    writeFileSync(
      join(root, 'src/importer.ts'),
      `import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep, win32 } from 'node:path';

export interface FetchHop { url:string; resolvedIp:string }
export interface ArchiveMetadata { entries:number; totalUncompressedBytes:number; maxEntryBytes:number; maxDepth:number }
export interface ConverterInvocation { file:string; args:string[]; shell:boolean }

export function validateFetchChain(hops:FetchHop[]):boolean {
  return hops.length > 0 && hops.every((hop) => {
    let url: URL;
    try { url = new URL(hop.url); } catch { return false; }
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    const parts = hop.resolvedIp.split('.').map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const [a,b,c] = parts;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && c === 2) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  });
}

export function archiveDestination(jobRoot:string, entryName:string):string {
  if (!entryName || entryName.includes('\\0') || isAbsolute(entryName) || win32.isAbsolute(entryName)) throw new Error('invalid path');
  const parts = entryName.replaceAll('\\\\','/').split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes(':'))) throw new Error('invalid path');
  const root = realpathSync(jobRoot);
  const target = resolve(root, ...parts);
  if (!target.startsWith(root + sep)) throw new Error('escape');
  const parent = realpathSync(dirname(target));
  if (parent !== root && !parent.startsWith(root + sep)) throw new Error('symlink escape');
  return target;
}

export function validateArchive(m:ArchiveMetadata):boolean {
  return m.entries > 0 && m.entries <= 10_000 && m.totalUncompressedBytes <= 2_000_000_000 && m.maxEntryBytes <= 1_000_000_000 && m.maxDepth <= 32;
}

export function converterInvocation(input:string, output:string, options:string[]):ConverterInvocation {
  if (options.length !== 2 || options[0] !== '--quality' || !['low','medium','high'].includes(options[1]!)) throw new Error('unsupported converter option');
  return { file:'media-converter', args:[...options, input, '-o', output], shell:false };
}

export function sanitizeDiagnostic(message:string):string {
  return message
    .replace(/Authorization:\\s*Bearer\\s+\\S+/giu, 'Authorization: Bearer [redacted]')
    .replace(/[\\u0000-\\u001f\\u007f-\\u009f]/gu, ' ')
    .slice(0, 1024);
}
`,
    );
    writeFileSync(
      join(root, 'tests/importer.test.ts'),
      `import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveDestination, converterInvocation, validateFetchChain } from '../src/importer';
test('redirect private SSRF targets are rejected',()=>expect(validateFetchChain([{url:'https://x.test',resolvedIp:'127.0.0.1'}])).toBe(false));
test('archive traversal path is rejected',()=>{const root=mkdtempSync(join(tmpdir(),'kory-appsec-test-'));try{expect(()=>archiveDestination(root,'../escape')).toThrow()}finally{rmSync(root,{recursive:true,force:true})}});
test('converter shell argv policy rejects unsupported flags',()=>expect(()=>converterInvocation('a','b',['--metadata','x'])).toThrow());
`,
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
