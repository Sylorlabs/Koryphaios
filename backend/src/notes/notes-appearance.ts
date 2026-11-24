/**
 * Per-project folder and tag appearance (emoji + color) for the Notes network.
 *
 * Folders have no row of their own: a folder exists while notes carry its
 * path. Appearance is therefore keyed by canonical folder path and persisted
 * beside notesSettings in the project's koryphaios.json, the same settings
 * store the other project-scoped Notes preferences use. No schema migration is
 * needed, and every read/write is scoped by the request's project root.
 */

import { ValidationError } from '../errors/types';
import {
  appearanceIsEmpty,
  normalizeFolderAppearance,
  normalizeFolderAppearancePath,
  normalizeNoteAppearanceColor,
  normalizeNoteAppearanceEmoji,
  normalizeTagAppearance,
  normalizeTagAppearanceTag,
  type FolderAppearance,
  type NotesAppearanceState,
  type NoteAppearanceColor,
  type TagAppearance,
} from '@koryphaios/shared';
import { PROJECT_DOCUMENT_PREFIX } from './note-document';
import { loadKoryphaiosConfig, saveKoryphaiosConfig } from './notes-settings';
import * as notesService from './notes-service';

/** A partial update. `undefined` keeps the stored field; `null` clears it. */
export interface NoteAppearancePatch {
  emoji?: string | null;
  color?: string | null;
}

export interface FolderRenameResult {
  from: string;
  to: string;
  movedNotes: number;
  /** Project-backed notes follow their source file on disk and are not rewritten here. */
  skippedProjectDocuments: number;
  appearanceMoved: boolean;
}

const CONFIG_KEY = 'notesAppearance';

function sanitizeState(raw: unknown): NotesAppearanceState {
  const record = (raw ?? {}) as Partial<Record<'folders' | 'tags', unknown>>;
  const folders = new Map<string, FolderAppearance>();
  const tags = new Map<string, TagAppearance>();
  // Hand-edited or stale entries are dropped rather than failing the whole
  // project's Notes surface.
  if (Array.isArray(record.folders)) {
    for (const entry of record.folders) {
      const result = normalizeFolderAppearance(entry as { path: unknown });
      if (result.ok && result.value) folders.set(result.value.path, result.value);
    }
  }
  if (Array.isArray(record.tags)) {
    for (const entry of record.tags) {
      const result = normalizeTagAppearance(entry as { tag: unknown });
      if (result.ok && result.value) tags.set(result.value.tag, result.value);
    }
  }
  return {
    folders: sortBy([...folders.values()], (folder) => folder.path),
    tags: sortBy([...tags.values()], (tag) => tag.tag),
  };
}

function sortBy<T>(items: T[], key: (item: T) => string): T[] {
  return items.sort((a, b) => key(a).localeCompare(key(b)));
}

function readState(projectRoot: string): NotesAppearanceState {
  return sanitizeState(loadKoryphaiosConfig(projectRoot)[CONFIG_KEY]);
}

function writeState(projectRoot: string, state: NotesAppearanceState): void {
  const config = loadKoryphaiosConfig(projectRoot);
  config[CONFIG_KEY] = { folders: state.folders, tags: state.tags };
  saveKoryphaiosConfig(projectRoot, config);
}

function assertValid<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new ValidationError(result.error);
  return result.value;
}

/** Folder appearance covers the folder itself and everything beneath it. */
function isWithinFolder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder === '/' ? '/' : `${folder}/`);
}

export function listNotesAppearance(projectRoot: string): NotesAppearanceState {
  return readState(projectRoot);
}

/**
 * Merge an update into a folder's appearance. Absent fields keep their stored
 * value, `null` clears a field, and a record left with neither an emoji nor a
 * color is removed.
 */
export function setFolderAppearance(
  projectRoot: string,
  input: NoteAppearancePatch & { path: string },
): FolderAppearance | null {
  const path = assertValid(normalizeFolderAppearancePath(input.path));
  const state = readState(projectRoot);
  const current = state.folders.find((folder) => folder.path === path);
  const emoji =
    input.emoji === undefined
      ? current?.emoji
      : assertValid(normalizeNoteAppearanceEmoji(input.emoji ?? undefined));
  const color =
    input.color === undefined
      ? current?.color
      : assertValid(normalizeNoteAppearanceColor(input.color ?? undefined));
  const merged: FolderAppearance = {
    path,
    ...(emoji ? { emoji } : {}),
    ...(color ? { color: color as NoteAppearanceColor } : {}),
  };
  const folders = state.folders.filter((folder) => folder.path !== path);
  if (!appearanceIsEmpty(merged)) folders.push(merged);
  writeState(projectRoot, { ...state, folders: sortBy(folders, (folder) => folder.path) });
  return appearanceIsEmpty(merged) ? null : merged;
}

