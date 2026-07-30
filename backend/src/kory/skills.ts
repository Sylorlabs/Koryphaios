import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { TaskContract, TaskKind } from './prompts';
import { PROFESSIONAL_SKILL_DEFINITIONS } from './professional-skill-definitions';
import { skillPlaybook } from './skill-playbooks';

export type SkillSource = 'personal' | 'project';
export type SkillState = 'active' | 'draft';

export interface KorySkillMetadata {
  version: string;
  baseVersion: string;
  baseHash: string;
  domains: string[];
  targetMedia: string[];
  shouldTrigger: string[];
  shouldNotTrigger: string[];
  evidence: string[];
  contextBudget: number;
  sourceScope: 'local-only';
  parent?: string;
  depth: number;
  requires: string[];
  conflicts: string[];
  activation: string[];
  excludes: string[];
}

export interface SkillRevision {
  name: string;
  description: string;
  source: SkillSource;
  state: SkillState;
  path: string;
  content: string;
  instructions: string;
  metadata: KorySkillMetadata;
  hash: string;
  validation: SkillValidationResult;
}

export interface SkillValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  ignoredAuthorityClaims: string[];
}

export interface SkillTestResult {
  passed: boolean;
  cases: Array<{ prompt: string; expected: boolean; selected: boolean; passed: boolean }>;
}

export interface SkillCollision {
  name: string;
  personalHash: string;
  projectHash: string;
}

export interface ResolvedSkill {
  skill: SkillRevision;
  reason: string;
  contextCost: number;
}

export interface SkillEvidence {
  taskKind: TaskKind;
  declaredMedia: string[];
  repositoryMedia: string[];
  languages: string[];
  runtimes: string[];
  toolkits: string[];
  topologies: string[];
  artifacts: string[];
}

export interface SkillResolverResult {
  selected: ResolvedSkill[];
  collisions: SkillCollision[];
  selectionConflicts: Array<{ left: string; right: string }>;
  hierarchyErrors: string[];
  omittedByBudget: string[];
  blocked: boolean;
  manifestHash: string;
  totalContextCost: number;
  evidence: SkillEvidence;
}

export type SkillLearningMode = 'human-only' | 'propose-then-verify' | 'automatic';
export type SkillChangeActor = 'human' | 'agent';

