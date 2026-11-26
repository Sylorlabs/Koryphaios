import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { readJsonArtifact, writeFixtureFile } from './skill-eval-fixture-helpers';
import { finishChecks, runBounded } from './skill-eval-real-web-runtime';
import { INSPECTOR_SWIFT } from './skill-eval-visual-native-fixtures';
import { swiftRuntimeReadiness } from './skill-eval-swift-runtime';

/**
 * visual-interface-design is blocked without evaluator supplied product identity
 * and current screenshots, because a visual direction cannot be reviewed against
 * synthetic requirements. This fixture supplies the real thing: an AppKit surface
 * that renders in the platform layout engine, its own measured token inventory, and
 * screenshots the evaluator produces before the candidate starts. The deliverable is
 * a direction spec whose claims are then checked against a fresh render.
 */

export const EDITOR_DIRECTION_SCENARIO = 'visual-interface-design-full-task-cross-platform-editor';
export const OPS_DIRECTION_SCENARIO =
  'visual-interface-design-full-task-dense-operations-workspace';

interface DirectionContext {
  id: string;
  width: number;
  height: number;
  appearance: 'light' | 'dark';
  locale: 'en' | 'de';
  textScale: number;
  empty: boolean;
  dense: boolean;
}

export const DIRECTION_CONTEXTS: readonly DirectionContext[] = [
  {
    id: 'min-light-en',
    width: 620,
    height: 520,
    appearance: 'light',
    locale: 'en',
    textScale: 1,
    empty: false,
    dense: false,
  },
  {
    id: 'default-light-en',
    width: 900,
    height: 700,
    appearance: 'light',
    locale: 'en',
    textScale: 1,
    empty: false,
    dense: false,
  },
  {
    id: 'wide-light-en',
    width: 1400,
    height: 900,
    appearance: 'light',
    locale: 'en',
    textScale: 1,
    empty: false,
    dense: true,
  },
  {
    id: 'default-dark-en',
    width: 900,
    height: 700,
    appearance: 'dark',
    locale: 'en',
    textScale: 1,
    empty: false,
    dense: false,
  },
  {
    id: 'min-dark-de-large',
    width: 620,
    height: 520,
    appearance: 'dark',
    locale: 'de',
    textScale: 1.35,
    empty: false,
    dense: true,
  },
  {
    id: 'empty-selection',
    width: 900,
    height: 700,
    appearance: 'light',
    locale: 'en',
    textScale: 1,
    empty: true,
    dense: false,
  },
  {
    id: 'dense-metadata',
    width: 900,
    height: 700,
    appearance: 'light',
    locale: 'en',
    textScale: 1,
    empty: false,
    dense: true,
  },
];

const TOKENS = {
  source: 'measured from the supplied surface source, not invented',
  type: {
    title: { size: 15, weight: 'semibold' },
    'sidebar-heading': { size: 12, weight: 'medium' },
    row: { size: 12, weight: 'regular' },
    'field-label': { size: 11, weight: 'regular' },
    'field-value': { size: 12, weight: 'regular' },
    'empty-state': { size: 13, weight: 'regular' },
  },
  metrics: {
    titleBarHeight: 44,
    sidebarMin: 180,
    sidebarMax: 240,
    sidebarFraction: 0.26,
    sidebarInset: 14,
    contentInset: 20,
    rowHeight: 22,
    labelColumn: 130,
    valueOffset: 140,
    controlWidth: 88,
    controlHeight: 30,
  },
  semanticColorRoles: [
    'windowBackground',
    'underPageBackground',
    'label',
    'secondaryLabel',
    'separator',
    'controlAccent',
  ],
  controls: { bezel: 'rounded', order: ['secondary:Cancel', 'primary:Apply'] },
} as const;

const IDENTITY = `# Product identity

Supplied by the evaluator. This surface is the product under review; it is not a mock and it is not
to be replaced. Its identity carriers are the window title treatment, the fixed sidebar geometry, the
two column label and value rhythm, the rounded bezel control pair, and the semantic color roles the
platform supplies rather than literal colors.
`;

const STATE_INVENTORY = {
  states: ['loading', 'empty', 'normal', 'dense', 'error', 'cancelled', 'disabled'],
  supplied: [
    'a selection with four metadata fields',
    'a dense selection with twelve metadata fields',
    'an empty selection',
    'a German localization at large text',
    'a dark appearance',
    'the minimum supported window',
    'a wide window with the dense selection',
  ],
  note: 'This inventory is evaluator supplied. Anything you add must be declared as proposed, not observed.',
};

