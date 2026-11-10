import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
import {
  DATA_PERFORMANCE_VISUALIZATION_MATERIALIZERS,
  DATA_PERFORMANCE_VISUALIZATION_SCORERS,
} from '../skill-eval-data-performance-visualization-fixtures';
import { buildSkillEvalSuiteV3 } from '../skill-eval-harness';
import { createConceptFixtures, scoreConceptFixture } from '../skill-eval-concept-fixtures';
import { hasRegressionText } from '../skill-eval-fixture-helpers';
import {
  BUILTIN_SKILL_EVAL_MATERIALIZERS,
  BUILTIN_SKILL_EVAL_SCORERS,
} from '../skill-eval-fixtures';
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

async function dataAnalysisFixture(scenarioId: string) {
  const skillPackage = loadV5SkillPackages().packages.find(
    (item) => item.sidecar.name === 'data-analysis',
  )!;
  const scenario = buildSkillEvalSuiteV3(skillPackage).scenarios.find(
    (item) => item.id === scenarioId,
  )!;
  const root = mkdtempSync(join(tmpdir(), 'kory-data-analysis-contract-'));
  roots.push(root);
  const materializer = PILOT_SKILL_EVAL_MATERIALIZERS.find((item) => item.matches(scenario))!;
  const scorer = PILOT_SKILL_EVAL_SCORERS.find((item) => item.scenarioIds.includes(scenarioId))!;
  await materializer.materialize(root, scenario);
  return { root, scenario, materializer, scorer };
}

async function visualizationFixture(scenarioId: string) {
  const skillPackage = loadV5SkillPackages().packages.find(
    (item) => item.sidecar.name === 'data-visualization',
  )!;
  const scenario = buildSkillEvalSuiteV3(skillPackage).scenarios.find(
    (item) => item.id === scenarioId,
  )!;
  const root = mkdtempSync(join(tmpdir(), 'kory-visualization-contract-'));
  roots.push(root);
  const materializer = DATA_PERFORMANCE_VISUALIZATION_MATERIALIZERS.find((item) =>
    item.matches(scenario),
  )!;
  const scorer = DATA_PERFORMANCE_VISUALIZATION_SCORERS.find((item) =>
    item.scenarioIds.includes(scenarioId),
  )!;
  await materializer.materialize(root, scenario);
  mkdirSync(join(root, '.kory-eval'), { recursive: true });
  return { root, scenario, materializer, scorer };
}