export function enforceSkillLearningPolicy(
  mode: SkillLearningMode,
  actor: SkillChangeActor,
  action: 'save-draft' | 'activate',
  promotionReady = false,
): void {
  if (actor === 'human') return;
  if (mode === 'human-only') {
    throw new Error('Agent-authored skill changes are disabled in Human only mode');
  }
  if (action === 'activate' && mode === 'propose-then-verify') {
    throw new Error('Agent-authored skills require explicit human activation in Propose then verify mode');
  }
  if (action === 'activate' && !promotionReady) {
    throw new Error('Automatic activation requires a ready promotion evidence gate');
  }
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const AUTHORITY_KEYS = ['allowed-tools', 'scripts', 'binaries', 'network', 'network-requirements'];

const unique = (values: string[]) => [...new Set(values)];

export function collectSkillEvidence(
  projectRoot: string,
  prompt: string,
  contract: TaskContract,
  targetMedium?: string,
): SkillEvidence {
  const text = prompt.toLowerCase();
  const root = resolve(projectRoot);
  const artifacts = [
    'package.json',
    'Cargo.toml',
    'go.mod',
    'pyproject.toml',
    'CMakeLists.txt',
    'build.zig',
    'index.html',
    'src-tauri',
    'android',
    'ios',
    'Makefile',
  ].filter((name) => existsSync(join(root, name)));
  let packageText = '';
  if (artifacts.includes('package.json')) {
    try {
      packageText = readFileSync(join(root, 'package.json'), 'utf8').toLowerCase();
    } catch {
      /* evidence is best effort */
    }
  }
  const declaredMedia = unique([
    ...(targetMedium ? [targetMedium.toLowerCase()] : []),
    ...['web', 'native', 'terminal', 'embedded', 'game', 'spatial'].filter((term) =>
      new RegExp(`\\b${term}\\b`).test(text),
    ),
    ...(text.includes('custom language') || text.includes('ui toolkit') ? ['novel-toolkit'] : []),
  ]);
  const repositoryMedia = unique([
    ...(artifacts.includes('index.html') || /"(react|svelte|vue|astro|next)"/.test(packageText)
      ? ['web']
      : []),
    ...(artifacts.includes('src-tauri') ||
    artifacts.includes('ios') ||
    artifacts.includes('android')
      ? ['native']
      : []),
  ]);
  const languages = unique([
    ...(artifacts.includes('Cargo.toml') ? ['rust'] : []),
    ...(artifacts.includes('go.mod') ? ['go'] : []),
    ...(artifacts.includes('pyproject.toml') ? ['python'] : []),
    ...(artifacts.includes('build.zig') ? ['zig'] : []),
    ...(artifacts.includes('package.json') ? ['javascript-typescript'] : []),
    ...['c', 'c++', 'rust', 'go', 'python', 'zig', 'java', 'swift', 'kotlin'].filter((term) =>
      new RegExp(`(?:^|[^a-z0-9+])${term.replace('+', '\\+')}(?:$|[^a-z0-9+])`).test(text),
    ),
  ]);
  const runtimes = unique([
    ...(/"bun"|bun\.lock/.test(packageText) ? ['bun'] : []),
    ...(text.includes('browser') ? ['browser'] : []),
    ...(text.includes('bare metal') ? ['bare-metal'] : []),
  ]);
  const toolkits = unique([
    ...['react', 'svelte', 'vue', 'astro', 'next'].filter((term) =>
      packageText.includes(`"${term}"`),
    ),
    ...(text.includes('custom language') ? ['custom-language'] : []),
  ]);
  const topologies = unique([
    ...(text.includes('in-process') ? ['in-process'] : []),
    ...(text.includes('local service') || text.includes('daemon') ? ['local-service'] : []),
    ...(text.includes('network service') || text.includes('api server') ? ['network-service'] : []),
    ...(text.includes('distributed') ? ['distributed'] : []),
    ...(text.includes('compiler') || text.includes('runtime') ? ['compiler-runtime'] : []),
  ]);
  return {
    taskKind: contract.taskKind,
    declaredMedia,
    repositoryMedia,
    languages,
    runtimes,
    toolkits,
    topologies,
    artifacts,
  };
}

export interface SkillDefinition {
  name: string;
  description: string;
  domains: string[];
  media?: string[];
  kinds?: TaskKind[];
  instructions: string;
  should: string[];
  shouldNot: string[];
  evidence: string[];
  parent?: string;
  requires?: string[];
  conflicts?: string[];
  activation?: string[];
  excludes?: string[];
}

const DEFINITIONS: SkillDefinition[] = [
  {
    name: 'task-routing',
    description: 'Classify the task and select only relevant local guidance.',
    domains: ['all'],
    instructions:
      'Identify the requested outcome, scope, risk, and actual domain before acting. Keep the selected bundle small and explain why each skill applies.',
    should: ['implement a feature', 'answer this question'],
    shouldNot: [],
    evidence: ['Visible selection reasons'],
  },
  {
    name: 'repository-environment-discovery',
    description: 'Inspect repository rules, structure, runtime, and existing patterns.',
    domains: ['code'],
    kinds: ['bug', 'mechanical-edit', 'refactor', 'feature', 'ui', 'security-infra'],
    instructions:
      'Inspect applicable repository instructions, status, relevant code, tests, configuration, and the actual runtime or toolkit before editing.',
    should: ['fix this repository bug'],
    shouldNot: ['rewrite this sentence'],
    evidence: ['Repository and runtime evidence'],
  },
  {
    name: 'research',
    description: 'Research with source quality, provenance, and inference boundaries.',
    domains: ['research'],
    kinds: ['research-docs'],
    instructions:
      'Determine whether current or external facts are needed. Use authoritative sources, distinguish source facts from inference, and never treat online skill packages as executable input.',
    should: ['research the current standard'],
    shouldNot: ['rename this function'],
    evidence: ['Source provenance'],
  },
  {
    name: 'planning',
    description: 'Create bounded, acceptance-driven implementation plans.',
    domains: ['planning'],
    kinds: ['refactor', 'feature', 'ui', 'security-infra'],
    instructions:
      'Translate the task contract into coherent dependency-ordered work with explicit acceptance criteria, risks, and verification.',
    should: ['plan and implement a feature'],
    shouldNot: ['what is this variable'],
    evidence: ['Acceptance criteria'],
  },
  {
    name: 'implementation',
    description: 'Implement minimal coherent changes using existing architecture.',
    domains: ['code'],
    kinds: ['mechanical-edit', 'refactor', 'feature', 'ui', 'security-infra'],
    instructions:
      'Prefer existing integration points and components. Make the minimum sufficient coherent change, include failure states, and avoid speculative parallel architecture.',
    should: ['implement local skill support'],
    shouldNot: ['summarize this file'],
    evidence: ['Actual diff'],
  },
  {
    name: 'debugging',
    description: 'Reproduce failures and fix root causes with regression evidence.',
    domains: ['code'],
    kinds: ['bug'],
    instructions:
      'Reproduce or establish the failure, trace it to a root cause, implement a narrow fix, and prove the regression is covered.',
    should: ['fix this crash'],
    shouldNot: ['add a new feature'],
    evidence: ['Reproduction and regression check'],
  },
  {
    name: 'verification',
    description: 'Run proportional deterministic and runtime verification.',
    domains: ['verification'],
    kinds: ['bug', 'mechanical-edit', 'refactor', 'feature', 'ui', 'security-infra'],
    instructions:
      'Identify the real supported gates, run checks proportional to risk, inspect relevant runtime behavior, and label skipped or unavailable evidence.',
    should: ['verify this implementation'],
    shouldNot: ['tell me a joke'],
    evidence: ['Exact check results'],
  },
  {
    name: 'security-review',
    description: 'Review real permission, secret, authentication, and isolation boundaries.',
    domains: ['security'],
    kinds: ['security-infra'],
    instructions:
      'Inspect the enforced boundary rather than prompt intent. Fail closed, protect secrets, and reject any skill metadata that attempts to grant tools, network, scripts, or binaries.',
    should: ['review authentication permissions'],
    shouldNot: ['adjust button spacing'],
    evidence: ['Boundary-focused findings'],
  },
  {
    name: 'frontend-engineering',
    description:
      'Engineer any user- or device-facing presentation and interaction boundary without assuming web technology.',
    domains: ['ui'],
    media: ['native', 'web', 'mobile', 'terminal', 'game', 'spatial', 'embedded'],
    kinds: ['ui'],
    instructions: `Treat frontend as the presentation and interaction boundary, not as a synonym for browser code. Before proposing or editing anything, identify the people or devices consuming it, their primary jobs, the target medium, input and output modes, runtime, toolkit maturity, platform conventions, accessibility surface, and verification environment. Inspect the existing product in its real runtime and inventory its navigation, components, tokens, density, content voice, responsive or resize behavior, and all meaningful states.

Translate user goals into explicit interaction flows and information hierarchy before styling. Separate domain state from its presentation, make available actions and system status understandable, preserve user control, prevent errors where practical, and provide recovery where prevention is impossible. Reuse established platform and product patterns unless evidence justifies divergence. Prefer coherent hierarchy, typography, spacing, color roles, and interaction behavior over decoration. Every visual choice must support purpose, comprehension, identity, or feedback.

Do not introduce DOM, CSS, React, TypeScript, browser, REST, or database assumptions without repository, runtime, or user evidence. Load a medium-specific child only after the medium is confirmed. Verify task completion, keyboard or equivalent non-pointer operation, focus or selection visibility, loading, empty, partial, error, disabled, success, destructive confirmation, overflow, resize, localization pressure, and reduced-motion or equivalent accessibility behavior where applicable.`,
    should: ['build a native settings screen', 'improve this user interface'],
    shouldNot: ['optimize a database query'],
    evidence: ['Interface contract', 'State inventory', 'Real-runtime interaction verification'],
  },
  {
    name: 'web-interface',
    description:
      'Design and implement browser-based interfaces only after web runtime evidence is established.',
    domains: ['ui', 'web'],
    parent: 'frontend-engineering',
    requires: ['interaction-design', 'accessibility-practice'],
    media: ['web'],
    activation: ['web', 'browser', 'html', 'css'],
    instructions: `Use this branch only when the target is genuinely browser-based. Inspect the rendered application, routes, framework, component library, tokens, content loading model, supported viewports, and browser constraints before editing. Prefer semantic HTML and native behavior, resilient layout, progressive enhancement where appropriate, URL and history correctness, explicit network states, and components already proven in the repository.

For web visual anti-slop, make a design read from audience, content, brand, references, and page purpose before choosing layout, density, and motion. Do not default to a centered hero, three equal cards, AI-purple glow, glass effects, generic bento grids, fake product screenshots, invented testimonials, or decorative animation. These are contextual warnings, not permanent bans: use any pattern when it is justified by the product, brand, content, or platform. Preserve a coherent token system, use real assets or clearly identified placeholders, and make motion earn its cost through feedback, orientation, or storytelling.

Implement responsive behavior from content and task priority rather than arbitrary device stereotypes. Verify keyboard navigation, focus restoration, landmarks and naming, zoom/reflow, target sizes, validation, async races, slow and failed requests, empty and partial data, navigation, refresh/deep links, multiple viewport sizes, console errors, and relevant browser accessibility tooling. Do not select React, Svelte, Tailwind, a state library, or an animation library unless the repository or user establishes it. Before declaring visual work complete, audit the real page for hierarchy, repetition, token drift, copy quality, imagery purpose, reduced motion, and its smallest supported viewport.`,
    should: ['build a web page', 'improve this browser frontend', 'fix responsive CSS'],
    shouldNot: ['build a terminal UI', 'create a native renderer'],
    evidence: ['Browser inspection', 'Responsive interaction and console verification'],
  },
  {
    name: 'native-interface',
    description:
      'Design and implement native desktop or mobile interfaces using confirmed platform characteristics and toolkit conventions.',
    domains: ['ui', 'native'],
    parent: 'frontend-engineering',
    requires: ['interaction-design', 'accessibility-practice'],
    media: ['native', 'mobile'],
    activation: ['native', 'desktop app', 'mobile app', 'ios', 'android'],
    instructions: `Use this branch only after confirming a native application and its platform/toolkit. Study platform characteristics, window and lifecycle behavior, input devices, menus and commands, navigation conventions, density, scaling, localization, accessibility APIs, and existing application components. Prefer native semantics and established platform behavior; divergence requires a user benefit that outweighs lost familiarity.

For native visual anti-slop, start from the platform's information density, commands, display scaling, and user workflows—not landing-page composition. Reject fake telemetry, ornamental containers, hidden-but-pretty controls, and web-shaped navigation when they obscure a frequent task. Preserve platform conventions unless a documented task benefit outweighs familiarity. For desktop, handle window resizing, multiple windows or documents where relevant, keyboard-first workflows, focus across active/inactive states, menus, shortcuts, precision input, display scaling, and long sessions. For mobile, handle touch ergonomics, safe areas, orientation, interruptions, virtual keyboards, navigation restoration, permissions, and constrained attention. Test on the actual runtime or representative simulator and do not substitute browser screenshots for native verification.`,
    should: ['build a native desktop UI', 'design a mobile app screen'],
    shouldNot: ['style a marketing website'],
    evidence: ['Platform and toolkit contract', 'Native runtime verification'],
  },
  {
    name: 'terminal-interface',
    description:
      'Design terminal and command-line interfaces around text, keyboard operation, streams, automation, and terminal constraints.',
    domains: ['ui', 'terminal'],
    parent: 'frontend-engineering',
    requires: ['interaction-design', 'content-error-design', 'accessibility-practice'],
    media: ['terminal'],
    activation: ['terminal', 'command line', 'cli', 'tui'],
    instructions: `Treat terminal interfaces as a distinct medium. Identify whether the product is a composable CLI, an interactive TUI, or both. Preserve predictable arguments, stdin/stdout/stderr separation, exit codes, noninteractive automation, discoverable help, safe confirmation, interruption and cancellation, narrow and wide terminal layouts, color-disabled operation, and keyboard-only interaction.

For terminal anti-slop, make hierarchy legible in plain text before adding color, panels, symbols, or animation. Do not use decorative box drawing, spinners, colors, Unicode, or progress indicators when they reduce piping, scanning, accessibility, or degraded-terminal behavior. For TUIs, define focus, selection, navigation, resize behavior, scroll ownership, shortcuts, screen-reader or plain-text fallback expectations, and recovery after terminal suspension. Never import browser layout or pointer-hover assumptions. Verify real terminal behavior, piping, redirection, errors, cancellation, resizing, and degraded color or Unicode environments.`,
    should: ['build a terminal UI', 'design a command line interface'],
    shouldNot: ['build a browser dashboard'],
    evidence: ['CLI/TUI contract', 'Terminal and automation verification'],
  },
  {
    name: 'novel-ui-toolkit',
    description:
      'Design a new cross-domain UI toolkit, rendering system, or language-native interface API without importing web architecture by default.',
    domains: ['ui', 'systems', 'language'],
    parent: 'frontend-engineering',
    requires: ['interaction-design', 'accessibility-practice', 'developer-experience'],
    media: ['native', 'game', 'spatial', 'embedded'],
    activation: ['ui toolkit', 'widget system', 'rendering system', 'custom language'],
    excludes: ['sandbox', 'security review', 'threat model'],
    instructions: `Use this branch when the task creates the interface substrate itself. Establish target platforms, consumers, language constraints, rendering backends, retained versus immediate ownership, layout model, text shaping, scene or widget tree, invalidation, event dispatch, focus, input capture, accessibility bridge, styling and theming, resource lifetime, concurrency boundary, testability, debugging tools, and performance budgets before proposing public APIs.

Separate the ergonomic surface used by application authors from backend adapters and platform integration. Design primitives that compose without forcing one product aesthetic. Make state ownership, identity, lifecycle, measurement, layout, rendering, and event propagation explicit. Provide escape hatches without making unsafe or platform-specific behavior the default. Research mature native, game, embedded, and declarative toolkits for tradeoffs, but do not clone DOM/CSS or a fashionable framework unless its model fits the language and runtime.

Build a vertical reference slice that proves layout, text, input, focus, theming, accessibility semantics, error reporting, and rendering in the real target. Test invariants, golden rendering where stable, event/focus traversal, resize/scaling, resource cleanup, performance, and at least one realistic application flow.`,
    should: [
      'build a UI toolkit for a custom language',
      'create a widget system',
      'design a native renderer',
    ],
    shouldNot: ['restyle an existing website'],
    evidence: [
      'Architecture decision record',
      'Real vertical slice',
      'Layout input focus and performance tests',
    ],
  },
  {
    name: 'game-spatial-interface',
    description:
      'Design game, simulation, immersive, and spatial interfaces around attention, embodiment, controllers, world context, and performance.',
    domains: ['ui', 'game', 'spatial'],
    parent: 'frontend-engineering',
    requires: ['interaction-design', 'accessibility-practice'],
    media: ['game', 'spatial'],
    activation: ['game ui', 'game hud', 'spatial interface', 'vr interface', 'ar interface'],
    instructions: `Treat game and spatial interfaces as situated experiences rather than flat application screens. Identify play or operational goals, camera and world relationship, attention budget, input devices, distance and scale, locomotion, handedness, latency and frame budget, interruption, multiplayer or spectator context, and accessibility options before choosing presentation.

Decide what belongs in the world, on objects, near the player, in a HUD, in menus, or outside active play. Preserve situational awareness, avoid unnecessary modality, communicate state through redundant channels, and ensure critical information survives motion, visual complexity, audio loss, color-vision differences, and alternate controls. Design onboarding through safe progressive practice instead of instruction dumps.

For game and spatial anti-slop, reject HUD clutter, cosmetic chrome, faux dashboards, and motion that competes with play or operation. Every persistent element must earn attention, screen/world space, and frame budget; every diegetic treatment must preserve legibility and accessibility. Verify with the actual engine/runtime and representative controls. Test camera extremes, aspect ratios or fields of view, rapid state changes, pause/resume, controller disconnect, remapping, subtitles, motion reduction, comfort settings, performance under load, and transitions between play and menus. Do not import website navigation, hover, or document-layout assumptions.`,
    should: ['design a game HUD', 'build a spatial interface', 'create a VR menu'],
    shouldNot: ['build an admin website'],
    evidence: ['Situated interaction contract', 'Engine/device runtime verification'],
  },
  {
    name: 'embedded-interface',
    description:
      'Design embedded, appliance, industrial, and constrained-device interfaces around safety, environment, physical controls, and resource limits.',
    domains: ['ui', 'embedded', 'safety'],
    parent: 'frontend-engineering',
    requires: ['interaction-design', 'content-error-design', 'accessibility-practice'],
    media: ['embedded'],
    activation: ['embedded ui', 'device interface', 'appliance display', 'industrial panel'],
    instructions: `Start from the physical system, operating environment, user expertise, frequency and urgency of use, gloves or mobility constraints, lighting, noise, viewing distance, physical controls, failure consequences, connectivity, power, memory, display, and update limitations. Separate normal operation, degraded operation, maintenance, calibration, emergency, and safe-state behavior.

Match information density and control placement to task priority. Make system mode unmistakable, prevent dangerous action through constraints and confirmation proportional to risk, preserve critical operation without network service, and provide diagnostics that technicians can act on. Coordinate screen behavior with physical affordances, indicators, alarms, and haptics; never rely on color, touch, or connectivity alone for critical meaning.

For embedded anti-slop, reject decorative dashboards, ambiguous modes, ornamental animation, and density that hides safety or maintenance information. The display must reinforce physical controls, safe state, urgency, and environmental constraints rather than imitate a web product. Verify on representative hardware or a faithful simulator, including boot, power loss, brownout, sensor failure, stale data, communication loss, extreme values, long-duration operation, physical-control conflict, and recovery. Do not assume browser resources, pointer input, abundant memory, or continuously deployable software.`,
    should: [
      'design an embedded UI',
      'build an appliance display',
      'create an industrial control panel',
    ],
    shouldNot: ['style a social media page'],
    evidence: ['Human-device safety contract', 'Hardware or faithful simulation evidence'],
  },
  {
    name: 'backend-engineering',
    description:
      'Engineer state, computation, coordination, persistence, policy, and reliability behind consumers without assuming language, SQL, REST, or cloud topology.',
    domains: ['backend', 'systems'],
    kinds: ['feature', 'refactor', 'bug', 'security-infra'],
    instructions: `Treat backend as a responsibility boundary, not a technology stack. Identify consumers, topology, deployment and trust boundaries, state ownership, consistency and concurrency requirements, failure model, latency and throughput needs, persistence lifetime, protocols, compatibility, observability, recovery, and operational constraints before selecting architecture.

Inspect the repository and runtime before choosing language, database, transport, framework, process model, or deployment platform. In-process modules, local services, embedded loops, compiler runtimes, peer systems, and distributed services require different designs. Select SQL, key-value, files, memory, logs, queues, RPC, REST, or no persistence only from requirements and existing architecture. Define contracts, invariants, idempotency, timeouts, cancellation, backpressure, resource limits, error taxonomy, migrations, and rollback proportional to the system. Verify at the real boundary, including failures and recovery; do not mistake endpoint existence for backend correctness.`,
    should: ['implement backend behavior', 'design a local service', 'build a compiler daemon'],
    shouldNot: ['adjust interface typography'],
    evidence: ['System boundary contract', 'Failure and recovery verification'],
  },
  {
    name: 'in-process-backend',
    description:
      'Engineer stateful application cores, libraries, game simulations, and local modules that do not require a service boundary.',
    domains: ['backend', 'architecture'],
    parent: 'backend-engineering',
    activation: ['in-process', 'application core', 'game simulation', 'library backend'],
    instructions: `Confirm that a process or network boundary is unnecessary before adding one. Define module ownership, state transitions, invariants, lifetime, concurrency or reentrancy, cancellation, resource ownership, error propagation, serialization boundaries, and test seams. Keep domain behavior independent from presentation and platform adapters without inventing interfaces that have no second implementation or substitution need.

Prefer direct calls and explicit data flow when they satisfy isolation and reliability requirements. Avoid service frameworks, REST, database servers, queues, containers, and distributed coordination unless a real boundary demands them. Test state machines, invariants, ordering, interruption, persistence adapters if present, and integration with the actual host runtime.`,
    should: ['build an in-process application core', 'implement a game simulation backend'],
    shouldNot: ['deploy a distributed API'],
    evidence: ['Ownership and state-transition model', 'Host-runtime tests'],
  },
  {
    name: 'local-service-backend',
    description:
      'Engineer desktop daemons, local IPC services, sidecars, and single-host processes without importing cloud assumptions.',
    domains: ['backend', 'local-service'],
    parent: 'backend-engineering',
    activation: ['local service', 'desktop daemon', 'ipc service', 'sidecar process'],
    instructions: `Establish why a separate local process is beneficial: isolation, privilege separation, lifecycle, language boundary, sharing, or fault containment. Define startup readiness, discovery, IPC transport, authentication or peer identity, permissions, version negotiation, request cancellation, streaming, backpressure, crash recovery, single-instance behavior, upgrades, logs, and shutdown ownership.

Prefer the operating system's appropriate local primitives and existing project conventions. Do not add HTTP, containers, cloud discovery, Kubernetes, or a network database merely because the component is called a service. Verify stale clients, server restart, partial messages, permission denial, path and user isolation, concurrent clients, upgrades, and supervisor behavior on the real host.`,
    should: ['build a local service', 'create a desktop daemon', 'implement an IPC server'],
    shouldNot: ['design a public cloud API'],
    evidence: ['Process and IPC contract', 'Restart and failure verification'],
  },
  {
    name: 'network-service-backend',
    description:
      'Engineer network-facing APIs and services from contracts, trust boundaries, load, failure, compatibility, and operations.',
    domains: ['backend', 'network'],
    parent: 'backend-engineering',
    activation: ['network service', 'http api', 'rpc service', 'public api'],
    instructions: `Identify clients, trust zones, protocol constraints, request and response semantics, latency and throughput targets, payload limits, compatibility period, authentication and authorization, abuse cases, deployment topology, and operational ownership. Choose HTTP, RPC, messaging, streaming, or another protocol from those needs; REST is not a default.

Specify schemas, validation, idempotency, pagination or flow control, timeouts, cancellation, retries, rate and resource limits, error taxonomy, observability, rollout, rollback, and versioning. Keep secrets and internal failures out of responses. Test contracts over the real transport, malformed and oversized input, auth boundaries, disconnects, duplicate requests, overload, dependency failure, compatibility, and deployment health.`,
    should: ['build a network service', 'design an HTTP API', 'implement an RPC backend'],
    shouldNot: ['create an offline library'],
    evidence: ['Protocol and trust contract', 'Transport and failure tests'],
  },
  {
    name: 'distributed-backend',
    description:
      'Engineer distributed systems with explicit consistency, partition, retry, ordering, ownership, and operability models.',
    domains: ['backend', 'distributed'],
    parent: 'backend-engineering',
    activation: ['distributed system', 'multi-region', 'consensus', 'event driven services'],
    instructions: `Require evidence that distribution is necessary. Define data and command ownership, consistency guarantees, ordering, clocks, identity, partition behavior, durability, replication, leader or coordination model, delivery semantics, idempotency, backpressure, retry budgets, failure detection, reconciliation, and disaster recovery. Make unavailable or uncertain states explicit instead of implying exactly-once behavior.

Minimize cross-boundary coordination and preserve debuggability. Document invariants and which component enforces each one. Test concurrency, duplication, reordering, delay, partitions, clock skew, node loss, recovery, schema evolution, overload, replay, and operator procedures with deterministic simulation or fault injection where possible. Do not introduce microservices, queues, orchestration, or eventual consistency as fashion.`,
    should: ['design a distributed system', 'build a multi-region service', 'implement consensus'],
    shouldNot: ['write a single-process parser'],
    evidence: ['Consistency and failure model', 'Fault-injection or simulation evidence'],
  },
  {
    name: 'compiler-runtime-backend',
    description:
      'Engineer compiler, language-server, build, VM, and language-runtime backends around semantics, diagnostics, determinism, and incremental behavior.',
    domains: ['backend', 'compiler', 'runtime'],
    parent: 'backend-engineering',
    activation: [
      'compiler runtime',
      'language server',
      'build daemon',
      'virtual machine',
      'custom language',
      'language toolchain',
    ],
    instructions: `Establish language semantics, phase boundaries, intermediate representations, source mapping, diagnostics, determinism, incremental invalidation, caching, concurrency, resource limits, compatibility, and host/target boundaries. Keep parser, semantic analysis, lowering, optimization, code generation, runtime services, and tooling contracts explicit without forcing a conventional compiler layout where the language differs.

Treat diagnostics and developer interaction as product interfaces. Preserve reproducibility, stable identifiers where required, cancellation, partial results, malformed-source recovery, and safe execution boundaries. Test golden diagnostics, semantic invariants, differential behavior, incremental versus clean builds, cache invalidation, concurrency, malformed input, target differences, and end-to-end execution. Do not default to a web server, SQL store, or TypeScript host.`,
    should: ['build a compiler runtime', 'create a language server', 'implement a build daemon'],
    shouldNot: ['style a web form'],
    evidence: ['Semantic and phase contract', 'Differential and end-to-end language tests'],
  },
  {
    name: 'testing-engineering',
    description:
      'Select professional evidence strategies across software, interfaces, systems, devices, data, and novel runtimes without assuming a test framework.',
    domains: ['test', 'verification'],
    kinds: ['bug', 'mechanical-edit', 'refactor', 'feature', 'ui', 'security-infra'],
    instructions: `Start from the claim that must be established, the risks that could falsify it, the faithful test boundary, and the oracle that determines correctness. Inspect the repository's supported gates and runtime before choosing a framework. Use the smallest evidence that can catch the relevant failure: static analysis, example/unit tests, contract tests, integration, property-based, fuzz, differential, simulation, visual golden, interaction, accessibility, performance, fault injection, hardware-in-loop, or live-runtime checks.

Test behavior and invariants rather than implementation trivia. Cover normal paths, boundaries, malformed input, state transitions, concurrency, interruption, partial failure, recovery, compatibility, and regression scope proportional to risk. Make tests deterministic where possible; isolate time, randomness, network, filesystem, devices, and external services without replacing the behavior under test with mocks. Record environment, commands, artifacts, skipped coverage, and limitations. A passing test is evidence only for the claim and boundary it actually exercised.`,
    should: ['test this system', 'add regression coverage', 'verify the frontend'],
    shouldNot: ['write an unverified product announcement'],
    evidence: ['Claim-to-evidence matrix', 'Exact reproducible results'],
  },
  {
    name: 'deterministic-contract-testing',
    description:
      'Test deterministic functions, state machines, schemas, APIs, and compatibility contracts against observable claims.',
    domains: ['test'],
    parent: 'testing-engineering',
    activation: ['unit test', 'contract test', 'state machine test', 'schema compatibility'],
    instructions: `Map each test to an observable contract or invariant. Choose examples that expose partitions, boundaries, transitions, error behavior, and compatibility rather than mirroring implementation lines. Use stable fixtures and explicit oracles; control time and randomness only at real seams. Keep tests readable enough to explain the product rule they protect.

Test public behavior, malformed input, boundary values, state-transition legality, error taxonomy, serialization round trips, and backward/forward compatibility where promised. Avoid snapshotting large opaque output, overspecifying call order, or mocking the unit into a tautology.`,
    should: ['write unit tests', 'add contract tests', 'test a state machine'],
    shouldNot: ['perform a visual usability study'],
    evidence: ['Contract-to-case mapping', 'Deterministic repeatable results'],
  },
  {
    name: 'property-fuzz-differential-testing',
    description:
      'Use properties, generated input, fuzzing, model-based checks, and differential oracles for broad behavioral exploration.',
    domains: ['test', 'fuzz'],
    parent: 'testing-engineering',
    activation: ['property test', 'fuzz test', 'differential test', 'generated inputs'],
    instructions: `Define invariants, generators, invalid-input space, shrink strategy, execution limits, seed recording, and the oracle before running generated tests. Prefer semantic properties such as round trips, conservation, monotonicity, equivalence, determinism, parser/formatter stability, or agreement with a trusted implementation over weak assertions like “does not crash.”

Preserve minimal counterexamples and exact seeds. Bound resource consumption and isolate untrusted input. Use differential testing only when implementations are independent enough to provide a meaningful oracle, and investigate shared disagreement rather than automatically declaring one side correct.`,
    should: ['add property tests', 'fuzz this parser', 'run differential testing'],
    shouldNot: ['check button spacing'],
    evidence: ['Properties generators and oracle', 'Reproducible minimized failures'],
  },
  {
    name: 'integration-fault-testing',
    description:
      'Test real component boundaries, lifecycle, dependencies, concurrency, and recovery with controlled faults.',
    domains: ['test', 'integration'],
    parent: 'testing-engineering',
    activation: [
      'integration test',
      'fault injection',
      'failure recovery test',
      'end to end backend',
    ],
    instructions: `Identify the boundary whose composition is risky and keep that boundary real: transport, database engine, filesystem, process, queue, device adapter, or provider protocol. Replace only uncontrollable external systems, and make substitutes contract-faithful. Control lifecycle and isolate data so failures do not leak across tests.

Exercise startup, readiness, shutdown, concurrency, retries, cancellation, partial writes, disconnects, timeouts, duplicate delivery, dependency loss, restart, and recovery. Assert externally observable state and durable side effects, not only response codes. Record unavailable infrastructure and distinguish simulated faults from physically verified behavior.`,
    should: ['add integration tests', 'test failure recovery', 'inject network faults'],
    shouldNot: ['write a typography guide'],
    evidence: ['Boundary and fault matrix', 'Recovery evidence'],
  },
  {
    name: 'interface-usability-testing',
    description:
      'Verify interface behavior, accessibility, visual integrity, comprehension, and task completion in the real medium.',
    domains: ['test', 'ui', 'ux'],
    parent: 'testing-engineering',
    requires: ['frontend-engineering'],
    activation: ['ui test', 'usability test', 'visual regression', 'interaction test'],
    instructions: `Separate functional interaction, accessibility conformance, visual regression, and usability evidence: none substitutes for the others. Derive realistic task flows and state coverage from the interface contract. Verify navigation, input, focus/selection, feedback, validation, loading, empty, partial, error, recovery, resize, scaling, localization pressure, reduced motion, and assistive behavior in the real medium.

Use stable visual goldens only for intentional visual contracts and review diffs rather than auto-accepting them. Automated flows prove mechanics, not comprehension. For material UX claims, observe representative people attempting realistic tasks, record success, errors, hesitation and recovery, and avoid leading prompts. Never call an interface “intuitive” based solely on an agent's opinion.`,
    should: ['run UI tests', 'perform usability testing', 'add visual regression tests'],
    shouldNot: ['benchmark a storage engine'],
    evidence: ['Interaction and state matrix', 'Accessibility and usability evidence'],
  },
  {
    name: 'performance-testing',
    description:
      'Measure latency, throughput, memory, frame time, startup, energy, and resource behavior with controlled representative workloads.',
    domains: ['test', 'performance'],
    parent: 'testing-engineering',
    activation: ['performance test', 'benchmark latency', 'profile memory', 'frame time'],
    instructions: `Define the user or system consequence, metric, percentile or distribution, workload, dataset, environment, warmup, duration, baseline, budget, and noise controls before measuring. Select end-to-end or component scope according to the claim. Capture resource saturation and correctness under load; faster incorrect behavior is not a win.

Repeat measurements, report variance, preserve raw artifacts, compare equivalent builds, and distinguish microbenchmarks from product performance. Investigate regressions with profiling rather than guessing. Test cold and warm behavior, steady state, spikes, degradation, cancellation, cleanup, and limits relevant to the medium.`,
    should: ['run performance tests', 'benchmark latency', 'measure frame time'],
    shouldNot: ['choose a color palette'],
    evidence: ['Reproducible benchmark protocol', 'Baseline budget and variance'],
  },
  {
    name: 'simulation-device-testing',
    description:
      'Verify embedded, graphics, robotics, GPU, and device behavior through models, simulators, emulators, hardware-in-loop, and physical gates.',
    domains: ['test', 'device', 'simulation'],
    parent: 'testing-engineering',
    activation: ['hardware in loop', 'device simulation', 'emulator test', 'gpu verification'],
    instructions: `Define which physical properties the simulation represents and which it cannot. Build a ladder from pure model and deterministic simulation through emulator, representative hardware, hardware-in-loop, and physical operation according to risk. Never report simulated success as physical proof.

Exercise timing, sensor and actuator ranges, noise, saturation, disconnects, power and reset behavior, resource exhaustion, thermal or frame constraints where relevant, invalid commands, safe states, and recovery. Preserve traces, device identity, firmware/runtime versions, seeds, workloads, and safety boundaries. On shared or display-bound hardware, run safe non-disruptive gates first and keep risky submission opt-in.`,
    should: ['test a device simulator', 'run hardware in loop tests', 'verify GPU behavior'],
    shouldNot: ['unit test a string helper'],
    evidence: ['Simulation validity boundary', 'Device-specific reproducible artifacts'],
  },
  {
    name: 'data-analysis',
    description: 'Analyze structured data with explicit assumptions and reproducible calculations.',
    domains: ['data'],
    instructions:
      'Inspect the data shape and actual analysis medium first. State assumptions, preserve units, validate calculations, and use tables or charts only when they clarify relationships.',
    should: ['analyze this dataset'],
    shouldNot: ['fix CSS'],
    evidence: ['Reproducible calculations'],
  },
  {
    name: 'documents-communication',
    description: 'Create clear documents and communication in the actual target format.',
    domains: ['documents'],
    kinds: ['research-docs', 'question'],
    instructions:
      'Identify the audience, target medium, required structure, and repository conventions. Preserve facts, separate uncertainty, and optimize for the reader action.',
    should: ['write the release notes'],
    shouldNot: ['debug a crash'],
    evidence: ['Format and factual review'],
  },
  {
    name: 'skill-authoring-evaluation',
    description: 'Author and evaluate safe local instruction-only Koryphaios skills.',
    domains: ['skills'],
    instructions:
      'Use portable SKILL.md name and description frontmatter plus Kory metadata. Keep revisions draft until validation and trigger tests pass. Skills are instructions and read-only references only.',
    should: ['create a local skill'],
    shouldNot: ['download a marketplace skill'],
    evidence: ['Validation and trigger test results'],
  },
  ...PROFESSIONAL_SKILL_DEFINITIONS,
];

function yamlList(values: string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(', ')}]`;
}

function definitionDepth(definition: (typeof DEFINITIONS)[number]): number {
  let depth = 0;
  let parent = definition.parent;
  const seen = new Set<string>([definition.name]);
  while (parent) {
    if (seen.has(parent)) return depth;
    seen.add(parent);
    depth += 1;
    parent = DEFINITIONS.find((item) => item.name === parent)?.parent;
  }
  return depth;
}

function template(definition: (typeof DEFINITIONS)[number]): string {
  const version =
    definition.parent ||
    ['frontend-engineering', 'backend-engineering', 'testing-engineering'].includes(definition.name)
      ? '2.0.0'
      : '1.0.0';
  const playbook = skillPlaybook(definition.name);
  const content = `---\nname: ${definition.name}\ndescription: ${definition.description}\nmetadata:\n  koryphaios:\n    version: ${version}\n    baseVersion: ${version}\n    baseHash: __BASE_HASH__\n    parent: ${definition.parent ?? ''}\n    depth: ${definitionDepth(definition)}\n    requires: ${yamlList(definition.requires ?? [])}\n    conflicts: ${yamlList(definition.conflicts ?? [])}\n    activation: ${yamlList(definition.activation ?? [])}\n    excludes: ${yamlList(definition.excludes ?? [])}\n    domains: ${yamlList(definition.domains)}\n    targetMedia: ${yamlList(definition.media ?? ['any'])}\n    shouldTrigger: ${yamlList(definition.should)}\n    shouldNotTrigger: ${yamlList(definition.shouldNot)}\n    evidence: ${yamlList(definition.evidence)}\n    contextBudget: ${definition.parent ? 5000 : 4000}\n    sourceScope: local-only\n---\n# ${definition.name}\n\n${definition.instructions}${playbook ? `\n\n${playbook}` : ''}\n`;
  return content.replace('__BASE_HASH__', contentFingerprint(content));
}

