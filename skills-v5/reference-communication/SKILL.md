---
name: reference-communication
description: Create precise, versioned lookup documentation with authoritative fields and validated examples. Use when writing API, CLI, configuration, schema, or error references; not for tutorials, runbooks, architecture narratives, or implementation without a reference artifact.
---

# Reference Communication

Optimize for exact retrieval, not narrative teaching. A reference is trustworthy only if a reader can map each documented item back to the authoritative definition or active implementation and can tell what version/scope the fact belongs to.

## Workflow

1. Define the reference surface and version boundary: API/service version, command release, configuration/schema dialect, product edition, language/runtime, platform, generated artifact revision, or repository commit/tag. Do not merge incompatible versions into one timeless table.
2. Identify the source-of-truth hierarchy. Prefer normative specifications and generated schemas/IDL/OpenAPI where they govern; then active parser/handler/configuration code and tests; then maintained docs/examples. If generated schema and normative specification disagree, preserve the authoritative precedence for that technology and flag the inconsistency.
3. Inventory coverage before writing. Enumerate endpoints/operations, commands/subcommands/flags, configuration keys, schema properties, enum values, errors, events, or other reference units from the source of truth so undocumented omissions are detectable.
4. For each applicable item capture exact semantics:
   - canonical name/path/signature;
   - type/shape and required/optional status;
   - default and whether it is explicit, computed, inherited, or absent;
   - units, ranges, enum/format constraints, and mutual/dependency rules;
   - lifecycle/deprecation/availability and compatibility scope;
   - errors/status codes/failure conditions where relevant;
   - security/permission/scope requirements where relevant;
   - minimal examples tied to the documented version.
5. Distinguish `omitted`, `null`, empty, defaulted, and inferred values when the system does. Do not manufacture a default because an example repeatedly uses one.
6. Validate examples against the real schema/parser/CLI/API/test fixture where practical. A syntactically plausible example is not evidence that the target accepts it. Label illustrative examples if validation is unavailable.
7. Structure for lookup: stable headings, consistent field order, searchable canonical names, tables where they improve exact comparison, and cross-links rather than duplicated definitions. Keep rationale and procedures brief or link to the appropriate explanation/how-to artifact.
8. Run a coverage/fidelity review: source units documented, documented units still exist, names/types/defaults/constraints/errors match source, examples validate, deprecated/versioned behavior is scoped, and aliases do not silently create duplicate canonical entries.

## Boundaries

- `documents-communication` supplies inherited factual/format discipline.
- `instructional-communication` owns ordered procedures and task completion; a reference may be linked from a how-to but should not become a long step sequence.
- `technical-communication` owns architecture, mechanism, rationale, and design decisions; reference keeps explanatory context only when necessary to interpret lookup semantics.
- `repository-research` establishes which code/schema/version is authoritative when the source-of-truth path is unclear.
- Domain/API/CLI/configuration engineering skills establish behavior and may generate source artifacts; this skill documents verified behavior and does not authorize implementation changes.

## Failure and recovery

- If schema/code/docs disagree, do not average them. Establish authoritative/active behavior, document the conflict, and lower confidence where runtime evidence is missing.
- If coverage cannot be enumerated, state that the reference is partial rather than presenting it as exhaustive.
- If a default is computed dynamically or environment-dependent, describe the rule/source instead of freezing one observed value as universal.
- If examples cannot be validated, label them illustrative and avoid claiming they are executable.
- If multiple supported versions differ materially, split or annotate entries by version rather than hiding compatibility differences.

Use [the maintained source map](references/sources.md) when refreshing API/schema/reference or skill-authoring guidance.
