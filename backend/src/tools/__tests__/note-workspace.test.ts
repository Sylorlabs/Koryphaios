import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_AGENT_SETTINGS } from '../../agent-settings';
import { initDb } from '../../db';
import {
  DEFAULT_NOTE_TOOL_PERMISSIONS,
  NOTE_WORKSPACE_TOOL_DEFINITIONS,
  canvasFromNotes,
} from '@koryphaios/shared';
import { saveNotesAgentPermissions, saveNotesSettings } from '../../notes/notes-settings';
import * as notes from '../../notes/notes-service';
import { noteTools } from '../notes';
import { ToolRegistry, type ToolContext } from '../registry';
import { resolveToolPermissionPolicy } from '../permission-policy';
import { toolsForRole } from '../../providers/kory-mcp-bridge';

const root = mkdtempSync(join(tmpdir(), 'kory-note-workspace-'));
const foreignRoot = mkdtempSync(join(tmpdir(), 'kory-note-foreign-'));
const registry = new ToolRegistry();
for (const tool of noteTools) registry.register(tool);
beforeAll(async () => {
  await initDb();
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(foreignRoot, { recursive: true, force: true });
});
let sequence = 0;
function context(mode: 'ask' | 'guarded' | 'yolo' = 'guarded'): ToolContext {
  return {
    sessionId: 'workspace-tools',
    workingDirectory: root,
    settingsRoot: root,
    callerRole: 'manager',
    permissionPolicy: resolveToolPermissionPolicy({
      ...DEFAULT_AGENT_SETTINGS,
      permissionMode: mode,
    }),
  };
}
async function run(name: string, input: Record<string, unknown>, ctx = context()) {
  const result = await registry.execute(ctx, { id: `workspace-${++sequence}`, name, input });
  if (result.isError) throw new Error(result.output);
  return JSON.parse(result.output);
}
function reset() {
  saveNotesAgentPermissions(root, { preset: 'default' });
  saveNotesSettings(root, { enabled: true });
}