async function capacityGapFixture(policy: Record<string, unknown> = { interpolation: false }) {
  const fixture = await visualizationFixture('data-visualization-full-task-1-individual');
  const artifactPath = join(fixture.root, '.kory-eval/visualization-capacity.json');
  const sourcePath = join(fixture.root, 'data/capacity.json');
  const artifact = {
    readerPersona: null,
    analyticalTask: 'trend comparison for when to consider adding capacity',
    timeGrainMinutes: 5,
    chart: {
      panels: [
        { medianMs: 'solid line in milliseconds', p95Ms: 'dashed line in milliseconds' },
        { throughputRps: 'square points in requests/sec on a separate panel' },
      ],
      missingness: { missingIntervals: ['10:10', '10:15'], ...policy },
      annotation: { time: '10:15', label: 'Deployment', causalClaim: false },
    },
    accessibleDescription: 'Text alternative for every observed point and missing interval.',
    accessibleTable: { rows: JSON.parse(readFileSync(sourcePath, 'utf8')) },
    verification: { status: 'unobserved', scope: 'structured specification only' },
  };
  const write = (value: unknown = artifact) =>
    writeFileSync(artifactPath, `${JSON.stringify(value, null, 2)}\n`);
  const score = () => fixture.scorer.score({
    scenario: fixture.scenario, experiment: {} as never, workingDirectory: fixture.root, observation,
  });
  write();
  return { ...fixture, artifact, artifactPath, sourcePath, write, score };
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

function sha256Path(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function writeVisualizationVerification(input: {
  root: string;
  artifactPath: string;
  sourcePath: string;
  verificationPath: string;
  mutation: string;
}) {
  writeFileSync(
    join(input.root, input.verificationPath),
    `${JSON.stringify({
      artifactSha256: sha256Path(join(input.root, input.artifactPath)),
      sourceSha256: sha256Path(join(input.root, input.sourcePath)),
      command: 'fixture verification command',
      success: { executed: true, passed: true },
      negativePath: { executed: true, mutation: input.mutation, rejected: true },
      recovery: { executed: true, passed: true },
    })}\n`,
  );
}

describe('evidence contract regressions', () => {
  test('planning verification criteria are falsifiable and not evidence-label placeholders', () => {
    const pkg = loadV5SkillPackages().packages.find((item) => item.sidecar.name === 'planning')!;
    const scenarios = buildSkillEvalSuiteV3(pkg).scenarios;
    const checks = scenarios.filter((item) => item.id.startsWith('planning-full-task-'))
      .map((task) => ({ task, assertion: task.falsifiableChecks.find((check) =>
        check.id === 'verification-discipline')!.assertion }));
    expect(checks).toHaveLength(2);
    for (const { task, assertion } of checks) {
      expect(task.requiredEvidence.some((entry) => entry.toLowerCase() === assertion.toLowerCase())).toBe(false);
      expect(assertion).toMatch(/observed result|observable pass\/fail/u);
    }
    expect(checks[0]!.assertion).toContain('session TTL');
    expect(checks[1]!.assertion).toContain('shadow-mode reconciliation');
  });

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

  test('grpc tasks keep blind verification scoped to the individual scenario', () => {
    const skillPackage = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'grpc-protobuf',
    )!;
    const scenarios = buildSkillEvalSuiteV3(skillPackage).scenarios;
    const fieldEvolution = scenarios.find(
      (item) => item.id === 'grpc-protobuf-full-task-1-individual',
    )!;
    const streaming = scenarios.find((item) => item.id === 'grpc-protobuf-full-task-2-individual')!;
    const fieldVerification = fieldEvolution.falsifiableChecks.find(
      (item) => item.id === 'verification-discipline',
    )!.assertion;
    const streamVerification = streaming.falsifiableChecks.find(
      (item) => item.id === 'verification-discipline',
    )!.assertion;

    expect(fieldVerification).toContain('old/new cross-version binary compatibility');
    expect(fieldVerification).toContain('Do not require unrelated streaming');
    expect(streamVerification).toContain('slow-reader backpressure');
    expect(streamVerification).toContain('Do not require unrelated protobuf field-evolution');
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

  test('game accessibility rejects keyword-only lists without task, channel, and verification evidence', async () => {
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
    expect(score.passed).toBe(false);
    expect(score.evidence).toContain(
      'structured task, channel, matrix and regression evidence: missing',
    );
  });

  test('game accessibility accepts complete planned task contracts with semantic compounds across separators', async () => {
    const { root, scenario, scorer } = await accessibilityFixture(
      'accessibility-practice',
      'accessibility-practice-full-task-game-system',
    );
    const tasks = [
      'menu',
      'tutorial',
      'combat',
      'coop-communication',
      'pause-settings',
      'recovery',
    ];
    const channels = [
      'dialogue',
      'non-speech-audio',
      'visual-events',
      'combat-status',
      'communication',
    ];
    const regressionTriggers = [
      'controller remap collision',
      'controller disconnect and reconnect',
      'directional urgent alarm',
      'color-only combat telegraph',
      'upgrade navigation losing selection',
      'online co-op shared pause and communication',
    ];
    const artifact = {
      taskContracts: tasks.map((taskId) => ({
        taskId,
        goal: `Finish the ${taskId} task and confirm accessible controller actions.`,
        barrier: `The ${taskId} screen hides a required action behind a controller-only gesture.`,
        alternative: `Provide an equivalent remappable action and an adaptive input path for ${taskId}.`,
        failureState: `A controller disconnect or remap collision interrupts ${taskId}.`,
        recoveryInvariant: `Reconnect the controller, restore focus and resume ${taskId} without losing progress.`,
        owner: 'Game accessibility engineering',
      })),
      channelAlternatives: channels.map((channelId) => ({
        channelId,
        information: `${channelId} conveys critical gameplay information, status and urgency.`,
        alternative: `Provide redundant text, audio and icon equivalents for ${channelId} information.`,
        deliveryBehavior: `Players configure the ${channelId} alternative in game settings and can replay it.`,
      })),
      verificationMatrix: tasks.map((taskId) => ({
        taskId,
        platform: 'PC console game build',
        controller: 'Controller, keyboard and adaptive switch input',
        expectedObservation: `The ${taskId} goal remains reachable and all critical cues have equivalents.`,
        method: `Perform manual controller remapping and assisted input checks for ${taskId}.`,
        status: 'planned',
        observedResult: null,
        evidenceRef: null,
        risk: 'Physical devices and live game build are unavailable for verification.',
      })),
      regressionOracles: regressionTriggers.map((trigger) => ({
        trigger,
        failure: `The ${trigger} failure removes essential information or traps input and selection.`,
        recoveryInvariant: `After ${trigger}, restore equivalent cues and recover navigable focus safely.`,
      })),
      designNotes: [
        'Controller remap supports confirm, back and pause after disconnect and reconnect.',
        'Urgent directional alarms pair non_speech_audio with visible and spoken equivalents.',
        'Color-only combat telegraph carries health, stamina and ammo status without color reliance.',
        'Camera motion and visual intensity are configurable, including long text readability.',
        'Upgrade navigation preserves focus and selection during interruption and recovery.',
        'Online co-op pings and text chat carry communication cues; offline solo remains viable.',
        'Planned hardware tests are untested and unverified; no compliance or conformance claimed.',
      ],
    };
    writeFileSync(
      join(root, '.kory-eval/game-accessibility.json'),
      `${JSON.stringify(artifact, null, 2)}\n`,
    );

    const score = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation,
    });
    expect(score.passed).toBe(true);
    expect(score.evidence).toContain(
      'structured task, channel, matrix and regression evidence: complete',
    );
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

  test('data-analysis AOV sensitivity normalizes units while preserving raw paid line grain', async () => {
    const { root, scenario, materializer, scorer } = await dataAnalysisFixture(
      'data-analysis-full-task-1-individual',
    );
    expect(materializer.id).toBe('data-analysis/unit-grain-revenue-reconciliation@2');
    expect(scorer.id).toBe('data-analysis/unit-grain-revenue-reconciliation-scorer@4');
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain(
      'average normalized `legacy_total` across paid source line rows',
    );
    writeFileSync(
      join(root, 'tests/analyze.test.ts'),
      `import { afterEach, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
afterEach(() => rmSync('analysis.json', { force: true }));
test('candidate may clean generated analysis output', () => {
  expect(true).toBe(true);
});
`,
    );

    const artifact = {
      grain: 'unique order',
      duplicateRowsRemoved: 1,
      refundedOrdersExcludedFromAov: 2,
      reconciliation: {
        pre: { orders: 3, grossRevenue: 300, netRevenue: 180 },
        post: { orders: 3, grossRevenue: 220, netRevenue: 160 },
      },
      aov: { pre: 90, post: 80, difference: -10, percentChange: -11.11 },
      naiveRowAverage: { pre: 95, post: 85 },
      uncertainty: {
        method: 'descriptive census of provided export; no inferential interval',
        sampleSizePre: 2,
        sampleSizePost: 2,
      },
      conclusion: { direction: 'decrease', causal: false },
    };
    writeFileSync(
      join(root, 'src/analyze.ts'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync('analysis.json', ${JSON.stringify(
        JSON.stringify(artifact, null, 2) + '\n',
      )});\n`,
    );
    const score = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation,
    });
    expect(score.passed).toBe(true);

    const mixedUnitArtifact = {
      ...artifact,
      naiveRowAverage: { pre: 9013.333333333334, post: 1231.6666666666667 },
    };
    writeFileSync(
      join(root, 'src/analyze.ts'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync('analysis.json', ${JSON.stringify(
        JSON.stringify(mixedUnitArtifact, null, 2) + '\n',
      )});\n`,
    );
    const mixedUnitScore = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation,
    });
    expect(mixedUnitScore.passed).toBe(false);
  });

  test.each([
    ['boolean interpolation policy', { interpolation: false }],
    ['none interpolation policy', { interpolation: 'none' }],
    ['disabled interpolation policy', { interpolation: 'disabled' }],
    ['null-aware interpolation policy', { interpolation: 'none-across-null-values' }],
    ['connection prohibition', { rendering: 'Do not connect across missing values.' }],
    ['segment prohibition', { rendering: 'Do not draw a line segment across either gap.' }],
    ['passive line prohibition', { rendering: 'Gaps stay visible: no line is drawn across missing telemetry.' }],
    ['null filter prohibition', { rendering: 'Break paths at null values and never filter nulls before connecting lines.' }],
    ['interpolation list prohibition', { rendering: 'Null metrics remain explicit gaps. No smoothing, interpolation, aggregation, or derived metrics.' }],
    ['prose none policy', { interpolation: 'None. Source observations are retained as supplied; null metric values remain explicit gaps.' }],
    ['pronominal interpolation list', { rendering: 'Null observations stay visible as gaps; do not filter, interpolate, or connect across them.' }],
    ['pronominal reconnect list', { rendering: 'Split the series into segments; never filter, reconnect, interpolate, or smooth across them.' }],
  ])('capacity scorer accepts %s without requiring a preferred prose spelling', async (_name, policy) => {
    const { artifact, artifactPath, sourcePath, score } = await capacityGapFixture(policy);
    const sourceBytes = readFileSync(sourcePath);
    const bytes = readFileSync(artifactPath, 'utf8');
    const result = await score();
    expect(result.passed).toBe(true);
    expect(result.verification).toBe(1);
    expect(result.evidence).toContain('missing intervals explicitly non-interpolated: yes');
    expect(result.evidence).toContain(
      'host-owned negative gap probes: interpolation enablement=rejected; null-dropping break-path=rejected',
    );
    expect(result.evidence.join('\n')).toContain(
      'success=passed; negative gap corruption=rejected; recovery reread=passed',
    );
    expect(result.evidence.join('\n')).toContain(`artifactSha256=${sha256Path(artifactPath)}`);
    expect(result.evidence.join('\n')).toContain(`sourceSha256=${sha256Path(sourcePath)}`);
    expect(result.evidence.join('\n')).toContain('browser rendering and reader usability are unobserved');
    expect(readFileSync(artifactPath, 'utf8')).toBe(bytes);
    expect(readFileSync(sourcePath)).toEqual(sourceBytes);

    // Neither a forbidden structured policy nor an executable null-dropping path
    // may be excused by otherwise correct prose, metadata or candidate claims.
    for (const corruption of [
      { chart: { ...artifact.chart, missingness: { ...artifact.chart.missingness, interpolation: true } } },
      { vconcat: [{
        mark: { type: 'line', invalid: 'break-paths-show-path-domains' },
        transform: [{ filter: 'isValid(datum.medianMs)' }],
        encoding: { y: { field: 'medianMs', type: 'quantitative' } },
      }] },
    ]) {
      writeFileSync(artifactPath, JSON.stringify({ ...artifact, ...corruption }));
      const corrupted = await score();
      expect(corrupted.passed).toBe(false);
      expect(corrupted.verification).toBe(0);
      expect(corrupted.evidence).toContain('missing intervals explicitly non-interpolated: no');
      expect(corrupted.evidence.join('\n')).toContain('negative gap corruption=not run');
    }
    writeFileSync(artifactPath, bytes);
    expect(await score()).toEqual(result);

    const unspecified = { ...artifact, chart: { ...artifact.chart, missingness: {
      missingIntervals: ['10:10', '10:15'],
    } } };
    writeFileSync(artifactPath, JSON.stringify(unspecified));
    expect((await score()).passed).toBe(false);
  });

  test('capacity scorer accepts camelCase fallback keys and a text-only fallback', async () => {
    const { artifact, write, score } = await capacityGapFixture();
    // JSON keys arrive without separators, so `textAlternative` and
    // `nonColorDistinctions` are the same declarations as their spaced spellings.
    write({
      ...artifact,
      accessibleDescription: undefined,
      accessibleTable: undefined,
      accessibility: {
        textAlternative: 'Every observed point and both missing intervals are described in text.',
        nonColorDistinctions: ['Median is solid with circles; p95 is dashed with squares.'],
      },
    });
    const textOnly = await score();
    expect(textOnly.evidence.join('\n')).toContain('non-color + table/text fallback: present');

    // The fallback is still required, and it still has to carry a non-color
    // distinction, so removing either keeps the artifact refused.
    write({ ...artifact, accessibleDescription: undefined, accessibleTable: undefined });
    expect((await score()).evidence.join('\n')).toContain(
      'non-color + table/text fallback: missing',
    );

    write({
      ...artifact,
      accessibleDescription: undefined,
      accessibility: { table: true },
      chart: {
        ...artifact.chart,
        panels: [
          { medianMs: 'first series in milliseconds', p95Ms: 'second series in milliseconds' },
          { throughputRps: 'throughput in requests/sec on a separate panel' },
        ],
      },
    });
    expect((await score()).evidence.join('\n')).toContain(
      'non-color + table/text fallback: missing',
    );
  });

  test.each([
    ['linear interpolation', { interpolation: 'linear' }],
    ['enabled interpolation', { interpolation: 'enabled' }],
    ['affirmative reconnect clause', { rendering: 'No interpolation; connect a line across missing intervals.' }],
    ['affirmative interpolation clause', { rendering: 'No interpolation, but interpolate across both gaps.' }],
    ['negated line break', { rendering: 'Do not break the line across either gap.' }],
  ])('capacity scorer rejects contradictory %s policy', async (_name, contradiction) => {
    const { artifact, artifactPath, sourcePath, write, score } = await capacityGapFixture();
    const pristine = readFileSync(artifactPath);
    const source = readFileSync(sourcePath);
    const success = await score();
    expect(success.passed).toBe(true);
    write({ ...artifact, renderingPolicy: contradiction });
    const rejected = await score();
    expect(rejected.passed).toBe(false);
    expect(rejected.verification).toBe(0);
    expect(rejected.evidence).toContain('missing intervals explicitly non-interpolated: no');
    expect(rejected.evidence.join('\n')).toContain('negative gap corruption=not run');
    expect(readFileSync(sourcePath)).toEqual(source);
    writeFileSync(artifactPath, pristine);
    expect(await score()).toEqual(success);
  });

  test('capacity scorer does not credit a negated line-break declaration', async () => {
    const { score } = await capacityGapFixture({ rendering: 'Do not break the line across either gap.' });
    const result = await score();
    expect(result.passed).toBe(false);
    expect(result.evidence).toContain('missing intervals explicitly non-interpolated: no');
  });

  test.each([
    ['nested valid filter', { mark: { type: 'line', invalid: 'break-paths-show-path-domains' }, transform: [
      { filter: { and: [{ field: 'medianMs', valid: true }] } },
    ] }],
    ['negated invalid filter', { mark: { type: 'line', invalid: 'break-paths-show-path-domains' }, transform: [
      { filter: { not: { field: 'p95Ms', valid: false } } },
    ] }],
    ['truthy telemetry filter', { mark: { type: 'line', invalid: 'break-paths-show-path-domains' }, transform: [
      { filter: 'datum.medianMs' },
    ] }],
    ['bracket-access validity filter', { mark: { type: 'line', invalid: 'break-paths-show-path-domains' }, transform: [
      { filter: 'isValid(datum["medianMs"])' },
    ] }],
    ['reverse null comparison filter', { mark: { type: 'line', invalid: 'break-paths-show-path-domains' }, transform: [
      { filter: 'null !== datum.p95Ms' },
    ] }],
    ['parenthesized conjunctive filter', { mark: { type: 'line', invalid: 'break-paths-show-path-domains' }, transform: [
      { filter: '(isValid(datum.medianMs)) && isValid(datum.time)' },
    ] }],
    ['null imputation', { mark: { type: 'line', invalid: 'break-paths-show-path-domains' }, transform: [
      { impute: 'medianMs', key: 'time', value: 0 },
    ] }],
  ])('capacity scorer rejects executable %s', async (_name, path) => {
    const { artifact, artifactPath, sourcePath, write, score } = await capacityGapFixture();
    const success = await score();
    const source = readFileSync(sourcePath);
    const corrupted = { ...artifact, vconcat: [{
      ...path, encoding: { y: { field: 'medianMs', type: 'quantitative' } },
    }] };
    write(corrupted);
    const bytes = readFileSync(artifactPath);
    const rejected = await score();
    expect(rejected.passed).toBe(false);
    expect(rejected.verification).toBe(0);
    expect(rejected.evidence).toContain('executable line-path topology: reconnect-risk');
    expect(readFileSync(artifactPath)).toEqual(bytes);
    expect(readFileSync(sourcePath)).toEqual(source);
    write();
    expect(await score()).toEqual(success);
  });

  test('capacity scorer inspects executable line paths inside the chart wrapper', async () => {
    const { artifact, write, score } = await capacityGapFixture();
    write({ ...artifact, chart: { ...artifact.chart,
      mark: { type: 'line', invalid: 'break-paths-show-path-domains' },
      transform: [{ filter: 'isValid(datum.medianMs)' }],
      encoding: { y: { field: 'medianMs', type: 'quantitative' } },
    } });
    const result = await score();
    expect(result.passed).toBe(false);
    expect(result.evidence).toContain('executable line-path topology: reconnect-risk');
  });

  test.each([
    ['default Vega-Lite path break', { type: 'line' }, true],
    ['explicit Vega-Lite path break', { type: 'line', invalid: 'break-paths-filter-domains' }, true],
    ['Vega-Lite reconnect filter', { type: 'line', invalid: 'filter' }, false],
    ['Vega-Lite forced invalid display', { type: 'line', invalid: 'show' }, false],
    ['unsupported legacy invalid mode', { type: 'line', invalid: 'break-path' }, false],
    ['unsupported Vega defined predicate', { type: 'line', invalid: 'filter', defined: '!isValid(datum.medianMs)' }, false],
  ])('capacity scorer handles %s without imaginary Vega-Lite tokens', async (_name, mark, expected) => {
    const { artifact, write, score } = await capacityGapFixture();
    write({ ...artifact, vconcat: [{ mark, encoding: {
      x: { field: 'time', type: 'ordinal' },
      y: { field: 'medianMs', type: 'quantitative' },
    } }] });
    const result = await score();
    expect(result.passed).toBe(expected);
    expect(result.evidence).toContain(
      `executable line-path topology: ${expected ? 'gap-preserving' : 'reconnect-risk'}`,
    );
  });

  test('capacity scorer rejects a scale override that makes missing points drawable', async () => {
    const { artifact, write, score } = await capacityGapFixture();
    write({ ...artifact, config: { scale: { invalid: { y: { value: 0 } } } },
      vconcat: [{ mark: 'line', encoding: {
        y: { field: 'medianMs', type: 'quantitative' },
      } }] });
    const result = await score();
    expect(result.passed).toBe(false);
    expect(result.evidence).toContain('executable line-path topology: reconnect-risk');
  });

  test.each([
    ['timestamp validity filter', { filter: 'isValid(datum.time)' }],
    ['structured timestamp filter', { filter: { field: 'time', valid: true } }],
    ['null-preserving disjunction', { filter: { or: [
      { field: 'medianMs', valid: true }, { field: 'medianMs', equal: null },
    ] } }],
    ['null-preserving expression', { filter: 'isValid(datum.medianMs) || datum.medianMs === null' }],
  ])('capacity scorer retains gap-preserving %s', async (_name, transform) => {
    const { artifact, write, score } = await capacityGapFixture();
    write({ ...artifact, transform: [transform], vconcat: [{
      mark: { type: 'line', invalid: 'break-paths-show-path-domains' },
      encoding: { y: { field: 'medianMs', type: 'quantitative' } },
    }] });
    const result = await score();
    expect(result.passed).toBe(true);
    expect(result.evidence).toContain('executable line-path topology: gap-preserving');
  });

  test.each([
    ['hyphenated', 'broader performance-debugging; gpu-compute is not selected'],
    ['spaced', 'broader performance debugging; GPU compute is not selected'],
    ['underscored', 'broader performance_debugging; gpu_compute is not selected'],
  ])('database-performance scorer accepts a %s hierarchy boundary', async (_name, boundary) => {
    const skillPackage = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'database-performance',
    )!;
    const scenario = buildSkillEvalSuiteV3(skillPackage).scenarios.find(
      (item) => item.id === 'database-performance-full-task-1-individual',
    )!;
    const root = mkdtempSync(join(tmpdir(), 'kory-dbperf-boundary-'));
    roots.push(root);
    const materializer = DATA_PERFORMANCE_VISUALIZATION_MATERIALIZERS.find((item) =>
      item.matches(scenario),
    )!;
    const scorer = DATA_PERFORMANCE_VISUALIZATION_SCORERS.find((item) =>
      item.scenarioIds.includes(scenario.id),
    )!;
    await materializer.materialize(root, scenario);
    mkdirSync(join(root, '.kory-eval'), { recursive: true });
    const artifact = {
      engine: 'PostgreSQL 17.5',
      query: 'tenant_id=$1 and status=$2 ordered by created_at desc limit 100',
      distribution: { rows: '8400000 enterprise, 4010 p99, 61 percent open' },
      before: 'generic plan misestimates cardinality; 3980 to 4010 ms tail',
      hypothesis: 'skew needs extended statistics rather than a new index',
      selected: 'extended-statistics with mcv and dependencies; 168 to 151 ms',
      rejected: [
        'redundant-prefix-index tenant-only index: planner does not select it, no benefit',
        'force-custom-plan: broad session setting regresses unrelated workload',
      ],
      effects: {
        writeCpu: '0.2 percent', storage: '0.01 GiB', lock: 'writers not blocked',
        neighbor: '1.1 percent', planningCpu: '19 percent for the rejected force_custom_plan setting',
      },
      concurrency: '850 writes per second',
      hierarchyBoundary: boundary,
    };
    const write = (hierarchyBoundary: string) =>
      writeFileSync(
        join(root, '.kory-eval/database-skew.json'),
        `${JSON.stringify({ ...artifact, hierarchyBoundary }, null, 2)}\n`,
      );
    write(boundary);
    const passed = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation,
    });
    expect(passed.evidence.join('\n')).toContain('performance-debugging/GPU boundary: explicit');
    expect(passed.passed, passed.evidence.join('\n')).toBe(true);

    // A boundary that names neither neighbour, or names them without a boundary
    // verdict, is still refused.
    write('broader performance debugging is related work');
    const neighborOnly = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation,
    });
    expect(neighborOnly.evidence.join('\n')).toContain('performance-debugging/GPU boundary: missing');
    expect(neighborOnly.passed).toBe(false);

    write('the boundary is recorded elsewhere');
    const verdictOnly = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation,
    });
    expect(verdictOnly.passed).toBe(false);
  });

  test('data-visualization capacity scorer uses host verification and preserves narrow negation', async () => {
    const { root, scenario, materializer, scorer } = await visualizationFixture(
      'data-visualization-full-task-1-individual',
    );
    expect(materializer.id).toBe('data-visualization/capacity-trend-uncertainty-chart@4');
    expect(scorer.id).toBe('data-visualization/capacity-trend-uncertainty-chart-scorer@13');
    expect(scenario.prompt).not.toMatch(/contains missingness, duplicates, unit ambiguity/u);
    expect(scenario.prompt).toContain('when to consider adding capacity');
    expect(scenario.prompt).toContain('no reader persona');

    writeFileSync(
      join(root, '.kory-eval/visualization-capacity.json'),
      `${JSON.stringify({
        reader: 'unspecified by fixture',
        decision: 'when to consider adding capacity',
        medium: 'responsive dashboard',
        analyticalTask: 'trend comparison',
        timeGrainMinutes: 5,
        encoding: {
          median: 'line in ms',
          p95: 'line in ms with dash non-color distinction',
          throughput: 'line in requests/sec',
          deployment: 'marker annotation only',
        },
        resolve: { scale: { y: 'independent' } },
        vconcat: [
          {
            mark: { type: 'line', invalid: 'break-paths-show-path-domains' },
            encoding: {
              x: { field: 'time', type: 'ordinal' },
              y: { field: 'medianMs', type: 'quantitative' },
            },
          },
        ],
        gaps: [
          { time: '10:10', state: 'missing gap', rendering: 'line break; no interpolation' },
          { time: '10:15', state: 'missing gap', rendering: 'line break; not interpolated' },
        ],
        accessibility: {
          table: true,
          description: 'accessible text alternative',
          distinction: 'non-color dash and marker',
        },
        interpretation:
          'A deployment marker is not presented as a cause of later values; it is temporal context only.',
        verification: {
          readerTask: 'Determine whether the deployment caused the p95 increase',
          expected: 'Cannot be determined from the supplied chart or data',
        },
        scopeBoundary:
          'Analytics engineering is not used to redefine telemetry or model semantics.',
      })}\n`,
    );

    const hostVerificationScore = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation,
    });
    expect(hostVerificationScore.passed).toBe(true);
    expect(hostVerificationScore.evidence.join('\n')).toContain(
      'host-owned static specification verification: success=passed; negative gap corruption=rejected; recovery reread=passed',
    );
    expect(hostVerificationScore.evidence.join('\n')).toContain(
      'browser rendering and reader usability are unobserved',
    );

    const reconnecting = JSON.parse(
      readFileSync(join(root, '.kory-eval/visualization-capacity.json'), 'utf8'),
    ) as { vconcat: Array<{ transform?: Array<{ filter: string }> }> };
    reconnecting.vconcat[0]!.transform = [{ filter: 'isValid(datum.medianMs)' }];
    writeFileSync(
      join(root, '.kory-eval/visualization-capacity.json'),
      `${JSON.stringify(reconnecting)}\n`,
    );
    const reconnectingScore = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation,
    });
    expect(reconnectingScore.passed).toBe(false);
    expect(reconnectingScore.evidence).toContain('executable line-path topology: reconnect-risk');

    reconnecting.vconcat[0]!.transform = [];
    writeFileSync(
      join(root, '.kory-eval/visualization-capacity.json'),
      `${JSON.stringify(reconnecting)}\n`,
    );

    const overreaching = JSON.parse(
      readFileSync(join(root, '.kory-eval/visualization-capacity.json'), 'utf8'),
    ) as Record<string, unknown>;
    overreaching.interpretation = 'The deployment caused the p95 latency spike.';
    writeFileSync(
      join(root, '.kory-eval/visualization-capacity.json'),
      `${JSON.stringify(overreaching)}\n`,
    );
    const overreachingScore = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation,
    });
    expect(overreachingScore.passed).toBe(false);
  });

  test('data-visualization conversion scorer accepts numeric interval arrays without weakening value checks', async () => {
    const { root, scenario, materializer, scorer } = await visualizationFixture(
      'data-visualization-full-task-2-individual',
    );
    expect(materializer.id).toBe('data-visualization/regional-conversion-denominator@5');
    expect(scorer.id).toBe('data-visualization/regional-conversion-denominator-scorer@10');

    const source = JSON.parse(readFileSync(join(root, 'data/conversion.json'), 'utf8')) as Array<{
      region: string | null;
      regionCode?: string;
      eligibleSessions: number;
      conversions: number;
    }>;
    const rows = source.map((row) => {
      const rate = row.conversions / row.eligibleSessions;
      const z2 = 1.96 ** 2;
      const scale = 1 + z2 / row.eligibleSessions;
      const center = (rate + z2 / (2 * row.eligibleSessions)) / scale;
      const halfWidth = (1.96 * Math.sqrt(
        (rate * (1 - rate) + z2 / (4 * row.eligibleSessions)) / row.eligibleSessions,
      )) / scale;
      return {
        regionLabel: row.region ?? `Unknown (${row.regionCode})`,
        regionCode: row.regionCode ?? null,
        eligibleSessions: row.eligibleSessions,
        conversions: row.conversions,
        rate,
        interval95: [center - halfWidth, center + halfWidth],
        lowSample: row.eligibleSessions < 50,
        lowSampleFlag:
          row.eligibleSessions < 50 ? 'Low sample: fewer than 50 eligible sessions' : null,
      };
    });
    const collisionOrder = [
      'Northeast',
      'East',
      'South',
      'North',
      'Central',
      'Southwest',
      'West',
      'Unknown (R8)',
    ];
    rows.sort(
      (left, right) =>
        collisionOrder.indexOf(left.regionLabel) - collisionOrder.indexOf(right.regionLabel),
    );
    writeFileSync(
      join(root, '.kory-eval/visualization-conversion.json'),
      `${JSON.stringify({
        analyticalTask: 'rate comparison with uncertainty',
        encoding: {
          type: 'dot-and-interval', order: 'descending conversion rate',
          x: { field: 'rate', type: 'quantitative' },
          interval: { field: 'interval95' },
        },
        rows,
        accessibleTable: {
          table: true,
          textAlternative: 'Accessible text alternative for every region and interval',
        },
        narrowScreen: 'narrow mobile small screen table fallback',
        scopeBoundary:
          'Visualization output only; source data and pipeline stay unchanged; product strategy is out of scope.',
      })}\n`,
    );
    writeVisualizationVerification({
      root,
      artifactPath: '.kory-eval/visualization-conversion.json',
      sourcePath: 'data/conversion.json',
      verificationPath: '.kory-eval/visualization-conversion-verification.json',
      mutation: 'change denominator for one region',
    });

    const score = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation,
    });
    expect(score.passed).toBe(true);

    // The task asks for a per-row low-sample flag. A boolean-only flag must count,
    // while an unmarked small row and a false-positive large row must still fail.
    const artifactPath = join(root, '.kory-eval/visualization-conversion.json');
    const originalArtifact = readFileSync(artifactPath, 'utf8');
    const asSpec = (mutate: (rows: Array<Record<string, unknown>>) => void) => {
      const parsed = JSON.parse(originalArtifact) as { rows: Array<Record<string, unknown>> };
      mutate(parsed.rows);
      writeFileSync(artifactPath, `${JSON.stringify(parsed)}\n`);
    };
    const rescore = async () =>
      scorer.score({ scenario, experiment: {} as never, workingDirectory: root, observation });

    asSpec((rows) => {
      for (const row of rows) delete row.lowSampleFlag;
    });
    const booleanOnly = await rescore();
    expect(booleanOnly.evidence.join('\n')).toContain('two <50 samples visibly flagged: yes');
    expect(booleanOnly.quality).toBe(score.quality);

    asSpec((rows) => {
      const large = rows.find((row) => Number(row.eligibleSessions) >= 50)!;
      large.lowSample = true;
    });
    expect((await rescore()).evidence.join('\n')).toContain(
      'two <50 samples visibly flagged: no',
    );

    asSpec((rows) => {
      const small = rows.find((row) => Number(row.eligibleSessions) < 50)!;
      small.lowSample = false;
    });
    expect((await rescore()).evidence.join('\n')).toContain(
      'two <50 samples visibly flagged: no',
    );

    writeFileSync(artifactPath, originalArtifact);

    const regionOnly = JSON.parse(
      readFileSync(join(root, '.kory-eval/visualization-conversion.json'), 'utf8'),
    ) as { rows: Array<{ regionLabel?: string; region?: string }> };
    const unresolved = regionOnly.rows.find((row) => row.regionLabel === 'Unknown (R8)')!;
    unresolved.region = unresolved.regionLabel;
    delete unresolved.regionLabel;
    writeFileSync(join(root, '.kory-eval/visualization-conversion.json'),
      `${JSON.stringify(regionOnly)}\n`);
    expect((await scorer.score({
      scenario, experiment: {} as never, workingDirectory: root, observation,
    })).passed).toBe(true);

    const wrongDenominator = JSON.parse(
      readFileSync(join(root, '.kory-eval/visualization-conversion.json'), 'utf8'),
    ) as { rows: Array<{ eligibleSessions: number }> };
    wrongDenominator.rows[0]!.eligibleSessions += 1;
    writeFileSync(
      join(root, '.kory-eval/visualization-conversion.json'),
      `${JSON.stringify(wrongDenominator)}\n`,
    );
    writeVisualizationVerification({
      root,
      artifactPath: '.kory-eval/visualization-conversion.json',
      sourcePath: 'data/conversion.json',
      verificationPath: '.kory-eval/visualization-conversion-verification.json',
      mutation: 'change denominator for one region',
    });
    const wrongDenominatorScore = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation,
    });
    expect(wrongDenominatorScore.passed).toBe(false);
  });

  test('CDC scenario binds scalar checkpoint evidence to one partition and separates schema evolution', async () => {
    const skillPackage = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'data-pipeline-engineering',
    )!;
    const scenario = buildSkillEvalSuiteV3(skillPackage).scenarios.find(
      (item) => item.id === 'data-pipeline-engineering-full-task-1-individual',
    )!;
    const materializer = DATA_ENGINEERING_SKILL_EVAL_MATERIALIZERS.find((item) =>
      item.matches(scenario),
    )!;
    const scorer = DATA_ENGINEERING_SKILL_EVAL_SCORERS.find((item) =>
      item.scenarioIds.includes(scenario.id),
    )!;

    expect(materializer.id).toBe('data-pipeline-engineering/idempotent-cdc-backfill@3');
    expect(scorer.id).toBe('data-pipeline-engineering/idempotent-cdc-backfill-scorer@3');
    expect(scenario.prompt).toContain('one Kafka partition (p0)');
    expect(scenario.prompt).toContain(
      'Schema-evolution behavior is exercised separately by scenario 2',
    );
    expect(
      scenario.falsifiableChecks.find((item) => item.id === 'verification-discipline')?.assertion,
    ).toContain('Distinguish the in-memory replay simulation');

    const root = mkdtempSync(join(tmpdir(), 'kory-cdc-identity-contract-'));
    roots.push(root);
    await materializer.materialize(root, scenario);
    mkdirSync(join(root, '.kory-eval'), { recursive: true });
    writeFileSync(
      join(root, 'src/cdc-pipeline.ts'),
      `export interface CdcEvent { eventId:string; sourceLsn:number; recordId:string; operation:'upsert'|'delete'; value?:string; valid?:boolean }
export interface SinkRow { recordId:string; value:string|null; sourceLsn:number; deleted:boolean }
export class CdcPipeline {
  private latest=new Map<string,SinkRow>(); private audit:CdcEvent[]=[]; private quarantine:Array<{event:CdcEvent;reason:string}>=[]; private seen=new Set<string>(); private checkpointLsn=0;
  process(events:CdcEvent[]):void { for(const event of events){ if(this.seen.has(event.eventId)){ this.checkpointLsn=Math.max(this.checkpointLsn,event.sourceLsn); continue; } this.seen.add(event.eventId); if(event.valid===false){ this.quarantine.push({event:structuredClone(event),reason:'INVALID_RECORD'}); this.checkpointLsn=Math.max(this.checkpointLsn,event.sourceLsn); continue; } this.audit.push(structuredClone(event)); const current=this.latest.get(event.recordId); if(!current||event.sourceLsn>current.sourceLsn){ this.latest.set(event.recordId,{recordId:event.recordId,value:event.operation==='delete'?null:String(event.value??''),sourceLsn:event.sourceLsn,deleted:event.operation==='delete'}); } this.checkpointLsn=Math.max(this.checkpointLsn,event.sourceLsn); } }
  rollbackCheckpoint(lsn:number):void { this.checkpointLsn=lsn; } checkpoint():number { return this.checkpointLsn; }
  snapshot(){ return { latest:[...this.latest.values()].sort((a,b)=>a.recordId.localeCompare(b.recordId)), audit:this.audit.map((event)=>structuredClone(event)), quarantine:this.quarantine.map((item)=>structuredClone(item)), checkpointLsn:this.checkpointLsn }; }
}
`,
    );
    writeFileSync(
      join(root, 'tests/cdc-pipeline.test.ts'),
      `import { expect,test } from 'bun:test'; import fixture from '../data/events.json'; import { CdcPipeline } from '../src/cdc-pipeline';
test('checkpoint replay, late backfill, poison quarantine, eventId/sourceLsn recovery',()=>{ const p=new CdcPipeline(); p.process(fixture.initial as any); p.rollbackCheckpoint(100); p.process(fixture.replayAfterCheckpointLoss as any); p.process(fixture.lateBackfill as any); p.process(fixture.poison as any); expect(p.checkpoint()).toBe(103); });
`,
    );
    writeFileSync(
      join(root, '.kory-eval/pipeline-cdc.json'),
      `${JSON.stringify({
        partition: 'single partition p0; sourceLsn and checkpoint are partition-local',
        eventIdentity: 'eventId is global across accepted and quarantined dispositions',
        ordering: 'sourceLsn is the authoritative partition-local order',
        duplicateReplay: 'an already-seen eventId does not write sink or audit again',
        checkpointReplay:
          'checkpoint rollback in this in-memory fixture simulates replay; process-durable restart verification is unavailable',
        lateBackfill: 'older backfill cannot regress newer latest state',
        quarantine: 'INVALID_RECORD retains raw provenance and lineage',
        schemaBoundary:
          'schema evolution is not present here and is covered by separate scenario 2',
        hierarchyBoundary: {
          broader: 'data-analysis',
          neighbor: 'analytics-engineering is downstream and not owned by this pipeline repair',
        },
      })}\n`,
    );
    const validScore = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation,
    });
    expect(validScore.passed).toBe(true);

    writeFileSync(
      join(root, 'src/cdc-pipeline.ts'),
      `export interface CdcEvent { eventId:string; sourceLsn:number; recordId:string; operation:'upsert'|'delete'; value?:string; valid?:boolean }
export interface SinkRow { recordId:string; value:string|null; sourceLsn:number; deleted:boolean }
export class CdcPipeline {
  private latest=new Map<string,SinkRow>(); private audit:CdcEvent[]=[]; private quarantine:Array<{event:CdcEvent;reason:string}>=[]; private auditIds=new Set<string>(); private quarantineIds=new Set<string>(); private checkpointLsn=0;
  process(events:CdcEvent[]):void { for(const event of events){ if(event.valid===false){ if(!this.quarantineIds.has(event.eventId)){ this.quarantineIds.add(event.eventId); this.quarantine.push({event:structuredClone(event),reason:'INVALID_RECORD'}); } this.checkpointLsn=Math.max(this.checkpointLsn,event.sourceLsn); continue; } if(!this.auditIds.has(event.eventId)){ this.auditIds.add(event.eventId); this.audit.push(structuredClone(event)); } const current=this.latest.get(event.recordId); if(!current||event.sourceLsn>current.sourceLsn){ this.latest.set(event.recordId,{recordId:event.recordId,value:event.operation==='delete'?null:String(event.value??''),sourceLsn:event.sourceLsn,deleted:event.operation==='delete'}); } this.checkpointLsn=Math.max(this.checkpointLsn,event.sourceLsn); } }
  rollbackCheckpoint(lsn:number):void { this.checkpointLsn=lsn; } checkpoint():number { return this.checkpointLsn; }
  snapshot(){ return { latest:[...this.latest.values()].sort((a,b)=>a.recordId.localeCompare(b.recordId)), audit:this.audit.map((event)=>structuredClone(event)), quarantine:this.quarantine.map((item)=>structuredClone(item)), checkpointLsn:this.checkpointLsn }; }
}
`,
    );
    const splitIdentityScore = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation,
    });
    expect(splitIdentityScore.passed).toBe(false);
  });
});

