import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('routes Network navigation directly through the guarded openNote handler', () => {
  const source = readFileSync(join(process.cwd(), 'src/lib/components/NotesPanel.svelte'), 'utf8');
  const network = source.match(/<NotesNetworkWorkspace\b[^>]*\/>/)?.[0];
  expect(network).toContain('onOpenNote={openNote}');
  // The workspace must remain mounted until both the draft guard and fetch succeed.
  const handler = source.slice(
    source.indexOf('  async function openNote('),
    source.indexOf('  async function createNewNote('),
  );
  const guard = handler.indexOf('await canLeaveCurrentNote()');
  const fetch = handler.indexOf('await notesStore.fetchNote(id)');
  const success = handler.indexOf('if (!opened || notesStore.currentNote?.id !== id) return;');
  const switchView = handler.indexOf('activeView =');
  expect(guard).toBeGreaterThan(-1);
  expect(fetch).toBeGreaterThan(guard);
  expect(success).toBeGreaterThan(fetch);
  expect(switchView).toBeGreaterThan(success);
  expect(handler.match(/activeView\s*=/g)).toHaveLength(1);
});

it('routes chat note targets through the draft guarded editor after mounting Notes', () => {
  const panel = readFileSync(join(process.cwd(), 'src/lib/components/NotesPanel.svelte'), 'utf8');
  const page = readFileSync(join(process.cwd(), 'src/routes/+page.svelte'), 'utf8');
  const handler = panel.slice(
    panel.indexOf('  async function handleOpenNoteTarget('),
    panel.indexOf('  function handleReviewDraftEvent('),
  );
  expect(handler).toContain('await notesStore.resolveNoteTarget(target)');
  expect(handler).toContain('project === projectStore.currentPath');
  expect(handler).toContain('await openNote(id)');
  expect(handler).not.toContain('notesStore.fetchNote');
  const route = page.slice(
    page.indexOf('    const handleOpenNote ='),
    page.indexOf("    window.addEventListener('open-note'"),
  );
  expect(route.indexOf('showNotes = true')).toBeLessThan(route.indexOf('await tick()'));
  expect(route.indexOf('await tick()')).toBeLessThan(
    route.indexOf("new CustomEvent('kory-notes-open-target'"),
  );
});
