import type { ConceptFixture, ConceptVector } from './skill-eval-concept-fixtures';
import { createConceptFixtures } from './skill-eval-concept-fixtures';
import {
  runSearchAnalyzerVersioningRuntime,
  runSearchTenantAuthorizationRuntime,
  searchIndexRuntimeReadiness,
} from './skill-eval-search-index-runtime';

const round = (value: number) => Math.round(value * 1_000) / 1_000;

function analyzerVectors(): ConceptVector[] {
  return [
    {
      name: 'versioned target index preserves writes and passes SKU accent and no-result goldens',
      input: {
        oldVersion: 'products-v1',
        targetVersion: 'products-v2',
        initial: [
          { id: '1', name: 'Café ABC-123' },
          { id: '2', name: 'Plain mug' },
        ],
        writesDuringReindex: [{ id: '3', name: 'Café DEF-456' }],
        queries: [
          { q: 'ABC-123', expected: ['1'] },
          { q: 'cafe', expected: ['1', '3'] },
          { q: 'missing', expected: [] },
        ],
      },
      expected: {
        targetVersion: 'products-v2',
        documentCount: 3,
        queryResults: { 'ABC-123': ['1'], cafe: ['1', '3'], missing: [] },
        cutover: true,
        rollbackIndex: 'products-v1',
      },
    },
    {
      name: 'failed relevance parity blocks alias cutover and preserves old index',
      input: {
        oldVersion: 'v1',
        targetVersion: 'v2',
        initial: [{ id: '1', name: 'ZX-9 widget' }],
        writesDuringReindex: [],
        queries: [{ q: 'ZX-9', expected: ['1'] }],
        forceBrokenHyphenHandling: true,
      },
      expected: {
        targetVersion: 'v2',
        documentCount: 1,
        queryResults: { 'ZX-9': [] },
        cutover: false,
        rollbackIndex: 'v1',
      },
    },
  ];
}

function tenantSearchVectors(): ConceptVector[] {
  return [
    {
      name: 'same query in two tenants keeps authorization in cache key and ranking boundary',
      input: {
        query: 'alpha',
        page: 1,
        pageSize: 2,
        tenant: 'A',
        documents: [
          { id: '1', tenant: 'A', text: 'alpha alpha', score: 2 },
          { id: '2', tenant: 'B', text: 'alpha alpha alpha', score: 3 },
          { id: '3', tenant: 'A', text: 'alpha', score: 1 },
        ],
        warmCache: { 'B|alpha|1|2': ['2'] },
      },
      expected: { cacheKey: 'A|alpha|1|2', ids: ['1', '3'], cacheHit: false },
    },
    {
      name: 'empty tenant result never falls back to global cache',
      input: {
        query: 'x',
        page: 1,
        pageSize: 10,
        tenant: 'C',
        documents: [{ id: '1', tenant: 'A', text: 'x', score: 9 }],
        warmCache: { 'A|x|1|10': ['1'] },
      },
      expected: { cacheKey: 'C|x|1|10', ids: [], cacheHit: false },
    },
    {
      name: 'tenant scoped warm cache can be reused',
      input: {
        query: 'x',
        page: 2,
        pageSize: 1,
        tenant: 'A',
        documents: [
          { id: '1', tenant: 'A', text: 'x', score: 2 },
          { id: '2', tenant: 'A', text: 'x', score: 1 },
        ],
        warmCache: { 'A|x|2|1': ['2'] },
      },
      expected: { cacheKey: 'A|x|2|1', ids: ['2'], cacheHit: true },
    },
  ];
}

function normalMatrixVectors(): ConceptVector[] {
  return [
    {
      name: 'inverse-transpose handles non-uniform scale',
      input: { scale: [2, 1, 0.5], normal: [1, 1, 0] },
      expected: { valid: true, normal: [0.447, 0.894, 0], mirrored: false },
    },
    {
      name: 'singular transform refuses to invent a normal',
      input: { scale: [1, 0, 1], normal: [0, 1, 0] },
      expected: { valid: false, normal: null, mirrored: false },
    },
    {
      name: 'negative determinant records mirrored tangent handedness',
      input: { scale: [-1, 2, 1], normal: [0, 0, 1] },
      expected: { valid: true, normal: [0, 0, 1], mirrored: true },
    },
  ];
}