const REQUIRED_TOKENS = {
  type: ['title', 'sidebar-heading', 'row', 'field-label', 'field-value', 'empty-state'],
  spacing: ['titleBarHeight', 'sidebarInset', 'contentInset', 'rowHeight', 'labelColumn'],
  color: TOKENS.semanticColorRoles as readonly string[],
};

const REQUIRED_TOKENS_PLACEHOLDER = REQUIRED_TOKENS;

const DIRECTION_README = (scenario: string) => `# Visual direction review: ${scenario}

The evaluator supplies a real rendered surface, its source, a measured token inventory, a state
inventory, and seven screenshots. Nothing in \`Surface.swift\`, \`captures/\`, \`geometry/\`,
\`tokens.json\`, \`identity.md\` or \`state-inventory.json\` may be modified: they are the evidence you are
reviewing.

Build and capture a context yourself if you need a fresh look:

    sh build.sh
    ./surface --width=900 --height=700 --appearance=light --locale=en --out=probe.png

The tool writes \`probe.png.json\` with the measured frame of every element, its \`requiredWidth\`, and
whether its text is \`truncated\`.

## Deliverable: \`direction.json\`

\`\`\`json
{
  "status": "TODO",
  "surface": "macos-appkit-record-inspector",
  "identity": {
    "shared": ["<identity carrier that must not change>"],
    "adapted": [
      { "platform": "macos", "decision": "<at least 40 characters>", "rationale": "<at least 40 characters>" },
      { "platform": "windows", "decision": "<at least 40 characters>", "rationale": "<at least 40 characters>" }
    ]
  },
  "system": {
    "typeSteps": [{ "token": "title", "role": "<at least 20 characters>" }],
    "spacingSteps": [{ "token": "contentInset", "role": "<at least 20 characters>" }],
    "colorRoles": [{ "token": "windowBackground", "role": "<at least 20 characters>" }],
    "iconography": "<at least 40 characters>",
    "density": "<at least 40 characters>"
  },
  "hierarchy": {
    "primaryAction": "<at least 20 characters>",
    "secondaryControls": "<at least 20 characters>",
    "contentHierarchy": "<at least 20 characters>",
    "statusSignals": "<at least 20 characters>"
  },
  "stateReviews": [
    { "context": "min-light-en", "verdict": "<at least 20 characters>", "truncated": [] }
  ],
  "motion": {
    "introduced": false,
    "rationale": "<at least 40 characters>",
    "reducedMotion": "<at least 40 characters>"
  },
  "boundary": {
    "visualOnly": true,
    "preserved": ["<approved interaction or content contract that must not change>"],
    "tradeoffs": ["<unresolved accessibility or visual tradeoff>"]
  }
}
\`\`\`

\`stateReviews\` must contain exactly one entry per supplied capture id: ${DIRECTION_CONTEXTS.map(
  (context) => context.id,
).join(
  ', ',
)}. In \`truncated\`, list the element ids that actually clip in that context, in ascending
order, taken from the geometry file for that context. Do not list an element that fits, and do not
omit one that clips.

Required completeness, exactly as the independent scorer counts it:

- \`identity.shared\`: at least 3 entries.
- \`identity.adapted\`: one \`macos\` entry and one \`windows\` entry.
- \`system.typeSteps\`: all of ${REQUIRED_TOKENS_PLACEHOLDER.type}.
- \`system.spacingSteps\`: all of ${REQUIRED_TOKENS_PLACEHOLDER.spacing}.
- \`system.colorRoles\`: all of ${REQUIRED_TOKENS_PLACEHOLDER.color}.
- \`boundary.preserved\`: at least 3 entries. \`boundary.tradeoffs\`: at least 1 entry.
- \`stateReviews\`: one entry per context id.

Every token name must come from \`tokens.json\`; a role text shorter than 20 characters does not count.
\`status\` stays \`TODO\` until the file is complete, then becomes \`proposed\` or \`verified\`.
`;

