import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { readFixtureText, readJsonArtifact, writeFixtureFile } from './skill-eval-fixture-helpers';

const EDITOR = 'visual-interface-design-full-task-cross-platform-editor';
const OPS = 'visual-interface-design-full-task-dense-operations-workspace';
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

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
  severityEncoding?: Record<string, string>;
  shadowLevels?: number;
  cardNesting?: number;
}

interface EditorVisualSystem {
  tokens?: {
    spacing?: unknown;
    radius?: unknown;
    accent?: unknown;
    brandAccent?: unknown;
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
  if (Array.isArray(value)) return expected.every((item) => value.includes(item));
  const record = asRecord(value);
  if (!record) return false;
  const names = new Set(Object.keys(record).map((key) => key.toLowerCase()));
  return expected.every((item) => names.has(item.toLowerCase()));
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
  const focusReady =
    value.focusVisible === true || /visible|ring|outline/u.test(focusText);
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
  const compactRow = rowHeight(system?.density, 'compactRow', ['compact', 'dense']);
  const comfortableRow = rowHeight(system?.density, 'comfortableRow', ['comfortable']);
  const checks: [string, boolean][] = [
    ['packet integrity', intact],
    [
      'brand tokens preserved',
      (system?.tokens?.accent === EDITOR_PACKET.brand.accent ||
        system?.tokens?.brandAccent === EDITOR_PACKET.brand.accent) &&
        editorRadiusMatches(system?.tokens?.radius, EDITOR_PACKET.brand.radius) &&
        sameNumbers(system?.tokens?.spacing, EDITOR_PACKET.brand.spacing),
    ],
    ['theme coverage', containsAllNamedValues(system?.themes, EDITOR_PACKET.constraints.themes)],
    [
      'platform adaptations',
      platformAdaptationsReady(system?.platformAdaptations, EDITOR_PACKET.constraints.platforms),
    ],
    ['full state set', containsAllNamedValues(system?.states, EDITOR_PACKET.states)],
    [
      'density defined',
      compactRow !== null && comfortableRow !== null && compactRow < comfortableRow,
    ],
    ['accessibility boundaries', editorAccessibilityReady(system?.accessibility)],
    [
      'verification matrix',
      !!verification &&
        /640/iu.test(verification) &&
        /light/iu.test(verification) &&
        /dark/iu.test(verification) &&
        /long label/iu.test(verification) &&
        /(loading|empty)/iu.test(verification) &&
        /dense/iu.test(verification),
    ],
  ];
  const passed = checks.every(([, ok]) => ok);
  return {
    passed,
    quality: checks.filter(([, ok]) => ok).length / checks.length,
    verification: passed ? 1 : 0,
    integrityFailure: !intact,
    evidence: [
      ...checks.map(([n, ok]) => `${n}: ${ok ? 'pass' : 'fail'}`),
      'Deterministic scoring covers token/state/verification integrity only; visual quality remains blind-semantic.',
    ],
  };
}

function scoreOps(root: string): SkillEvalDeterministicScore {
  const intact = fixed(root, 'evidence/operations.json', json(OPS_PACKET));
  const system = readJsonArtifact<VisualSystem>(root, 'visual-system.json');
  const verification = text(root, 'verification.md');
  const encoded = system?.severityEncoding ? Object.values(system.severityEncoding) : [];
  const colorLike = encoded.filter((v) => /#|rgb|hsl|color/i.test(v)).length;
  const checks: [string, boolean][] = [
    ['packet integrity', intact],
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
      'severity not color-only',
      system?.accessibility?.colorNotSoleSignal === true &&
        system?.accessibility?.focusVisible === true &&
        encoded.length === OPS_PACKET.constraints.severity.length &&
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
        system!.density!.compactRow! < system!.density!.comfortableRow!,
    ],
    [
      'representative verification',
      !!verification &&
        /case table/iu.test(verification) &&
        /case detail/iu.test(verification) &&
        /dense/iu.test(verification) &&
        /sparse|empty/iu.test(verification) &&
        /critical/iu.test(verification) &&
        /primary action/iu.test(verification),
    ],
  ];
  const passed = checks.every(([, ok]) => ok);
  return {
    passed,
    quality: checks.filter(([, ok]) => ok).length / checks.length,
    verification: passed ? 1 : 0,
    integrityFailure: !intact,
    evidence: [
      ...checks.map(([n, ok]) => `${n}: ${ok ? 'pass' : 'fail'}`),
      'Deterministic scoring covers design-system constraints only; aesthetic judgment remains blind-semantic.',
    ],
  };
}

export const VISUAL_DESIGN_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  {
    id: 'visual-interface-design/cross-platform-system@1',
    matches: (s) => s.id === EDITOR,
    materialize: (root) => {
      writeFixtureFile(root, 'evidence/editor.json', json(EDITOR_PACKET));
      writeFixtureFile(
        root,
        'visual-system.json',
        '{"tokens":{},"themes":[],"platformAdaptations":{},"states":[],"density":{},"accessibility":{},"hierarchy":{}}\n',
      );
      writeFixtureFile(root, 'verification.md', '# Verification matrix\n\nTODO\n');
      writeFixtureFile(
        root,
        'README.md',
        '# Cross-platform editor visual system\nCreate visual-system.json and verification.md. Preserve brand tokens, define light/dark, macOS/Windows adaptations, dense/comfortable rows, full states, long-label/text-scale/focus/color accessibility, and a matrix including minimum width. Do not redesign interaction flows.\n',
      );
    },
  },
  {
    id: 'visual-interface-design/dense-operations-system@1',
    matches: (s) => s.id === OPS,
    materialize: (root) => {
      writeFixtureFile(root, 'evidence/operations.json', json(OPS_PACKET));
      writeFixtureFile(
        root,
        'visual-system.json',
        '{"tokens":{},"themes":["light","dark"],"platformAdaptations":{},"states":[],"density":{},"accessibility":{},"hierarchy":{},"severityEncoding":{},"shadowLevels":99,"cardNesting":99}\n',
      );
      writeFixtureFile(root, 'verification.md', '# Representative-state verification\n\nTODO\n');
      writeFixtureFile(
        root,
        'README.md',
        '# Dense operations visual system\nCreate an implementation-ready token/state system for the supplied fraud-operations workspace without changing IA or interaction. Preserve identity, reduce color-only severity dependence, establish primary/secondary hierarchy, bound shadows/card nesting, and verify dense/sparse states.\n',
      );
    },
  },
];
export const VISUAL_DESIGN_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  {
    id: 'visual-interface-design/cross-platform-system-scorer@3',
    scenarioIds: [EDITOR],
    score: ({ workingDirectory }) => scoreEditor(workingDirectory),
  },
  {
    id: 'visual-interface-design/dense-operations-system-scorer@2',
    scenarioIds: [OPS],
    score: ({ workingDirectory }) => scoreOps(workingDirectory),
  },
];
