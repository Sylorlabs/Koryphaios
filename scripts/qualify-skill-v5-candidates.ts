import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LEGACY_BUNDLED_SKILL_DEFINITIONS, type SkillDefinition } from '../backend/src/kory/skills';
import { skillPlaybook } from '../backend/src/kory/skill-playbooks';
import { isScaffoldRoutingPrompt } from '../backend/src/kory/skill-v5-quality';
import type {
  V5FullTaskFixture,
  V5HeldOutRoutingCase,
  V5SkillPackageSidecar,
} from '../backend/src/kory/skill-packages';

const projectRoot = resolve(import.meta.dir, '..');
const skillsRoot = join(projectRoot, 'skills-v5');
const candidateMarker = 'V5 candidate, not a qualified skill';
const authoredMarker = 'is an individually authored V5 skill package';
const refreshQualified = process.argv.includes('--refresh-qualified');
const coreTaskKindNegativeSafe = new Set([
  'repository-environment-discovery',
  'research',
  'planning',
  'implementation',
  'debugging',
  'verification',
  'security-review',
  'frontend-engineering',
  'testing-engineering',
  'human-experience',
]);
const negativeNeighborExclusions: Readonly<Record<string, ReadonlySet<string>>> = {
  'statistical-inference': new Set(['experimentation-ab-testing', 'experimental-analysis']),
};
const definitions = [...LEGACY_BUNDLED_SKILL_DEFINITIONS];
const byName = new Map(definitions.map((definition) => [definition.name, definition]));

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function title(name: string): string {
  return name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function phrases(definition: SkillDefinition, sidecar: V5SkillPackageSidecar): string[] {
  const declared = [...sidecar.activation, ...(definition.activation ?? [])]
    .map((value) => value.trim())
    .filter(Boolean);
  if (declared.length) return unique(declared);
  return unique([
    definition.name.replaceAll('-', ' '),
    ...definition.should.map((value) => value.trim()).filter(Boolean),
  ]);
}

function portableDescription(definition: SkillDefinition, sidecar: V5SkillPackageSidecar): string {
  const summary = definition.description.trim().replace(/[.!?]+$/, '');
  const triggers = phrases(definition, sidecar).slice(0, 4).join(', ');
  const result = `${summary}. Use when the request specifically requires ${triggers || definition.name}; prefer a narrower child only when its boundary is established.`;
  return result.length <= 360
    ? result
    : `${summary}. Use when the request requires ${phrases(definition, sidecar)[0] ?? definition.name}.`;
}

function broaderThan(candidate: string, narrower: string, seen = new Set<string>()): boolean {
  if (seen.has(narrower)) return false;
  seen.add(narrower);
  const direct = byName.get(narrower)?.broader ?? [];
  return (
    direct.includes(candidate) || direct.some((parent) => broaderThan(candidate, parent, seen))
  );
}

function childrenOf(name: string): string[] {
  return definitions
    .filter((definition) => definition.broader?.includes(name))
    .map((definition) => definition.name)
    .sort();
}

function overlap(left: string[], right: string[]): number {
  const set = new Set(left);
  return right.reduce((sum, item) => sum + (set.has(item) ? 1 : 0), 0);
}

function negativeNeighbors(definition: SkillDefinition): SkillDefinition[] {
  const parents = new Set(definition.broader ?? []);
  const excluded = negativeNeighborExclusions[definition.name] ?? new Set<string>();
  return definitions
    .filter(
      (candidate) =>
        candidate.name !== definition.name &&
        !excluded.has(candidate.name) &&
        !broaderThan(candidate.name, definition.name) &&
        !broaderThan(definition.name, candidate.name),
    )
    .sort((left, right) => {
      const leftSibling = (left.broader ?? []).some((parent) => parents.has(parent)) ? 1 : 0;
      const rightSibling = (right.broader ?? []).some((parent) => parents.has(parent)) ? 1 : 0;
      if (leftSibling !== rightSibling) return rightSibling - leftSibling;
      const domainDelta =
        overlap(right.domains, definition.domains) - overlap(left.domains, definition.domains);
      if (domainDelta !== 0) return domainDelta;
      return left.name.localeCompare(right.name);
    })
    .slice(0, 10);
}

function neighborPhrase(definition: SkillDefinition): string {
  return definition.activation?.[0] ?? definition.should[0] ?? definition.name.replaceAll('-', ' ');
}

function directRequest(
  definition: SkillDefinition,
  sidecar: V5SkillPackageSidecar,
  index: number,
): string {
  const requests = definition.should.map((value) => value.trim()).filter(Boolean);
  if (requests.length) return requests[index % requests.length]!;
  const candidates = phrases(definition, sidecar);
  return candidates[index % candidates.length] ?? definition.name;
}

function routingPhrase(
  definition: SkillDefinition,
  sidecar: V5SkillPackageSidecar,
  index: number,
): string {
  const candidates = phrases(definition, sidecar);
  return candidates[index % candidates.length] ?? definition.name.replaceAll('-', ' ');
}

function publicPositive(
  definition: SkillDefinition,
  sidecar: V5SkillPackageSidecar,
  index: number,
): string {
  const phrase = routingPhrase(definition, sidecar, index);
  const variants = [
    `Please handle ${phrase}.`,
    `The current task is ${phrase}.`,
    `I need help with ${phrase}.`,
    `Work on ${phrase} for this request.`,
    `This request specifically requires ${phrase}.`,
  ];
  return variants[index % variants.length]!;
}

function publicNegative(neighbor: SkillDefinition, index: number): string {
  const phrase = neighborPhrase(neighbor);
  const variants = [
    `The only requested work is ${phrase}.`,
    `Please handle ${phrase} only.`,
    `This task is limited to ${phrase}.`,
    `The current request is ${phrase}.`,
    `Work only on ${phrase}.`,
  ];
  return variants[index % variants.length]!;
}

function safeCoreNegative(index: number): string {
  const prompts = [
    'What does lexical scope mean? Give a concise conceptual answer only.',
    'Explain immutability in general terms. No changes or execution are requested.',
    'What is tail recursion? Answer conceptually and keep the response explanatory.',
    'Explain referential transparency as a programming-language concept only.',
    'What is the difference between a stack and a heap in general terms? Give an explanatory answer only.',
  ];
  return prompts[index % prompts.length]!;
}

function routingCase(
  definition: SkillDefinition,
  sidecar: V5SkillPackageSidecar,
  neighbor: SkillDefinition,
  category: 'ambiguous' | 'adversarial',
  index: number,
  heldOut = false,
): V5HeldOutRoutingCase {
  const ownPhrase = routingPhrase(definition, sidecar, index);
  const adjacent = neighborPhrase(neighbor);
  const prompt =
    category === 'ambiguous'
      ? heldOut
        ? `Please handle both ${ownPhrase} and ${adjacent}.`
        : `The request includes ${ownPhrase} and ${adjacent}.`
      : heldOut
        ? `An archived issue says "${ownPhrase}". The current task is ${adjacent}.`
        : `A historical note says "${ownPhrase}". The current request is ${adjacent}.`;
  return {
    id: `${definition.name}-${heldOut ? 'heldout-' : ''}${category}-${index + 1}`,
    category: heldOut ? category : undefined,
    prompt,
    expectedSelection: category === 'ambiguous',
    expectedSkills: [],
    forbiddenSkills: [],
    adjacentSkills: [neighbor.name],
    tags: [heldOut ? 'held-out' : category, category, 'hierarchy-boundary'].filter(
      (value, position, array) => array.indexOf(value) === position,
    ),
  } as V5HeldOutRoutingCase;
}

function heldOutCases(
  definition: SkillDefinition,
  sidecar: V5SkillPackageSidecar,
  neighbors: SkillDefinition[],
): V5HeldOutRoutingCase[] {
  const rows: V5HeldOutRoutingCase[] = [];
  for (let index = 0; index < 5; index += 1) {
    const phrase = routingPhrase(definition, sidecar, index);
    const variants = [
      `For this evaluation, the live request is ${phrase}.`,
      `The user explicitly asks for ${phrase}.`,
      `Treat ${phrase} as the current requested responsibility.`,
      `The requested specialty is ${phrase}.`,
      `The assignment explicitly calls for ${phrase}.`,
    ];
    rows.push({
      id: `${definition.name}-heldout-positive-${index + 1}`,
      category: 'positive',
      expectedSelection: true,
      prompt: variants[index]!,
      expectedSkills: [],
      forbiddenSkills: [],
      adjacentSkills: [neighbors[index % neighbors.length]!.name],
      tags: ['held-out', 'positive', 'hierarchy-aware'],
    });
  }
  for (let index = 0; index < 5; index += 1) {
    const neighbor = neighbors[index % neighbors.length]!;
    rows.push({
      id: `${definition.name}-heldout-negative-${index + 1}`,
      category: 'negative',
      expectedSelection: false,
      prompt: coreTaskKindNegativeSafe.has(definition.name)
        ? `${safeCoreNegative(index)} This is a held-out core-skill non-trigger case.`
        : `The current task is ${neighborPhrase(neighbor)}.`,
      expectedSkills: [],
      forbiddenSkills: [],
      adjacentSkills: [neighbor.name],
      tags: ['held-out', 'negative', 'near-neighbor'],
    });
  }
  for (let index = 0; index < 3; index += 1) {
    rows.push(
      routingCase(
        definition,
        sidecar,
        neighbors[index % neighbors.length]!,
        'ambiguous',
        index,
        true,
      ),
    );
    rows.push(
      routingCase(
        definition,
        sidecar,
        neighbors[(index + 3) % neighbors.length]!,
        'adversarial',
        index,
        true,
      ),
    );
  }
  return rows;
}

function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) return '';
  const body = text.slice(start + heading.length).replace(/^\s+/, '');
  const next = body.search(/\n###\s+/);
  return (next >= 0 ? body.slice(0, next) : body).trim();
}