function frustumVectors(): ConceptVector[] {
  return [
    {
      name: 'sphere entirely inside normalized perspective frustum is visible',
      input: { center: [0, 0, -5], radius: 1, near: 1, far: 10, tanHalfFovX: 1, tanHalfFovY: 1 },
      expected: { visible: true, reason: 'inside' },
    },
    {
      name: 'sphere behind camera is culled',
      input: { center: [0, 0, 2], radius: 0.5, near: 1, far: 10, tanHalfFovX: 1, tanHalfFovY: 1 },
      expected: { visible: false, reason: 'behind-camera' },
    },
    {
      name: 'sphere beyond right plane is culled',
      input: { center: [7, 0, -5], radius: 0.5, near: 1, far: 10, tanHalfFovX: 1, tanHalfFovY: 1 },
      expected: { visible: false, reason: 'right-plane' },
    },
    {
      name: 'sphere intersecting near plane remains visible',
      input: {
        center: [0, 0, -1.2],
        radius: 0.5,
        near: 1,
        far: 10,
        tanHalfFovX: 1,
        tanHalfFovY: 1,
      },
      expected: { visible: true, reason: 'inside' },
    },
  ];
}

function terminalTableVectors(): ConceptVector[] {
  return [
    {
      name: 'wide terminal shows table while redirected output stays stable lines',
      input: {
        tty: true,
        width: 80,
        height: 20,
        rows: [
          { name: 'alpha', path: '/tmp/a', status: 'ok' },
          { name: 'βeta', path: '/very/long/path/to/b', status: 'loading' },
        ],
        signal: null,
      },
      expected: {
        mode: 'table',
        visibleRows: 2,
        columns: ['name', 'path', 'status'],
        cursorRestored: true,
        plainLines: [],
      },
    },
    {
      name: 'narrow terminal collapses columns instead of horizontal corruption',
      input: {
        tty: true,
        width: 28,
        height: 8,
        rows: [{ name: 'alpha', path: '/a/really/long/path', status: 'error' }],
        signal: null,
      },
      expected: {
        mode: 'compact',
        visibleRows: 1,
        columns: ['name', 'status'],
        cursorRestored: true,
        plainLines: [],
      },
    },
    {
      name: 'redirected mode uses one stable line per row and no cursor control',
      input: {
        tty: false,
        width: 0,
        height: 0,
        rows: [{ name: 'a', path: '/x', status: 'ok' }],
        signal: null,
      },
      expected: {
        mode: 'plain',
        visibleRows: 1,
        columns: [],
        cursorRestored: true,
        plainLines: ['a\tok\t/x'],
      },
    },
    {
      name: 'interrupt restores terminal state',
      input: { tty: true, width: 80, height: 20, rows: [], signal: 'SIGINT' },
      expected: {
        mode: 'table',
        visibleRows: 0,
        columns: ['name', 'path', 'status'],
        cursorRestored: true,
        plainLines: [],
      },
    },
  ];
}

function terminalModalVectors(): ConceptVector[] {
  return [
    {
      name: 'modal captures delete binding and one confirm queues one command',
      input: { events: ['open-delete', 'delete', 'confirm', 'confirm'] },
      expected: {
        modalOpen: false,
        focus: 'list',
        queued: ['delete-confirmed'],
        announcements: ['Delete item?', 'Delete confirmed'],
      },
    },
    {
      name: 'cancel returns focus without background delete',
      input: { events: ['open-delete', 'cancel', 'delete'] },
      expected: {
        modalOpen: false,
        focus: 'list',
        queued: ['open-delete'],
        announcements: ['Delete item?', 'Delete canceled'],
      },
    },
    {
      name: 'resize while modal open preserves modal focus',
      input: { events: ['open-delete', 'resize', 'key-repeat-delete'] },
      expected: { modalOpen: true, focus: 'modal', queued: [], announcements: ['Delete item?'] },
    },
  ];
}