/** Drops a folder's appearance and the appearance of every folder beneath it. */
export function deleteFolderAppearance(projectRoot: string, rawPath: string): number {
  const path = assertValid(normalizeFolderAppearancePath(rawPath));
  const state = readState(projectRoot);
  const folders = state.folders.filter((folder) => !isWithinFolder(folder.path, path));
  const removed = state.folders.length - folders.length;
  if (removed > 0) writeState(projectRoot, { ...state, folders });
  return removed;
}

export function setTagAppearance(
  projectRoot: string,
  input: NoteAppearancePatch & { tag: string },
): TagAppearance | null {
  const tag = assertValid(normalizeTagAppearanceTag(input.tag));
  const state = readState(projectRoot);
  const current = state.tags.find((entry) => entry.tag === tag);
  const emoji =
    input.emoji === undefined
      ? current?.emoji
      : assertValid(normalizeNoteAppearanceEmoji(input.emoji ?? undefined));
  const color =
    input.color === undefined
      ? current?.color
      : assertValid(normalizeNoteAppearanceColor(input.color ?? undefined));
  const merged: TagAppearance = {
    tag,
    ...(emoji ? { emoji } : {}),
    ...(color ? { color: color as NoteAppearanceColor } : {}),
  };
  const tags = state.tags.filter((entry) => entry.tag !== tag);
  if (!appearanceIsEmpty(merged)) tags.push(merged);
  writeState(projectRoot, { ...state, tags: sortBy(tags, (entry) => entry.tag) });
  return appearanceIsEmpty(merged) ? null : merged;
}

export function deleteTagAppearance(projectRoot: string, rawTag: string): boolean {
  const tag = assertValid(normalizeTagAppearanceTag(rawTag));
  const state = readState(projectRoot);
  const tags = state.tags.filter((entry) => entry.tag !== tag);
  if (tags.length === state.tags.length) return false;
  writeState(projectRoot, { ...state, tags });
  return true;
}

/**
 * Carry a folder's appearance from one path to another, including its
 * sub-folders. The moved record replaces anything already stored at the target.
 */
export function moveFolderAppearance(projectRoot: string, from: string, to: string): boolean {
  const source = assertValid(normalizeFolderAppearancePath(from));
  const target = assertValid(normalizeFolderAppearancePath(to));
  if (source === '/') throw new ValidationError('The root folder cannot be moved');
  const state = readState(projectRoot);
  const moving = state.folders.filter((folder) => isWithinFolder(folder.path, source));
  if (moving.length === 0) return false;
  const rewrite = (path: string) => target + path.slice(source.length);
  const movedPaths = new Set(moving.map((folder) => rewrite(folder.path)));
  const folders = state.folders
    .filter((folder) => !isWithinFolder(folder.path, source) && !movedPaths.has(folder.path))
    .concat(moving.map((folder) => ({ ...folder, path: rewrite(folder.path) })));
  writeState(projectRoot, { ...state, folders: sortBy(folders, (folder) => folder.path) });
  return true;
}

/**
 * Rename a folder by moving every note under it, then carry its appearance.
 * Each note move is a normal revision-bumping update. The note moves and the
 * appearance write are not one transaction, so a failure part-way leaves the
 * already-moved notes in the new folder and reports the error to the caller.
 */
export async function renameNoteFolder(
  projectRoot: string,
  rawFrom: string,
  rawTo: string,
): Promise<FolderRenameResult> {
  const from = assertValid(normalizeFolderAppearancePath(rawFrom));
  const to = assertValid(normalizeFolderAppearancePath(rawTo));
  if (from === '/') throw new ValidationError('The root folder cannot be renamed');
  if (to === from || to.startsWith(`${from}/`)) {
    throw new ValidationError('A folder cannot be moved into itself');
  }
  const candidates = (await notesService.listNotes({ folderPath: from }, projectRoot)).filter(
    (note) => isWithinFolder(note.folderPath, from),
  );
  let movedNotes = 0;
  let skippedProjectDocuments = 0;
  for (const note of candidates) {
    if (note.id.startsWith(PROJECT_DOCUMENT_PREFIX)) {
      skippedProjectDocuments++;
      continue;
    }
    const nextFolder = to + note.folderPath.slice(from.length);
    await notesService.updateNote(
      note.id,
      { folderPath: nextFolder, expectedRevision: note.revision },
      projectRoot,
    );
    movedNotes++;
  }
  const appearanceMoved = moveFolderAppearance(projectRoot, from, to);
  return { from, to, movedNotes, skippedProjectDocuments, appearanceMoved };
}
