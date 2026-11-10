# Notes knowledge workspace

## Notes, Memory, and Skills

These are separate destinations in Settings → Knowledge:

| Destination | Purpose                                                            | Scope                                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Notes       | Documents, research, and saved findings                            | The selected project folder. Its Markdown/HTML subfolders are indexed as live documents; Notes folders organize that collection. Sibling projects have separate collections.                    |
| Memory      | Durable facts, preferences, decisions, and conversation continuity | Universal memory is personal across projects on this computer; session memory belongs to one chat. Project memory may inherit a registered workspace root, which the editor reports explicitly. |
| Skills      | Reusable task procedures and operating instructions                | Personal skills are available across projects; project skills belong to the selected project. Drafts remain inactive until tested and activated.                                                |

Rules are standing instructions, shown in their own section of Memory rather than mixed into remembered facts. A note's **In context** setting is independent from pinning; saving or pinning a note does not activate a skill. Skill-package directories and their reference files are excluded from ordinary Notes indexing. Explicitly importing Memory as Notes creates separate reference documents, not a replacement memory store.

Memory and Skills share a writing-first editor with visual formatting, exact Source mode, and a source/preview Split view. Unsupported visual constructs remain protected so switching modes does not silently rewrite their source.

Knowledge destinations are navigated from the Settings sidebar. Each page shows its current scope as a project selector with a compact expandable description. Notes settings group everyday controls into Collection and Agent context; graph tuning expands on demand. Note tool permissions are not duplicated here — approval tiers and per-tool overrides live in Agent behavior.

Notes, Bases, Graph, Network and Canvas are views of project-scoped knowledge:

- **Notes** hold Markdown or sandboxed HTML, typed YAML properties, attachments and revision history.
- **Bases** are saved validated filter/sort/group definitions, not separate databases. The editor supports nested AND/OR conditions, up to three sort fields, grouping and visible columns. Save a view before using its results.
- **Graph** visualizes references and associations; a link is not proof.
- **Network** holds typed evidence proposals and reviewed relationships. Refreshing evidence creates a new proposal at current endpoint revisions, retains historical decisions, and never automatically accepts it. Stale evidence cannot be accepted.
- **Canvas** is a visual board stored as a `canvas`-tagged note with a versioned JSON document. Visual connectors do not create evidence claims. Malformed documents fail as a whole rather than silently losing cards.

## Connected workflows

Create a research investigation, architecture decision, bug investigation or handoff from the template picker. Use **Ask agent** on a note or **Ask agent about this page** on a Base to populate the chat composer for review; these actions do not send automatically or spend provider tokens.

**Create Canvas from this page** arranges the current saved Base result page into note cards. It does not pretend to include later pages. Clicking a Canvas note in the Notes catalog opens its board rather than exposing JSON in the editor. Agent updates refresh Bases, Network and clean Canvas documents; unsaved edits retain their optimistic revision protection.

**Where this note appears** aggregates every reference site for the open note — document links, typed relationship pairs, Canvas cards and saved Base membership — in one sidebar section with click-through navigation. Relationship counterparties are shown once as pairs instead of being double-counted as document links, and scans that hit a safety bound say so rather than pretending to be complete.

**Save this chat finding as a sourced note** turns one reviewed chat response into a `/Findings` note. The title and body stay editable before saving. The server verifies the source session belongs to the selected project and, when supplied, that the message is an assistant response in that session; session/message IDs and role/provider/model/timestamp provenance are recorded by the host, never trusted from client-supplied claims.

**Change review** is one queue for everything the agent has proposed but not settled: relationship proposals waiting for accept/reject, accepted evidence whose endpoints changed since review, and recovery drafts. Stale proposals cannot be accepted until their evidence is refreshed, and a decision that loses a revision race fails visibly instead of retrying.

## Links from chat

Click a note link in chat to open Notes and navigate to that document. Existing `[[Title]]` links work, and `[[/Findings/Guide|Guide]]` selects a note by its folder and title. Duplicate titles require a complete path or note ID. Missing destinations show an error without creating a note. Navigation uses the editor's normal unsaved draft protection.

Markdown links can carry percent encoded destinations:

- `[Guide](kory-note://path/%2FFindings%2FGuide)` opens `/Findings/Guide`.
- `[Workspace guide](kory-note://path/docs%2Fnotes-workspace.md)` opens the indexed project document.
- `[Note](kory-note://id/<encoded-note-id>)` opens an exact note ID.
- `[Guide](kory-note://title/Guide)` resolves a unique title.

Encode the entire ID, path, or title once with `encodeURIComponent`. Spaces, Unicode, literal percent signs, and reserved characters are preserved. Links resolve only within the active project. Notes must be enabled in Settings.

## Agent tools

The Notes toolset includes dedicated operations for:

- Base discovery, reading, creation, editing, trash and restore.
- Canvas discovery, validated reading, creation and bounded card/edge patches.
- Typed property reading, setting, removal and atomic patch batches on one note.
- Relationship listing, proposal, review, evidence refresh and revision-bound removal.
- Appearance discovery (`list_note_appearances`): where a note appears across document links, relationship pairs, Canvas boards and saved Bases.
- Trash listing, note restore, history listing/reading and revision restore.
- Recovery draft listing/reading and revision-bound discard.
- Attachment metadata, bounded text/Markdown/JSON reads, and bounded add/remove operations.

These tools use the same registry through native agent calls and the authenticated MCP bridge. Critics can read and challenge evidence but cannot mutate knowledge.

## Permissions

Settings → Notes exposes a dedicated **Allow / Ask / Block** control for each operation.

- Inherited defaults: reads **Allow**, writes **Ask**.
- Guarded and YOLO skip inherited Notes approval defaults.
- An explicit per-operation **Ask** or **Block** applies in every mode, including Guarded and YOLO.
- Explicit host block/ask rules also apply. Plan interaction mode and critic roles stay read-only.
- Relationship review follows its own dedicated permission rather than an unconditional approval exception. Current evidence and optimistic revisions are still mandatory.
- Click an operation's reset arrow to return it to its mode-aware default. Global Reset restores all inherited defaults.
- Legacy restrictive presets are migrated conservatively; existing custom Ask choices remain explicit.
- Disabled Notes rejects calls even from a stale tool catalog. Approval receipts are invocation-bound and removed after execution; permissions are rechecked after approval.

Notes settings target the selected project explicitly, not a stale chat workspace. Settings persist in that project's `koryphaios.json`.

## Bounds and safety

Canvas documents permit at most 2,000 cards and 5,000 edges, unique IDs, finite bounded geometry, safe six-digit hex colors and existing edge endpoints. Dedicated agent Canvas writes validate referenced notes in the current project. Canvas patches permit at most 100 card and 200 edge changes per call.

Agent attachment additions are capped at 256,000 bytes per call. Text attachment reads are bounded to 16,000 characters and do not expose storage paths. Existing attachment MIME/content checks remain enforced.

Base queries remain saved-definition-only: query tools do not accept caller SQL or ad-hoc filter ASTs. Creation/editing validates structured definitions through the same backend service as the UI. Note/property/Canvas/Base writes and evidence reviews reject stale revisions instead of silently retrying.

Vault archives and destructive recovery decisions remain explicit user-facing workflows; no agent operation silently exports or restores an entire vault. Embedding indexing continues to require explicit opt-in and its existing read-permission boundary.