function compact(value: string, max = 700): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function firstSentence(value: string, fallback: string): string {
  const normalized = compact(value, 900).replace(/^(?:[-*+]\s+|\d+[.)]\s*)/u, '');
  if (!normalized) return fallback;
  const match = normalized.match(/^.*?[.!?](?:\s|$)/);
  return (match?.[0] ?? normalized).trim();
}

function scenarioChallenge(definition: SkillDefinition, index: number): string {
  const domains = new Set(definition.domains);
  const pair = (left: string, right: string) => (index === 0 ? left : right);
  if (domains.has('database') || definition.name.includes('database')) {
    return pair(
      'The fixture includes skewed representative data, a tempting cargo-cult index, and concurrent transactions whose lock behavior matters.',
      'The fixture includes a migration/rollback boundary, stale statistics or plan assumptions, and a production-like failure path that a happy-path query test misses.',
    );
  }
  if (domains.has('data') || domains.has('statistics') || domains.has('analytics')) {
    return pair(
      'The evidence packet contains missingness, duplicates, unit ambiguity, and an attractive aggregate that can change the unit of analysis.',
      'The evidence packet contains a surprising subgroup result, a stale or weak source field, and uncertainty that must not be converted into unsupported precision.',
    );
  }
  if (domains.has('frontend') || domains.has('ui') || domains.has('design')) {
    return pair(
      'The fixture has a convincing happy-path interface but also loading, empty, error, keyboard/focus, and narrow-viewport states that expose ownership and accessibility mistakes.',
      'The fixture mixes existing design-system conventions with one tempting framework shortcut; verify lifecycle, async cleanup, recovery, and the actual target medium.',
    );
  }
  if (domains.has('backend') || domains.has('systems') || domains.has('api')) {
    return pair(
      'The fixture includes partial failure, cancellation, retry/idempotency pressure, concurrency, and an attractive topology assumption that is not established by evidence.',
      'The fixture includes compatibility-sensitive callers, restart or migration behavior, stale/duplicate input, and a happy path that can hide resource or recovery defects.',
    );
  }
  if (domains.has('business') || domains.has('product') || domains.has('planning')) {
    return pair(
      'The evidence packet contains conflicting stakeholder pressure, incomplete evidence, capacity or cost constraints, and an attractive option whose reversibility and opportunity cost differ from alternatives.',
      'The evidence packet contains one strong headline metric, a material guardrail or dependency problem, uncertain assumptions, and a decision that must remain traceable to evidence rather than confidence theater.',
    );
  }
  if (domains.has('integration') || definition.name.includes('integration')) {
    return pair(
      'The fixture includes duplicate delivery, retries, idempotency, authentication/authorization boundaries, and a downstream partial failure.',
      'The fixture includes version drift, malformed or stale external data, timeout/cancellation behavior, and a recovery path that must preserve local state.',
    );
  }
  if (domains.has('media') || domains.has('audio') || domains.has('video')) {
    return pair(
      'The source material has target-format constraints, noisy or incomplete input, accessibility/legibility requirements, and an export path that can silently degrade quality.',
      'The source material includes conflicting loudness/color/format assumptions, multiple delivery targets, and a final-output verification step rather than editor-preview confidence.',
    );
  }
  return pair(
    'The fixture contains a plausible happy path, an adjacent-skill decoy, one invalid or partial state, and a recovery condition that must be demonstrated rather than assumed.',
    'The fixture contains version/runtime ambiguity, a tempting shortcut, a compatibility edge case, and a failure path that distinguishes real expertise from generic completion.',
  );
}