async function pipelineDriftFixture() {
  const skillPackage = loadV5SkillPackages().packages.find(
    (item) => item.sidecar.name === 'data-pipeline-engineering',
  )!;
  const scenario = buildSkillEvalSuiteV3(skillPackage).scenarios.find(
    (item) => item.id === 'data-pipeline-engineering-full-task-2-individual',
  )!;
  const root = mkdtempSync(join(tmpdir(), 'kory-pipeline-drift-contract-'));
  roots.push(root);
  const materializer = DATA_ENGINEERING_SKILL_EVAL_MATERIALIZERS.find((item) =>
    item.matches(scenario),
  )!;
  const scorer = DATA_ENGINEERING_SKILL_EVAL_SCORERS.find((item) =>
    item.scenarioIds.includes(scenario.id),
  )!;
  await materializer.materialize(root, scenario);
  mkdirSync(join(root, '.kory-eval'), { recursive: true });
  return { root, scenario, scorer };
}

const DRIFT_BOUNDARY_ARTIFACT = {
  sourceVersion: 'feed v1',
  collaboration: 'broader data-analysis owns the analysis layer',
  neighbours:
    'data-visualization and business metrics remain out of scope here; this is fixture evidence only',
};

describe('pipeline drift boundary guard', () => {
  test('a boundary sentence that says "carry" is not read as an ARR business metric', async () => {
    const { root, scenario, scorer } = await pipelineDriftFixture();
    writeFileSync(
      join(root, '.kory-eval/pipeline-drift.json'),
      JSON.stringify({
        ...DRIFT_BOUNDARY_ARTIFACT,
        rows: 'the pipeline may carry the raw epoch row through unchanged',
      }),
    );
    const result = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation: {} as never,
    });
    expect(result.evidence.join('\n')).toContain('pipeline-vs-visual/business boundary: explicit');
  });

  test('a camelCase neighbour name is read the same as the hyphenated one', async () => {
    const { root, scenario, scorer } = await pipelineDriftFixture();
    writeFileSync(
      join(root, '.kory-eval/pipeline-drift.json'),
      JSON.stringify({
        evidenceLabel: 'synthetic fixture evidence',
        collaboration: 'broader dataAnalysis owns the analysis layer',
        neighbours: 'dataVisualization and business metrics remain out of scope',
      }),
    );
    const result = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation: {} as never,
    });
    expect(result.evidence.join('\n')).toContain('pipeline-vs-visual/business boundary: explicit');
  });

  test('naming visualization without the data neighbour still loses the boundary', async () => {
    const { root, scenario, scorer } = await pipelineDriftFixture();
    writeFileSync(
      join(root, '.kory-eval/pipeline-drift.json'),
      JSON.stringify({
        evidenceLabel: 'synthetic fixture evidence',
        collaboration: 'broader dataAnalysis owns the analysis layer',
        neighbours: 'visualization and business metrics remain out of scope',
      }),
    );
    const result = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation: {} as never,
    });
    expect(result.evidence.join('\n')).toContain('pipeline-vs-visual/business boundary: missing');
  });

  test('an artifact that actually defines ARR still loses the boundary', async () => {
    const { root, scenario, scorer } = await pipelineDriftFixture();
    writeFileSync(
      join(root, '.kory-eval/pipeline-drift.json'),
      JSON.stringify({
        ...DRIFT_BOUNDARY_ARTIFACT,
        metrics: 'ARR is the annual recurring revenue metric this pipeline feeds',
      }),
    );
    const result = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation: {} as never,
    });
    expect(result.evidence.join('\n')).toContain('pipeline-vs-visual/business boundary: missing');
  });
});

