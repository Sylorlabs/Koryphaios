import { Tool, ToolRegistry, ToolContext, ToolCallInput, ToolCallOutput } from './registry';
import { AutoCommitService } from '../kory/auto-commit-service';
import { GitManager } from '../kory/git-manager';
import { getContext } from '../context';
import type { ChatGitSwitchRequest } from '@koryphaios/shared';
import { chatGitForSession, switchChatGit } from '../services/chat-git-service';

export class CommitAndCreatePRTool implements Tool {
  readonly name = 'commit_and_create_pr';
  readonly description =
    'Auto-commits all changes, creates a branch, pushes it, and opens a Pull Request. Use this only when you have successfully completed a task and are ready to save the work. Pass a brief description of what you did.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      taskDescription: {
        type: 'string',
        description:
          'A brief description of the task that was completed (e.g. "added a dark mode toggle"). This will be used to generate the branch name and commit message.',
      },
    },
    required: ['taskDescription'],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const start = Date.now();
    try {
      const taskDescription = String(call.input.taskDescription || '');
      const gitManager = new GitManager(ctx.workingDirectory);
      if (!gitManager.isGitRepo()) {
        return this.createResult(
          call,
          'Error: The current working directory is not a git repository.',
          true,
          start,
        );
      }

      const autoCommitService = new AutoCommitService(ctx.workingDirectory, gitManager);
      const result = await autoCommitService.autoCommitAndCreatePR(taskDescription);

      if (result.success && result.branch) {
        const { wsManager } = getContext();
        const message = result.prUrl
          ? `✨ I've saved your work and created a pull request for review: ${result.prUrl}`
          : `✨ I've saved your work to branch "${result.branch}". You can merge it when you're ready!`;

        wsManager.broadcastToSession(ctx.sessionId, {
          type: 'system.notification',
          payload: {
            type: 'success',
            title: 'Changes Saved',
            message,
            metadata: {
              branch: result.branch,
              commitHash: result.commitHash,
              prUrl: result.prUrl,
            },
          },
          timestamp: Date.now(),
        });

        return this.createResult(call, result.message, false, start);
      } else {
        return this.createResult(
          call,
          `Failed to auto-commit or no changes found: ${result.message}`,
          true,
          start,
        );
      }
    } catch (e) {
      return this.createResult(
        call,
        `Error: ${e instanceof Error ? e.message : String(e)}`,
        true,
        start,
      );
    }
  }

  private createResult(
    call: ToolCallInput,
    output: string,
    isError: boolean,
    startTs: number,
  ): ToolCallOutput {
    return {
      callId: call.id,
      name: this.name,
      output,
      isError,
      durationMs: Date.now() - startTs,
    };
  }
}

export class GitInspectTool implements Tool {
  readonly name = 'git_inspect';
  readonly role = 'manager' as const;
  readonly description =
    'Inspect this chat’s isolated Git state, commit details, or GitHub pull requests. Never reads the currently selected project as a substitute for the chat. Use state first, then pass its expected HEAD/branch to git_switch.';
  readonly inputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['state', 'commit', 'pull-requests', 'pull-request'] },
      source: {
        type: 'boolean',
        description: 'Read commit details from the source repository rather than this chat.',
      },
      ref: { type: 'string', minLength: 1, maxLength: 1024 },
      number: { type: 'integer', minimum: 1, maximum: 1_000_000_000 },
    },
    required: ['action'],
  };
  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const start = Date.now();
    try {
      if (ctx.callerRole !== 'manager')
        throw new Error('Only this chat’s manager may use chat Git tools.');
      const { git, session } = await chatGitForSession(ctx.sessionId);
      const input = call.input;
      let data;
      if (input.action === 'state')
        data = await git.state(ctx.sessionId, session.gitWorkspace?.selection);
      else if (input.action === 'commit' && typeof input.ref === 'string')
        data = await git.details(input.ref, input.source === true);
      else if (input.action === 'pull-requests') data = await git.prs();
      else if (input.action === 'pull-request' && typeof input.number === 'number')
        data = await git.pr(input.number);
      else
        throw new Error(
          'Choose state, commit (with ref), pull-requests, or pull-request (with number).',
        );
      return {
        callId: call.id,
        name: this.name,
        output: JSON.stringify(data),
        isError: false,
        durationMs: Date.now() - start,
      };
    } catch (error) {
      return {
        callId: call.id,
        name: this.name,
        output: error instanceof Error ? error.message : 'Git inspection failed.',
        isError: true,
        durationMs: Date.now() - start,
      };
    }
  }
}

export class GitSwitchTool implements Tool {
  readonly name = 'git_switch';
  readonly role = 'manager' as const;
  readonly description =
    'Switch only this chat’s clean isolated checkout to a branch, commit, or GitHub PR. Inspect first and supply expectedHead/expectedBranch. Commits, tags, remote branches and PRs require a new working branch; no force/reset/stash/push. Finish workers/background terminals and pending change reviews first.';
  readonly inputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      expectedHead: { type: 'string', pattern: '^[a-fA-F0-9]{40,64}$' },
      expectedBranch: { type: ['string', 'null'], maxLength: 255 },
      target: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['branch', 'commit', 'pull-request'] },
          source: {
            type: 'boolean',
            description: 'Import the revision from the source project into a new chat branch.',
          },
          ref: { type: 'string', minLength: 1, maxLength: 1024 },
          number: { type: 'integer', minimum: 1, maximum: 1_000_000_000 },
          branch: { type: 'string', minLength: 1, maxLength: 255 },
          expectedHash: { type: 'string', pattern: '^[a-fA-F0-9]{40,64}$' },
        },
        required: ['kind'],
        oneOf: [
          { properties: { kind: { enum: ['branch', 'commit'] } }, required: ['ref'] },
          { properties: { kind: { const: 'pull-request' } }, required: ['number', 'branch'] },
        ],
      },
    },
    required: ['expectedHead', 'expectedBranch', 'target'],
  };
  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const start = Date.now();
    try {
      if (ctx.callerRole !== 'manager' || ctx.permissionPolicy?.mode === 'plan')
        throw new Error('Only the acting manager may switch its own chat checkout.');
      const data = await switchChatGit(
        ctx.sessionId,
        call.input as unknown as ChatGitSwitchRequest,
        { workingDirectory: ctx.workingDirectory, signal: ctx.signal },
      );
      return {
        callId: call.id,
        name: this.name,
        output: JSON.stringify(data),
        isError: false,
        durationMs: Date.now() - start,
      };
    } catch (error) {
      return {
        callId: call.id,
        name: this.name,
        output: error instanceof Error ? error.message : 'Git switching failed.',
        isError: true,
        durationMs: Date.now() - start,
      };
    }
  }
}

export function registerGitTools(registry: ToolRegistry) {
  registry.register(new CommitAndCreatePRTool());
  registry.register(new GitInspectTool());
  registry.register(new GitSwitchTool());
}
