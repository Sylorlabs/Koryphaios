import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '@koryphaios/shared';
import type { ContextArchiveService } from '../context-archive';
import type { ISessionStore } from '../../stores/session-store';
import {
  buildAutoIsolatedPromptSection,
  buildSiblingChatsPromptSection,
  findSiblingChats,
} from '../sibling-chats';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function dir(name = 'folder'): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kory-siblings-')));
  roots.push(root);
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function session(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    title: `Chat ${id}`,
    messageCount: 0,
    totalTokensIn: 0,
    totalTokensOut: 0,
    totalCost: 0,
    version: 1,
    createdAt: 1_000,
    updatedAt: 5_000,
    ...over,
  };
}

function store(rows: Session[]): ISessionStore {
  return { listActive: async () => rows } as ISessionStore;
}

function archive(entriesBySession: Record<string, { kind: string; label: string; ts: number }[]>) {
  return {
    listRecent: async (sessionId: string) => (entriesBySession[sessionId] ?? []) as never,
  } as unknown as ContextArchiveService;
}

const idle = () => false;

describe('findSiblingChats', () => {
  test('lists chats in the same folder, excluding the chat itself', async () => {
    const folder = dir();
    const self = session('self', { workingDirectory: folder });
    const sibling = session('sib', { workingDirectory: folder });
    const siblings = await findSiblingChats({
      session: self,
      sessions: store([self, sibling]),
      isRunning: idle,
    });
    expect(siblings.map((s) => s.id)).toEqual(['sib']);
    expect(siblings[0].isolation).toBe('in place');
  });

  test('matches nested folders in both directions', async () => {
    const parent = dir('parent');
    const nested = join(parent, 'nested');
    mkdirSync(nested, { recursive: true });
    const self = session('self', { workingDirectory: nested });
    const outer = session('outer', { workingDirectory: parent });
    const unrelated = session('far', { workingDirectory: dir('elsewhere') });
    const fromNested = await findSiblingChats({
      session: self,
      sessions: store([self, outer, unrelated]),
      isRunning: idle,
    });
    expect(fromNested.map((s) => s.id)).toEqual(['outer']);
    // And the reverse direction.
    const outerSelf = session('outer', { workingDirectory: parent });
    const fromOuter = await findSiblingChats({
      session: outerSelf,
      sessions: store([outerSelf, self, unrelated]),
      isRunning: idle,
    });
    expect(fromOuter.map((s) => s.id)).toEqual(['self']);
  });

  test('skips revision-picker isolated chats but keeps auto-isolated ones', async () => {
    const folder = dir();
    const self = session('self', { workingDirectory: folder });
    const picked = session('picked', {
      workingDirectory: folder,
      gitWorkspace: {
        path: '/tmp/picked-checkout',
        branch: 'main',
        baseCommit: 'abc',
        repositoryPath: '/tmp/picked-repo',
        isolation: 'independent-repository',
      },
    });
    const auto = session('auto', {
      workingDirectory: folder,
      gitWorkspace: {
        path: '/tmp/auto-checkout',
        branch: 'kory-copy',
        baseCommit: 'abc',
        repositoryPath: '/tmp/auto-repo',
        isolation: 'independent-repository',
        autoIsolated: {
          sourceDirectory: folder,
          sourceBranch: 'main',
          sourceHead: 'abc',
          reason: 'collision',
          isolatedAt: Date.now(),
        },
      },
    });
    const siblings = await findSiblingChats({
      session: self,
      sessions: store([self, picked, auto]),
      isRunning: idle,
    });
    expect(siblings.map((s) => s.id)).toEqual(['auto']);
    expect(siblings[0].isolation).toBe('own copy, will merge back');
  });

  test('returns nothing for an isolated or folder-less chat', async () => {
    const folder = dir();
    const other = session('other', { workingDirectory: folder });
    const isolated = session('self', {
      workingDirectory: folder,
      gitWorkspace: {
        path: '/tmp/x-checkout',
        branch: 'b',
        baseCommit: 'a',
        repositoryPath: '/tmp/x-repo',
        isolation: 'independent-repository',
        autoIsolated: {
          sourceDirectory: folder,
          sourceBranch: 'main',
          sourceHead: 'a',
          reason: 'r',
          isolatedAt: Date.now(),
        },
      },
    });
    const globals = session('global', {});
    for (const self of [isolated, globals]) {
      const siblings = await findSiblingChats({
        session: self,
        sessions: store([self, other]),
        isRunning: idle,
      });
      expect(siblings).toEqual([]);
    }
  });

  test('reports busy state, update age and recent file edits', async () => {
    const folder = dir();
    const now = Date.now();
    const self = session('self', { workingDirectory: folder });
    const sibling = session('sib', { workingDirectory: folder, updatedAt: now - 3 * 60_000 });
    const entries = {
      sib: [
        { kind: 'file_edit', label: 'write_file src/a.ts', ts: now - 60_000 },
        { kind: 'file_edit', label: 'write_file src/a.ts', ts: now - 50_000 },
        { kind: 'file_edit', label: 'patch src/b.ts', ts: now - 40_000 },
        { kind: 'tool_call', label: 'bash ls', ts: now - 30_000 },
        { kind: 'file_edit', label: 'write_file old.ts', ts: now - 25 * 60 * 60 * 1000 },
      ],
    };
    const siblings = await findSiblingChats({
      session: self,
      sessions: store([self, sibling]),
      isRunning: (id) => id === 'sib',
      archive: archive(entries),
      now,
    });
    expect(siblings[0].busy).toBe(true);
    expect(siblings[0].updatedAt).toBe(sibling.updatedAt);
    // Newest first, deduped, file_edit only, within 24h.
    expect(siblings[0].recentFiles).toEqual(['src/b.ts', 'src/a.ts']);
  });
});