function taskFixture(
  definition: SkillDefinition,
  sidecar: V5SkillPackageSidecar,
  neighbors: SkillDefinition[],
  index: number,
  currentPath?: string,
): V5FullTaskFixture {
  const resolvedCurrentPath =
    currentPath ??
    join(skillsRoot, definition.name, 'evals', 'tasks', `scenario-${index + 1}.json`);
  const current = JSON.parse(readFileSync(resolvedCurrentPath, 'utf8')) as V5FullTaskFixture;
  const playbook = skillPlaybook(definition.name);
  const operating =
    section(playbook, '### Specialist operating contract') ||
    section(playbook, '### Operating contract') ||
    definition.instructions;
  const execution = section(playbook, '### Execution sequence');
  const verification =
    section(playbook, '### Verification discipline') ||
    section(playbook, '### Evidence required before completion') ||
    definition.evidence.join('; ');
  const failures =
    section(playbook, '### Failure patterns to resist') ||
    section(playbook, '### Failure and recovery discipline') ||
    section(playbook, '### Anti-misinterpretation boundaries');
  const phrase = directRequest(definition, sidecar, index);
  const neighbor = neighbors[index % neighbors.length]!;
  const hierarchy = [
    ...(sidecar.broader.length ? [`broader=${sidecar.broader.join(',')}`] : []),
    ...(childrenOf(definition.name).length
      ? [`children=${childrenOf(definition.name).join(',')}`]
      : []),
    `near-neighbor=${neighbor.name}`,
  ].join('; ');
  const checks = [
    {
      id: 'scope-and-hierarchy',
      assertion: `The result must establish the actual ${definition.name} boundary and relevant environment before acting, preserve the hierarchy relationship (${hierarchy}), and not absorb the near-neighbor responsibility merely because it is adjacent.`,
    },
    {
      id: 'operating-contract',
      assertion: firstSentence(
        operating,
        `The result must follow the ${definition.name} operating contract rather than a generic domain shortcut.`,
      ),
    },
    {
      id: 'execution-invariant',
      assertion: firstSentence(
        execution,
        `The result must make its consequential assumptions, ownership, and decision sequence explicit and reproducible.`,
      ),
    },
    {
      id: 'verification-discipline',
      assertion: firstSentence(
        verification,
        `The result must exercise representative success, negative, and recovery evidence appropriate to ${definition.name}.`,
      ),
    },
    {
      id: 'anti-pattern-resistance',
      assertion: failures
        ? `The result must not take the tempting shortcut prohibited by this skill: ${firstSentence(failures, 'preserve the skill failure boundary')}`
        : `The result must not treat a happy path, generated artifact, compilation, or unsupported assumption as sufficient proof of ${definition.name} correctness.`,
    },
    {
      id: 'evidence-and-uncertainty',
      assertion: `Every material completion claim must map to observable evidence (${sidecar.evidence.slice(0, 4).join('; ')}), with simulated, unavailable, inferred, stale, or unresolved evidence labeled rather than converted into certainty.`,
    },
  ];
  return {
    ...current,
    id: `${definition.name}-full-task-${index + 1}-individual`,
    prompt: `The evaluation repository asks the agent to "${phrase}". ${scenarioChallenge(definition, index)} The acceptance boundary is ${definition.name}: ${firstSentence(operating, definition.instructions)} The adjacent ${neighbor.name} discipline is a routing decoy unless its separate responsibility is actually requested. Resolve environment facts that change the answer, preserve existing contracts and user-owned state, and produce reproducible success plus failure or recovery evidence. A happy path alone is insufficient.`,
    environment: {
      ...current.environment,
      requirements: unique([
        ...current.environment.requirements,
        `${definition.name} parent/child/neighbor hierarchy boundary fixture`,
        'domain-specific tempting anti-pattern or shortcut',
        'representative negative, interruption, compatibility, or recovery path',
      ]),
    },
    falsifiableChecks: checks,
    scorers: [
      {
        id: `${definition.name}-individual-deterministic-${index + 1}`,
        kind: 'deterministic',
        weight: 0.75,
        evidence: [
          ...sidecar.evidence,
          'hierarchy boundary and specialist selection rationale',
          'representative negative/recovery verification',
          'source/version boundary when facts can drift',
        ],
      },
      {
        id: `${definition.name}-individual-blind-quality-${index + 1}`,
        kind: 'blind-semantic',
        weight: 0.25,
        evidence: [
          'randomized candidate and no-skill artifacts',
          'independent evaluator record',
          'quality comparison without variant labels',
        ],
        blindTo: ['skill-variant', 'expected-outcome'],
      },
    ],
    requiredEvidence: unique([
      ...sidecar.evidence,
      'hierarchy boundary and selected specialist rationale',
      'representative success plus negative/recovery evidence',
      'paired skill/no-skill run artifacts',
      'explicit unavailable, simulated, inferred, or stale evidence labels',
    ]),
    requiredArtifacts: [
      `${definition.name}-individual-scenario-${index + 1}-result`,
      `${definition.name}-individual-scenario-${index + 1}-verification`,
      `${definition.name}-individual-scenario-${index + 1}-paired-evaluation`,
    ],
  };
}

