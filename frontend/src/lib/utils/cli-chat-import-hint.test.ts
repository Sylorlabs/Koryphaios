import { describe, expect, it } from 'vitest';
import {
  IMPORT_HINT_DISMISSED_KEY,
  NO_IMPORTABLE_CHATS,
  dismissImportHint,
  fetchImportableSummary,
  importHintText,
  isImportHintDismissed,
  shouldShowImportHint,
  summarizeImportable,
} from './cli-chat-import-hint';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

const discovery = {
  data: {
    providers: [],
    projects: [
      {
        projectPath: '/a',
        chats: [
          { provider: 'claude', providerDisplayName: 'Claude Code', alreadyImported: false },
          { provider: 'claude', providerDisplayName: 'Claude Code', alreadyImported: true },
        ],
      },
      {
        projectPath: '/b',
        chats: [
          { provider: 'codex', providerDisplayName: 'Codex', alreadyImported: false },
          { provider: 'codex', providerDisplayName: 'Codex', alreadyImported: false },
        ],
      },
    ],
  },
};

describe('summarizeImportable', () => {
  it('counts only chats not yet imported and lists their sources once', () => {
    expect(summarizeImportable(discovery)).toEqual({
      count: 3,
      providerNames: ['Claude Code', 'Codex'],
    });
  });

  it('treats malformed or empty bodies as nothing importable', () => {
    expect(summarizeImportable(null)).toEqual(NO_IMPORTABLE_CHATS);
    expect(summarizeImportable({ data: { projects: 'nope' } })).toEqual(NO_IMPORTABLE_CHATS);
    expect(
      summarizeImportable({
        data: { projects: [{ chats: [null, 4, { alreadyImported: false }] }] },
      }),
    ).toEqual({ count: 1, providerNames: [] });
  });
});

describe('importHintText', () => {
  it('names the count and the sources', () => {
    expect(importHintText({ count: 3, providerNames: ['Claude Code', 'Codex'] })).toBe(
      'Import 3 chats from Claude Code / Codex',
    );
    expect(importHintText({ count: 1, providerNames: ['Codex'] })).toBe('Import 1 chat from Codex');
    expect(importHintText({ count: 2, providerNames: [] })).toBe('Import 2 chats from local CLIs');
  });
});

describe('shouldShowImportHint', () => {
  it('shows only when chats are importable and the hint is not dismissed', () => {
    const summary = { count: 2, providerNames: ['Codex'] };
    expect(shouldShowImportHint(summary, false)).toBe(true);
    expect(shouldShowImportHint(summary, true)).toBe(false);
    expect(shouldShowImportHint(NO_IMPORTABLE_CHATS, false)).toBe(false);
  });
});

describe('dismissal storage', () => {
  it('remembers a dismissal across reads', () => {
    const storage = memoryStorage();
    expect(isImportHintDismissed(storage)).toBe(false);
    dismissImportHint(storage);
    expect(storage.data.get(IMPORT_HINT_DISMISSED_KEY)).toBe('1');
    expect(isImportHintDismissed(storage)).toBe(true);
  });

  it('survives storage that throws on every access', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(isImportHintDismissed(broken)).toBe(false);
    expect(() => dismissImportHint(broken)).not.toThrow();
    expect(() => dismissImportHint(undefined)).not.toThrow();
  });
});

describe('fetchImportableSummary', () => {
  it('reads the discovery body into a summary', async () => {
    const summary = await fetchImportableSummary(async () => ({
      ok: true,
      json: async () => discovery,
    }));
    expect(summary.count).toBe(3);
  });

  it('reports nothing importable on an HTTP error or a thrown request', async () => {
    expect(
      await fetchImportableSummary(async () => ({ ok: false, json: async () => discovery })),
    ).toEqual(NO_IMPORTABLE_CHATS);
    expect(
      await fetchImportableSummary(async () => {
        throw new Error('offline');
      }),
    ).toEqual(NO_IMPORTABLE_CHATS);
    expect(await fetchImportableSummary(async () => undefined)).toEqual(NO_IMPORTABLE_CHATS);
  });
});