function contentFingerprint(content: string): string {
  return sha256(content.replace(/^\s*baseHash:\s*.+$/m, '    baseHash: __BASE_HASH__'));
}

function personalRoot(): string {
  return process.env.KORYPHAIOS_SKILLS_HOME || join(homedir(), '.koryphaios', 'skills');
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, 'utf8');
  renameSync(temporary, path);
}

/** A read-only installed library must remain usable even when an app update has a new default. */
function writeSeedIfWritable(path: string, content: string): boolean {
  try {
    atomicWrite(path, content);
    return true;
  } catch (error: any) {
    if (error?.code === 'EROFS' || error?.code === 'EACCES' || error?.code === 'EPERM')
      return false;
    throw error;
  }
}

export function seedDefaultSkills(): void {
  for (const name of ['ui-ux-professional-practice', 'interface-accessibility']) {
    const path = join(personalRoot(), name, 'SKILL.md');
    const local = readRevision(path, 'personal', 'active');
    if (local && local.metadata.baseHash === contentFingerprint(local.content)) {
      renameSync(path, join(personalRoot(), name, 'RETIRED.md'));
    }
  }
  for (const definition of DEFINITIONS) {
    const path = join(personalRoot(), definition.name, 'SKILL.md');
    if (!existsSync(path)) {
      writeSeedIfWritable(path, template(definition));
      continue;
    }
    // Update an untouched seeded default in place. Edited copies keep their
    // content and flow through the explicit replace/merge/keep-local UI.
    const local = readRevision(path, 'personal', 'active');
    const legacyBodyHash = sha256(local?.instructions.replace(/^# .+\n+/, '').trim() ?? '');
    const legacyUntouched =
      local?.metadata.baseHash === legacyBodyHash &&
      local.metadata.parent === definition.parent &&
      JSON.stringify(local.metadata.requires) === JSON.stringify(definition.requires ?? []) &&
      JSON.stringify(local.metadata.conflicts) === JSON.stringify(definition.conflicts ?? []) &&
      JSON.stringify(local.metadata.domains) === JSON.stringify(definition.domains) &&
      JSON.stringify(local.metadata.targetMedia) === JSON.stringify(definition.media ?? ['any']);
    if (
      local?.metadata.baseHash &&
      (local.metadata.baseHash === contentFingerprint(local.content) || legacyUntouched)
    ) {
      writeSeedIfWritable(path, template(definition));
    }
  }
}

function scalar(frontmatter: string, key: string): string {
  return frontmatter.match(new RegExp(`^[ \\t]*${key}:[ \\t]*(.*)$`, 'm'))?.[1]?.trim() ?? '';
}

function list(frontmatter: string, key: string): string[] {
  const raw = scalar(frontmatter, key);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return raw
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
}

export function validateSkillContent(content: string): SkillValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ignoredAuthorityClaims = AUTHORITY_KEYS.filter((key) =>
    new RegExp(`^\\s*${key}:`, 'mi').test(content),
  );
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) errors.push('SKILL.md must contain YAML frontmatter delimited by ---');
  const frontmatter = match?.[1] ?? '';
  if (!scalar(frontmatter, 'name')) errors.push('name is required');
  if (!scalar(frontmatter, 'description')) errors.push('description is required');
  if (!/metadata:\s*\n\s+koryphaios:/m.test(frontmatter))
    errors.push('metadata.koryphaios is required');
  if (!scalar(frontmatter, 'version')) errors.push('metadata.koryphaios.version is required');
  if (scalar(frontmatter, 'sourceScope') !== 'local-only')
    errors.push('sourceScope must be local-only');
  const budget = Number(scalar(frontmatter, 'contextBudget'));
  if (!Number.isInteger(budget) || budget < 100 || budget > 20_000)
    errors.push('contextBudget must be an integer from 100 to 20000');
  if (ignoredAuthorityClaims.length)
    warnings.push(`Ignored authority claims: ${ignoredAuthorityClaims.join(', ')}`);
  if (!match?.[2]?.trim()) errors.push('Skill instructions are required');
  return { valid: errors.length === 0, errors, warnings, ignoredAuthorityClaims };
}