function skillMarkdown(definition: SkillDefinition, sidecar: V5SkillPackageSidecar): string {
  const children = childrenOf(definition.name);
  const hierarchyLines = [
    sidecar.broader.length
      ? `- Broader skills: ${sidecar.broader.join(', ')}.`
      : '- This is a graph root for its responsibility.',
    children.length
      ? `- Narrower children: ${children.join(', ')}.`
      : '- No narrower bundled child is declared.',
    sidecar.facets.length ? `- Cross-cutting facets: ${sidecar.facets.join(', ')}.` : '',
    sidecar.requires.length ? `- Required skills: ${sidecar.requires.join(', ')}.` : '',
  ].filter(Boolean);
  const playbook = skillPlaybook(definition.name).trim();
  return `---\nname: ${definition.name}\ndescription: ${portableDescription(definition, sidecar)}\n---\n\n# ${title(definition.name)}\n\n## Responsibility\n\n${definition.instructions.trim()}\n\n## Hierarchy and routing\n\n${hierarchyLines.join('\n')}\n\nUse the broader skill for shared invariants and this skill only for its narrower responsibility. When a child boundary is explicitly established, compose that child instead of stretching this skill to imitate specialist knowledge. A sibling or facet can compose with this skill, but neither silently replaces its evidence boundary. Quoted, historical, negated, fixture-only, or example text is not a live trigger.\n\n${playbook ? `${playbook}\n\n` : ''}## Completion evidence\n\n${sidecar.evidence.map((item) => `- ${item}`).join('\n')}\n- Preserve contradictory or missing evidence explicitly.\n- Verify the highest-value invalid, partial, compatibility, interruption, or recovery path for the actual environment.\n- Do not claim success from compilation, a screenshot, a happy-path example, or source documentation alone when runtime or operational evidence is required.\n\nUse [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.\n`;
}

