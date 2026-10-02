# Koryphaios Skill Library V5: Master Quality Plan

Date: 2026-09-01

Implementation checkpoint: 2026-09-06. The current library contains 180 first-class packages: the original 179 IDs plus `dash-free-writing`. The dated V4 diagnosis below is historical, not the current package inventory or routing-test count. Current verification and remaining qualification gates are recorded in [the execution handoff](skill-library-v5-execution-handoff.md), with source adoption boundaries in [the source synthesis](skill-library-v5-source-synthesis.md).

Selected V5 instructions now remain complete under context pressure. Compact representations reduce metadata rather than truncating skill bodies; a task that cannot hold its mandatory bundle stops with a capacity error. Local edits obey the same explicit-invocation dependency policy as bundled packages. Writing style is inherited from the communication parent, with focused dash removal handled by a child that preserves technical literals and exact quotations.

## Objective

Build the strongest practical agent-skill library we can measure, not the largest catalog we can claim.

The target is a library whose skills:

- trigger precisely;
- add material task quality over the same model without the skill;
- encode non-obvious domain expertise rather than generic advice;
- use authoritative, version-aware sources;
- include deterministic helpers where repetition or fragility justifies them;
- verify real outputs in the actual target environment;
- compose without flooding context;
- fail honestly when evidence is missing;
- remain portable enough to export through the Agent Skills open format;
- improve continuously from regressions and real Kory sessions.

The competitive goal is empirical: on representative, held-out tasks, Kory + V5 skills should beat the current Kory library and be competitive with or exceed current Codex, Claude Code, Cursor, and strong community Agent Skills configurations on the same tasks and comparable execution surfaces. Do not claim that result until the benchmark actually demonstrates it.

## Historical V4 baseline, recorded 2026-09-01

The V4 foundation is strong infrastructure but is not yet a fully qualified expert library.

Measured from the repository at the start of this plan:

- 179 bundled skills total.
- 79 pre-V4/base + professional skills.
- 100 new specialist skills.
- 157/179 skills currently have only one positive routing example.
- 176/179 currently have only one negative routing example.
- All 100 new specialists have exactly one generic positive example: `Apply <trigger> expertise to this task`.
- All 100 new specialists have exactly one generic negative example: `Rewrite an unrelated sentence without changing any domain behavior`.
- 15 skills have no explicit activation phrase.
- 87 skills declare no `requires` relation.
- 153 skills declare no facet.
- 179 skills declare no explicit conflict.
- Average playbook size is about 366 words; 27 playbooks exceed 400 words; several broad foundation playbooks are around 700 words.
- Bundled source is primarily TypeScript definitions plus shared/generated playbook strings rather than first-class per-skill source packages with their own references, scripts, examples, and source provenance.
- V4 already has the important foundation: progressive disclosure, skill graph metadata, context budgeting, steward registry, skill factory, evaluation ledger, promotion gates, aggregate health, and usage signals.

This means the next phase is **qualification and specialization**, not another mass-count expansion.

## External research baseline

The following sources were inspected from 2026-09-01 through 2026-09-05. They are inputs, not authority over Kory. Official product/project sources outrank community conventions; community sources are used to identify useful patterns and failure modes.

