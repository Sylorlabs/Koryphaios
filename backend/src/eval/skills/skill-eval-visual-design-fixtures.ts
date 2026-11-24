import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { readFixtureText, readJsonArtifact, writeFixtureFile } from './skill-eval-fixture-helpers';
import {
  EDITOR_DIRECTION_SCENARIO,
  materializeRealDirectionFixture,
  scoreRealDirectionFixture,
} from './skill-eval-visual-direction-fixtures';

const EDITOR = 'visual-interface-design-full-task-cross-platform-editor';
const OPS = 'visual-interface-design-full-task-dense-operations-workspace';
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

// These packets contain design constraints, not the existing applications. They have no
// source revision, original screenshots, or runnable browser/native state fixtures.
// The evaluator cannot independently observe a condition or verify a candidate render.
// A candidate-authored screenshot, matrix, manifest, or executor log cannot unblock this.
const VISUAL_EVIDENCE_BLOCKERS = [
  'Requires evaluator-supplied original UI source identity and current product screenshots; the sealed packet contains synthetic requirements only.',
  'Requires independent browser/native captures tied to that source for representative platforms, themes, states, and viewing conditions.',
  'Requires an evaluator-owned rendered-condition verifier before visual claims can contribute to V5 scores.',
] as const;

const EDITOR_PACKET = {
  brand: { accent: '#5B63FF', radius: 6, typeScale: [12, 13, 15, 20], spacing: [4, 8, 12, 16, 24] },
  constraints: {
    platforms: ['macOS', 'Windows'],
    themes: ['light', 'dark'],
    minWidth: 640,
    longLabelChars: 42,
    textScale: 1.25,
    denseSurfaces: ['sidebar', 'search-results', 'diagnostics', 'canvas'],
  },
  states: ['loading', 'empty', 'normal', 'dense', 'error', 'selected', 'disabled'],
  identity: 'one product identity with platform-appropriate chrome and control affordances',
} as const;
const OPS_PACKET = {
  brand: { accent: '#1457D9', radius: 4, spacing: [4, 8, 12, 16] },
  constraints: {
    session: 'long analyst sessions',
    surfaces: ['case-table', 'case-detail', 'filters', 'timeline'],
    severity: ['critical', 'high', 'medium', 'low', 'informational'],
    maxColorCodedSeverities: 3,
    primaryActions: ['resolve-case', 'escalate'],
    states: ['loading', 'empty', 'normal', 'dense', 'error', 'selected', 'disabled'],
  },
  problems: [
    'inconsistent component tokens',
    'risk/status colors overused',
    'primary actions compete with secondary controls',
    'recent cards/shadows obscure density',
  ],
} as const;

interface VisualSystem {
  tokens?: {
    spacing?: number[];
    radius?: number;
    typeScale?: number[];
    accent?: string;
    surfaceLevels?: number;
  };
  themes?: string[];
  platformAdaptations?: Record<string, string[]>;
  states?: string[];
  density?: { compactRow?: number; comfortableRow?: number };
  accessibility?: {
    minTextScale?: number;
    longLabelStrategy?: string;
    focusVisible?: boolean;
    colorNotSoleSignal?: boolean;
  };
  hierarchy?: { primaryAction?: string; secondaryTreatment?: string };
  severityEncoding?: Record<string, unknown>;
  shadowLevels?: number;
  cardNesting?: number;
}

interface EditorVisualSystem {
  tokens?: {
    spacing?: unknown;
    radius?: unknown;
    accent?: unknown;
    brandAccent?: unknown;
    typeScale?: unknown;
    typography?: unknown;
  };
  themes?: unknown;
  platformAdaptations?: Record<string, unknown>;
  states?: unknown;
  density?: Record<string, unknown>;
  accessibility?: Record<string, unknown>;
}

function text(root: string, path: string): string | null {
  try {
    const s = lstatSync(join(root, path));
    if (!s.isFile() || s.isSymbolicLink()) return null;
    return readFixtureText(root, path);
  } catch {
    return null;
  }
}
function fixed(root: string, path: string, expected: string) {
  return text(root, path) === expected;
}
const sameNumbers = (a: unknown, b: readonly number[]) =>
  Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);
