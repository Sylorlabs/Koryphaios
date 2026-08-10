import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  autosaveDelayForDraft,
  createDraftRegistry,
  draftExitAction,
  draftLifecycleAction,
  isCurrentDraftVersion,
  utf8DraftBytes,
} from './draft-save';

describe('long-form draft saving', () => {
  it('counts persistence bytes instead of JavaScript code units', () => {
    expect(utf8DraftBytes('essay')).toBe(5);
    expect(utf8DraftBytes('✨')).toBe(3);
  });

  it('only marks the exact saved revision clean', () => {
    expect(isCurrentDraftVersion(4, 4)).toBe(true);
    expect(isCurrentDraftVersion(4, 5)).toBe(false);
  });

  it('honors disabled autosave and size errors while bounding persisted settings', () => {
    expect(autosaveDelayForDraft({ enabled: false, overBudget: false, delayMs: 1500 })).toBeNull();
    expect(autosaveDelayForDraft({ enabled: true, overBudget: true, delayMs: 1500 })).toBeNull();
    expect(autosaveDelayForDraft({ enabled: true, overBudget: false, delayMs: 20 })).toBe(250);
    expect(autosaveDelayForDraft({ enabled: true, overBudget: false, delayMs: 50_000 })).toBe(
      10_000,
    );
  });

  it('never turns navigation or teardown into a save when autosave is off', () => {
    expect(draftExitAction({ dirty: false, autosaveEnabled: false })).toBe('none');
    expect(draftExitAction({ dirty: true, autosaveEnabled: false })).toBe('hold');
    expect(draftExitAction({ dirty: true, autosaveEnabled: true })).toBe('save');
  });

  it('keeps passive lifecycle events write-free when autosave is disabled', () => {
    for (const trigger of ['autosave', 'visibility-hidden'] as const) {
      expect(
        draftLifecycleAction({
          trigger,
          dirty: true,
          autosaveEnabled: false,
          sameScope: true,
        }),
      ).toBe('none');
    }
    for (const trigger of ['navigation', 'destroy'] as const) {
      expect(
        draftLifecycleAction({
          trigger,
          dirty: true,
          autosaveEnabled: false,
          sameScope: true,
        }),
      ).toBe('hold');
    }
    expect(
      draftLifecycleAction({
        trigger: 'explicit',
        dirty: true,
        autosaveEnabled: false,
        sameScope: true,
      }),
    ).toBe('save');
  });

  it('uses the same policy for every lifecycle write site in NotesCanvas', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/lib/components/NotesCanvas.svelte'),
      'utf8',
    );
    expect(source).toContain("persistCanvas('visibility-hidden')");
    expect(source).toContain("persistCanvas('navigation')");
    expect(source).toContain("persistCanvas('destroy')");
    expect(source.match(/persistCanvas\('explicit'\)/g)).toHaveLength(2);
    expect(source).toContain('const action = draftLifecycleAction({');
    expect(source).toContain('autosaveEnabled: notesStore.settings.autosaveEnabled');
    expect(source).not.toContain('save(false)');
    expect(source).not.toMatch(/visibilityState[\s\S]{0,180}save\(false\)/);
    expect(source).not.toMatch(/onDestroy\([\s\S]{0,260}save\(false\)/);
  });

  it('saves lifecycle work only when autosave is enabled and blocks stale scopes', () => {
    for (const trigger of ['autosave', 'navigation', 'visibility-hidden', 'destroy'] as const) {
      expect(
        draftLifecycleAction({
          trigger,
          dirty: true,
          autosaveEnabled: true,
          sameScope: true,
        }),
      ).toBe('save');
    }
    expect(
      draftLifecycleAction({
        trigger: 'explicit',
        dirty: true,
        autosaveEnabled: false,
        sameScope: false,
      }),
    ).toBe('block');
  });

  it('holds independent project/document drafts across editor remounts', () => {
    const registry = createDraftRegistry<{ content: string }>('draft-save-test');
    registry.clear();
    registry.set('/project-a\0note-1', { content: 'first' });
    registry.set('/project-b\0note-2', { content: 'second' });

    const remounted = createDraftRegistry<{ content: string }>('draft-save-test');
    expect(remounted.list()).toHaveLength(2);
    expect(remounted.get('/project-a\0note-1')?.content).toBe('first');
    expect(remounted.get('/project-b\0note-2')?.content).toBe('second');
    remounted.clear();
  });
});