describe('admin step-up fixed input rule', () => {
  async function adminFixture() {
    const skillPackage = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'secure-authentication',
    )!;
    const scenario = buildSkillEvalSuiteV3(skillPackage).scenarios.find((item) =>
      item.id.startsWith('secure-authentication-full-task-2'),
    )!;
    const root = mkdtempSync(join(tmpdir(), 'kory-admin-stepup-'));
    roots.push(root);
    const materializer = BUILTIN_SKILL_EVAL_MATERIALIZERS.find((item) => item.matches(scenario))!;
    const scorer = BUILTIN_SKILL_EVAL_SCORERS.find((item) =>
      item.scenarioIds.includes(scenario.id),
    )!;
    await materializer.materialize(root, scenario);
    mkdirSync(join(root, '.kory-eval'), { recursive: true });
    return { root, scenario, scorer };
  }

  test('the administrator task states that the policy module is a fixed input', async () => {
    const { root, scenario } = await adminFixture();
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    expect(readme).toContain('Preserve the evaluator');
    expect(readme).toContain('fixed input');
    expect(scenario.prompt.length).toBeGreaterThan(0);
  });

  test('editing the fixed policy module still trips evaluator integrity', async () => {
    const { root, scenario, scorer } = await adminFixture();
    const original = readFileSync(join(root, 'src/auth-policy.ts'), 'utf8');
    writeFileSync(join(root, 'src/auth-policy.ts'), `${original}\n// candidate edits the oracle\n`);
    const result = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation: {} as never,
    });
    expect(result.integrityFailure).toBe(true);
    expect(result.passed).toBe(false);
  });
});