function readRevision(path: string, source: SkillSource, state: SkillState): SkillRevision | null {
  if (!existsSync(path)) return null;
  const content = readFileSync(path, 'utf8');
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  const frontmatter = match?.[1] ?? '';
  return {
    name: scalar(frontmatter, 'name'),
    description: scalar(frontmatter, 'description'),
    source,
    state,
    path,
    content,
    instructions: match?.[2]?.trim() ?? '',
    hash: sha256(content),
    validation: validateSkillContent(content),
    metadata: {
      version: scalar(frontmatter, 'version'),
      baseVersion: scalar(frontmatter, 'baseVersion') || scalar(frontmatter, 'version'),
      baseHash: scalar(frontmatter, 'baseHash'),
      parent: scalar(frontmatter, 'parent') || undefined,
      depth: Number(scalar(frontmatter, 'depth')) || 0,
      requires: list(frontmatter, 'requires'),
      conflicts: list(frontmatter, 'conflicts'),
      activation: list(frontmatter, 'activation'),
      excludes: list(frontmatter, 'excludes'),
      domains: list(frontmatter, 'domains'),
      targetMedia: list(frontmatter, 'targetMedia'),
      shouldTrigger: list(frontmatter, 'shouldTrigger'),
      shouldNotTrigger: list(frontmatter, 'shouldNotTrigger'),
      evidence: list(frontmatter, 'evidence'),
      contextBudget: Number(scalar(frontmatter, 'contextBudget')) || 0,
      sourceScope: 'local-only',
    },
  };
}