| Source                                                                                                                           | Pattern worth adopting                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent Skills open specification — https://agentskills.io/specification                                                           | Three-level progressive disclosure; small main skill; focused references; scripts/assets; validation.                                                                                                                                                                                                                                                                                              |
| OpenAI `skill-creator` — https://github.com/openai/skills/blob/main/skills/.system/skill-creator/SKILL.md                        | Concision; match degree of freedom to task fragility; description as primary trigger; scripts for deterministic repetition; explicit validation and iteration.                                                                                                                                                                                                                                     |
| OpenAI ChatGPT/Codex skill docs — https://developers.openai.com/codex/skills                                                     | Progressive disclosure; explicit and implicit invocation; concise/front-loaded trigger descriptions; optional references/scripts; `allow_implicit_invocation`; and a bounded discovery list (at most 2% of context, or 8,000 characters when context is unknown) that may shorten or omit skill descriptions at large library sizes.                                                               |
| OpenAI skill eval guidance — https://developers.openai.com/blog/eval-skills                                                      | Small realistic trigger suites, explicit/implicit/contextual/negative controls, regression retention, and description-level routing iteration.                                                                                                                                                                                                                                                     |
| OpenAI skills catalog — https://github.com/openai/skills                                                                         | Portable packages, curated/system separation, per-skill resources.                                                                                                                                                                                                                                                                                                                                 |
| Cursor skills — https://prod.cursor.com/docs/skills                                                                              | Agent Skills packages plus `paths`-scoped surfacing, recursive/nested skill discovery, explicit-only `disable-model-invocation`, and Custom Mode pinning; a strong precedent for keeping file-specific guidance out of unrelated context.                                                                                                                                                          |
| Matt Pocock engineering skills — https://github.com/mattpocock/skills                                                            | Small, adaptable, composable engineering skills; explicit user-invoked vs model-invoked split; user-invoked skills may compose automatic skills but must not become hidden automatic dependencies. Community evidence only.                                                                                                                                                                        |
| Matt Pocock invocation contract — https://github.com/mattpocock/skills/blob/main/.agents/invocation.md                           | Maps explicit invocation to Claude `disable-model-invocation` and Codex implicit-invocation policy; treats invocation direction as a graph invariant rather than prose convention.                                                                                                                                                                                                                 |
| Claude Code skills — https://code.claude.com/docs/en/slash-commands                                                              | Agent Skills packages with automatic/direct invocation, `disable-model-invocation`, model-only `user-invocable: false`, `context: fork` subagent execution, supporting files, dynamic context injection, and per-turn tool grants/restrictions. Full invoked skill content persists across later turns, reinforcing core-body concision.                                                           |
| Anthropic custom skill guidance — https://support.claude.com/en/articles/12512198-how-to-create-custom-skills                    | Focused repeatable workflows; clear descriptions; examples; incremental testing; composability.                                                                                                                                                                                                                                                                                                    |
| Anthropic Agent Skills engineering — https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills | Procedural knowledge packaged as composable folders and loaded dynamically.                                                                                                                                                                                                                                                                                                                        |
| Anthropic agent eval guidance — https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents                           | Task suites, realistic agent trajectories, layered scoring, regression-driven development.                                                                                                                                                                                                                                                                                                         |
| Anthropic Claude Code power-user guidance — https://support.claude.com/en/articles/14554000-claude-code-power-user-tips          | Verification is the highest-leverage workflow pattern; repeated workflows belong in skills; subagents fit reusable review flows.                                                                                                                                                                                                                                                                   |
| Anthropic official skills — https://github.com/anthropics/skills                                                                 | Production document skills demonstrate deep multi-file resources; frontend-design demonstrates concise, opinionated design direction.                                                                                                                                                                                                                                                              |
| Vercel agent skills — https://github.com/vercel-labs/agent-skills                                                                | Rule-level guidance prioritized by impact; incorrect/correct examples; generated consolidated reference; validation and eval-case extraction.                                                                                                                                                                                                                                                      |
| Supabase agent skills — https://github.com/supabase/agent-skills                                                                 | Official docs/product behavior as source of truth; specialized Postgres guidance; portable skill packaging.                                                                                                                                                                                                                                                                                        |
| Supabase Evals — https://github.com/supabase/evals                                                                               | Same-task experiment suites, no-skill baselines, real environments, deterministic scorers plus semantic judging, regression suites.                                                                                                                                                                                                                                                                |
| Expo skills — https://github.com/expo/skills                                                                                     | Official docs/CLI remain authoritative; highly specific skills; version/platform boundaries; dedicated end-to-end skill eval harness with device screenshots.                                                                                                                                                                                                                                      |
| GitHub awesome-copilot skills catalog — https://github.com/github/awesome-copilot/blob/main/docs/README.skills.md                | Large-scale quality scanning; specialized security/agent skills; reference packs; community validator heuristics such as concrete commands/examples and sequenced workflows.                                                                                                                                                                                                                       |
| Wshobson agent/skill ecosystem — https://github.com/wshobson/agents/blob/main/docs/agent-skills.md                               | Fine-grained backend/domain skills, separation of agents/skills/commands, workflow orchestration, single-purpose plugin boundaries.                                                                                                                                                                                                                                                                |
| SecondSky Claude skills — https://github.com/secondsky/claude-skills                                                             | Deep design review and technology-specific packages with references/templates/scripts.                                                                                                                                                                                                                                                                                                             |
| Remotion agent skills — https://github.com/remotion-dev/remotion/blob/main/packages/skills/README.md                             | Router skill plus narrow workflow skills; runtime-specific instructions.                                                                                                                                                                                                                                                                                                                           |
| Superpowers — https://github.com/obra/superpowers                                                                                | Workflow discipline around TDD, debugging, planning, review, and progressive supporting docs.                                                                                                                                                                                                                                                                                                      |
| Less Context, Better Agents — https://arxiv.org/abs/2606.10209                                                                   | Selective recent context plus summarization can outperform full-history context on long tool trajectories while substantially reducing tokens.                                                                                                                                                                                                                                                     |
| Prompt Design at Scale — https://arxiv.org/abs/2607.19257                                                                        | Instruction adherence degrades as simultaneous instruction count rises; formatting alone is not a universal remedy.                                                                                                                                                                                                                                                                                |
| IFScale — https://arxiv.org/abs/2507.11538                                                                                       | Frontier models still lose instruction-following accuracy as simultaneous constraint count grows, with measurable position/order effects.                                                                                                                                                                                                                                                          |
| ToolScope — https://arxiv.org/abs/2510.20036                                                                                     | Context-aware tool filtering/merging improves tool selection, reinforcing selective capability exposure over flat global catalogs.                                                                                                                                                                                                                                                                 |
| SkillsBench v4: https://arxiv.org/abs/2602.12670v4                                                                               | Revision dated 2026-06-14, abstract rechecked 2026-09-06: 87 tasks, 8 domains and 18 model/harness configurations; average pass rate increases from 33.9% to 50.5% (+16.6 percentage points). Focused bundles of at most three modules outperform larger bundles in that benchmark. These are external results, not Kory results; earlier version statistics must not be blended into this record. |
| SkillRouter — https://arxiv.org/abs/2603.22455                                                                                   | At ecosystem scale, skill-body evidence materially improves retrieval over metadata-only routing. Kory should not inject all bodies into context; it should evaluate a bounded off-context retrieve/rerank stage if the 179-skill metadata/hierarchy router stops scaling.                                                                                                                         |
| R3-Skill / “Skill Is Not Document” — https://arxiv.org/abs/2606.03565                                                            | Joint skill compatibility matters in addition to individual relevance, and rejected skill combinations are useful supervision. This supports Kory’s `broader`/`requires`/`facets`/`conflicts` graph plus preservation of forbidden/near-neighbor routing failures as first-class regression data.                                                                                                  |
| AgentSkillOS — https://arxiv.org/abs/2603.02176                                                                                  | Capability-tree organization plus DAG-based multi-skill orchestration outperformed flat invocation at 200–200K-skill scales. This is direct evidence for a visible hierarchy/polyhierarchy and dependency-aware composition rather than a flat 179-item catalog.                                                                                                                                   |
| Agent Skill Evaluation and Evolution — https://arxiv.org/abs/2606.11435                                                          | The 2026 survey frames skill improvement as evaluation-driven evolution across execution feedback, trajectory distillation, compression, and reinforcement learning, reinforcing Kory’s candidate/qualification/promotion lifecycle instead of bulk authoring as a completion signal.                                                                                                              |

### 2026-09-05 competitive synthesis

The web refresh changes the implementation standard in several concrete ways:

- **Codex/OpenAI strength to keep:** tiny discovery surface, front-loaded discriminating descriptions, progressive disclosure, instruction-first packages, and an explicit implicit-invocation policy. Kory must continue measuring discovery/context overhead instead of assuming 179 visible descriptions are free.
- **Claude Code strength to keep:** invocation is a first-class execution policy, not prose. Forked contexts are useful for isolated task skills, but Claude-specific frontmatter such as `context`, `agent`, `background`, or tool grants belongs in host adapters/sidecars rather than the portable Kory `SKILL.md` core.
- **Cursor strength to keep:** file applicability is a routing signal. Kory’s `pathScopes` should remain additive evidence, with nested/domain organization reflected in the hierarchy rather than forcing every path-specific skill into every task.
- **Matt Pocock strength to keep:** user-invoked versus model-invoked direction is a graph invariant. A user-invoked skill may compose model-invoked skills; automatic/model-invoked skills must never smuggle in a user-only dependency.
- **Research constraint:** more instructions are not automatically better. The versioned SkillsBench focused-bundle result supports measuring benefit rather than equating detail with volume. “Super detailed” should mean useful decision criteria and falsifiable procedures, not a giant always-loaded rulebook. Do not extrapolate an external aggregate into a claim that every Kory skill improves every task.
- **Research opportunity:** if routing quality later degrades as the library grows, evaluate body-aware retrieve/rerank outside the prompt and compatibility-aware composition. Do not revive the rejected global semantic fallback unless held-out evidence shows it improves precision, recall, and context cost together.

## Core diagnosis

### 1. Breadth outran qualification

The 100 V4 specialists are useful coverage placeholders, but they were generated from one common profile pattern. They have not yet received individual source research, worked examples, runtime-specific checks, or deep routing adversaries.

**Required correction:** every skill gets an individual research → rewrite → eval → blind-review lifecycle. No batch template is allowed to qualify an entire domain.

### 2. Routing tests are too easy

The dominant negative example is an unrelated sentence. That proves only that an obviously irrelevant request does not match. It does not test the real problem: confusion between neighboring skills.

Examples of real routing boundaries that must be tested:

- `react-engineering` vs `web-interface` vs `visual-interface-design` vs `nextjs-engineering`;
- `architecture-planning` vs `backend-engineering` vs `distributed-backend`;
- `application-security` vs `authorization-security` vs `web-security` vs `security-verification`;
- `data-analysis` vs `statistical-inference` vs `product-analytics`;
- `llm-application-engineering` vs `agentic-systems` vs `prompt-context-engineering` vs `rag-retrieval-systems`;
- `testing-engineering` vs `verification` vs specialist verification skills.

**Required correction:** replace generic routing cases with near-neighbor, ambiguous, adversarial, compound, negated, and medium-specific cases.

### 3. Most bundled skills lack first-class supporting resources

Best-in-class skill ecosystems use focused `references/`, reusable scripts, templates/assets, examples, and generated rule catalogs. Kory currently concentrates the knowledge in TypeScript-defined strings and shared playbook builders.

**Required correction:** make the authoring source a first-class skill package, then compile it into Kory's runtime representation. Keep Kory-only metadata in a sidecar rather than forcing portability concerns into the portable body.

Target source shape:

```text
skills-v5/<skill-name>/
├── SKILL.md                 # portable trigger + essential workflow
├── kory.json                # Kory graph/eval/context metadata
├── references/
│   ├── sources.md           # authoritative source map + version scope
│   ├── patterns.md          # domain rules/patterns
│   ├── examples.md          # worked good/bad examples when useful
│   └── troubleshooting.md   # only when the domain needs it
├── scripts/                 # only deterministic/repeated helpers
├── assets/                  # templates/output resources when needed
└── evals/
    ├── routing.jsonl
    ├── tasks/
    └── regressions/
```

Do not require every directory for every skill. Sparse, purposeful packages are better than ceremonial files.

### 4. Source provenance and freshness are missing as first-class quality signals

A high-quality framework/provider skill must know what version and source it was written against. Otherwise a long skill simply becomes stale with confidence.

**Required correction:** every specialist skill gets a source manifest containing:

- authoritative URLs;
- source type (`official-docs`, `spec`, `reference-implementation`, `community-pattern`);
- project/framework version scope;
- source commit/release when available;
- last verified date;
- stale-after policy;
- license/provenance for adapted material;
- notes on contradictory or deprecated guidance.

Suggested freshness targets:

- fast-moving framework/provider/API skills: review every 30–60 days or on detected release;
- security standards and agent protocols: review every 60–90 days or on standard revision;
- stable language/foundation practice: review every 180–365 days plus regression-triggered review;
- project-specific vendor behavior: version-gated to the installed/runtime version whenever possible.

### 5. Rules are not prioritized enough by impact

Vercel's React skill is strong because it does not present 70 rules as equal. It ranks categories by impact and uses bad/good examples.

**Required correction:** technical rulebook skills should carry impact/severity and applicability. A skill should tell the agent what matters first.

Example rule schema:

```yaml
id: async-eliminate-waterfall
impact: critical
applies_when: independent work is awaited sequentially
evidence: timeline or dependency graph
```

### 6. Workflow skills need observable sequences and stop conditions

Some skills are knowledge lenses; others are real procedures. Treating them identically reduces reliability.

Add a Kory `skillKind` classification:

- `router` — chooses a domain/medium;
- `workflow` — ordered procedure with state transitions and stop/recovery rules;
- `rulebook` — prioritized domain rules/patterns;
- `facet` — cross-cutting lens such as security/accessibility/performance/privacy;
- `provider` — version-aware vendor/tool usage;
- `verification` — claim-to-evidence checks;
- `artifact` — produces a defined reusable artifact;
- `orchestrator` — composes multiple skills/agents for a larger workflow.

Sequential workflow skills should contain numbered steps. Rulebooks do not need fake numbered steps.

### 7. Evidence contracts are still too generic

The current average is only about 2.2 declared evidence items per skill, and many specialist entries use generic evidence wording.

**Required correction:** evidence must be falsifiable and domain-specific.

Examples:

- React: interaction reproduction, render/profile evidence, network waterfall evidence, accessibility behavior.
- Postgres: exact query, parameters, plan, data distribution, lock behavior, before/after measurements.
- Security: source→sink/control trace, exploitability prerequisites, positive and negative enforcement test, residual risk.
- Design: representative states, target viewport/platform captures, typography/token audit, task completion, accessibility and motion checks.
- Agent systems: tool trace, denied path, retry/idempotency behavior, final external state, cost/latency, independent completion check.

### 8. The graph underuses facets, dependencies, and pairwise confusion data

Zero explicit conflicts is not automatically wrong, but it shows the graph is not yet expressing many real selection relationships. Cross-cutting facets are also sparse.