function authoredSourceMap(
  current: string,
  definition: SkillDefinition,
  sidecar: V5SkillPackageSidecar,
): string {
  const children = childrenOf(definition.name);
  const replacement = `\`${definition.name}\` is an individually authored V5 skill package; empirical qualification is tracked separately in the audit/evaluation ledger. These maintained sources bound factual and version-sensitive guidance; qualification requires hierarchy-aware held-out routing, paired same-model skill/no-skill tasks, and independent blind evaluation.`;
  const updated = current.replace(
    new RegExp(`\\\`${definition.name}\\\` is a V5 candidate, not a qualified skill\\.[^\\n]*`),
    replacement,
  );
  const qualification = `## Qualification basis\n\n- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.\n- Hierarchy: ${sidecar.broader.length ? `broader ${sidecar.broader.join(', ')}` : 'root responsibility'}${children.length ? `; narrower children ${children.join(', ')}` : ''}.\n- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.\n- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.\n- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.\n\n`;
  return updated.includes('## Qualification basis')
    ? updated
    : updated.replace('## Maintained sources\n', `${qualification}## Maintained sources\n`);
}

function generatedPublicRouting(
  definition: SkillDefinition,
  sidecar: V5SkillPackageSidecar,
  neighbors: SkillDefinition[],
): V5SkillPackageSidecar['routing'] {
  return {
    positive: Array.from({ length: 5 }, (_, index) => publicPositive(definition, sidecar, index)),
    negative: Array.from({ length: 5 }, (_, index) =>
      coreTaskKindNegativeSafe.has(definition.name)
        ? safeCoreNegative(index)
        : publicNegative(neighbors[index]!, index),
    ),
    ambiguous: Array.from({ length: 3 }, (_, index) =>
      routingCase(definition, sidecar, neighbors[index]!, 'ambiguous', index, false),
    ),
    adversarial: Array.from({ length: 3 }, (_, index) =>
      routingCase(definition, sidecar, neighbors[index + 3]!, 'adversarial', index, false),
    ),
  };
}