function scan(root: string, source: SkillSource): SkillRevision[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const directory = join(root, entry.name);
      return [
        readRevision(join(directory, 'SKILL.md'), source, 'active'),
        readRevision(join(directory, 'DRAFT.md'), source, 'draft'),
      ].filter((item): item is SkillRevision => Boolean(item));
    });
}

export function listSkills(projectRoot: string): SkillRevision[] {
  seedDefaultSkills();
  return [
    ...scan(personalRoot(), 'personal'),
    ...scan(join(resolve(projectRoot), '.koryphaios', 'skills'), 'project'),
  ];
}

export function saveSkillDraft(
  projectRoot: string,
  source: SkillSource,
  name: string,
  content: string,
): SkillRevision {
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(name)) throw new Error('Invalid skill name');
  const root =
    source === 'personal' ? personalRoot() : join(resolve(projectRoot), '.koryphaios', 'skills');
  const path = join(root, name, 'DRAFT.md');
  atomicWrite(path, content);
  return readRevision(path, source, 'draft')!;
}

function triggers(
  skill: SkillRevision,
  prompt: string,
  contract?: TaskContract,
  targetMedium?: string,
): boolean {
  const text = prompt.toLowerCase();
  if (skill.name === 'task-routing') return true;
  // A user-confirmed medium is stronger evidence than a coincidental keyword
  // in the request (for example, "do not assume web technologies").
  if (
    targetMedium &&
    !skill.metadata.targetMedia.includes('any') &&
    !skill.metadata.targetMedia.includes(targetMedium.toLowerCase())
  ) {
    return false;
  }
  if (skill.metadata.excludes.some((term) => text.includes(term.toLowerCase()))) return false;
  if (skill.metadata.activation.length > 0) {
    return (
      skill.metadata.activation.some((term) => text.includes(term.toLowerCase())) ||
      skill.metadata.shouldTrigger.some((example) => text === example.toLowerCase())
    );
  }
  if (
    targetMedium &&
    skill.metadata.parent &&
    skill.metadata.targetMedia.includes(targetMedium.toLowerCase())
  ) {
    return true;
  }
  const definition = DEFINITIONS.find((item) => item.name === skill.name);
  if (definition?.kinds?.includes(contract?.taskKind as TaskKind)) return true;
  return skill.metadata.shouldTrigger.some((example) => {
    const words = example
      .toLowerCase()
      .split(/\W+/)
      .filter((word) => word.length > 2);
    const matches = words.filter((word) => text.includes(word)).length;
    return matches >= Math.min(2, words.length);
  });
}

