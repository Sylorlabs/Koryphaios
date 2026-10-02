# Source map

`nextjs-engineering` is an individually authored V5 skill package; empirical qualification is tracked separately in the audit/evaluation ledger. These maintained sources bound factual and version-sensitive guidance; qualification is tested with hierarchy-aware held-out routing, paired same-model skill/no-skill tasks, and independent blind evaluation.

## Qualification basis

- Hierarchy: broader web-interface.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Next.js documentation:** https://nextjs.org/docs
  - Scope: Next.js documentation as fetched 2026-09-06.
  - Use: Primary authority for App Router, rendering, data, caching, routing, and deployment behavior.
  - Verified: 2026-09-06; refresh after 30 days.
- **Server and Client Components:** https://nextjs.org/docs/app/getting-started/server-and-client-components
  - Scope: Page last updated 2026-03-16.
  - Use: Default Server Components, `'use client'` as a client module-graph boundary, serializable props, bundle size, and server-only code separation.
  - Verified: 2026-09-06; refresh after 30 days.
- **Revalidating with Cache Components:** https://nextjs.org/docs/app/getting-started/revalidating
  - Scope: Page last updated 2026-03-03 and explicitly applies when `cacheComponents: true`.
  - Use: `cacheLife`, `revalidateTag`, `updateTag`, `revalidatePath`, and the distinction from the previous caching model.
  - Verified: 2026-09-06; refresh after 30 days.
- **Matt Pocock skills:** https://github.com/mattpocock/skills
  - Scope: `main` commit `3cca18b368ae95cdbdebbff572ccafa662551015`, authored 2026-09-04T08:43:27Z; repository `package.json` reports `mattpocock-skills` 1.2.3.
  - Use: Community packaging reference for keeping specialist rules small and routing explicit. Never authority over Next.js behavior.
  - Verified: 2026-09-06; refresh after 30 days.

## Research notes

- Adopted: the Matt Pocock repository keeps routing as its own concern and reusable engineering guidance composable. Revision: https://github.com/mattpocock/skills/commit/3cca18b368ae95cdbdebbff572ccafa662551015
- Adapted: this skill makes the framework execution boundary the routing seam. Ordinary React component logic stays with React; server/client graphs, routing, cache models, revalidation, and deployment stay here.
- Rejected: no fixed project lifecycle, issue tracker, or test-first orchestration from the community repository is embedded into the Next.js specialist instructions.
- Primary-source concepts adopted: Server Components are the default in App Router; `'use client'` marks the entry into the client module graph; client-bound props must be serializable; Cache Components use a documented revalidation model that must not be mixed with previous-model guidance.

## Interpretation rules

- Prefer the primary official/spec/reference source over community conventions when they conflict.
- Resolve the actual product, language, runtime, provider, platform, protocol, or standard version before applying details that can drift.
- Treat examples as examples, not proof that the current repository/runtime behaves the same way.
- Preserve unknowns and source conflicts explicitly; do not merge incompatible guidance into a false universal rule.
- Keep operational checks in the real target environment whenever the claim depends on runtime behavior.