**Required correction:** build graph relations from observed co-activation/confusion evidence, not from taxonomy aesthetics.

Add:

- pairwise confusion matrix;
- co-activation heatmap;
- dependency usefulness rate;
- context-cost attribution per selected skill;
- unnecessary-selection rate;
- missing-facet rate on relevant tasks.

Never add a conflict merely because two skills overlap. Conflicts are for genuinely incompatible operating contracts. Most adjacent skills should instead use discriminating triggers, precedence, target-medium boundaries, or compositional facets.

### 9. Real environment evaluation is not broad enough yet

Trigger tests and persisted evaluation records are a start. Elite skills need outcome tests.

**Required correction:** create a V5 eval harness modeled on the strongest patterns from Supabase and Expo:

- eval scenario = prompt + starting state + scorer + environment;
- experiment = model/provider/harness/skill configuration;
- suite = domain benchmark/regression set;
- deterministic checks score state wherever possible;
- blind semantic judge scores only what deterministic checks cannot;
- runtime screenshots for UI/native/visual tasks;
- real CLI/tool execution for operational skills;
- skill/no-skill pairs for uplift;
- competitor experiments under comparable resources;
- regression cases preserved permanently.

### 10. We do not yet measure whether a skill is worth its context cost

A skill that adds 2,000 tokens and no measurable uplift is a regression even if its prose is excellent.

Add per-skill efficiency metrics:

- quality uplift per 1k input tokens;
- verification uplift;
- task success uplift;
- latency delta;
- cost delta;
- context bytes loaded;
- tool calls added/removed;
- unnecessary activation cost.

## V5 per-skill quality contract

No skill is considered V5-qualified until all applicable gates pass.

### A. Discovery and routing

- Description names the capability and its real trigger conditions.
- All important trigger information is available in metadata, not hidden only in the body.
- At least 5 realistic positive prompts spanning different phrasings.
- At least 5 realistic negative prompts, primarily near-neighbor rather than unrelated tasks.
- At least 3 ambiguous/compound prompts.
- At least 3 adversarial/negated prompts where accidental activation is plausible.
- Pairwise confusion tests against every adjacent skill.
- Measured routing precision and recall target >= 0.95 on the held-out routing suite unless domain ambiguity makes that threshold inappropriate; exceptions must be documented.

### B. Scope and specialization

- One repeatable professional responsibility or workflow.
- Explicit inputs, outputs, decision points, and boundaries.
- No generic model advice that would apply to almost every task.
- No framework/vendor assumptions unless the trigger establishes them.
- Version/platform/runtime detection where the answer changes materially.

### C. Authoritative knowledge

- Primary official sources identified.
- Community sources used only for proven operational patterns, edge cases, or examples.
- Source conflicts called out instead of merged silently.
- Deprecated guidance and version cutoffs explicit.
- Facts likely to drift are in references, not timeless core prose.

### D. Progressive disclosure

- `SKILL.md` carries only essential operating contract and routing-to-resource instructions.
- Detailed variants live in focused references.
- References are one hop from the entrypoint where practical.
- Large rule catalogs are generated/organized, not pasted as an unstructured wall.
- Context cost is measured on representative tasks.

### E. Concrete examples

- Technical rulebooks include correct/incorrect examples for high-impact rules when examples materially reduce ambiguity.
- Workflow skills include representative input/output artifacts.
- Security skills include safe minimal reproductions or trace patterns without turning the skill into exploit theater.
- Design skills include concrete composition/state/token examples and anti-patterns, not only adjectives.

### F. Deterministic helpers

- Repeated or fragile transformations move to scripts.
- Scripts validate inputs, fail clearly, and have focused tests.
- Scripts do not broaden authority.
- No script is included merely to make the package look sophisticated.

### G. Verification and recovery

- Every material completion claim has an observable check.
- At least 2 realistic full-task evals before initial promotion; high-risk skills need more.
- Failure, partial, denied, interrupted, stale, and recovery cases chosen according to risk.
- No success claim based solely on compilation, mock output, generated text, or a single screenshot.

### H. Skill uplift

- Candidate is compared to the same harness/model with the skill withheld.
- At least one outcome dimension shows meaningful improvement and none materially regress.
- For high-volume skills, require enough repeated runs to distinguish uplift from stochastic noise.
- Blind reviewer cannot see whether output came from candidate or no-skill baseline.

### I. Portability and safety

- Portable `SKILL.md` validates against the Agent Skills open spec where possible.
- Kory-specific graph/authority metadata remains Kory-owned and cannot grant tools by prompt.
- Imported resources retain source/license provenance.
- External skill scripts are never trusted merely because the skill is popular.

## ChatGPT Web steward operating model

Every logical skill keeps one persistent expert owner, but workers remain ephemeral.

Non-negotiable policy for this project:

- Skill-authoring/deep-review subagents must be actual `chatgpt-web/...` agents.
- Display names begin `ChatGPT web — <skill-name>`.
- Never substitute GPT-5.6 Sol, Codex, or another provider when a ChatGPT Web steward was requested.
- If ChatGPT Web delegation is unavailable, the main agent performs the work itself.
- The author does not grade its own candidate.
- Use a separate ChatGPT Web blind evaluator for promotion evidence.
- Respect the live browser concurrency ceiling; keep one slot available for evaluation/coordination rather than saturating every slot with authors.

Recommended per-skill loop:

1. `ChatGPT web — <skill>` receives the current skill, source map, adjacent skills, raw eval failures, and representative repo/runtime evidence.
2. Steward researches primary sources first, then selected community references.
3. Steward writes a candidate package and source manifest.
4. Deterministic validator checks structure, links, scripts, routing fixtures, context budget, and graph integrity.
5. Candidate runs against held-out full tasks and routing cases.
6. Separate ChatGPT Web evaluator receives randomized candidate/baseline artifacts without the intended answer or variant label.
7. Promotion gate requires measured uplift and no unresolved regression.
8. Failure becomes a permanent regression case and steward backlog item.

## Domain masterplan

### Wave 0 — Skill system itself

Current skills:

- `task-routing`
- `skill-authoring-evaluation`
- `repository-environment-discovery`
- `plan-mode`