export function testSkill(skill: SkillRevision): SkillTestResult {
  const cases = [
    ...skill.metadata.shouldTrigger.map((prompt) => ({ prompt, expected: true })),
    ...skill.metadata.shouldNotTrigger.map((prompt) => ({ prompt, expected: false })),
  ].map((item) => {
    const selected = triggers(skill, item.prompt);
    return { ...item, selected, passed: selected === item.expected };
  });
  return { passed: cases.length > 0 && cases.every((item) => item.passed), cases };
}

export function activateSkill(
  projectRoot: string,
  source: SkillSource,
  name: string,
): SkillRevision {
  const root =
    source === 'personal' ? personalRoot() : join(resolve(projectRoot), '.koryphaios', 'skills');
  const draft = readRevision(join(root, name, 'DRAFT.md'), source, 'draft');
  if (!draft) throw new Error('Draft not found');
  if (!draft.validation.valid) throw new Error(draft.validation.errors.join('; '));
  const tests = testSkill(draft);
  if (!tests.passed) throw new Error('Trigger tests must pass before activation');
  atomicWrite(join(root, name, 'SKILL.md'), draft.content);
  return readRevision(join(root, name, 'SKILL.md'), source, 'active')!;
}

export function resolveSkills(
  projectRoot: string,
  prompt: string,
  contract: TaskContract,
  options: {
    pins?: string[];
    remove?: string[];
    collisionChoices?: Record<string, SkillSource>;
    targetMedium?: string;
    contextBudget?: number;
  } = {},
): SkillResolverResult {
  const evidence = collectSkillEvidence(projectRoot, prompt, contract, options.targetMedium);
  const active = listSkills(projectRoot).filter(
    (skill) => skill.state === 'active' && skill.validation.valid,
  );
  const grouped = new Map<string, SkillRevision[]>();
  for (const skill of active) grouped.set(skill.name, [...(grouped.get(skill.name) ?? []), skill]);
  const collisions: SkillCollision[] = [];
  const candidates: SkillRevision[] = [];
  for (const [name, versions] of grouped) {
    const preferred = options.collisionChoices?.[name];
    const explicit = versions.find((item) => item.source === preferred);
    const defaultSelection =
      versions.find((item) => item.source === 'project') ??
      versions.find((item) => item.source === 'personal') ??
      versions[0];

    if (versions.length > 1 && !preferred) {
      collisions.push({
        name,
        personalHash: versions.find((item) => item.source === 'personal')?.hash ?? '',
        projectHash: versions.find((item) => item.source === 'project')?.hash ?? '',
      });
    }
    if (explicit || defaultSelection) {
      candidates.push(explicit ?? defaultSelection);
    }
  }
  const removed = new Set(options.remove ?? []);
  const pins = new Set(options.pins ?? []);
  const directlySelected = candidates.filter(
    (skill) =>
      !removed.has(skill.name) &&
      (pins.has(skill.name) || triggers(skill, prompt, contract, options.targetMedium)),
  );
  const byName = new Map(candidates.map((skill) => [skill.name, skill]));
  const hierarchyErrors: string[] = [];
  for (const skill of candidates) {
    if (skill.metadata.parent && !byName.has(skill.metadata.parent)) {
      hierarchyErrors.push(`${skill.name} references missing parent ${skill.metadata.parent}`);
    }
    for (const requirement of skill.metadata.requires) {
      if (!byName.has(requirement)) {
        hierarchyErrors.push(`${skill.name} requires missing skill ${requirement}`);
      }
    }
    const seen = new Set<string>([skill.name]);
    let parent = skill.metadata.parent;
    while (parent) {
      if (seen.has(parent)) {
        hierarchyErrors.push(
          `Hierarchy cycle detected at ${skill.name}: ${[...seen, parent].join(' -> ')}`,
        );
        break;
      }
      seen.add(parent);
      parent = byName.get(parent)?.metadata.parent;
    }
  }
  const expanded = new Map<string, SkillRevision>();
  const includeWithAncestors = (skill: SkillRevision): void => {
    if (expanded.has(skill.name) || removed.has(skill.name)) return;
    if (skill.metadata.parent) {
      const parent = byName.get(skill.metadata.parent);
      if (parent) includeWithAncestors(parent);
    }
    for (const requirement of skill.metadata.requires) {
      const required = byName.get(requirement);
      if (required) includeWithAncestors(required);
    }
    expanded.set(skill.name, skill);
  };
  directlySelected.forEach(includeWithAncestors);
  const selectionConflicts: Array<{ left: string; right: string }> = [];
  const conflictKeys = new Set<string>();
  for (const skill of expanded.values()) {
    for (const conflict of skill.metadata.conflicts) {
      if (!expanded.has(conflict)) continue;
      const [left, right] = [skill.name, conflict].sort();
      const key = `${left}:${right}`;
      if (!conflictKeys.has(key)) {
        conflictKeys.add(key);
        selectionConflicts.push({ left, right });
      }
    }
  }
  // Reserve context for the most specific evidence-matched branches first. Their
  // ancestors still precede them, while broad task-kind guidance is optional.
  const specialistClosure = new Set<string>();
  const markSpecialistClosure = (skill: SkillRevision): void => {
    if (specialistClosure.has(skill.name)) return;
    specialistClosure.add(skill.name);
    for (const name of [skill.metadata.parent, ...skill.metadata.requires]) {
      const dependency = name ? byName.get(name) : undefined;
      if (dependency) markSpecialistClosure(dependency);
    }
  };
  directlySelected.filter((skill) => skill.metadata.depth > 0).forEach(markSpecialistClosure);
  const ordered = [...expanded.values()].sort((left, right) => {
    const priority =
      Number(specialistClosure.has(right.name)) - Number(specialistClosure.has(left.name));
    if (priority) return priority;
    return left.metadata.depth - right.metadata.depth || left.name.localeCompare(right.name);
  });
  const directlySelectedNames = new Set(directlySelected.map((skill) => skill.name));
  const mandatory = new Set<string>([...pins]);
  const markDependencies = (name: string): void => {
    const skill = byName.get(name);
    if (!skill) return;
    for (const dependency of [skill.metadata.parent, ...skill.metadata.requires]) {
      if (dependency && !mandatory.has(dependency)) {
        mandatory.add(dependency);
        markDependencies(dependency);
      }
    }
  };
  pins.forEach(markDependencies);
  const contextBudget = Math.max(1, options.contextBudget ?? 30_000);
  let used = 0;
  const included: SkillRevision[] = [];
  const omittedByBudget: string[] = [];
  for (const skill of ordered) {
    const cost = Math.min(skill.content.length, skill.metadata.contextBudget);
    if (used + cost <= contextBudget || mandatory.has(skill.name)) {
      included.push(skill);
      used += cost;
    } else {
      omittedByBudget.push(skill.name);
    }
  }
  // A budget may omit an ancestor that sorted after a child at the same declared
  // depth. Prune the dependent too; never flatten a hierarchy silently.
  let pruned = true;
  while (pruned) {
    pruned = false;
    for (let index = included.length - 1; index >= 0; index -= 1) {
      const skill = included[index];
      const dependencies = [skill.metadata.parent, ...skill.metadata.requires].filter(
        (name): name is string => Boolean(name),
      );
      if (
        dependencies.some(
          (name) => expanded.has(name) && !included.some((item) => item.name === name),
        )
      ) {
        included.splice(index, 1);
        used -= Math.min(skill.content.length, skill.metadata.contextBudget);
        if (!omittedByBudget.includes(skill.name)) omittedByBudget.push(skill.name);
        pruned = true;
      }
    }
  }
  const selected = included.map((skill) => ({
    skill,
    reason: pins.has(skill.name)
      ? 'Pinned for this task'
      : !directlySelectedNames.has(skill.name)
        ? 'Required by a selected child skill'
        : skill.name === 'task-routing'
          ? 'Universal task routing'
          : `Matched ${contract.taskKind} task; evidence: ${
              [...evidence.declaredMedia, ...evidence.topologies, ...evidence.toolkits].join(
                ', ',
              ) || 'task contract and trigger metadata'
            }`,
    contextCost: Math.min(skill.content.length, skill.metadata.contextBudget),
  }));
  const manifest = selected.map(({ skill, reason, contextCost }) => ({
    name: skill.name,
    version: skill.metadata.version,
    source: skill.source,
    hash: skill.hash,
    reason,
    contextCost,
  }));
  const selectedSkillNames = new Set(selected.map((item) => item.skill.name));
  const effectiveCollisions = collisions.filter((item) => selectedSkillNames.has(item.name));
  return {
    selected,
    collisions: effectiveCollisions,
    selectionConflicts,
    hierarchyErrors,
    omittedByBudget,
    blocked:
      effectiveCollisions.length > 0 ||
      selectionConflicts.length > 0 ||
      hierarchyErrors.length > 0 ||
      omittedByBudget.some((name) => mandatory.has(name)) ||
      used > contextBudget,
    manifestHash: sha256(JSON.stringify(manifest)),
    totalContextCost: selected.reduce((sum, item) => sum + item.contextCost, 0),
    evidence,
  };
}

export function compareSkillRevisions(
  active: SkillRevision,
  draft: SkillRevision,
): { activeHash: string; draftHash: string; changed: boolean; active: string; draft: string } {
  return {
    activeHash: active.hash,
    draftHash: draft.hash,
    changed: active.hash !== draft.hash,
    active: active.content,
    draft: draft.content,
  };
}

export function applyDefaultUpdate(
  projectRoot: string,
  name: string,
  choice: 'replace' | 'merge' | 'keep-local',
): SkillRevision {
  const definition = DEFINITIONS.find((item) => item.name === name);
  if (!definition) throw new Error('Bundled default not found');
  const path = join(personalRoot(), name, 'SKILL.md');
  const local = readRevision(path, 'personal', 'active');
  const bundled = template(definition);
  if (!local || choice === 'replace') atomicWrite(path, bundled);
  else if (choice === 'merge') {
    const merged = `${bundled.trim()}\n\n## Preserved local additions\n\n${local.instructions}\n`;
    atomicWrite(join(personalRoot(), name, 'DRAFT.md'), merged);
    return readRevision(join(personalRoot(), name, 'DRAFT.md'), 'personal', 'draft')!;
  }
  return readRevision(path, 'personal', 'active')!;
}
