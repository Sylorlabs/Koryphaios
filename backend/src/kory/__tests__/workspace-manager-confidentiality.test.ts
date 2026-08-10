import { describe, expect, test } from 'bun:test';
import { workspaceGitLogMetadata } from '../workspace-manager';

describe('WorkspaceManager Git diagnostic confidentiality', () => {
  test('never copies repository-controlled Git output into log metadata', () => {
    const sentinel = 'ghp_REPOSITORY_CONTROLLED_SENTINEL_123456789';
    const operations = [
      'worktree-add',
      'stash-push',
      'checkout',
      'merge-squash',
      'merge',
      'stash-apply',
      'stash-drop',
      'worktree-remove',
      'worktree-prune',
    ] as const;

    for (const operation of operations) {
      const output = `hook stderr: token=${sentinel}\n${'repository output '.repeat(2_000)}`;
      const metadata = workspaceGitLogMetadata(operation, { success: false, output });

      expect(metadata).toEqual({
        gitOperation: operation,
        success: false,
        outputLength: output.length,
      });
      expect(JSON.stringify(metadata)).not.toContain(sentinel);
      expect(Object.keys(metadata).sort()).toEqual(['gitOperation', 'outputLength', 'success']);
    }
  });
});