function operatorUsabilityVectors(): ConceptVector[] {
  return [
    {
      name: 'plan covers novice and expert success failure cancellation rollback and reconnect tasks',
      input: {
        profiles: ['novice', 'expert'],
        scenarios: [
          'target-select',
          'preflight-warning',
          'deploy',
          'cancel',
          'partial-failure',
          'rollback',
          'reconnect',
        ],
        measures: ['completion', 'errors', 'time', 'confidence'],
        observedFindings: [],
      },
      expected: {
        decisionReady: true,
        requiredTasks: [
          'target-select',
          'preflight-warning',
          'deploy',
          'cancel',
          'partial-failure',
          'rollback',
          'reconnect',
        ],
        participantSlices: ['novice', 'expert'],
        severityScale: ['blocker', 'major', 'minor', 'observation'],
        claimsObservedOnly: true,
      },
    },
    {
      name: 'missing recovery scenario makes evaluation incomplete',
      input: {
        profiles: ['novice', 'expert'],
        scenarios: ['target-select', 'deploy'],
        measures: ['completion'],
        observedFindings: [],
      },
      expected: {
        decisionReady: false,
        requiredTasks: [
          'target-select',
          'preflight-warning',
          'deploy',
          'cancel',
          'partial-failure',
          'rollback',
          'reconnect',
        ],
        participantSlices: ['novice', 'expert'],
        severityScale: ['blocker', 'major', 'minor', 'observation'],
        claimsObservedOnly: true,
      },
    },
  ];
}

export const INTERFACE_SEARCH_GRAPHICS_CONCEPTS: readonly ConceptFixture[] = [
  {
    id: 'search-indexing-full-task-1-individual',
    skill: 'search-indexing',
    generation: 3,
    contract: `Build a versioned target search view without mutating oldVersion. Normalize accents by Unicode NFD diacritic removal and lowercase. Treat hyphenated SKU-like tokens containing letters/digits on both sides of '-' as an exact preserved token in addition to natural-language pieces. Apply writesDuringReindex to target before verification. For each query return ids in document order whose analyzed tokens contain all analyzed query tokens. forceBrokenHyphenHandling=true intentionally removes exact hyphen token to model a failed candidate. cutover is true only when every query result exactly matches expected and target document count equals initial unique ids plus new unique writes. rollbackIndex is oldVersion.`,
    vectors: analyzerVectors,
  },
  {
    id: 'search-indexing-full-task-2-individual',
    skill: 'search-indexing',
    generation: 4,
    contract: `Authorization is applied before ranking. cacheKey is tenant|query|page|pageSize. Only documents for tenant are eligible. Warm cache is usable only for the exact cacheKey and returned ids must all belong to tenant; otherwise ignore it. Cold ranking sorts eligible matching documents by score descending then id, then paginates 1-based. Return cacheKey,ids,cacheHit. Never fall back to another tenant/global cache. warmCache is supplied as a plain object mapping cacheKey to the cached id array.`,
    vectors: tenantSearchVectors,
  },
  {
    id: 'three-d-graphics-full-task-1-individual',
    skill: 'three-d-graphics',
    contract: `For diagonal object scale, transform normals by inverse-transpose: divide normal components by scale, then normalize. Any zero scale is singular and returns valid:false, normal:null. mirrored is true when scale product<0. Round normalized components to three decimals. Do not transform normals with the position matrix directly.`,
    vectors: normalMatrixVectors,
  },
  {
    id: 'three-d-graphics-full-task-2-individual',
    skill: 'three-d-graphics',
    contract: `Use a right-handed camera looking down -Z. A sphere is behind-camera when center.z-radius>=0. It is outside near when -center.z+radius<near and outside far when -center.z-radius>far. Horizontal half extent at depth d is d*tanHalfFovX; cull right when center.x-radius>extent and left when center.x+radius<-extent; analogous top/bottom. Return the first reason in behind-camera,near-plane,far-plane,right-plane,left-plane,top-plane,bottom-plane; otherwise visible true reason inside.`,
    vectors: frustumVectors,
  },
  {
    id: 'terminal-interface-full-task-1-individual',
    skill: 'terminal-interface',
    generation: 2,
    contract: `If tty=false return mode plain, no columns, one line per row as name<TAB>status<TAB>path. If tty=true and width<40 return mode compact with columns name,status; otherwise return mode table with columns name,path,status. visibleRows is min(rows.length,max(0,height-2)) for TTY and all rows for plain. cursorRestored must always be true including signals/errors. Return no escape/control content in plainLines.`,
    vectors: terminalTableVectors,
  },
  {
    id: 'terminal-interface-full-task-2-individual',
    skill: 'terminal-interface',
    contract: `Replay terminal UI events. open-delete opens modal, focuses modal and announces Delete item?. While modal open global delete/key-repeat-delete is captured and queues nothing. confirm while open queues delete-confirmed exactly once, closes modal, focuses list, announces Delete confirmed; later confirm does nothing. cancel closes/focuses list/announces Delete canceled. resize never changes focus. A delete event while no modal queues open-delete to represent the normal global binding. Return modalOpen,focus,queued,announcements.`,
    vectors: terminalModalVectors,
  },
  {
    id: 'usability-evaluation-full-task-operator-terminal',
    skill: 'usability-evaluation',
    contract: `This is a bounded evaluation-plan contract, not observed findings. requiredTasks is always target-select,preflight-warning,deploy,cancel,partial-failure,rollback,reconnect in that order. participantSlices must include novice and expert when supplied. severityScale is blocker,major,minor,observation. decisionReady requires both participant slices, every required task, and measures containing completion and errors. claimsObservedOnly is always true because no observedFindings may be fabricated.`,
    vectors: operatorUsabilityVectors,
  },
];

