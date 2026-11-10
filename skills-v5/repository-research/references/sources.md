# Source map

`repository-research` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. These sources bound its repository navigation, history/provenance, code-search, and skill/eval design. Runtime conclusions still come from the target repository and its actual execution/configuration rather than from these stewardship references.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader research, repository-environment-discovery.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **GitHub search documentation**: https://docs.github.com/en/search-github
  - Type: `official-docs`
  - Scope: GitHub repository/code/issues/commits search documentation as available 2026-09-05.
  - Use: Repository/code/issues/commits search behavior and query boundaries.
  - Verified: 2026-09-05; refresh after 90 days.

- **GitHub code navigation**: https://docs.github.com/en/repositories/working-with-files/using-files/navigating-code-on-github
  - Type: `official-docs`
  - Scope: GitHub definition/reference and symbol navigation behavior as available 2026-09-05.
  - Use: definition/reference tracing as a repository-navigation aid; unsupported/dynamic paths still require text/config/runtime tracing.
  - Verified: 2026-09-05; refresh after 90 days.

- **Git `log` documentation**: https://git-scm.com/docs/git-log
  - Type: `official-docs`
  - Scope: Git documentation through current 2.55-era manuals as inspected 2026-09-05.
  - Use: path-aware history, diffs, revision ranges, rename-following constraints, and pickaxe-style provenance searches.
  - Verified: 2026-09-05; refresh after 180 days.

- **Git `blame` documentation**: https://git-scm.com/docs/git-blame
  - Type: `official-docs`
  - Scope: Git blame behavior and current manual history as inspected 2026-09-05.
  - Use: line-level revision provenance with explicit limits: deleted/replaced lines require history/diff searches and blame does not establish design intent by itself.
  - Verified: 2026-09-05; refresh after 180 days.

- **Agent Skills specification**: https://agentskills.io/specification
  - Type: `spec`
  - Scope: portable Agent Skills format as available 2026-09-05.
  - Use: discovery metadata and progressive disclosure for this package.
  - Verified: 2026-11-03; refresh after 90 days.

- **OpenAI skill creator reference**: https://github.com/openai/skills/blob/main/skills/.system/skill-creator/SKILL.md
  - Type: `reference-implementation`
  - Scope: OpenAI public skill-authoring guidance on `main` as inspected 2026-11-03.
  - Use: bounded triggers, selective references, and behavioral validation.
  - Verified: 2026-11-03; refresh after 60 days.

## Interpretation rules

- Prefer repository-local source, active configuration, tests, generated artifacts, and observed runtime evidence for claims about the repository itself.
- Use symbol/code search for discovery, then follow the actual registration/call/data path; search results alone are not architecture proof.
- Use Git history for provenance questions and explicitly distinguish current behavior from historical intent.
- Treat comments, READMEs, issues, and plans as documented claims until executable/configured behavior corroborates them.
- Bind external documentation to the dependency/provider version actually selected by the repository before applying it to runtime behavior.