function buildSurface(root: string): string | undefined {
  writeFixtureFile(root, 'Surface.swift', INSPECTOR_SWIFT);
  writeFixtureFile(
    root,
    'build.sh',
    '#!/bin/sh\nset -eu\n: "${DEVELOPER_DIR:=$(xcode-select -p 2>/dev/null || echo /Applications/Xcode.app/Contents/Developer)}"\nexport DEVELOPER_DIR\nxcrun swiftc -O Surface.swift -o surface\n',
  );
  const result = spawnSync('sh', ['build.sh'], {
    cwd: root,
    env: {
      ...process.env,
    },
    timeout: 180_000,
    encoding: 'utf8',
  });
  if (result.status !== 0) return (result.stderr || result.stdout || 'swiftc failed').slice(0, 400);
  return undefined;
}

function capture(root: string, context: DirectionContext): string | undefined {
  const output = join(root, 'captures', `${context.id}.png`);
  mkdirSync(join(root, 'captures'), { recursive: true });
  mkdirSync(join(root, 'geometry'), { recursive: true });
  const run = spawnSync(
    join(root, 'surface'),
    [
      `--width=${context.width}`,
      `--height=${context.height}`,
      `--appearance=${context.appearance}`,
      `--locale=${context.locale}`,
      `--text-scale=${context.textScale}`,
      `--empty=${context.empty ? '1' : '0'}`,
      `--dense=${context.dense ? '1' : '0'}`,
      `--out=${output}`,
    ],
    { cwd: root, timeout: 60_000, encoding: 'utf8' },
  );
  if (run.status !== 0) return (run.stderr || 'render failed').slice(0, 300);
  const geometry = `${output}.json`;
  if (!existsSync(geometry) || !existsSync(output)) return 'render produced no capture';
  return undefined;
}

export function materializeRealDirectionFixture(root: string, scenario?: string): void {
  const scenarioLabel = scenario ?? EDITOR_DIRECTION_SCENARIO;
  writeFixtureFile(root, 'README.md', DIRECTION_README(scenarioLabel));
  writeFixtureFile(root, 'tokens.json', JSON.stringify(TOKENS, null, 2) ?? '{}');
  writeFixtureFile(root, 'identity.md', IDENTITY);
  writeFixtureFile(root, 'state-inventory.json', JSON.stringify(STATE_INVENTORY, null, 2) ?? '{}');
  writeFixtureFile(root, 'direction.json', '{\n  "status": "TODO"\n}\n');
  const buildError = buildSurface(root);
  if (buildError)
    throw new Error(`visual direction fixture could not build its surface: ${buildError}`);
  for (const context of DIRECTION_CONTEXTS) {
    const error = capture(root, context);
    if (error)
      throw new Error(`visual direction fixture could not capture ${context.id}: ${error}`);
    const geometry = readJsonArtifact<{ elements?: Array<{ id?: string; truncated?: boolean }> }>(
      root,
      `captures/${context.id}.png.json`,
    );
    writeFixtureFile(
      root,
      `geometry/${context.id}.json`,
      JSON.stringify({ context: context.id, elements: geometry?.elements ?? [] }, null, 2),
    );
  }
  // The capture sidecar is also the geometry file the candidate reads, so keep one copy.
  for (const context of DIRECTION_CONTEXTS) {
    writeFixtureFile(
      root,
      `captures/${context.id}.png.json`,
      JSON.stringify(readJsonArtifact(root, `geometry/${context.id}.json`) ?? {}, null, 2),
    );
  }
}

export const VISUAL_DIRECTION_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  {
    id: 'visual-interface-design/native-direction-editor@1',
    realRuntime: true,
    get readinessBlockers() {
      return swiftRuntimeReadiness().reasons;
    },
    matches: (scenario) => scenario.id === EDITOR_DIRECTION_SCENARIO,
    materialize: (root) => materializeRealDirectionFixture(root, EDITOR_DIRECTION_SCENARIO),
  },
  {
    id: 'visual-interface-design/native-direction-ops@1',
    realRuntime: true,
    get readinessBlockers() {
      return swiftRuntimeReadiness().reasons;
    },
    matches: (scenario) => scenario.id === OPS_DIRECTION_SCENARIO,
    materialize: (root) => materializeRealDirectionFixture(root, OPS_DIRECTION_SCENARIO),
  },
];

function scenario_label(scenario: string): string {
  return scenario === EDITOR_DIRECTION_SCENARIO
    ? 'cross-platform record editor'
    : 'dense fraud operations workspace';
}

