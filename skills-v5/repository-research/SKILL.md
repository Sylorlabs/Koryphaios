---
name: repository-research
description: Explain repository behavior by tracing actual code, configuration, tests, history, and runtime evidence. Use when locating an implementation or investigating how a codebase works; not for implementation only, isolated snippet explanation, or external fact research.
---

# Repository Research

Establish what the repository actually does. A symbol definition, comment, issue, or README is a lead; the answer comes from following the active path far enough to distinguish implemented, configured, tested, generated, historical, and runtime behavior.

## Workflow

1. Establish repository identity and scope. Read applicable repository instructions, current worktree/branch state, relevant package manifests or lockfiles, and generated/source boundaries before making architectural claims. Preserve user-owned dirty work and do not mutate files for a read-only research request.
2. Search from the question outward. Find the named behavior, endpoint, command, setting, symbol, event, schema, or visible effect; prefer bounded repository search and symbol/reference navigation over guessing likely filenames.
3. Trace the live path in both directions. Follow declarations to callers/registrations/entry points and downstream to adapters, persistence, network/process boundaries, rendering, or observable output. Include configuration, environment variables, feature flags, dependency injection, generated code, and build/runtime wiring when they can change which implementation is active.
   For dynamic package-backed or overlay-driven behavior, trace the complete resolution chain from package discovery through the active overlay or definition to runtime seeding/registration (for example, package → overlay → seed) before claiming that a package is active.
   The returned trace must also identify the activation trigger, required or broader dependency expansion, context-budget or representation decision, and at least one negative or fail-closed path. Label each material step with the evidence class it actually has, such as `implemented`, `configured`, `tested`, or `observed`.
   For a package-backed resolver, name the package instruction file, manifest, routing inputs, and task fixture directory precisely in the trace, including `SKILL.md`, `routing.json`, and `evals/tasks`; a generic statement that tasks or references were loaded is insufficient to establish the active package boundary.
4. Distinguish evidence classes:
   - `implemented`: executable code exists on the active path;
   - `configured`: current config selects or modifies it;
   - `tested`: a test exercises the relevant contract;
   - `observed`: runtime or deterministic execution demonstrates it;
   - `historical`: Git history explains when/why it changed;
   - `documented`: comments/docs/issues state an intent or claim.
     Do not promote `documented` or `historical` evidence into current runtime truth without corroboration.
5. Use history when the current snapshot cannot answer why, when, or whether behavior was replaced. Inspect path-aware logs, diffs, blame, and pickaxe-style history as appropriate; account for renames/moves and do not treat blame as proof of design intent.
6. Corroborate runtime-sensitive claims. Run a narrowly scoped existing test, read a deterministic fixture/output, inspect registration/configuration, or reproduce the behavior when safe and relevant. If execution is unavailable, label the conclusion as static-analysis evidence rather than observed behavior.
7. Resolve external-version questions only after identifying the dependency/provider/version actually used by the repository. External docs may compose with `factual-research`; do not let generic current docs overwrite repository-specific version evidence.
8. Return a compact trace: entry point → key transformations/decisions → state/side effects → observable result, with file/symbol evidence, configuration/runtime qualifiers, and unresolved branches. For architecture questions, identify ownership boundaries and where a change would actually need to land, but do not edit unless the user separately requested implementation.

## Boundaries

- Use `repository-environment-discovery` for the preflight needed before changing a checkout: instructions, dirty worktree, runtime/toolchain identity, and project verification commands. It may compose with this skill when a change request first requires understanding the live path.
- Use `debugging` when the requested outcome is to reproduce and fix a defect; `repository-research` can supply the implementation trace without authorizing a fix.
- Use `implementation` or a domain implementation skill when the user asks to change code rather than only understand it.
- Use `factual-research` for a discrete external fact and `research` for broad external synthesis. Repository claims remain grounded in repository evidence.
- Do not activate for a pasted snippet that can be explained entirely from supplied text when no repository access or cross-file trace is requested.

## Failure and recovery

- If symbol search misses generated/dynamic registration, inspect build steps, registries, string keys, config maps, and generated artifacts before concluding the path does not exist.
- If multiple implementations exist, prove which one is selected in the relevant runtime/configuration instead of choosing by filename or recency.
- If history was rewritten or unavailable, report that the provenance question cannot be established from the checkout.
- If a test proves only a mocked boundary, do not claim the real integration path is observed.
- If repository evidence contradicts documentation, report the executable/configured behavior first and identify the stale or aspirational documentation separately.
- When the trace crosses an authorization, tool bridge, plugin, or native-tool boundary, include both an allowed path and a denied or mismatched path, and state literally that `native tools` may remain a separate provider-managed or sandboxed surface. Include the permission-policy effect and explain that a control-plane grant does not disable or bypass that separate surface.

Use [the maintained source map](references/sources.md) when refreshing repository-search/history methodology or skill provenance.