const searchDefinitions = INTERFACE_SEARCH_GRAPHICS_CONCEPTS.filter(
  (definition) => definition.skill === 'search-indexing',
);
const otherDefinitions = INTERFACE_SEARCH_GRAPHICS_CONCEPTS.filter(
  (definition) => definition.skill !== 'search-indexing',
);
const searchComponents = createConceptFixtures(searchDefinitions);
const fixtures = createConceptFixtures(otherDefinitions);

const searchMaterializers = searchComponents.materializers.map((materializer) => ({
  ...materializer,
  id: materializer.id.replace('/concept@3', '/concept-elasticsearch@3'),
  realRuntime: true,
  get readinessBlockers() {
    return searchIndexRuntimeReadiness();
  },
}));

const searchScorers = searchComponents.scorers.map((scorer) => ({
  ...scorer,
  id: scorer.id.replace('/concept-scorer@3', '/concept-elasticsearch-scorer@3'),
  score: async (context: Parameters<typeof scorer.score>[0]) => {
    const component = await scorer.score(context);
    if (!component.passed || component.integrityFailure) {
      return {
        ...component,
        evidence: [
          ...component.evidence,
          'Elasticsearch runtime skipped because the component contract failed.',
        ],
      };
    }
    const runtime = scorer.scenarioIds.includes('search-indexing-full-task-1-individual')
      ? runSearchAnalyzerVersioningRuntime()
      : runSearchTenantAuthorizationRuntime();
    return {
      passed: component.passed && runtime.passed,
      quality: runtime.passed ? component.quality : Math.min(component.quality, 0.8),
      verification: runtime.passed ? component.verification : 0,
      integrityFailure: component.integrityFailure,
      evidence: [...component.evidence, runtime.evidence],
    };
  },
}));

export const INTERFACE_SEARCH_GRAPHICS_SKILL_EVAL_MATERIALIZERS = [
  ...searchMaterializers,
  ...fixtures.materializers,
];
export const INTERFACE_SEARCH_GRAPHICS_SKILL_EVAL_SCORERS = [...searchScorers, ...fixtures.scorers];
