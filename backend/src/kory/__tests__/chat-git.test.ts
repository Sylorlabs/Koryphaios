import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatPullRequest } from '@koryphaios/shared';
import { ChatGit } from '../chat-git';
import { createSessionWorkspace } from '../session-workspace';
import { GitExecutor } from '../git-executor';
import { githubRepositoryFromRemote } from '../github-pull-requests';
import { directoryLinkType } from '../../runtime/platform';

let root: string;
let source: string;
let chat: string;
let sibling: string;
let initial: string;
let feature: string;
let service: ChatGit;
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
async function input(target: Parameters<ChatGit['switch']>[0]['target']) {
  const state = await service.state('chat-one');
  return { target, expectedHead: state.head!, expectedBranch: state.branch };
}
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'kory-chat-git-')));
  source = join(root, 'source');
  mkdirSync(source);
  git(source, 'init', '-b', 'main');
  git(source, 'config', 'user.name', 'Test');
  git(source, 'config', 'user.email', 'test@example.test');
  git(source, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(source, 'file.txt'), 'baseline');
  mkdirSync(join(source, 'package'));
  writeFileSync(join(source, 'package', 'index.ts'), 'initial');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'Baseline');
  initial = git(source, 'rev-parse', 'HEAD');
  git(source, 'switch', '-c', 'feature');
  writeFileSync(join(source, 'file.txt'), 'feature');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'Feature details');
  feature = git(source, 'rev-parse', 'HEAD');
  git(source, 'switch', 'main');
  chat = (
    await createSessionWorkspace(source, { storageRoot: join(root, 'chats'), branch: 'chat-one' })
  ).path;
  sibling = (
    await createSessionWorkspace(source, { storageRoot: join(root, 'chats'), branch: 'chat-two' })
  ).path;
  service = new ChatGit(chat);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('chat-local Git revisions', () => {
  test('switches an existing chat branch without changing the source or another chat', async () => {
    git(chat, 'branch', 'local-feature', initial);
    await service.switch(await input({ kind: 'branch', ref: 'refs/heads/local-feature' }));
    expect(git(chat, 'branch', '--show-current')).toBe('local-feature');
    expect(git(source, 'branch', '--show-current')).toBe('main');
    expect(git(sibling, 'branch', '--show-current')).toBe('chat-two');
    expect(git(source, 'rev-parse', 'HEAD')).toBe(initial);
    expect(git(sibling, 'rev-parse', 'HEAD')).toBe(initial);
    expect(git(chat, 'remote')).toBe('');
  });
  test('imports a source-only branch into a new chat-local branch and exposes details', async () => {
    const snapshot = await service.state('chat-one');
    expect(snapshot.sourceRefs.some((ref) => ref.ref === 'refs/heads/feature')).toBe(true);
    const detail = await service.details('refs/heads/feature', true);
    expect(detail.subject).toBe('Feature details');
    expect(detail.stat).toContain('file.txt');
    await service.switch(
      await input({
        kind: 'branch',
        ref: 'refs/heads/feature',
        source: true,
        expectedHash: feature,
        branch: 'work-on-feature',
      }),
    );
    expect(git(chat, 'rev-parse', 'HEAD')).toBe(feature);
    expect(readFileSync(join(chat, 'file.txt'), 'utf8')).toBe('feature');
    expect(readFileSync(join(source, 'file.txt'), 'utf8')).toBe('baseline');
    expect(git(source, 'branch', '--show-current')).toBe('main');
  });
  test('new source commits import with read-only access that cannot write source Git metadata', async () => {
    writeFileSync(join(source, 'file.txt'), 'new source commit');
    git(source, 'add', '.');
    git(source, 'commit', '-m', 'Created after the chats');
    const commit = git(source, 'rev-parse', 'HEAD');
    const index = readFileSync(join(source, '.git', 'index'));
    const config = readFileSync(join(source, '.git', 'config'));
    expect(git(chat, 'rev-parse', 'HEAD')).toBe(initial);
    const original = GitExecutor.prototype.exec;
    let imports = 0;
    const transport = spyOn(GitExecutor.prototype, 'exec').mockImplementation(function (
      this: GitExecutor,
      args,
      options,
    ) {
      if (args.includes('fetch') && args.includes(source)) {
        imports++;
        expect(options?.readOnlyRoots).toEqual([source]);
      }
      return original.call(this, args, options);
    });
    try {
      await service.switch(
        await input({ kind: 'commit', ref: commit, source: true, branch: 'new-source-commit' }),
      );
      expect(imports).toBe(1);
    } finally {
      transport.mockRestore();
    }
    expect(git(chat, 'rev-parse', 'HEAD')).toBe(commit);
    expect(readFileSync(join(chat, 'file.txt'), 'utf8')).toBe('new source commit');
    const sourceWrite = await new GitExecutor(chat).exec(
      ['config', '--local', 'test.escape', 'blocked'],
      {
        readOnlyRoots: [source],
        env: { GIT_DIR: join(source, '.git'), GIT_WORK_TREE: source },
      },
    );
    expect(sourceWrite.success).toBe(false);
    expect(readFileSync(join(source, '.git', 'index'))).toEqual(index);
    expect(readFileSync(join(source, '.git', 'config'))).toEqual(config);
    expect(git(source, 'rev-parse', 'HEAD')).toBe(commit);
    expect(git(sibling, 'rev-parse', 'HEAD')).toBe(initial);
  });
  test('source inspection does not run fsmonitor helpers or refresh the source index', async () => {
    const marker = join(root, 'source-helper-ran');
    const hook = join(root, 'fsmonitor');
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
    git(source, 'config', 'core.fsmonitor', hook);
    const index = readFileSync(join(source, '.git', 'index'));
    await service.state('chat-one');
    await service.details('refs/heads/main', true);
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(source, '.git', 'index'))).toEqual(index);
  });

  test('opens a commit on a named branch, never detached', async () => {
    await service.switch(await input({ kind: 'commit', ref: initial, branch: 'from-commit' }));
    expect(git(chat, 'branch', '--show-current')).toBe('from-commit');
    await expect(service.switch(await input({ kind: 'commit', ref: initial }))).rejects.toThrow(
      'new working branch',
    );
  });
  test('rejects staged, unstaged and untracked work without discarding or stashing', async () => {
    const request = await input({ kind: 'branch', ref: 'refs/heads/main' });
    writeFileSync(join(chat, 'file.txt'), 'staged');
    git(chat, 'add', '.');
    writeFileSync(join(chat, 'file.txt'), 'unstaged');
    writeFileSync(join(chat, 'private.txt'), 'private');
    const before = git(chat, 'status', '--porcelain');
    await expect(service.switch(request)).rejects.toThrow('uncommitted');
    expect(git(chat, 'status', '--porcelain')).toBe(before);
    expect(git(chat, 'stash', 'list')).toBe('');
    expect(git(chat, 'branch', '--show-current')).toBe('chat-one');
  });
  test('protects ignored files from checkout collisions', async () => {
    writeFileSync(join(source, 'ignored.txt'), 'committed upstream');
    git(source, 'add', '.');
    git(source, 'commit', '-m', 'Add collision');
    const upstream = git(source, 'rev-parse', 'HEAD');
    writeFileSync(join(chat, '.git', 'info', 'exclude'), 'ignored.txt\n');
    writeFileSync(join(chat, 'ignored.txt'), 'private ignored content');
    await expect(
      service.switch(
        await input({ kind: 'commit', ref: upstream, source: true, branch: 'collision' }),
      ),
    ).rejects.toThrow('Git refused');
    expect(readFileSync(join(chat, 'ignored.txt'), 'utf8')).toBe('private ignored content');
    expect(git(chat, 'branch', '--show-current')).toBe('chat-one');
  });
  test('blocks stale HEAD/branch, in-progress operations, and existing branch overwrite', async () => {
    const request = await input({ kind: 'commit', ref: initial, branch: 'next' });
    await expect(service.switch({ ...request, expectedHead: 'a'.repeat(40) })).rejects.toThrow(
      'changed',
    );
    await expect(service.switch({ ...request, expectedBranch: 'wrong' })).rejects.toThrow(
      'changed',
    );
    writeFileSync(join(chat, '.git', 'MERGE_HEAD'), initial);
    await expect(service.switch(request)).rejects.toThrow('current merge');
    rmSync(join(chat, '.git', 'MERGE_HEAD'));
    await expect(
      service.switch(await input({ kind: 'commit', ref: initial, branch: 'main' })),
    ).rejects.toThrow('already exists');
  });
  test('rejects source checkouts, malicious refs and missing project subdirectories', async () => {
    expect(() => new ChatGit(source)).toThrow('owned isolated');
    for (const ref of ['--help', 'HEAD~1', 'refs/heads/a..b'])
      await expect(service.details(ref)).rejects.toThrow();
    const subService = new ChatGit(join(chat, 'package'));
    git(source, 'rm', '-r', 'package');
    git(source, 'commit', '-m', 'Remove subdirectory');
    await expect(
      subService.switch({
        ...(await input({
          kind: 'commit',
          ref: git(source, 'rev-parse', 'HEAD'),
          source: true,
          branch: 'missing-subdir',
        })),
      }),
    ).rejects.toThrow('subdirectory is absent');
    expect(git(chat, 'branch', '--show-current')).toBe('chat-one');
  });
  test('requires explicit in-place access and retains owned checkout containment', async () => {
    const inPlace = new ChatGit(source, undefined, { allowInPlace: true });
    const state = await inPlace.state('ordinary-chat');
    expect(state.isolated).toBe(false);
    expect(state.head).toBe(initial);
    expect(state.branch).toBe('main');
    expect(() => new ChatGit(source)).toThrow('owned isolated');

    const redirected = join(chat, 'outside');
    symlinkSync(source, redirected, directoryLinkType());
    for (const allowInPlace of [false, true]) {
      expect(() => new ChatGit(redirected, undefined, { allowInPlace })).toThrow('redirected');
    }
    expect(git(source, 'rev-parse', 'HEAD')).toBe(initial);
    expect(git(sibling, 'rev-parse', 'HEAD')).toBe(initial);
  });
  test('fetches a PR into this chat only, pins its head and records details', async () => {
    git(source, 'remote', 'add', 'origin', 'git@github.com:example/project.git');
    git(source, 'update-ref', 'refs/pull/12/head', feature);
    const pr: ChatPullRequest = {
      number: 12,
      repository: 'example/project',
      title: 'Feature PR',
      url: 'https://github.com/example/project/pull/12',
      state: 'open',
      draft: false,
      author: 'author',
      baseBranch: 'main',
      headBranch: 'feature',
      headCommit: feature,
    };
    service = new ChatGit(chat, { list: async () => [pr], get: async () => pr });
    const original = GitExecutor.prototype.exec;
    let fetches = 0;
    const transport = spyOn(GitExecutor.prototype, 'exec').mockImplementation(function (
      this: GitExecutor,
      args,
      options,
    ) {
      if (args.includes('https://github.com/example/project.git')) {
        fetches++;
        expect(args).toContain('--no-write-fetch-head');
        // Test transport: only substitute the fixed GitHub URL, not the service's validation.
        return original.call(
          this,
          args.map((arg) =>
            arg === 'https://github.com/example/project.git'
              ? source
              : arg === 'protocol.file.allow=never'
                ? 'protocol.file.allow=always'
                : arg,
          ),
          options,
        );
      }
      return original.call(this, args, options);
    });
    try {
      expect((await service.prs())[0].number).toBe(12);
      const selected = await service.switch(
        await input({ kind: 'pull-request', number: 12, branch: 'pr/12', expectedHash: feature }),
      );
      expect(fetches).toBe(1);
      expect(selected.pullRequest?.title).toBe('Feature PR');
      expect(git(chat, 'rev-parse', 'HEAD')).toBe(feature);
      expect(git(chat, 'branch', '--show-current')).toBe('pr/12');
      expect(git(chat, 'remote')).toBe('');
      expect(git(source, 'rev-parse', 'HEAD')).toBe(initial);
      expect(git(sibling, 'rev-parse', 'HEAD')).toBe(initial);
      expect((await service.state('chat-one', selected)).selection?.pullRequest?.number).toBe(12);
      await expect(
        service.switch(
          await input({
            kind: 'pull-request',
            number: 12,
            branch: 'stale-pr',
            expectedHash: initial,
          }),
        ),
      ).rejects.toThrow('PR head changed');
      expect(fetches).toBe(1);
    } finally {
      transport.mockRestore();
    }
  });
});

describe('GitHub repository identity', () => {
  test('accepts only credential-free GitHub remotes', () => {
    expect(githubRepositoryFromRemote('https://github.com/owner/repo.git')).toBe('owner/repo');
    expect(githubRepositoryFromRemote('git@github.com:owner/repo.git')).toBe('owner/repo');
    for (const url of [
      'https://token@github.com/owner/repo',
      'https://github.com.evil.test/a/b',
      'file:///tmp/repo',
      'ext::sh -c bad',
      'https://github.com/../repo',
      'https://github.com/a/b?token=secret',
    ])
      expect(githubRepositoryFromRemote(url)).toBeNull();
  });
});
