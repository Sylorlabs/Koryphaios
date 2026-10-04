import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import type { ChatPullRequest } from '@koryphaios/shared';
import { ValidationError } from '../errors/types';
import { getSafeSubprocessEnv } from '../runtime/safe-env';

const execFileAsync = promisify(execFile);

/** Only GitHub.com repository identities, never caller-supplied transport URLs. */
export function githubRepositoryFromRemote(remote: string): string | null {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
      remote.trim(),
    );
  if (!match || match[1] === '.' || match[1] === '..' || match[2] === '.' || match[2] === '..')
    return null;
  return `${match[1]}/${match[2]}`;
}

export interface PullRequestReader {
  list(repository: string): Promise<ChatPullRequest[]>;
  get(repository: string, number: number): Promise<ChatPullRequest>;
}

export class GitHubPullRequests implements PullRequestReader {
  private async read(repository: string, suffix: string): Promise<unknown> {
    if (githubRepositoryFromRemote(`https://github.com/${repository}`) !== repository) {
      throw new ValidationError('A GitHub.com repository is required.');
    }
    try {
      // gh owns login credentials. Fixed GET endpoints only: no shell, extensions,
      // caller-defined hostname, raw tokens in argv, or repository working directory.
      const { stdout } = await execFileAsync(
        'gh',
        ['api', '--hostname', 'github.com', `repos/${repository}/pulls${suffix}`],
        {
          cwd: homedir(),
          env: getSafeSubprocessEnv({ GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' }),
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
          encoding: 'utf8',
        },
      );
      return JSON.parse(stdout);
    } catch {
      throw new ValidationError(
        'Could not load GitHub pull requests. Install GitHub CLI (gh), run gh auth login, and check access to this repository.',
      );
    }
  }

  async list(repository: string): Promise<ChatPullRequest[]> {
    const data = await this.read(repository, '?state=open&per_page=30');
    if (!Array.isArray(data))
      throw new ValidationError('GitHub returned an invalid pull request list.');
    return data.map((item) => parsePullRequest(repository, item));
  }

  async get(repository: string, number: number): Promise<ChatPullRequest> {
    if (!Number.isSafeInteger(number) || number < 1 || number > 1_000_000_000)
      throw new ValidationError('Enter a valid pull request number.');
    return parsePullRequest(repository, await this.read(repository, `/${number}`));
  }
}

function parsePullRequest(repository: string, input: unknown): ChatPullRequest {
  const raw = input as Record<string, any>;
  if (
    !raw ||
    !Number.isSafeInteger(raw.number) ||
    typeof raw.title !== 'string' ||
    !/^[a-f0-9]{40,64}$/i.test(raw.head?.sha ?? '') ||
    typeof raw.base?.ref !== 'string' ||
    typeof raw.head?.ref !== 'string'
  ) {
    throw new ValidationError('GitHub returned invalid pull request metadata.');
  }
  return {
    number: raw.number,
    title: raw.title.slice(0, 500),
    url: `https://github.com/${repository}/pull/${raw.number}`,
    repository,
    state: raw.merged || raw.merged_at ? 'merged' : raw.state === 'closed' ? 'closed' : 'open',
    draft: raw.draft === true,
    author: typeof raw.user?.login === 'string' ? raw.user.login : '',
    baseBranch: raw.base.ref,
    headBranch: raw.head.ref,
    headCommit: raw.head.sha,
    ...(Number.isSafeInteger(raw.additions) && { additions: raw.additions }),
    ...(Number.isSafeInteger(raw.deletions) && { deletions: raw.deletions }),
    ...(Number.isSafeInteger(raw.changed_files) && { changedFiles: raw.changed_files }),
  };
}
