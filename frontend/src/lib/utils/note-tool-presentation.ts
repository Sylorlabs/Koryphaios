import { NOTE_TOOL_DEFINITIONS } from '@koryphaios/shared';

export type ToolIntent =
  | 'read'
  | 'list'
  | 'search'
  | 'create'
  | 'edit'
  | 'delete'
  | 'restore'
  | 'link'
  | 'unlink'
  | 'review'
  | 'refresh'
  | 'use';
export type WorkspaceSurface = 'note' | 'base' | 'network' | 'canvas';
export type WorkspaceIcon = WorkspaceSurface | 'properties' | 'history' | 'draft' | 'attachment';

const noteTools = new Map(NOTE_TOOL_DEFINITIONS.map((tool) => [tool.name as string, tool]));
const verbs: Record<string, { running: string; complete: string; intent: ToolIntent }> = {
  read: { running: 'Reading', complete: 'Read', intent: 'read' },
  get: { running: 'Reading', complete: 'Read', intent: 'read' },
  list: { running: 'Listing', complete: 'Listed', intent: 'list' },
  search: { running: 'Searching', complete: 'Searched', intent: 'search' },
  recall: { running: 'Recalling', complete: 'Recalled', intent: 'read' },
  retrieve: { running: 'Retrieving', complete: 'Retrieved', intent: 'search' },
  query: { running: 'Querying', complete: 'Queried', intent: 'search' },
  render: { running: 'Rendering', complete: 'Rendered', intent: 'read' },
  create: { running: 'Creating', complete: 'Created', intent: 'create' },
  update: { running: 'Editing', complete: 'Edited', intent: 'edit' },
  patch: { running: 'Editing', complete: 'Edited', intent: 'edit' },
  set: { running: 'Updating', complete: 'Updated', intent: 'edit' },
  delete: { running: 'Trashing', complete: 'Trashed', intent: 'delete' },
  trash: { running: 'Trashing', complete: 'Trashed', intent: 'delete' },
  remove: { running: 'Removing', complete: 'Removed', intent: 'delete' },
  discard: { running: 'Discarding', complete: 'Discarded', intent: 'delete' },
  restore: { running: 'Restoring', complete: 'Restored', intent: 'restore' },
  add: { running: 'Adding', complete: 'Added', intent: 'create' },
  link: { running: 'Linking', complete: 'Linked', intent: 'link' },
  unlink: { running: 'Unlinking', complete: 'Unlinked', intent: 'unlink' },
  propose: { running: 'Proposing', complete: 'Proposed', intent: 'link' },
  review: { running: 'Reviewing', complete: 'Reviewed', intent: 'review' },
  refresh: { running: 'Refreshing', complete: 'Refreshed', intent: 'refresh' },
  record: { running: 'Recording', complete: 'Recorded', intent: 'create' },
};

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function noteToolPresentation(
  name: string,
  input: Record<string, unknown>,
  output: string,
  complete: boolean,
) {
  if (!noteTools.has(name)) return null;
  const verb = verbs[name.split('_')[0]];
  if (!verb) return null;
  let surface: WorkspaceSurface = 'note';
  let icon: WorkspaceIcon = 'note';
  let result: Record<string, unknown> = {};
  if (complete && output.trim().startsWith('{')) {
    try {
      result = record(JSON.parse(output));
    } catch {
      /* A clipped preview is still readable text. */
    }
  }
  const title = text(input.newTitle ?? input.title ?? result.title);
  const noteId = text(input.noteId ?? input.id ?? result.noteId ?? result.id);
  const note = title || noteId;
  let target = note ? `note ${note}` : 'note';

  if (/note_bases?$/.test(name)) {
    surface = icon = 'base';
    const base = text(input.name ?? input.baseName ?? result.name ?? input.baseId);
    target = name === 'list_note_bases' ? 'Bases' : base ? `Base ${base}` : 'Base';
  } else if (/note_canva/.test(name)) {
    surface = icon = 'canvas';
    const canvas = text(
      input.name ?? record(input.document).name ?? record(result.document).name ?? note,
    );
    target = name === 'list_note_canvases' ? 'canvases' : canvas ? `canvas ${canvas}` : 'canvas';
  } else if (
    /note_relationship|^link_notes$|^unlink_notes$|note_backlinks|note_graph|retrieve_note_context/.test(
      name,
    )
  ) {
    surface = icon = 'network';
    const from = text(input.fromTitle ?? input.fromId);
    const to = text(input.toTitle ?? input.toId);
    const pair = from && to ? `${from} → ${to}` : '';
    target =
      name === 'get_note_graph_summary'
        ? 'note network'
        : name === 'get_note_backlinks'
          ? `backlinks${note ? ` for ${note}` : ''}`
          : name === 'retrieve_note_context'
            ? `note context${text(input.query) ? ` · ${text(input.query)}` : ''}`
            : /relationship/.test(name)
              ? `note relationships${pair ? ` · ${pair}` : note ? ` for ${note}` : ''}`
              : `notes${pair ? ` · ${pair}` : ''}`;
  } else if (/note_propert/.test(name)) {
    icon = 'properties';
    target = `${text(input.key) ? `property ${text(input.key)}` : 'note properties'}${note ? ` · ${note}` : ''}`;
  } else if (/note_revision/.test(name)) {
    icon = 'history';
    target = `${name === 'list_note_revisions' ? 'note history' : 'note revision'}${input.revision ? ` ${input.revision}` : ''}${note ? ` · ${note}` : ''}`;
  } else if (/note_draft/.test(name)) {
    icon = 'draft';
    target =
      name === 'list_note_drafts'
        ? 'note drafts'
        : `note draft${text(input.draftId) ? ` ${text(input.draftId)}` : ''}`;
  } else if (/note_attachment/.test(name)) {
    icon = 'attachment';
    const attachment = text(input.filename ?? result.filename ?? input.attachmentId);
    target = `${name === 'list_note_attachments' ? 'note attachments' : 'note attachment'}${attachment ? ` · ${attachment}` : note ? ` · ${note}` : ''}`;
  } else if (name === 'list_note_trash') {
    target = 'Notes trash';
  } else if (name === 'record_work_note') {
    target = title ? `work note ${title}` : 'work note';
  } else if (name === 'search_notes' || name === 'recall_notes' || name === 'list_notes') {
    const titles = Array.isArray(input.titles)
      ? input.titles.filter((title) => typeof title === 'string').join(', ')
      : '';
    const scope = text(input.query ?? input.folderPath) || titles;
    target = `notes${scope ? ` · ${scope}` : ''}`;
  }

  return {
    surface,
    icon,
    intent: verb.intent,
    action: complete ? verb.complete : verb.running,
    target,
  };
}