Work:

- make `skill-authoring-evaluation` the canonical V5 authoring contract;
- add source freshness, license/provenance, portability, and context-efficiency checks;
- create a Kory skill-package compiler rather than hand-maintaining large TypeScript arrays;
- create migration tooling that preserves existing local skill hashes/custom edits;
- make the health dashboard show V5 qualification dimensions;
- add pairwise routing confusion and source freshness to health.

### Wave 1 — Design, human experience, and frontend craft

Current skills:

- `human-experience`
- `user-research`
- `interaction-design`
- `information-architecture`
- `visual-interface-design`
- `content-error-design`
- `accessibility-practice`
- `usability-evaluation`
- `developer-experience`
- `frontend-engineering`
- `web-interface`
- `native-interface`
- `terminal-interface`
- `novel-ui-toolkit`
- `game-spatial-interface`
- `embedded-interface`
- `react-engineering`
- `svelte-engineering`
- `vue-engineering`
- `angular-engineering`
- `nextjs-engineering`
- `ios-swiftui`
- `android-compose`
- `react-native-expo`
- `desktop-electron-tauri`
- `shell-cli-engineering`
- `visual-verification`
- `accessibility-verification`
- `interface-usability-testing`
- `image-generation-practice`
- `video-production`
- `audio-production`
- `three-d-graphics`

Known weaknesses to correct:

- Visual design guidance is still too general compared with Anthropic/SecondSky/Expo design-system skills.
- No first-class design-system skill focused on tokens, component states, visual consistency, drift, and reuse.
- No dedicated design critique/review workflow with severity, responsive/state matrix, typography, composition, content, accessibility, and implementation fidelity.
- Framework engineering skills need version-aware official-doc source packs and real app evals.
- `visual-interface-design` should learn from the strongest anti-generic design patterns without turning taste into rigid aesthetics.
- Native design needs platform-specific references rather than browser-derived defaults.

Candidate gaps to investigate, not auto-create:

- `design-system-engineering`
- `frontend-design-direction`
- `design-review`
- `typography-layout`
- `motion-interaction-design`
- `responsive-interface-design`
- `design-to-code-fidelity`
- `brand-visual-systems`
- `web-components-engineering`
- `css-architecture`
- `tailwind-engineering`
- `astro-engineering`
- `solidjs-engineering`
- `flutter-engineering`

### Wave 2 — Backend, architecture, APIs, and distributed systems

Current skills:

- `backend-engineering`
- `in-process-backend`
- `local-service-backend`
- `network-service-backend`
- `distributed-backend`
- `compiler-runtime-backend`
- `architecture-planning`
- `feature-implementation`
- `integration-implementation`
- `api-contract-design`
- `http-rest-engineering`
- `graphql-engineering`
- `grpc-protobuf`
- `event-driven-architecture`
- `realtime-systems`
- `serverless-platforms`
- `webhook-integration`
- `payment-integration`
- `email-delivery`
- `nodejs-runtime`
- `bun-deno-runtime`

Known weaknesses to correct:

- Broad architecture skills need worked tradeoff cases and explicit anti-pattern boundaries.
- Framework/service patterns are underrepresented compared with strong community backend libraries.
- Durable workflow/orchestration, queues, backpressure, transaction boundaries, and data consistency deserve deeper rule packs and runtime evals.
- API skills need contract compatibility fixtures, client/server version tests, idempotency/retry matrices, and generated examples.

Candidate gaps to investigate:

- `fastapi-engineering`
- `django-engineering`
- `rails-engineering`
- `laravel-engineering`
- `spring-boot-engineering`
- `aspnet-core-engineering`
- `nestjs-engineering`
- `express-fastify-engineering`
- `temporal-workflows`
- `queue-worker-systems`
- `kafka-engineering`
- `rabbitmq-engineering`
- `cqrs-event-sourcing`
- `saga-compensation`
- `service-resilience-patterns`

### Wave 3 — Languages and runtime engineering

Current skills:

- `typescript-javascript-engineering`
- `python-engineering`
- `rust-engineering`
- `go-engineering`
- `java-jvm-engineering`
- `kotlin-engineering`
- `swift-engineering`
- `c-cpp-systems-engineering`
- `csharp-dotnet-engineering`
- `ruby-engineering`
- `php-engineering`
- `shell-cli-engineering`
- `language-runtime-security`
- `compiler-runtime-backend`

Known weaknesses to correct:

- Current language skills are compact expert summaries, not source-backed language/runtime playbooks.
- Each needs version/toolchain discovery, idiomatic project conventions, package/build behavior, concurrency/runtime traps, compatibility, and high-signal examples.
- Generic language skills must not fight project-specific conventions.

Candidate gaps to investigate:

- `zig-engineering`
- `scala-engineering`
- `elixir-beam-engineering`
- `clojure-engineering`
- `haskell-engineering`
- `ocaml-engineering`
- `dart-engineering`
- `lua-engineering`
- `r-engineering`
- `julia-engineering`

Create only when task demand and benchmark gaps justify the context/maintenance cost.

### Wave 4 — Data, databases, analytics, and search

Current skills:

- `data-analysis`
- `exploratory-data-analysis`
- `statistical-inference`
- `experimental-analysis`
- `operational-data-analysis`
- `data-visualization`
- `product-analytics`
- `analytics-engineering`
- `data-pipeline-engineering`
- `relational-data-modeling`
- `postgres-engineering`
- `mysql-engineering`
- `sqlite-engineering`
- `redis-engineering`
- `mongodb-engineering`
- `database-performance`
- `search-indexing`
- `vector-search-systems`
- `stream-processing`
- `experimentation-ab-testing`

Known weaknesses to correct:

- Database skills need provider/version source maps and query/schema examples tied to real plans/data distributions.
- Data-analysis skills need explicit unit/denominator/provenance checks and reproducible artifact contracts.
- Warehouse/OLAP/data-quality coverage is thin.
- Vector/search skills need labeled retrieval benchmarks rather than intuition-only tuning.

Candidate gaps to investigate:

- `sql-server-engineering`
- `oracle-engineering`
- `dynamodb-engineering`
- `cockroachdb-engineering`
- `cassandra-engineering`
- `clickhouse-engineering`
- `duckdb-engineering`
- `snowflake-engineering`
- `bigquery-engineering`
- `data-quality-engineering`
- `dbt-engineering`
- `lakehouse-engineering`

### Wave 5 — Testing, debugging, verification, performance, and reliability

Current skills:

- `testing-engineering`
- `deterministic-contract-testing`
- `property-fuzz-differential-testing`
- `integration-fault-testing`
- `interface-usability-testing`
- `performance-testing`
- `simulation-device-testing`
- `debugging`
- `deterministic-debugging`
- `concurrency-debugging`
- `distributed-debugging`
- `performance-debugging`
- `hardware-runtime-debugging`
- `verification`
- `functional-verification`
- `visual-verification`
- `accessibility-verification`
- `reliability-verification`
- `security-verification`
- `performance-verification`
- `observability-sre`
- `incident-response`

Known weaknesses to correct:

- Testing taxonomy is good but examples and framework-specific execution are shallow.
- Verification skills need concrete claim→oracle→artifact patterns.
- Debugging skills need hypothesis/evidence templates, trace artifact formats, and real failure cases.
- Reliability needs chaos/fault, restart/replay, soak, failover, data-integrity, and runbook tests.

Candidate gaps to investigate:

- `test-driven-development`
- `mutation-testing`
- `browser-e2e-testing`
- `flaky-test-diagnosis`
- `load-soak-testing`
- `chaos-engineering`
- `contract-compatibility-testing`
- `release-validation`
- `disaster-recovery-testing`

### Wave 6 — Security, privacy, identity, and supply chain

Current skills:

- `security-review`
- `application-security`
- `authorization-security`
- `infrastructure-security`
- `supply-chain-security`
- `privacy-engineering`
- `embedded-device-security`
- `language-runtime-security`
- `security-verification`
- `applied-cryptography`
- `secrets-key-management`
- `web-security`
- `cloud-security`
- `secure-authentication`
- `oauth-oidc`
- `threat-modeling-practice`
- `ai-safety-evaluation`

Known weaknesses to correct:

- Security needs language/framework-specific source→sink patterns and concrete enforcement tests.
- Agent/MCP-specific attack surfaces need their own current standards/reference pack.
- Findings need evidence, exploit prerequisites, severity rationale, false-positive self-check, and remediation verification.
- Supply-chain skills need provenance/signature/lockfile/plugin integrity workflows and reproducible scripts.

Candidate gaps to investigate:

- `agentic-security`
- `mcp-security-review`
- `container-kubernetes-security`
- `mobile-application-security`
- `api-security-testing`
- `secure-code-review`
- `sast-dast-triage`
- `dependency-vulnerability-management`
- `security-incident-response`

### Wave 7 — Cloud, infrastructure, delivery, and operations

Current skills:

- `aws-cloud`
- `gcp-cloud`
- `azure-cloud`
- `kubernetes-operations`
- `container-engineering`
- `terraform-iac`
- `cicd-engineering`
- `release-planning`
- `migration-planning`
- `observability-sre`
- `incident-response`
- `linux-systems`
- `networking-systems`
- `edge-cdn`
- `serverless-platforms`
- `finops-cloud-cost`

Known weaknesses to correct:

- Cloud skills are too high-level for provider-specific operational excellence.
- Kubernetes needs Helm/GitOps/policy/storage/networking/autoscaling subdomains or references.
- IaC skills need plan/state/import/drift test fixtures.
- CI/CD needs provider-specific workflow semantics where repository evidence selects the platform.

Candidate gaps to investigate:

- `helm-engineering`
- `gitops-argocd-flux`
- `pulumi-iac`
- `ansible-automation`
- `nix-engineering`
- `github-actions-engineering`
- `gitlab-ci-engineering`
- `capacity-planning`
- `backup-restore-operations`
- `database-operations`

### Wave 8 — AI, ML, agents, retrieval, and evaluation

Current skills:

- `llm-application-engineering`
- `agentic-systems`
- `prompt-context-engineering`
- `rag-retrieval-systems`
- `llm-evaluation`
- `ml-evaluation`
- `fine-tuning-training`
- `embedding-systems`
- `computer-vision`
- `speech-audio-ai`
- `recommendation-ranking`
- `mlops`
- `vector-search-systems`
- `ai-safety-evaluation`

Known weaknesses to correct:

- Provider/protocol-specific behavior changes too quickly for generic prose alone.
- Agent skills need explicit tool contracts, authorization, idempotency, delegation, memory, budget, and completion evidence patterns.
- RAG needs corpus lifecycle, access control, retrieval metrics, citation grounding, abstention, and freshness cases.
- Evals need held-out suites, judge calibration, infrastructure normalization, and contamination controls.

Candidate gaps to investigate:

- `openai-api-engineering`
- `anthropic-api-engineering`
- `openai-agents-sdk`
- `mcp-development`
- `tool-contract-design`
- `model-routing`
- `agent-memory-systems`
- `agent-orchestration`
- `llm-observability`
- `prompt-injection-defense`
- `synthetic-data-evaluation`

Provider-specific skills must be docs-backed and refreshed aggressively.

### Wave 9 — Research, communication, product, and business

Current skills:

- `research`
- `factual-research`
- `literature-research`
- `market-competitive-research`
- `repository-research`
- `documents-communication`
- `technical-communication`
- `executive-communication`
- `instructional-communication`
- `reference-communication`
- `product-management`
- `product-analytics`
- `market-strategy`
- `pricing-monetization`
- `startup-operations`
- `sales-engineering`
- `customer-success`
- `growth-engineering`
- `marketing-strategy`
- `procurement-vendor-evaluation`
- `project-program-management`
- `business-case-analysis`
- `contract-analysis`

Known weaknesses to correct:

- Research needs source-quality rubrics, freshness rules, contradiction handling, citation integrity, and decision-oriented synthesis examples.
- Product/business skills need explicit artifact templates and evidence boundaries rather than polished generic consulting prose.
- Contract analysis must stay clearly separate from legal advice and preserve clause/source traceability.
- Marketing/growth needs measurement and experimentation guardrails rather than channel folklore.

Candidate gaps to investigate:

- `standards-research`
- `academic-paper-analysis`
- `evidence-synthesis`
- `decision-memo`
- `product-discovery`
- `roadmap-prioritization`
- `go-to-market-planning`
- `seo-geo-content`
- `customer-interview-analysis`
- `board-investor-communication`

### Wave 10 — Creative, hardware, simulation, and finance

Current skills:

- `image-generation-practice`
- `video-production`
- `audio-production`
- `three-d-graphics`
- `game-development`
- `embedded-firmware`
- `robotics-control`
- `gpu-compute`
- `hardware-runtime-debugging`
- `simulation-device-testing`
- `financial-modeling`
- `business-case-analysis`

Known weaknesses to correct:

- Creative skills need artifact-specific QA and target-medium delivery checks.
- Hardware skills need exact platform/board/device identity and explicit simulated-vs-physical proof boundaries.
- Finance needs auditable formulas, source traceability, scenario/sensitivity checks, and strict unit/time consistency.

Candidate gaps to investigate:

- `electronics-board-bringup`
- `device-driver-engineering`
- `fpga-hdl-engineering`
- `realtime-systems-engineering`
- `graphics-shader-engineering`
- `spreadsheet-modeling`
- `presentation-design`
- `pdf-document-production`

## Complete current-library audit inventory

The next agent must account for every unique current skill. Shared polyhierarchy entries appear under their first visited parent below; no skill is exempt from individual review.

```text
backend-engineering
  bun-deno-runtime
  compiler-runtime-backend
    embedded-firmware
  distributed-backend
    event-driven-architecture
    stream-processing
  in-process-backend
  linux-systems
  local-service-backend
  mongodb-engineering
  network-service-backend
    edge-cdn
    networking-systems
    realtime-systems
    serverless-platforms
  nodejs-runtime
  redis-engineering
  relational-data-modeling
    mysql-engineering
    postgres-engineering
    sqlite-engineering
  search-indexing
  vector-search-systems

data-analysis
  analytics-engineering
  data-pipeline-engineering
  data-visualization
  experimental-analysis
  exploratory-data-analysis
  financial-modeling
  ml-evaluation
    computer-vision
    embedding-systems
    fine-tuning-training
    llm-evaluation
    recommendation-ranking
    speech-audio-ai
  operational-data-analysis
    finops-cloud-cost
  product-analytics
    growth-engineering
  statistical-inference
    experimentation-ab-testing

debugging
  concurrency-debugging
  deterministic-debugging
  distributed-debugging
  hardware-runtime-debugging
  performance-debugging
    database-performance
    gpu-compute

documents-communication
  executive-communication
  instructional-communication
  reference-communication
    contract-analysis
  technical-communication
    sales-engineering

frontend-engineering
  angular-engineering
  embedded-interface
  game-spatial-interface
    three-d-graphics
  native-interface
    android-compose
    desktop-electron-tauri
    ios-swiftui
    react-native-expo
  novel-ui-toolkit
  react-engineering
  svelte-engineering
  terminal-interface
    shell-cli-engineering
  vue-engineering
  web-interface
    nextjs-engineering

human-experience
  accessibility-practice
  audio-production
  content-error-design
  customer-success
  developer-experience
    api-contract-design
      graphql-engineering
      grpc-protobuf
      http-rest-engineering
  information-architecture
  interaction-design
  usability-evaluation
    interface-usability-testing
  user-research
  video-production
  visual-interface-design
    image-generation-practice
    visual-verification

implementation
  c-cpp-systems-engineering
  container-engineering
  csharp-dotnet-engineering
  feature-implementation
  game-development
  go-engineering
  integration-implementation
    email-delivery
    payment-integration
    webhook-integration
  java-jvm-engineering
  kotlin-engineering
  llm-application-engineering
    agentic-systems
    prompt-context-engineering
    rag-retrieval-systems
  php-engineering
  python-engineering
  refactor-implementation
  robotics-control
  ruby-engineering
  rust-engineering
  swift-engineering
  typescript-javascript-engineering

plan-mode

planning
  architecture-planning
    aws-cloud
    azure-cloud
    gcp-cloud
    kubernetes-operations
    terraform-iac
  business-case-analysis
  migration-planning
  product-management
  project-program-management
  release-planning
    cicd-engineering
    mlops
  startup-operations

repository-environment-discovery
  repository-research

research
  factual-research
  literature-research
  market-competitive-research
    market-strategy
    marketing-strategy
    pricing-monetization
    procurement-vendor-evaluation

security-review
  ai-safety-evaluation
  application-security
    authorization-security
      oauth-oidc
    secure-authentication
    web-security
  applied-cryptography
  embedded-device-security
  infrastructure-security
    cloud-security
    secrets-key-management
  language-runtime-security
  privacy-engineering
  security-verification
  supply-chain-security
  threat-modeling-practice

skill-authoring-evaluation
task-routing

testing-engineering
  deterministic-contract-testing
  integration-fault-testing
  performance-testing
    performance-verification
  property-fuzz-differential-testing
  simulation-device-testing

verification
  functional-verification
  reliability-verification
    incident-response
    observability-sre
```

Polyhierarchy/shared facets omitted from duplicate positions in the inventory above but still part of the graph include `novel-ui-toolkit`, `data-visualization`, `embedded-interface`, `game-spatial-interface`, `native-interface`, `terminal-interface`, `web-interface`, `repository-research`, `interface-usability-testing`, `ml-evaluation`, `performance-debugging`, `hardware-runtime-debugging`, `accessibility-verification`, `performance-verification`, `security-verification`, and `visual-verification`.

## Competitive evaluation program

The goal is to measure capability, not produce marketing screenshots.

### Experiments

At minimum:

1. Kory current model, no skills.
2. Kory current model, V4 current library.
3. Kory current model, V5 candidate skills.
4. Current Codex default on the same local task/environment where automation is supported.
5. Codex with its relevant official/curated skill when available.
6. Current Claude Code default on the same task/environment where automation is supported.
7. Claude Code with its relevant official/community skill when licensing and setup permit.
8. Current Cursor default on the same task/environment where automation is supported.
9. Cursor with the relevant installed or portable skill when setup permits.
10. Matt Pocock/Agent-Skills community package on the same task when dependencies and licensing permit a comparable run.