describe('buildSiblingChatsPromptSection', () => {
  const sibling = {
    id: 'sib',
    title: 'Sibling chat',
    busy: false,
    updatedAt: Date.now() - 3 * 60_000,
    isolation: 'in place' as const,
    recentFiles: ['src/a.ts'],
  };

  test('is empty without siblings', () => {
    expect(buildSiblingChatsPromptSection({ siblings: [], worktreeMode: 'auto' })).toBe('');
  });

  test('lists each sibling on one line with state and files', () => {
    const section = buildSiblingChatsPromptSection({ siblings: [sibling], worktreeMode: 'auto' });
    expect(section).toContain('## Other chats in this folder');
    expect(section).toContain('Sibling chat (id sib)');
    expect(section).toContain('idle');
    expect(section).toContain('3 min ago');
    expect(section).toContain('in place');
    expect(section).toContain('src/a.ts');
  });

  test('guidance offers isolate_chat under auto/always but not never', () => {
    const auto = buildSiblingChatsPromptSection({ siblings: [sibling], worktreeMode: 'auto' });
    const always = buildSiblingChatsPromptSection({ siblings: [sibling], worktreeMode: 'always' });
    const never = buildSiblingChatsPromptSection({ siblings: [sibling], worktreeMode: 'never' });
    expect(auto).toContain('isolate_chat');
    expect(always).toContain('isolate_chat');
    expect(auto).toContain('ask_user');
    expect(never).toContain('Worktree is Off');
    expect(never).not.toContain('isolate_chat');
  });

  test('shows "nothing recorded" without recent files', () => {
    const section = buildSiblingChatsPromptSection({
      siblings: [{ ...sibling, recentFiles: [] }],
      worktreeMode: 'auto',
    });
    expect(section).toContain('nothing recorded');
  });
});

describe('buildAutoIsolatedPromptSection', () => {
  test('names the source folder, reason and merge_chat_back', () => {
    const section = buildAutoIsolatedPromptSection({
      sourceDirectory: '/repo',
      reason: 'busy sibling',
    });
    expect(section).toContain('## This chat runs in its own copy');
    expect(section).toContain('/repo');
    expect(section).toContain('busy sibling');
    expect(section).toContain('merge_chat_back');
  });
});
