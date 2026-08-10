# ADR-008: Skill polyhierarchy and professional facets

## Status

Accepted

## Context

Koryphaios originally stored one `parent` for each local skill. That field was simultaneously used as a taxonomy, dependency edge, resolver expansion rule, and UI breadcrumb. A single tree cannot truthfully represent cross-domain work: a web interface is narrower than both visual interface design and interface engineering, while interaction and accessibility are relevant professional lenses rather than technologies or hard execution dependencies.

The 79 TypeScript-defined skills must remain stable and readable, but framework, vendor, file-format, and target-medium specializations must not become false top-level disciplines.

The distinction follows the W3C SKOS model's separation between hierarchical broader/narrower links and non-hierarchical related concepts. SKOS also permits one concept to have multiple broader concepts. See the [SKOS Primer](https://www.w3.org/TR/skos-primer/#secrel) and [SKOS Reference](https://www.w3.org/TR/skos-reference/).

## Decision

- `broader` is an ordered array of more-general professional concepts. The resolver follows every branch transitively. The first entry is the primary UI breadcrumb.
- `facets` is an array of cross-cutting professional lenses. The resolver includes declared facets one hop only and then includes each facet's own broader concepts and hard requirements. Facets never expand recursively.
- `requires` remains a hard execution dependency. `conflicts` remains a fail-closed incompatibility.
- `parent` remains in generated metadata as a compatibility field and must equal `broader[0]`. New code must not use it as the complete hierarchy.
- Bundled definitions are version `3.0.0`. Untouched generated copies update in place; user-edited local copies remain canonical and surface a bundled update for explicit replace or merge.
- Medium branches such as `web-interface`, `native-interface`, and `terminal-interface` are narrower than broad visual design and interface engineering. Cross-domain specialties such as data visualization, accessibility verification, and repository research use multiple broader disciplines.
- Every bundled definition is validated before seeding for count, stable-name syntax, uniqueness, bounded trigger description, positive and negative routing examples, evidence gates, existing relations, duplicate/self relations, hierarchy cycles, and hierarchy/facet overlap.
- Trigger phrases use normalized token and phrase boundaries. Substrings are not activation evidence: for example, `clinical` cannot activate `cli`. Bounded negation is authoritative: `Do not assume web technologies` excludes the web branch, while a positive `desktop` signal can still establish the native medium. Collected medium, topology, toolkit, and domain signals are passed explicitly to the matcher, and the recorded selection reason names only the signal or declared relation actually used.
- Resolution assigns each selected skill a `full`, `compact`, or `minimal` prompt representation. `minimal` is lossless for the skill's mandatory core, boundaries, and evidence contract; optional professional detail alone may be compressed. Costs include the exact injected active-skills heading, manifest JSON, manifest hash, item headings, reasons, and separators. Direct matches, explicit pins, hierarchy dependencies, `task-routing`, and mutation-task testing and verification guidance are mandatory; a budget that cannot fit their minimal forms blocks instead of silently dropping them.
- Live prompt compilation caps the requested skill budget against a provider-confirmed model context window, a UTF-8 token upper bound for serialized conversation/tool context, the non-skill system prompt, and the caller's actual completion limit (16,384 tokens for manager/worker turns and 2,048 for critics). A final guard measures the complete provider-rendered system prompt, including adapter wrappers and separators. Unknown live model capacity and crowded windows fail closed before a provider call; Kory never guesses capacity from a model name. The 30,000-character default exists only for planning previews and non-live compiler inspection.
- The versioned prompt manifest is `kory-workflow-v6-verified-context-skills`; each entry records representation, injected cost, full cost, omitted-detail characters, complete prompt token upper bound, and total context upper bound so evidence and cache identity follow the rendered prompt and its verified-capacity decision.
- The native structured creator supports broader concepts, facets, requirements, conflicts, exclusion phrases, target media, hierarchy depth, and per-skill context budget. IDs, relation existence, contradictory relations, depth, and cycles are validated before the draft is persisted. New drafts are fully written and synced to a same-directory temporary file, then published with an atomic no-replace hard-link compare-and-set. Simultaneous processes therefore produce one winner and a conflict instead of last-writer data loss. Publication cleans at most 32 regular temporary files older than five minutes; symlinks and fresh files are never cleanup targets. Activation atomically retires the exact validated draft into a recoverable archive; a divergent draft created concurrently is not deleted.
- The tracked `skill-installer`, `skill-creator`, `plugin-creator`, `imagegen`, `review-agent`, and `openai-docs` packages currently depend on Codex-only tools, paths, or plugin semantics. Koryphaios does not seed them into the active personal library. Existing copies and repository resources remain untouched and visible with an explicit `unavailable` compatibility reason until a Kory-native adapter is implemented and verified.

## Consequences

- Skill selection can express professional polyhierarchies without loading every related skill.
- Older clients can continue displaying `parent`, but they show only the primary breadcrumb.
- Edited pre-v3 skills remain readable through `parent` fallback and are never silently overwritten.
- `task-routing` is intentionally universal and therefore has no negative trigger; every other bundled definition has both positive and negative forward cases.
- Custom drafts created in the native editor can be placed directly into the same validated polyhierarchy. They remain inactive until trigger tests pass and a human activates them under the configured learning policy.
- Settings exposes a planning-only routing preview with representation, exact item and raw section cost, planning budget, manifest/header overhead, full cost, omitted-detail count, compressed-skill list, and at most 24 highest-signal rejected-candidate reasons. It never labels that preview manager-ready: the final selection is recomputed at turn time against authenticated model metadata, occupied context, actual output reserve, and provider framing. The full rejected count and truncation state remain visible. Frontend normalization keeps older preview payloads readable during mixed-version recovery.

## Verification

- `bun test backend/src/kory/__tests__/skills.test.ts backend/src/routes/v1/agent-settings-skills.test.ts`
- `bun run --filter backend typecheck`
- `bun run --filter frontend check`
- `bun run format:changed`
- `git diff --check`

The atomic draft publication gate is proven with six synchronized two-process races; every race must return exactly one success and one conflict while preserving the winner's bytes.