function refreshPublicRouting(
  definition: SkillDefinition,
  sidecar: V5SkillPackageSidecar,
  neighbors: SkillDefinition[],
): { routing: V5SkillPackageSidecar['routing']; rewrites: number } {
  const generated = generatedPublicRouting(definition, sidecar, neighbors);
  let rewrites = 0;
  const replacePrompt = (current: unknown, replacement: string) => {
    if (typeof current === 'string' && !isScaffoldRoutingPrompt(current)) return current;
    rewrites += 1;
    return replacement;
  };
  return {
    routing: {
      positive: sidecar.routing.positive.map((prompt, index) =>
        replacePrompt(prompt, generated.positive[index % generated.positive.length]!),
      ),
      negative: sidecar.routing.negative.map((prompt, index) =>
        replacePrompt(prompt, generated.negative[index % generated.negative.length]!),
      ),
      ambiguous: sidecar.routing.ambiguous.map((row, index) => {
        if (!isScaffoldRoutingPrompt(row.prompt)) return row;
        rewrites += 1;
        const replacement = generated.ambiguous[index % generated.ambiguous.length]!;
        return { ...row, prompt: replacement.prompt, adjacentSkills: replacement.adjacentSkills };
      }),
      adversarial: sidecar.routing.adversarial.map((row, index) => {
        if (!isScaffoldRoutingPrompt(row.prompt)) return row;
        rewrites += 1;
        const replacement = generated.adversarial[index % generated.adversarial.length]!;
        return { ...row, prompt: replacement.prompt, adjacentSkills: replacement.adjacentSkills };
      }),
    },
    rewrites,
  };
}