describe('concept harness integrity classification', () => {
  function conceptWorkspace() {
    const definition = {
      id: 'contract-probe-full-task-1-individual',
      skill: 'contract-probe',
      contract: 'Return exactly {ok}. ok is true.',
      vectors: () => [{ name: 'accepts', input: { a: 1 }, expected: { ok: true } }],
    };
    const root = mkdtempSync(join(tmpdir(), 'kory-concept-integrity-'));
    roots.push(root);
    const fixtures = createConceptFixtures([definition as never]);
    fixtures.materializers[0]!.materialize(root, {} as never);
    return { definition, root };
  }

  test('an unwritten candidate module is a failed attempt, not an integrity failure', () => {
    const { definition, root } = conceptWorkspace();
    rmSync(join(root, 'candidate.ts'));
    const result = scoreConceptFixture(definition as never, root);
    expect(result.passed).toBe(false);
    expect(result.integrityFailure).toBe(false);
    expect(result.evidence.join('\n')).toContain('Candidate module is absent');
  });

  test('a symlinked candidate path is still an integrity failure', () => {
    const { definition, root } = conceptWorkspace();
    rmSync(join(root, 'candidate.ts'));
    writeFileSync(join(root, 'real-candidate.ts'), 'export function solve() { return { ok: true }; }\n');
    symlinkSync(join(root, 'real-candidate.ts'), join(root, 'candidate.ts'));
    const result = scoreConceptFixture(definition as never, root);
    expect(result.integrityFailure).toBe(true);
    expect(result.passed).toBe(false);
  });

  test('tampering with an evaluator input is still an integrity failure', () => {
    const { definition, root } = conceptWorkspace();
    writeFileSync(join(root, 'candidate.ts'), 'export function solve() { return { ok: true }; }\n');
    writeFileSync(join(root, 'contract.json'), '{"tampered":true}\n');
    const result = scoreConceptFixture(definition as never, root);
    expect(result.integrityFailure).toBe(true);
  });
});

describe('regression file naming across languages', () => {
  const requirement = [/remove|shutdown|close|tenant/iu, /exception|concurrent|thread|leak/iu];
  function writtenAs(path: string) {
    const root = mkdtempSync(join(tmpdir(), 'kory-regression-name-'));
    roots.push(root);
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(
      join(root, path),
      'remove shutdown close tenant; exception under concurrent thread leak\n',
    );
    return hasRegressionText(root, requirement);
  }

  test('accepts the Java and Ruby conventions their fixtures ask for', () => {
    for (const path of [
      'src/test/java/TenantSchedulersTest.java',
      'src/TenantSchedulersTests.java',
      'src/TenantSchedulersIT.java',
      'src/TenantSchedulersSpec.java',
      'spec/tenant_spec.rb',
      'spec/tenant_test.rb',
    ]) {
      expect(writtenAs(path), path).toBe(true);
    }
  });

  test('still refuses a production source file and a prose note', () => {
    for (const path of [
      'src/fixture/TenantSchedulers.java',
      'tests/lifecycle-regression.md',
      'README.md',
    ]) {
      expect(writtenAs(path), path).toBe(false);
    }
  });
});
