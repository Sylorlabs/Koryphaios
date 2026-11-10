/**
 * Note-appearance discovery: "where does this note appear?"
 *
 * A note participates in the workspace through more than document links: it
 * can sit on one side of an evidence relationship, appear as a card on a
 * Canvas board, or be a member row of a saved Base view. This service answers
 * that question in one bounded, project-scoped scan so the UI and agent tools
 * never have to stitch the four sources together themselves.
 */

import { validateNoteCanvas, type NoteAppearances } from '@koryphaios/shared';
import { NotFoundError } from '../errors/types';
import { PROJECT_ROOT } from '../runtime/paths';
import { queryNoteBase, listNoteBases } from './note-bases-service';
import {
  getNote,
  getNoteBacklinks,
  listNoteRelationships,
  listNotes,
} from './notes-service';

/** Safety bounds: appearance discovery must stay a metadata scan. */
const MAX_CANVASES_SCANNED = 200;
const MAX_BASES_SCANNED = 50;
const MAX_BASE_ROWS_SAMPLED = 500;
const MAX_CARD_TEXT_CHARS = 200;

function trimmedCardText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_CARD_TEXT_CHARS);
}

export async function listNoteAppearances(
  id: string,
  projectRoot = PROJECT_ROOT,
): Promise<NoteAppearances> {
  const note = await getNote(id, projectRoot);
  if (!note) throw new NotFoundError('Note', id);

  const backlinks = (await getNoteBacklinks(id, projectRoot)).map((row) => ({
    noteId: row.id,
    title: row.title,
    folderPath: row.folderPath,
  }));

  const relationships = (await listNoteRelationships(projectRoot, { noteId: id, limit: 200 })).map(
    (row) => {
      const outgoing = row.fromId === id;
      return {
        fromId: row.fromId,
        toId: row.toId,
        fromTitle: row.fromTitle,
        toTitle: row.toTitle,
        type: row.type,
        status: row.status,
        stale: row.stale,
        revision: row.revision,
        direction: (outgoing ? 'outgoing' : 'incoming') as 'outgoing' | 'incoming',
        counterpartyId: outgoing ? row.toId : row.fromId,
        counterpartyTitle: outgoing ? row.toTitle : row.fromTitle,
      };
    },
  );

  // Canvas boards store their document as tagged note content. Boards whose
  // JSON no longer validates are skipped rather than failing the whole scan.
  const canvases: NoteAppearances['canvases'] = [];
  let truncated = false;
  const canvasNotes = (await listNotes({}, projectRoot))
    .filter((row) => row.tags.includes('canvas'))
    .slice(0, MAX_CANVASES_SCANNED);
  if (canvasNotes.length === MAX_CANVASES_SCANNED) truncated = true;
  for (const summary of canvasNotes) {
    const canvasNote = await getNote(summary.id, projectRoot);
    if (!canvasNote) continue;
    let document: ReturnType<typeof validateNoteCanvas>;
    try {
      document = validateNoteCanvas(JSON.parse(canvasNote.content));
    } catch {
      continue;
    }
    for (const card of document.cards) {
      if (card.noteId !== id) continue;
      canvases.push({
        noteId: canvasNote.id,
        title: canvasNote.title,
        cardId: card.id,
        cardText: trimmedCardText(card.text ?? ''),
      });
    }
  }

  // Base membership is evaluated by running each saved view with its own
  // deterministic query, bounded per view and across views.
  const bases: NoteAppearances['bases'] = [];
  const baseSummaries = listNoteBases(projectRoot, {}).slice(0, MAX_BASES_SCANNED);
  if (baseSummaries.length === MAX_BASES_SCANNED) truncated = true;
  for (const base of baseSummaries) {
    const result = await queryNoteBase(
      base.id,
      { limit: MAX_BASE_ROWS_SAMPLED },
      projectRoot,
    );
    if (result.hasMore) truncated = true;
    if (result.rows.some((row) => row.id === id)) {
      bases.push({ baseId: base.id, name: base.name, revision: base.revision });
    }
  }

  return {
    noteId: note.id,
    title: note.title,
    revision: note.revision,
    backlinks,
    relationships,
    canvases,
    bases,
    counts: {
      backlinks: backlinks.length,
      relationships: relationships.length,
      canvases: canvases.length,
      bases: bases.length,
    },
    truncated,
  };
}