function refreshHeldOutRouting(
  existing: V5HeldOutRoutingCase[],
  generated: V5HeldOutRoutingCase[],
): { routing: V5HeldOutRoutingCase[]; rewrites: number } {
  const generatedById = new Map(generated.map((row) => [row.id, row]));
  let rewrites = 0;
  const refreshed = existing.map((row) => {
    const replacement = generatedById.get(row.id);
    const generatedBaseline =
      row.tags?.includes('hierarchy-aware') || row.tags?.includes('hierarchy-boundary');
    if (
      !replacement ||
      row.tags?.includes('regression') ||
      (!generatedBaseline && !isScaffoldRoutingPrompt(row.prompt))
    ) {
      return row;
    }
    rewrites += 1;
    return replacement;
  });

  // A hand-authored suite may already contain the complete 5/5/3/3 routing
  // matrix under bespoke IDs. Generated baseline rows only fill missing
  // category coverage; they do not duplicate an already complete curated set.
  const targets: Record<V5HeldOutRoutingCase['category'], number> = {
    positive: 5,
    negative: 5,
    ambiguous: 3,
    adversarial: 3,
  };
  const keepGeneratedIds = new Set<string>();
  for (const category of Object.keys(targets) as Array<V5HeldOutRoutingCase['category']>) {
    const customCount = refreshed.filter(
      (row) =>
        row.category === category &&
        (!generatedById.has(row.id) || row.tags?.includes('regression')),
    ).length;
    const needed = Math.max(0, targets[category] - customCount);
    for (const row of refreshed
      .filter(
        (candidate) =>
          candidate.category === category &&
          generatedById.has(candidate.id) &&
          !candidate.tags?.includes('regression'),
      )
      .slice(0, needed)) {
      keepGeneratedIds.add(row.id);
    }
  }
  const routing = refreshed.filter(
    (row) =>
      !generatedById.has(row.id) ||
      row.tags?.includes('regression') ||
      keepGeneratedIds.has(row.id),
  );
  rewrites += refreshed.length - routing.length;

  const existingIds = new Set(routing.map((row) => row.id));
  const categoryCounts = new Map<V5HeldOutRoutingCase['category'], number>();
  for (const row of routing) {
    categoryCounts.set(row.category, (categoryCounts.get(row.category) ?? 0) + 1);
  }
  for (const row of generated) {
    if (existingIds.has(row.id)) continue;
    if ((categoryCounts.get(row.category) ?? 0) >= targets[row.category]) continue;
    routing.push(row);
    existingIds.add(row.id);
    categoryCounts.set(row.category, (categoryCounts.get(row.category) ?? 0) + 1);
    rewrites += 1;
  }
  return { routing, rewrites };
}

function isScaffoldTaskFixture(task: V5FullTaskFixture): boolean {
  return (
    /^Complete a realistic .+ assignment while staying inside the .+ responsibility\./iu.test(
      task.prompt,
    ) || task.falsifiableChecks.some((check) => check.assertion.trim() === '1.')
  );
}

