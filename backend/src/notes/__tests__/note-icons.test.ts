import { beforeAll, expect, test } from 'bun:test';
import { initDb } from '../../db';
import {
  createNote,
  getGraphData,
  getNote,
  listNotes,
  setNoteIcon,
  updateNote,
} from '../notes-service';
import { PROJECT_ROOT } from '../../runtime/paths';

beforeAll(async () => {
  await initDb();
});

test('persists icons across note/catalog/graph reads without invalidating a document draft', async () => {
  const note = await createNote({ title: 'Icon persistence', content: 'Draft base' }, PROJECT_ROOT);
  const icon = { kind: 'builtin' as const, value: '💡' };
  await getGraphData(PROJECT_ROOT); // Warm the cache before changing appearance.
  await setNoteIcon(note.id, icon, PROJECT_ROOT);
  expect((await getNote(note.id, PROJECT_ROOT))?.icon).toEqual(icon);
  expect(
    (await listNotes(undefined, PROJECT_ROOT)).find((row) => row.id === note.id)?.icon,
  ).toEqual(icon);
  expect((await getGraphData(PROJECT_ROOT)).nodes.find((row) => row.id === note.id)?.icon).toEqual(
    icon,
  );
  expect((await getNote(note.id, PROJECT_ROOT))?.revision).toBe(note.revision);
  const saved = await updateNote(
    note.id,
    { content: 'Saved draft', expectedRevision: note.revision },
    PROJECT_ROOT,
  );
  expect(saved.icon).toEqual(icon);
  await setNoteIcon(note.id, null, PROJECT_ROOT);
  expect((await getNote(note.id, PROJECT_ROOT))?.icon).toBeUndefined();
  expect(
    (await getGraphData(PROJECT_ROOT)).nodes.find((row) => row.id === note.id)?.icon,
  ).toBeUndefined();
});

test('accepts uploaded raster icons and rejects invalid, external, or cross-project icons', async () => {
  const note = await createNote({ title: 'Uploaded icon' }, PROJECT_ROOT);
  const icon = { kind: 'image' as const, value: 'data:image/png;base64,iVBORw0KGgo=' };
  await setNoteIcon(note.id, icon, PROJECT_ROOT);
  expect((await getNote(note.id, PROJECT_ROOT))?.icon).toEqual(icon);
  await expect(
    setNoteIcon(note.id, { kind: 'image', value: 'https://example.com/icon.png' }, PROJECT_ROOT),
  ).rejects.toThrow('Invalid note icon');
  await expect(
    setNoteIcon(note.id, { kind: 'builtin', value: 'not an icon' }, PROJECT_ROOT),
  ).rejects.toThrow('Invalid note icon');
  await expect(setNoteIcon(note.id, null, `${PROJECT_ROOT}/another-project`)).rejects.toThrow();
  expect((await getNote(note.id, PROJECT_ROOT))?.icon).toEqual(icon);
});

test('persists free emoji icons, including ZWJ, flag and keycap sequences, and rejects malformed ones', async () => {
  const note = await createNote({ title: 'Emoji icon' }, PROJECT_ROOT);
  for (const value of ['👩🏽‍💻', '🇯🇵', '❤️']) {
    const icon = { kind: 'emoji' as const, value, label: 'Custom' };
    await setNoteIcon(note.id, icon, PROJECT_ROOT);
    expect((await getNote(note.id, PROJECT_ROOT))?.icon).toEqual(icon);
  }
  expect((await getNote(note.id, PROJECT_ROOT))?.revision).toBe(note.revision);
  for (const value of ['ab', '🙂🙂', 'a🙂', '🙂\n', '👨' + '‍👨'.repeat(12)]) {
    await expect(setNoteIcon(note.id, { kind: 'emoji', value }, PROJECT_ROOT)).rejects.toThrow(
      'Invalid note icon',
    );
  }
  expect((await getNote(note.id, PROJECT_ROOT))?.icon).toEqual({
    kind: 'emoji',
    value: '❤️',
    label: 'Custom',
  });
});
