import { Tool, ToolRegistry, ToolContext, ToolCallInput, ToolCallOutput } from './registry';
import { AutoCommitService } from '../kory/auto-commit-service';
import { GitManager } from '../kory/git-manager';
import { getContext } from '../context';

export class CommitAndCreatePRTool implements Tool {
  readonly name = 'commit_and_create_pr';
  readonly description = 'Auto-commits all changes, creates a branch, pushes it, and opens a Pull Request. Use this only when you have successfully completed a task and are ready to save the work. Pass a brief description of what you did.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      taskDescription: {
        type: 'string',
        description: 'A brief description of the task that was completed (e.g. "added a dark mode toggle"). This will be used to generate the branch name and commit message.',
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
        return this.createResult(call, 'Error: The current working directory is not a git repository.', true, start);
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
          title: 'Changes Saved',
          message,
          metadata: {
            branch: result.branch,
            commitHash: result.commitHash,
            prUrl: result.prUrl,
          },
        } as any);
        
        return this.createResult(call, result.message, false, start);
      } else {
        return this.createResult(call, `Failed to auto-commit or no changes found: ${result.message}`, true, start);
      }
    } catch (e) {
      return this.createResult(call, `Error: ${e instanceof Error ? e.message : String(e)}`, true, start);
    }
  }

  private createResult(call: ToolCallInput, output: string, isError: boolean, startTs: number): ToolCallOutput {
    return {
      callId: call.id,
      name: this.name,
      output,
      isError,
      durationMs: Date.now() - startTs,
    };
  }
}

export function registerGitTools(registry: ToolRegistry) {
  registry.register(new CommitAndCreatePRTool());
}