let authoredOrRefreshed = 0;
let publicRoutingRewrites = 0;
let heldOutRoutingRewrites = 0;
let taskFixtureRewrites = 0;
for (const definition of definitions) {
  const directory = join(skillsRoot, definition.name);
  const sidecarPath = join(directory, 'kory.json');
  const sourcePath = join(directory, 'references', 'sources.md');
  if (!existsSync(sidecarPath) || !existsSync(sourcePath)) continue;
  const sourceMap = readFileSync(sourcePath, 'utf8');
  const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')) as V5SkillPackageSidecar;
  const alreadyAuthored =
    sidecar.authoringMaturity === 'individual' ||
    sourceMap.includes(authoredMarker) ||
    sourceMap.includes('individually authored for V5');
  if (!sourceMap.includes(candidateMarker) && !(refreshQualified && alreadyAuthored)) continue;
  const neighbors = negativeNeighbors(definition);
  if (neighbors.length < 5)
    throw new Error(`${definition.name} has too few hierarchy-safe neighbors`);
  const publicRefresh = alreadyAuthored
    ? refreshPublicRouting(definition, sidecar, neighbors)
    : { routing: generatedPublicRouting(definition, sidecar, neighbors), rewrites: 16 };
  const nextSidecar: V5SkillPackageSidecar = {
    ...sidecar,
    authoringMaturity: 'individual',
    activation: phrases(definition, sidecar),
    evidence: unique([
      ...sidecar.evidence,
      'Hierarchy boundary and selected specialist rationale',
      'Representative success, negative-path, and recovery verification',
    ]),
    // Preserve steward-written routing while replacing only known generator
    // scaffolds. This keeps regressions and bespoke boundary cases intact.
    routing: publicRefresh.routing,
  };
  // Individual authorship creates the initial contract. A refresh of an
  // already-authored package must preserve steward/manual refinements (and
  // their context-budget work) instead of bulk-regenerating SKILL.md.
  if (!alreadyAuthored) {
    writeFileSync(join(directory, 'SKILL.md'), skillMarkdown(definition, nextSidecar));
  }
  writeFileSync(sidecarPath, `${JSON.stringify(nextSidecar, null, 2)}\n`);
  writeFileSync(sourcePath, authoredSourceMap(sourceMap, definition, nextSidecar));
  publicRoutingRewrites += publicRefresh.rewrites;
  const generatedHeldOut = heldOutCases(definition, nextSidecar, neighbors);
  const routingPath = join(directory, 'evals', 'routing.jsonl');
  const existingHeldOut =
    alreadyAuthored && existsSync(routingPath)
      ? readFileSync(routingPath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as V5HeldOutRoutingCase)
      : [];
  const heldOutRefresh = alreadyAuthored
    ? refreshHeldOutRouting(existingHeldOut, generatedHeldOut)
    : { routing: generatedHeldOut, rewrites: generatedHeldOut.length };
  const heldOut = heldOutRefresh.routing;
  heldOutRoutingRewrites += heldOutRefresh.rewrites;
  writeFileSync(routingPath, `${heldOut.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const taskDirectory = join(directory, 'evals', 'tasks');
  const taskPaths = readdirSync(taskDirectory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(taskDirectory, name));
  if (taskPaths.length !== 2) {
    throw new Error(`${definition.name} must have exactly two V5 full-task fixtures`);
  }
  for (let index = 0; index < taskPaths.length; index += 1) {
    const taskPath = taskPaths[index]!;
    const currentTask = JSON.parse(readFileSync(taskPath, 'utf8')) as V5FullTaskFixture;
    const nextTask =
      !alreadyAuthored || isScaffoldTaskFixture(currentTask)
        ? taskFixture(definition, nextSidecar, neighbors, index, taskPath)
        : currentTask;
    if (nextTask !== currentTask) taskFixtureRewrites += 1;
    writeFileSync(taskPath, `${JSON.stringify(nextTask, null, 2)}\n`);
  }
  authoredOrRefreshed += 1;
}

console.log(
  JSON.stringify(
    { authoredOrRefreshed, publicRoutingRewrites, heldOutRoutingRewrites, taskFixtureRewrites },
    null,
    2,
  ),
);