interface DirectionArtifact {
  status?: string;
  surface?: string;
  identity?: {
    shared?: string[];
    adapted?: Array<{ platform?: string; decision?: string; rationale?: string }>;
  };
  system?: {
    typeSteps?: Array<{ token?: string; role?: string }>;
    spacingSteps?: Array<{ token?: string; role?: string }>;
    colorRoles?: Array<{ token?: string; role?: string }>;
    iconography?: string;
    density?: string;
  };
  hierarchy?: {
    primaryAction?: string;
    secondaryControls?: string;
    contentHierarchy?: string;
    statusSignals?: string;
  };
  stateReviews?: Array<{ context?: string; verdict?: string; truncated?: string[] }>;
  motion?: { introduced?: boolean; rationale?: string; reducedMotion?: string };
  boundary?: { visualOnly?: boolean; preserved?: string[]; tradeoffs?: string[] };
}

function measuredTruncation(
  root: string,
  context: DirectionContext,
): { ids: string[]; error?: string } {
  const output = join(root, `.evaluator-${context.id}.png`);
  const run = spawnSync(
    join(root, 'surface'),
    [
      `--width=${context.width}`,
      `--height=${context.height}`,
      `--appearance=${context.appearance}`,
      `--locale=${context.locale}`,
      `--text-scale=${context.textScale}`,
      `--empty=${context.empty ? '1' : '0'}`,
      `--dense=${context.dense ? '1' : '0'}`,
      `--out=${output}`,
    ],
    { cwd: root, timeout: 60_000, encoding: 'utf8' },
  );
  if (run.status !== 0) return { ids: [], error: (run.stderr || 'render failed').slice(0, 300) };
  const geometry = readJsonArtifact<{ elements?: Array<{ id?: string; truncated?: boolean }> }>(
    root,
    `.evaluator-${context.id}.png.json`,
  );
  const ids = (geometry?.elements ?? [])
    .filter((element) => element.truncated === true && typeof element.id === 'string')
    .map((element) => element.id as string)
    .sort();
  return { ids };
}

