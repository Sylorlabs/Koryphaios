import { describe, expect, test } from 'bun:test';
import { buildWorkNote } from '../work-note';

describe('evidence-backed work notes', () => {
  test('binds agent claims to host-owned session and model provenance', () => {
    const note = buildWorkNote(
      {
        title: 'Harden Notes autosave',
        summary: 'Removed the self-refetch loop without weakening conflict detection.',
        objective: 'Keep large vault editing stable.',
        status: 'completed',
        decisions: ['Use exact mutation correlation instead of a timing heuristic.'],
        changedFiles: ['frontend/src/lib/stores/notes.svelte.ts'],
        commands: ['bun run test src/lib/stores/notes.test.ts'],
        tests: [{ name: 'Notes store regression suite', outcome: 'pass', evidence: '24 passed' }],
        relatedNotes: ['Notes architecture'],
      },
      {
        sessionId: 'session-authoritative',
        provider: 'codex',
        model: 'gpt-5.6-sol',
        agentId: 'worker-notes-1',
        goalId: 'goal-1',
        createdAt: new Date('2026-08-30T22:30:00.000Z'),
      },
    );

    expect(note.folderPath).toBe('/Work Notes/2026/08');
    expect(note.tags).toEqual(['agent-work-note', 'evidence', 'status-completed']);
    expect(note.content).toContain('| Session | `session-authoritative` |');
    expect(note.content).toContain('| Model | `gpt-5.6-sol` |');
    expect(note.content).toContain('| Agent | `worker-notes-1` |');
    expect(note.content).toContain('**PASS** — Notes store regression suite — 24 passed');
    expect(note.content).toContain('[[Notes architecture]]');
  });

  test('renders command backticks without breaking Markdown', () => {
    const note = buildWorkNote(
      {
        title: 'Command evidence',
        summary: 'Captured exact verification.',
        status: 'partial',
        commands: ['printf `value`'],
      },
      { sessionId: 'session-2', createdAt: new Date('2026-01-02T00:00:00.000Z') },
    );

    expect(note.content).toContain('- `` printf `value` ``');
  });

  test('rejects provenance-free or content-free work notes', () => {
    expect(() =>
      buildWorkNote(
        { title: 'Missing provenance', summary: 'No session.', status: 'blocked' },
        { sessionId: '' },
      ),
    ).toThrow('session provenance');
    expect(() =>
      buildWorkNote(
        { title: 'Missing outcome', summary: '   ', status: 'decision' },
        { sessionId: 'session-3' },
      ),
    ).toThrow('summary is required');
  });
});