const containsAllStrings = (value: unknown, expected: readonly string[]) =>
  Array.isArray(value) && expected.every((v) => value.includes(v));

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function containsAllNamedValues(value: unknown, expected: readonly string[]): boolean {
  if (Array.isArray(value)) {
    return expected.every((item) =>
      value.some((entry) => {
        if (typeof entry === 'string') return entry.toLowerCase() === item.toLowerCase();
        const record = asRecord(entry);
        if (!record) return false;
        const id = record.id ?? record.name;
        return (
          typeof id === 'string' &&
          id.toLowerCase() === item.toLowerCase() &&
          Object.entries(record).some(
            ([key, detail]) => !['id', 'name'].includes(key) && hasStructuredContent(detail),
          )
        );
      }),
    );
  }
  const record = asRecord(value);
  if (!record) return false;
  return expected.every((item) => {
    const entry = Object.entries(record).find(([key]) => key.toLowerCase() === item.toLowerCase());
    return Boolean(entry && hasStructuredContent(entry[1]));
  });
}

function hasStructuredContent(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(hasStructuredContent);
  const record = asRecord(value);
  return Boolean(record && Object.values(record).some(hasStructuredContent));
}

function platformAdaptationsReady(
  value: Record<string, unknown> | undefined,
  platforms: readonly string[],
): boolean {
  if (!value) return false;
  return platforms.every((platform) => {
    const match = Object.entries(value).find(
      ([key]) => key.toLowerCase() === platform.toLowerCase(),
    );
    return Boolean(match && hasStructuredContent(match[1]));
  });
}

function editorRadiusMatches(value: unknown, expected: number): boolean {
  if (value === expected) return true;
  const record = asRecord(value);
  return Boolean(
    record &&
    [record.control, record.base, record.default].some(
      (candidate) => typeof candidate === 'number' && candidate === expected,
    ),
  );
}

function editorTypeScaleMatches(
  tokens: EditorVisualSystem['tokens'],
  expected: readonly number[],
): boolean {
  const typography = asRecord(tokens?.typography);
  return (
    sameNumbers(tokens?.typeScale, expected) ||
    sameNumbers(typography?.typeScale, expected) ||
    sameNumbers(typography?.scale, expected)
  );
}