describe('Notes workspace tools', () => {
  test('every operation has a dedicated setting, runtime schema and correct critic role', () => {
    for (const definition of NOTE_WORKSPACE_TOOL_DEFINITIONS) {
      expect(DEFAULT_NOTE_TOOL_PERMISSIONS[definition.name]).toBe(
        definition.category === 'read' ? 'auto' : 'ask',
      );
      const tool = noteTools.find((tool) => tool.name === definition.name)!;
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(registry.isAllowedForRole(tool.name, 'critic')).toBe(definition.category === 'read');
      expect(toolsForRole('manager').some((row) => row.name === `kory__${tool.name}`)).toBe(true);
    }
  });

  test('reads auto, edits ask, Guarded/YOLO skip defaults but explicit Ask and Block win', async () => {
    for (const mode of ['ask', 'guarded', 'yolo'] as const) {
      reset();
      const input = {
        name: `Mode ${mode}`,
        definition: {
          version: 1,
          sort: [],
          view: { kind: 'table', fields: [{ source: 'system', field: 'title' }] },
        },
      };
      let prompts = 0;
      const ctx = context(mode);
      ctx.waitForUserInput = async () => {
        prompts++;
        return 'Allow once';
      };
      await run('list_note_bases', {}, ctx);
      expect(prompts).toBe(0);
      await run('create_note_base', input, ctx);
      expect(prompts).toBe(mode === 'ask' ? 1 : 0);
      saveNotesAgentPermissions(root, {
        preset: 'custom',
        tools: DEFAULT_NOTE_TOOL_PERMISSIONS,
        overrides: { create_note_base: 'ask' },
      });
      await run('create_note_base', { ...input, name: `${input.name} explicit` }, ctx);
      expect(prompts).toBe(mode === 'ask' ? 2 : 1);
      saveNotesAgentPermissions(root, {
        preset: 'custom',
        overrides: { create_note_base: 'block' },
        tools: { ...DEFAULT_NOTE_TOOL_PERMISSIONS, create_note_base: 'block' },
      });
      await expect(run('create_note_base', { ...input, name: 'blocked' }, ctx)).rejects.toThrow(
        /block/,
      );
    }
    reset();
  });

  test('creates, edits, queries, trashes and restores a Base with stale-write rejection', async () => {
    reset();
    await notes.createNote(
      { title: 'Workspace property', content: '---\nstatus: open\n---\nBody' },
      root,
    );
    const base = await run('create_note_base', {
      name: 'Open findings',
      definition: {
        version: 1,
        filter: {
          kind: 'predicate',
          field: { source: 'property', key: 'status', type: 'text' },
          operator: 'eq',
          value: 'open',
        },
        sort: [],
        view: { kind: 'table', fields: [{ source: 'system', field: 'title' }] },
      },
    });
    expect((await run('read_note_base', { baseId: base.id })).revision).toBe(1);
    expect((await run('query_note_base', { baseId: base.id })).rows.length).toBeGreaterThan(0);
    const updated = await run('update_note_base', {
      baseId: base.id,
      expectedRevision: 1,
      name: 'Current findings',
    });
    await expect(
      run('update_note_base', { baseId: base.id, expectedRevision: 1, name: 'stale' }),
    ).rejects.toThrow(/changed/);
    const trashed = await run('trash_note_base', {
      baseId: base.id,
      expectedRevision: updated.revision,
    });
    expect(
      (await run('restore_note_base', { baseId: base.id, expectedRevision: trashed.revision }))
        .trashedAt,
    ).toBeUndefined();
  });

  test('patches validated Canvas cards without dropping unrelated cards or changing graph claims', async () => {
    reset();
    const a = await notes.createNote({ title: 'Canvas A' }, root),
      b = await notes.createNote({ title: 'Canvas B' }, root);
    const doc = canvasFromNotes('Board', [a, b]);
    const created = await run('create_note_canvas', { document: doc });
    const patched = await run('patch_note_canvas', {
      noteId: created.noteId,
      expectedRevision: 1,
      upsertCards: [{ ...doc.cards[0], text: 'Changed', x: 80 }],
      upsertEdges: [{ id: 'edge', from: doc.cards[0]!.id, to: doc.cards[1]!.id }],
    });
    expect(patched.document.cards).toHaveLength(2);
    expect(patched.document.cards[0].text).toBe('Changed');
    expect(await notes.listNoteRelationships(root, { noteId: a.id })).toHaveLength(0);
    await expect(
      run('patch_note_canvas', {
        noteId: created.noteId,
        expectedRevision: 1,
        removeCardIds: [doc.cards[0]!.id],
      }),
    ).rejects.toThrow(/revision conflict/);
    const foreign = await notes.createNote({ title: 'Foreign' }, foreignRoot);
    await expect(
      run('create_note_canvas', { document: canvasFromNotes('Foreign board', [foreign]) }),
    ).rejects.toThrow(/foreign/);
    await expect(
      notes.updateNote(
        created.noteId,
        { content: '{"v":1,"name":"Broken","cards":[{}],"edges":[]}', expectedRevision: 2 },
        root,
      ),
    ).rejects.toThrow(/Invalid canvas/);
    expect((await run('read_note_canvas', { noteId: created.noteId })).document.cards).toHaveLength(
      2,
    );
  });

  test('lists where a note appears across backlinks, canvases and saved views', async () => {
    reset();
    const target = await notes.createNote({ title: 'Appearance tool target' }, root);
    await notes.createNote({
      title: 'Appearance tool linker',
      content: `[[${target.title}]]`,
    }, root);
    const board = await run('create_note_canvas', {
      document: canvasFromNotes('Appearance tool board', [target]),
    });
    expect(board.document.cards[0].noteId).toBe(target.id);
    const appearances = await run('list_note_appearances', { noteId: target.id });
    expect(appearances.noteId).toBe(target.id);
    expect(appearances.counts.backlinks).toBe(1);
    expect(appearances.counts.canvases).toBe(1);
    expect(appearances.canvases[0]).toMatchObject({
      title: 'Appearance tool board',
      noteId: board.noteId,
    });
    expect(appearances.truncated).toBe(false);
    await expect(run('list_note_appearances', { noteId: 'missing-note' })).rejects.toThrow(
      /not found/i,
    );
  });

  test('property batches and removals are atomic and reject stale writes', async () => {
    reset();
    const note = await notes.createNote(
      { title: 'Batch properties', content: '---\nstatus: open\n---\nBody' },
      root,
    );
    const updated = await run('patch_note_properties', {
      noteId: note.id,
      expectedRevision: 1,
      patches: [
        { op: 'set', key: 'priority', type: 'number', value: 3 },
        { op: 'remove', key: 'status' },
      ],
    });
    expect(updated.properties).toContainEqual({ key: 'priority', type: 'number', value: 3 });
    await expect(
      run('remove_note_property', { noteId: note.id, expectedRevision: 1, key: 'priority' }),
    ).rejects.toThrow(/conflict/);
    await expect(
      run('patch_note_properties', {
        noteId: note.id,
        expectedRevision: 2,
        patches: [
          { op: 'set', key: 'priority', type: 'number', value: 7 },
          { op: 'set', key: 'invalid', type: 'number', value: 'bad' },
        ],
      }),
    ).rejects.toThrow();
    expect((await notes.getNote(note.id, root))!.revision).toBe(2);
    expect(
      (await run('remove_note_property', { noteId: note.id, expectedRevision: 2, key: 'priority' }))
        .properties,
    ).toHaveLength(0);
  });

  test('folder and tag appearance tools set, clear and validate through the note permission path', async () => {
    reset();
    expect(
      await run('set_folder_appearance', { path: '/Research/', emoji: '🔬', color: 'violet' }),
    ).toEqual({ path: '/Research', emoji: '🔬', color: 'violet' });
    expect(await run('set_folder_appearance', { path: '/Research', emoji: null })).toEqual({
      path: '/Research',
      color: 'violet',
    });
    expect(await run('set_tag_appearance', { tag: 'blocked', color: '#FF0000' })).toEqual({
      tag: 'blocked',
      color: '#ff0000',
    });
    expect(await run('set_tag_appearance', { tag: 'blocked', color: null })).toBeNull();
    await expect(run('set_folder_appearance', { path: '/x', emoji: 'two 🔬🔬' })).rejects.toThrow(
      /emoji/i,
    );
    await expect(run('set_tag_appearance', { tag: 'x', color: 'red' })).rejects.toThrow(/Color/);
    saveNotesAgentPermissions(root, { preset: 'custom', tools: { set_tag_appearance: 'block' } });
    await expect(run('set_tag_appearance', { tag: 'x', color: 'accent' })).rejects.toThrow();
    reset();
  });

  test('refreshes stale evidence as a new proposal without losing history or accepting it', async () => {
    reset();
    const a = await notes.createNote({ title: 'Evidence A' }, root),
      b = await notes.createNote({ title: 'Evidence B' }, root);
    const proposed = await run('propose_note_relationship', {
      fromId: a.id,
      toId: b.id,
      type: 'supports',
      evidence: 'Measured evidence',
      expectedSourceRevision: 1,
      expectedTargetRevision: 1,
    });
    const accepted = await run('review_note_relationship', {
      fromId: a.id,
      toId: b.id,
      expectedRevision: proposed.revision,
      status: 'accepted',
    });
    await notes.updateNote(a.id, { content: 'New measurement', expectedRevision: 1 }, root);
    const refreshed = await run('refresh_note_relationship', {
      fromId: a.id,
      toId: b.id,
      expectedRevision: accepted.revision,
      expectedSourceRevision: 2,
      expectedTargetRevision: 1,
      type: 'contradicts',
      evidence: 'New contradictory measurement',
    });
    expect(refreshed.status).toBe('proposed');
    expect(refreshed.stale).toBe(false);
    expect(refreshed.revision).toBeGreaterThan(accepted.revision);
    await expect(
      run('refresh_note_relationship', {
        fromId: a.id,
        toId: b.id,
        expectedRevision: accepted.revision,
        expectedSourceRevision: 2,
        expectedTargetRevision: 1,
        type: 'supports',
        evidence: 'Replay',
      }),
    ).rejects.toThrow(/changed/);
    expect((await run('list_note_relationships', { noteId: a.id })).rows[0].type).toBe(
      'contradicts',
    );
  });

  test('attachment reads are bounded and mutation requires the reviewed note revision', async () => {
    reset();
    const note = await notes.createNote({ title: 'Attachment tool note' }, root);
    const attachment = await run('add_note_attachment', {
      noteId: note.id,
      expectedRevision: 1,
      filename: 'evidence.txt',
      mimeType: 'text/plain',
      encoding: 'utf8',
      data: 'e'.repeat(2000),
    });
    expect((await run('list_note_attachments', { noteId: note.id })).rows[0].filename).toBe(
      'evidence.txt',
    );
    const excerpt = await run('read_note_attachment', {
      attachmentId: attachment.id,
      maxChars: 256,
    });
    expect(excerpt.content).toHaveLength(256);
    expect(excerpt.truncated).toBe(true);
    expect(excerpt.storagePath).toBeUndefined();
    await notes.updateNote(note.id, { content: 'Changed', expectedRevision: 1 }, root);
    await expect(
      run('remove_note_attachment', { attachmentId: attachment.id, expectedRevision: 1 }),
    ).rejects.toThrow(/changed/);
    await run('remove_note_attachment', { attachmentId: attachment.id, expectedRevision: 2 });
    expect((await run('list_note_attachments', { noteId: note.id })).rows).toHaveLength(0);
  });

  test('recovery tools are scoped, bounded and revision-safe; disabled Notes rejects stale catalogs', async () => {
    reset();
    const note = await notes.createNote(
      { title: 'Recover tool note', content: 'x'.repeat(2000) },
      root,
    );
    expect(
      (await run('read_note_revision', { noteId: note.id, revision: 1, maxChars: 256 })).truncated,
    ).toBe(true);
    const deletion = await registry.execute(context(), {
      id: 'trash-recovery',
      name: 'delete_note',
      input: { id: note.id },
    });
    expect(deletion.isError).toBe(false);
    const trashed = (await run('list_note_trash', {})).rows.find(
      (row: { id: string }) => row.id === note.id,
    );
    await run('restore_note', { noteId: note.id, expectedRevision: trashed.revision });
    expect((await notes.getNote(note.id, root))!.content.length).toBe(2000);
    saveNotesSettings(root, { enabled: false });
    await expect(run('list_note_bases', {})).rejects.toThrow(/disabled/);
    reset();
    await expect(
      run(
        'create_note_canvas',
        { document: canvasFromNotes('Critic writes', []) },
        { ...context(), callerRole: 'critic' },
      ),
    ).rejects.toThrow(/critic/);
  });
});