Optional Copilot/OpenCode experiments may be added if they can be run comparably.

### Controls

- Same repository snapshot and starting state.
- Same user task text unless a harness requires a mechanical wrapper.
- Record model/provider/runtime versions.
- Record context limits and tool surfaces.
- Equal wall-clock or token budget classes when possible.
- Multiple runs for stochastic tasks.
- Randomize/blind output identity before semantic judging.
- Do not let a candidate skill see held-out expected answers.
- Separate infrastructure failures from model/skill failures.
- Record package installation/dependency failures separately from skill-quality failures.
- Record invocation mode (`model-invoked` versus `user-invoked`) and prohibit user-only skills from satisfying hidden dependency chains.
- Record optional path/file applicability and test it as an additional routing signal, never as a substitute for semantic task routing.
- Record skill installation/context footprint alongside task context cost.

### Scoring

Use a layered scorecard, never one LLM-judge number:

- deterministic task completion/state;
- tests/build/lint/typecheck where relevant;
- runtime behavior;
- security/authorization negative paths;
- visual/accessibility/device evidence for UI;
- correctness of citations/source use for research;
- blind semantic quality rubric;
- regression count;
- cost/latency/context overhead.

## V5 health dashboard additions

For each skill expose:

- steward;
- skill kind;
- source version and last verified date;
- source freshness status;
- routing precision/recall;
- top pairwise confusion partners;
- full-task pass rate;
- no-skill uplift;
- candidate-vs-active delta;
- blind review coverage;
- context cost;
- uplift per 1k tokens;
- usage count;
- unnecessary activation rate;
- open regressions;
- dependency/facet health;
- script/helper test status;
- portability validation;
- license/provenance status;
- next steward action.

## Implementation sequence / PR program

### PR V5.1 — Canonical package source and compiler

- Introduce `skills-v5/<skill>/` package source.
- Add `kory.json` sidecar schema.
- Compile packages into existing runtime structures without breaking user-local skill updates.
- Preserve V4 hashes/base-version semantics during migration.
- Add Agent Skills spec validation.
- Add source/provenance manifest validation.

### PR V5.2 — Evaluation harness V3

- Scenario/experiment/suite architecture.
- Skill/no-skill experiments.
- Deterministic scorers and blind semantic judge interface.
- Runtime artifacts and screenshots.
- Regression suite storage.
- Infrastructure-failure classification.

### PR V5.3 — Routing qualification

- Replace generic trigger fixtures.
- Generate pairwise adjacent-skill matrices.
- Add false-positive/false-negative and confusion metrics.
- Add compound/negation/medium cases.
- Gate promotion on held-out routing quality.

### PR V5.4 — Source freshness and import pipeline

- Source manifests.
- Link/version drift checks.
- License/provenance ledger.
- Safe community-skill import analyzer.
- Never activate imported scripts without review/test.

### PR V5.5 — Design/human-experience wave

- Individually research/rewrite/evaluate every Wave 1 skill.
- Build design-system and design-review candidates only if the gap suite proves need.
- Add visual/device/browser evidence harness.

### PR V5.6 — Backend/language/data wave

- Individually qualify Waves 2–4.
- Add provider/framework specialists only from measured gaps.
- Add rule catalogs and code fixtures.

### PR V5.7 — Testing/security/infrastructure wave

- Individually qualify Waves 5–7.
- Add stronger enforcement/evidence and failure-recovery suites.
- Add standards/version refresh rules.

### PR V5.8 — AI/product/research/creative wave

- Individually qualify Waves 8–10.
- Add provider-specific AI skills only with aggressive freshness policy.
- Add artifact and decision-quality scorers.

### PR V5.9 — Competitive benchmark and pruning

- Run controlled Kory/Codex/Claude/Cursor/community-Agent-Skills experiments.
- Remove or merge skills that do not add measurable value.
- Split skills whose scope causes confusion.
- Promote only evidence-backed candidates.

### PR V5.10 — Continuous skill improvement

- Real-session failure → regression case.
- Steward backlog from health metrics.
- Scheduled freshness checks.
- Periodic competitive benchmark.
- Automatic proposals remain draft-only until the configured learning policy and promotion gate allow activation.

## Tracking ledger

Create a durable machine-readable ledger before the first rewrite:

```json
{
  "skill": "postgres-engineering",
  "cohort": "specialist-v4",
  "v5Status": "researching",
  "steward": "ChatGPT web — postgres-engineering",
  "adjacentSkills": ["relational-data-modeling", "database-performance"],
  "sources": [],
  "routing": {
    "positive": 0,
    "negative": 0,
    "ambiguous": 0,
    "adversarial": 0
  },
  "fullTaskEvals": 0,
  "openRegressions": 0,
  "uplift": null,
  "freshness": "unmeasured",
  "nextAction": "source research"
}
```

Do not derive `v5Status=qualified` from word count, file count, trigger-test syntax, or steward completion alone.

## Definition of done

V5 is complete only when:

- All 179 current skills have an individual audit record.
- No specialist retains the current generic positive/negative routing fixtures.
- Every skill has realistic near-neighbor routing tests.
- Every specialist skill has authoritative source provenance and freshness metadata.
- Every workflow skill has explicit sequence, stop/recovery conditions, and output evidence.
- Every rulebook has prioritized applicability and concrete examples where useful.
- Every high-risk skill has independent blind evaluation.
- Every promoted skill shows non-negative no-skill delta and meaningful value on at least one outcome dimension.
- No open integrity/security regression exists for a promoted revision.
- Cross-skill selection precision/recall and context cost are visible.
- Invocation mode, dependency integrity, missing-dependency failures, and optional path applicability are visible and tested.
- Candidate gap skills are created only when observed demand and coverage analysis justify them.
- Kory current V5 benchmark results are published internally with exact model/harness/runtime identities.
- Any claim that Kory's skills outperform Codex/Claude/Cursor/community Agent Skills is backed by those controlled results, not intuition.

## Final principle

The library should become smaller when evidence says a skill is redundant and larger only when evidence says a capability is missing. The quality advantage will come from **source-backed expertise + precise routing + deterministic tooling + realistic verification + relentless regression capture**, not from having the highest skill count.
