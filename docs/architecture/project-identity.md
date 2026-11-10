# Project identity and icons

Status: Milestone 0 contract and Sprint 1 characterization

## User-visible contract

A durable project identity is the label and icon shown for a filesystem-backed
project. It is distinct from a checkout, a chat, and a workspace container.
The default flow remains simple: a project is selected by the existing
workspace navigation flow, and its identity is rendered wherever the product
shows that project.

The first implementation must preserve the current path-based navigation while
introducing a migration seam. A path-derived identity is a compatibility
projection, not the final identity authority.

## Shared contract

`shared/src/project-identity.ts` defines:

- `ProjectId`: opaque application identity.
- `ProjectIdentity`: id, display name, and icon specification.
- `ProjectCheckout`: association between an identity and a checkout root.
- `ProjectIconSpec`: versionable `automatic`, `emoji`, `monogram`, `color`, or
  `image` data.

Rules:

- automatic icons are deterministic for the same id and name;
- emoji is limited to one Unicode grapheme;
- monograms are limited to two Unicode graphemes;
- colors are curated theme tokens, never arbitrary CSS;
- image references are opaque asset IDs, never paths, URLs, or image bytes;
- unknown or malformed future icon modes fall back to automatic;
- browser local storage must not contain project image data.

## Current inventory

| Concern                      | Current authority                                  | Current limitation                                              |
| ---------------------------- | -------------------------------------------------- | --------------------------------------------------------------- |
| Selected project             | `backend/src/stores/workspace-navigation-store.ts` | Persisted by canonical path under singleton `local-desktop` row |
| Project listing              | Filesystem children of workspace root              | Rebuilt on every snapshot; not a durable catalog                |
| Frontend projection          | `frontend/src/lib/stores/project.svelte.ts`        | Duplicates backend snapshot types and uses paths                |
| Workspace event              | `workspace.updated`                                | Payload is not a shared discriminated contract                  |
| Project label                | `projectDisplayName(path)`                         | Basename is not a durable identity                              |
| Safe image storage precedent | `backend/src/providers/custom-provider-icons.ts`   | Provider-scoped; no project ownership yet                       |
| Recent navigation hints      | `navigation-preferences.ts`                        | Intentionally stores no project path or image data              |

## Identity priority and migration

The eventual resolver uses this order:

1. safely verified stable repository identity;
2. repository-local identity when no remote exists;
3. canonical path identity for ordinary folders;
4. explicit user confirmation when candidates are ambiguous.

Until the resolver and persistence table exist, the frontend uses
`path:<canonical-or-authoritative-path>` as a clearly named compatibility
projection. Consumers must not treat that value as proof that a moved folder
has the same identity.

Multiple checkouts must point at one `ProjectIdentity`; a checkout path must
never silently create a second project identity. Icon metadata is project
scoped and therefore must be returned from the backend or a project event, not
stored as a device-local preference.

## Icon renderer contract

`ProjectIcon.svelte` is the shared decorative renderer. It may display a
monogram, emoji, curated-color tile, or server-provided image. It must:

- remain decorative inside a named button or next to visible project text;
- use theme tokens for surfaces and text;
- show a safe automatic monogram when an image is missing or fails to load;
- keep status overlays separate from the base icon;
- never expose a filesystem path as an image source.

## Next migration steps

1. Add a backend project identity store keyed by `ProjectId`.
2. Resolve identities from repository metadata and canonical paths.
3. Add project-owned normalized PNG storage with ownership manifests, ETags,
   revisioned retrieval, and atomic replacement, reusing provider-icon safety
   checks.
4. Add project identity fields to the authoritative workspace snapshot or a
   dedicated versioned project event.
5. Replace compatibility projections in sidebar, picker, settings, menu, and
   remote clients one surface at a time.
6. Separate imported briefs from filesystem project references before allowing
   recent-item code to create or select projects.

## Acceptance evidence

The shared contract tests cover grapheme bounds, deterministic fallback,
curated color validation, opaque image IDs, and unknown-mode fallback. The
frontend store tests cover stable path projections and render-ready automatic
icons. Upload and remote synchronization remain intentionally open until the
backend identity store exists.
