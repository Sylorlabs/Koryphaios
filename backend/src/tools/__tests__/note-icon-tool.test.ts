import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_AGENT_SETTINGS } from '../../agent-settings';
import { initDb } from '../../db';
import { DEFAULT_NOTE_TOOL_PERMISSIONS, NOTE_WORKSPACE_TOOL_DEFINITIONS } from '@koryphaios/shared';
import { saveNotesAgentPermissions, saveNotesSettings } from '../../notes/notes-settings';
import * as notes from '../../notes/notes-service';
import { resolveToolPermissionPolicy } from '../permission-policy';
import type { ToolContext } from '../registry';

// Capture the live notes change event without a running WebSocket server.
const broadcasts: Array<{ action: string; noteId?: string; sessionId?: string }> = [];
mock.module('../../notes/notes-events', () => ({
  broadcastNotesNetworkUpdate: (action: string, noteId?: string, sessionId?: string) => {
    broadcasts.push({ action, noteId, sessionId });
  },
}));
const { noteWorkspaceTools } = await import('../note-workspace');
const { ToolRegistry } = await import('../registry');

const root = mkdtempSync(join(tmpdir(), 'kory-note-icon-tool-'));
const registry = new ToolRegistry();
for (const tool of noteWorkspaceTools) registry.register(tool);

beforeAll(async () => {
  await initDb();
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function context(approved?: string[], mode: 'ask' | 'guarded' = 'guarded'): ToolContext {
  return {
    sessionId: 'icon-tool-session',
    workingDirectory: root,
    settingsRoot: root,
    callerRole: 'manager',
    approvedToolCallIds: approved ? new Set(approved) : undefined,
    permissionPolicy: resolveToolPermissionPolicy({ ...DEFAULT_AGENT_SETTINGS, permissionMode: mode }),
  };
}

let sequence = 0;
async function setIcon(
  noteId: string,
  icon: unknown,
  options: { approved?: boolean; mode?: 'ask' | 'guarded' } = {},
) {
  const id = `set-note-icon-${++sequence}`;
  const approved = options.approved ?? true;
  const result = await registry.execute(context(approved ? [id] : [], options.mode), {
    id,
    name: 'set_note_icon',
    input: { noteId, icon },
  });
  return result.isError ? { error: result.output } : JSON.parse(result.output);
}

describe('set_note_icon agent tool', () => {
  test('is a write operation with an ask-by-default setting, like the other note edits', () => {
    const definition = NOTE_WORKSPACE_TOOL_DEFINITIONS.find((tool) => tool.name === 'set_note_icon');
    expect(definition?.category).toBe('write');
    expect(DEFAULT_NOTE_TOOL_PERMISSIONS.set_note_icon).toBe('ask');
  });

  test('requires approval, then sets, clears and broadcasts the notes change event', async () => {
    saveNotesAgentPermissions(root, { preset: 'default' });
    saveNotesSettings(root, { enabled: true });
    const note = await notes.createNote({ title: 'Agent icon', content: 'Body' }, root);

    // Ask mode gates every edit on an explicit approval; Guarded skips the default ask.
    const denied = await setIcon(note.id, { kind: 'emoji', value: '🇯🇵' }, { approved: false, mode: 'ask' });
    expect(denied.error).toBeDefined();
    expect((await notes.getNote(note.id, root))?.icon).toBeUndefined();

    broadcasts.length = 0;
    const set = await setIcon(note.id, { kind: 'emoji', value: '👩🏽‍💻', label: 'Coder' });
    expect(set).toEqual({ noteId: note.id, icon: { kind: 'emoji', value: '👩🏽‍💻', label: 'Coder' } });
    expect((await notes.getNote(note.id, root))?.icon).toEqual({ kind: 'emoji', value: '👩🏽‍💻', label: 'Coder' });
    expect((await notes.getNote(note.id, root))?.revision).toBe(note.revision);
    expect(broadcasts).toContainEqual({ action: 'update', noteId: note.id, sessionId: 'icon-tool-session' });

    const cleared = await setIcon(note.id, null);
    expect(cleared).toEqual({ noteId: note.id, icon: null });
    expect((await notes.getNote(note.id, root))?.icon).toBeUndefined();
  });

  test('rejects malformed icons with a readable error and leaves the note unchanged', async () => {
    const note = await notes.createNote({ title: 'Bad agent icon' }, root);
    await setIcon(note.id, { kind: 'emoji', value: '🙂' });
    const bad = await setIcon(note.id, { kind: 'emoji', value: 'two words' });
    expect(bad.error).toContain('Invalid note icon');
    expect((await notes.getNote(note.id, root))?.icon).toEqual({ kind: 'emoji', value: '🙂' });
  });
});