function normalizeCondition(value: string): string {
  return value
    .toLowerCase()
    .replace(/[-_/]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

// Only the evaluator can supply these records, after observing the original source
// and checking each rendered condition. The candidate's workspace, its screenshots,
// and the executor's own observations are never a source of this evidence.
export interface IndependentVisualCapture {
  readonly sourceIdentity: string;
  readonly condition: string;
  readonly verifiedRequirements: readonly string[];
  readonly passed: boolean;
}

export interface IndependentVisualEvidence {
  readonly sourceIdentity: string | null;
  readonly captures: ReadonlyMap<string, IndependentVisualCapture>;
}

// Matching a capture ID is insufficient: its independent condition, source, result,
// and verified requirements must all agree. Coverage is drawn from verifier records,
// never from prose or "observed: pass" assertions in the candidate's table.
export function verificationMatrixCovers(
  markdown: string | null,
  conditions: readonly string[],
  independent: IndependentVisualEvidence,
): boolean {
  if (!markdown || !independent.sourceIdentity?.trim()) return false;
  const tables: string[][][] = [];
  let current: string[][] = [];
  for (const line of markdown.split(/\r?\n/u)) {
    if (/^\s*\|.*\|\s*$/u.test(line)) {
      current.push(
        line
          .trim()
          .slice(1, -1)
          .split('|')
          .map((cell) => cell.trim()),
      );
    } else if (current.length > 0) {
      tables.push(current);
      current = [];
    }
  }
  if (current.length > 0) tables.push(current);

  const checkableConditions: string[] = [];
  const capturedIds = new Set<string>();
  for (const lines of tables) {
    if (lines.length < 3) continue;
    const headers = lines[0]!.map(normalizeCondition);
    const index = (names: readonly string[]) =>
      headers.findIndex((header) => names.some((name) => header.includes(name)));
    const conditionIndex = index(['condition', 'scenario', 'state']);
    const expectedIndex = index(['expected']);
    const methodIndex = index(['method', 'check']);
    const statusIndex = index(['status', 'result']);
    const evidenceIndex = index(['evidence', 'capture']);
    if ([conditionIndex, expectedIndex, methodIndex, statusIndex, evidenceIndex].some((i) => i < 0))
      continue;
    if (
      lines[1]!.length !== headers.length ||
      !lines[1]!.every((cell) => /^:?-{3,}:?$/u.test(cell))
    )
      continue;
    for (const row of lines.slice(2)) {
      if (
        row.length !== headers.length ||
        !row[conditionIndex] ||
        !row[expectedIndex] ||
        !row[methodIndex] ||
        row.some((cell) => /\bTODO\b/iu.test(cell)) ||
        !/^observed\s*:\s*pass$/iu.test(row[statusIndex] ?? '')
      )
        continue;
      const captureId = row[evidenceIndex]!;
      const capture = independent.captures.get(captureId);
      if (
        !capture ||
        capturedIds.has(captureId) ||
        !capture.passed ||
        capture.sourceIdentity !== independent.sourceIdentity ||
        normalizeCondition(capture.condition) !== normalizeCondition(row[conditionIndex]!) ||
        !capture.verifiedRequirements.length ||
        !normalizeCondition(capture.verifiedRequirements.join(' ')).includes(
          normalizeCondition(capture.condition),
        )
      )
        continue;
      capturedIds.add(captureId);
      checkableConditions.push(...capture.verifiedRequirements);
    }
  }
  if (capturedIds.size < 7) return false;
  const actualConditions = normalizeCondition(checkableConditions.join(' '));
  return conditions.every((condition) => actualConditions.includes(normalizeCondition(condition)));
}

// Neither scenario has an authentic source or evaluator-run capture verifier.
// This is intentionally empty: never synthesize trusted evidence from candidate
// files or executor reports. Future real evidence requires an evaluator-owned
// renderer and immutable source identity, plus removal of readiness blockers.
function independentVisualEvidence(): IndependentVisualEvidence {
  return { sourceIdentity: null, captures: new Map() };
}

function severityEntriesReady(value: unknown, expected: readonly string[]) {
  const map = asRecord(value);
  if (!map || Object.keys(map).length !== expected.length) return false;
  return expected.every((name) => {
    const entry = map[name];
    return (
      typeof entry === 'string' &&
      entry.trim().length > 4 &&
      /\b(?:label|icon|shape|pattern|border|badge|text|symbol|glyph|name|word)\b/iu.test(entry)
    );
  });
}

function usesSeverityColor(description: string): boolean {
  const withoutNegation = description.replace(
    /\b(?:no|without|avoid|never|non[- ]|instead of)\s+(?:any\s+)?color(?:[- ]coded|[- ]only)?\b/giu,
    '',
  );
  return (
    /#[a-f0-9]{3,8}\b|(?:rgb|hsl)a?\s*\(|var\s*\(\s*--(?:color|severity|status)-/iu.test(
      withoutNegation,
    ) ||
    /\b(?:red|orange|yellow|green|blue|purple|violet|pink|brown|gray|grey|amber|cyan|indigo|lime|teal|magenta|crimson|gold)\b/iu.test(
      withoutNegation,
    ) ||
    /\b(?:colored|coloured|color[- ]coded|color\s*:|color\s+emphasis|using color)\b/iu.test(
      withoutNegation,
    )
  );
}

function rowHeight(
  density: Record<string, unknown> | undefined,
  directKey: string,
  nestedKeys: readonly string[],
): number | null {
  if (!density) return null;
  const direct = density[directKey];
  if (typeof direct === 'number') return direct;
  for (const key of nestedKeys) {
    const nested = asRecord(density[key]);
    if (typeof nested?.rowHeight === 'number') return nested.rowHeight;
  }
  return null;
}

function editorAccessibilityReady(value: Record<string, unknown> | undefined): boolean {
  if (!value) return false;
  const focusText = String(value.focus ?? '').toLowerCase();
  const colorText = String(value.colorIndependence ?? value.colorSemantics ?? '').toLowerCase();
  const scale = value.minTextScale ?? value.textScale;
  const scaleNumber =
    typeof scale === 'number'
      ? scale
      : typeof scale === 'string'
        ? Number(scale.match(/\d+(?:\.\d+)?/u)?.[0] ?? Number.NaN)
        : Number.NaN;
  const localization = String(value.longLabelStrategy ?? value.localization ?? '').toLowerCase();
  const focusReady = value.focusVisible === true || /visible|ring|outline/u.test(focusText);
  const colorReady =
    value.colorNotSoleSignal === true ||
    /icon|text|label|border|pattern|addition to color|more than color/u.test(colorText);
  const labelsReady =
    typeof value.longLabelStrategy === 'string' ||
    (/label/u.test(localization) && /wrap|expand|clip|truncat/u.test(localization));
  return focusReady && colorReady && scaleNumber >= 1.25 && labelsReady;
}

function scoreEditor(root: string): SkillEvalDeterministicScore {
  const intact = fixed(root, 'evidence/editor.json', json(EDITOR_PACKET));
  const system = readJsonArtifact<EditorVisualSystem>(root, 'visual-system.json');
  const verification = text(root, 'verification.md');
  const independent = independentVisualEvidence();
  const sourceReady = !!independent.sourceIdentity;
  const capturesReady =
    sourceReady &&
    [...independent.captures.values()].filter(
      (capture) => capture.passed && capture.sourceIdentity === independent.sourceIdentity,
    ).length >= 7;
  const verificationReady = verificationMatrixCovers(
    verification,
    [
      '640',
      '1.25',
      '42',
      'macOS',
      'Windows',
      'light',
      'dark',
      'long label',
      ...EDITOR_PACKET.constraints.denseSurfaces,
      ...EDITOR_PACKET.states,
    ],
    independent,
  );
  const compactRow = rowHeight(system?.density, 'compactRow', ['compact', 'dense']);
  const comfortableRow = rowHeight(system?.density, 'comfortableRow', ['comfortable']);
  const checks: [string, boolean][] = [
    ['packet integrity', intact],
    ['authentic product source identity', sourceReady],
    ['independent rendered captures', capturesReady],
    [
      'brand tokens preserved',
      (system?.tokens?.accent === EDITOR_PACKET.brand.accent ||
        system?.tokens?.brandAccent === EDITOR_PACKET.brand.accent) &&
        editorRadiusMatches(system?.tokens?.radius, EDITOR_PACKET.brand.radius) &&
        sameNumbers(system?.tokens?.spacing, EDITOR_PACKET.brand.spacing) &&
        editorTypeScaleMatches(system?.tokens, EDITOR_PACKET.brand.typeScale),
    ],
    ['theme coverage', containsAllNamedValues(system?.themes, EDITOR_PACKET.constraints.themes)],
    [
      'platform adaptations',
      platformAdaptationsReady(system?.platformAdaptations, EDITOR_PACKET.constraints.platforms),
    ],
    ['full state set', containsAllNamedValues(system?.states, EDITOR_PACKET.states)],
    [
      'density defined',
      compactRow !== null &&
        comfortableRow !== null &&
        Number.isFinite(compactRow) &&
        Number.isFinite(comfortableRow) &&
        compactRow > 0 &&
        compactRow < comfortableRow,
    ],
    ['accessibility boundaries', editorAccessibilityReady(system?.accessibility)],
    ['verification matrix', verificationReady],
  ];
  const passed = checks.every(([, ok]) => ok);
  return {
    passed,
    // Without source and independent observations, constraint matches are only
    // diagnostic. They must not yield quality credit toward promotion.
    quality:
      sourceReady && capturesReady && verificationReady
        ? checks.filter(([, ok]) => ok).length / checks.length
        : 0,
    verification: passed ? 1 : 0,
    integrityFailure: !intact,
    evidence: [
      ...checks.map(([n, ok]) => `${n}: ${ok ? 'pass' : 'fail'}`),
      ...VISUAL_EVIDENCE_BLOCKERS,
      'Design-token checks are diagnostic only until independent rendered-condition evidence exists; blind review remains required.',
    ],
  };
}

function scoreOps(root: string): SkillEvalDeterministicScore {
  const intact = fixed(root, 'evidence/operations.json', json(OPS_PACKET));
  const system = readJsonArtifact<VisualSystem>(root, 'visual-system.json');
  const verification = text(root, 'verification.md');
  const independent = independentVisualEvidence();
  const sourceReady = !!independent.sourceIdentity;
  const capturesReady =
    sourceReady &&
    [...independent.captures.values()].filter(
      (capture) => capture.passed && capture.sourceIdentity === independent.sourceIdentity,
    ).length >= 7;
  const verificationReady = verificationMatrixCovers(
    verification,
    [
      ...OPS_PACKET.constraints.surfaces,
      ...OPS_PACKET.constraints.states,
      'sparse',
      'focus',
      'long label',
      'critical',
      'primary action',
    ],
    independent,
  );
  const encoded = asRecord(system?.severityEncoding);
  const colorLike = Object.values(encoded ?? {}).filter(
    (value) => typeof value === 'string' && usesSeverityColor(value),
  ).length;
  const checks: [string, boolean][] = [
    ['packet integrity', intact],
    ['authentic product source identity', sourceReady],
    ['independent rendered captures', capturesReady],
    [
      'brand tokens preserved',
      system?.tokens?.accent === OPS_PACKET.brand.accent &&
        system?.tokens?.radius === OPS_PACKET.brand.radius &&
        sameNumbers(system?.tokens?.spacing, OPS_PACKET.brand.spacing),
    ],
    ['all states represented', containsAllStrings(system?.states, OPS_PACKET.constraints.states)],
    [
      'dense hierarchy explicit',
      system?.hierarchy?.primaryAction === 'resolve-case' &&
        typeof system?.hierarchy?.secondaryTreatment === 'string' &&
        system!.hierarchy!.secondaryTreatment!.length > 4,
    ],
    [
      'severity names and non-color signals',
      severityEntriesReady(system?.severityEncoding, OPS_PACKET.constraints.severity),
    ],
    [
      'severity accessibility and color budget',
      system?.accessibility?.colorNotSoleSignal === true &&
        system?.accessibility?.focusVisible === true &&
        colorLike <= OPS_PACKET.constraints.maxColorCodedSeverities,
    ],
    [
      'generated-card excess bounded',
      (system?.shadowLevels ?? 99) <= 2 && (system?.cardNesting ?? 99) <= 1,
    ],
    [
      'density defined',
      typeof system?.density?.compactRow === 'number' &&
        typeof system?.density?.comfortableRow === 'number' &&
        Number.isFinite(system.density.compactRow) &&
        Number.isFinite(system.density.comfortableRow) &&
        system.density.compactRow > 0 &&
        system!.density!.compactRow! < system!.density!.comfortableRow!,
    ],
    ['representative verification', verificationReady],
  ];
  const passed = checks.every(([, ok]) => ok);
  return {
    passed,
    quality:
      sourceReady && capturesReady && verificationReady
        ? checks.filter(([, ok]) => ok).length / checks.length
        : 0,
    verification: passed ? 1 : 0,
    integrityFailure: !intact,
    evidence: [
      ...checks.map(([n, ok]) => `${n}: ${ok ? 'pass' : 'fail'}`),
      ...VISUAL_EVIDENCE_BLOCKERS,
      'Design-token checks are diagnostic only until independent rendered-condition evidence exists; blind review remains required.',
    ],
  };
}

export const VISUAL_DESIGN_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  // Both scenarios now supply evaluator-owned product source, measured tokens and real
  // rendered captures, so the previous "synthetic requirements only" block is resolved.
  // The ids are deliberately unchanged: regression closure binds a passing rerun to the
  // original materializer and scorer identities, and a new id would strand old evidence.
  {
    id: 'visual-interface-design/cross-platform-system@2',
    matches: (s) => s.id === EDITOR,
    materialize: (root) => materializeRealDirectionFixture(root, EDITOR_DIRECTION_SCENARIO),
  },
  {
    id: 'visual-interface-design/dense-operations-system@2',
    matches: (s) => s.id === OPS,
    materialize: (root) => materializeRealDirectionFixture(root, OPS),
  },
];

export const VISUAL_DESIGN_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  {
    id: 'visual-interface-design/cross-platform-system-scorer@6',
    scenarioIds: [EDITOR],
    score: ({ workingDirectory }) =>
      scoreRealDirectionFixture(workingDirectory, EDITOR_DIRECTION_SCENARIO),
  },
  {
    id: 'visual-interface-design/dense-operations-system-scorer@5',
    scenarioIds: [OPS],
    score: ({ workingDirectory }) => scoreRealDirectionFixture(workingDirectory, OPS),
  },
];