export function scoreRealDirectionFixture(
  root: string,
  scenario: string,
): Promise<SkillEvalDeterministicScore> {
  return (async () => {
    const checks: Array<{ name: string; passed: boolean; detail: string }> = [];
    const add = (name: string, passed: boolean, detail: string) =>
      checks.push({ name, passed, detail });

    const suppliedIntact =
      existsSync(join(root, 'Surface.swift')) &&
      existsSync(join(root, 'tokens.json')) &&
      existsSync(join(root, 'identity.md')) &&
      DIRECTION_CONTEXTS.every(
        (context) =>
          existsSync(join(root, 'captures', `${context.id}.png`)) &&
          existsSync(join(root, 'geometry', `${context.id}.json`)),
      );
    add(
      'evaluator supplied source, tokens and captures',
      suppliedIntact,
      suppliedIntact
        ? 'all seven captures and the source are present'
        : 'a supplied input is missing',
    );

    const direction = readJsonArtifact<DirectionArtifact>(root, 'direction.json');
    add(
      'surface identity recorded honestly',
      direction?.surface === 'macos-appkit-record-inspector',
      `surface=${direction?.surface ?? 'missing'}`,
    );

    const token = (
      list: Array<{ token?: string; role?: string }> | undefined,
      names: readonly string[],
    ): boolean =>
      list !== undefined &&
      names.every((name) =>
        list.some((entry) => entry.token === name && (entry.role ?? '').trim().length >= 20),
      );
    const system = direction?.system;
    add(
      'type, spacing and color steps come from the supplied tokens',
      token(system?.typeSteps, REQUIRED_TOKENS.type) &&
        token(system?.spacingSteps, REQUIRED_TOKENS.spacing) &&
        token(system?.colorRoles, REQUIRED_TOKENS.color),
      `type=${system?.typeSteps?.length ?? 0} spacing=${system?.spacingSteps?.length ?? 0} color=${system?.colorRoles?.length ?? 0}`,
    );

    const hierarchy = direction?.hierarchy ?? {};
    const hierarchyComplete = (
      ['primaryAction', 'secondaryControls', 'contentHierarchy', 'statusSignals'] as const
    ).every((key) => (hierarchy[key] ?? '').trim().length >= 20);
    add(
      'hierarchy separates primary action, controls, content and status',
      hierarchyComplete,
      hierarchyComplete ? 'all four levels stated' : 'a hierarchy level is missing',
    );

    const motion = direction?.motion;
    const motionComplete =
      motion?.introduced === false
        ? (motion.rationale ?? '').trim().length >= 40 &&
          (motion.reducedMotion ?? '').trim().length >= 40
        : motion?.introduced === true &&
          (motion.rationale ?? '').trim().length >= 40 &&
          (motion.reducedMotion ?? '').trim().length >= 40;
    add(
      'motion purpose and reduced motion behavior are explicit',
      motionComplete,
      `introduced=${String(motion?.introduced)}`,
    );

    const boundary = direction?.boundary;
    add(
      'visual only boundary with preserved contracts and tradeoffs',
      boundary?.visualOnly === true &&
        (boundary.preserved?.length ?? 0) >= 3 &&
        (boundary.tradeoffs?.length ?? 0) >= 1,
      `preserved=${boundary?.preserved?.length ?? 0} tradeoffs=${boundary?.tradeoffs?.length ?? 0}`,
    );

    if (scenario === EDITOR_DIRECTION_SCENARIO) {
      const identity = direction?.identity;
      const adapted = identity?.adapted ?? [];
      const editorIdentity =
        (identity?.shared?.length ?? 0) >= 3 &&
        ['macos', 'windows'].every((platform) =>
          adapted.some(
            (entry) =>
              entry.platform === platform &&
              (entry.decision ?? '').trim().length >= 40 &&
              (entry.rationale ?? '').trim().length >= 40,
          ),
        );
      add(
        'shared identity and per platform adaptation are separated',
        editorIdentity,
        `shared=${identity?.shared?.length ?? 0} adapted=${adapted.map((entry) => entry.platform).join(',') || 'none'}`,
      );
    }

    // The strongest check: does each per context claim match a fresh render?
    const reviews = direction?.stateReviews ?? [];
    const mismatches: string[] = [];
    for (const context of DIRECTION_CONTEXTS) {
      const review = reviews.find((entry) => entry.context === context.id);
      if (!review || (review.verdict ?? '').trim().length < 20) {
        mismatches.push(`${context.id}:missing`);
        continue;
      }
      const measured = measuredTruncation(root, context);
      if (measured.error) {
        mismatches.push(`${context.id}:render:${measured.error}`);
        continue;
      }
      const claimed = [...(review.truncated ?? [])].sort();
      if (JSON.stringify(claimed) !== JSON.stringify(measured.ids)) {
        mismatches.push(
          `${context.id}:claimed=${claimed.join('|') || 'none'}/measured=${measured.ids.join('|') || 'none'}`,
        );
      }
    }
    add(
      'per context truncation claims match a fresh render',
      mismatches.length === 0,
      mismatches.slice(0, 4).join(' ; ') || `${DIRECTION_CONTEXTS.length} contexts agree`,
    );

    const status = (direction?.status ?? '').trim();
    add(
      'declared direction status',
      ['proposed', 'verified'].includes(status),
      `status=${status || 'missing'}`,
    );

    // Keep the unused import honest: runBounded proves the toolchain reproduces a render.
    let rebuilt = true;
    try {
      await runBounded('sh', ['build.sh'], root, 120_000, {
        ...process.env,
        DEVELOPER_DIR:
          process.env.DEVELOPER_DIR?.trim() || '/Applications/Xcode-beta.app/Contents/Developer',
      });
    } catch {
      rebuilt = false;
    }
    add(
      'supplied surface still builds with the platform toolchain',
      rebuilt,
      rebuilt ? 'built' : 'build failed',
    );

    return finishChecks(checks.map((check) => ({ ...check, browser: true })));
  })();
}

export const VISUAL_DIRECTION_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  {
    id: 'visual-interface-design/native-direction-editor@1',
    scenarioIds: [EDITOR_DIRECTION_SCENARIO],
    score: ({ workingDirectory }) =>
      scoreRealDirectionFixture(workingDirectory, EDITOR_DIRECTION_SCENARIO),
  },
  {
    id: 'visual-interface-design/native-direction-ops@1',
    scenarioIds: [OPS_DIRECTION_SCENARIO],
    score: ({ workingDirectory }) =>
      scoreRealDirectionFixture(workingDirectory, OPS_DIRECTION_SCENARIO),
  },
];
