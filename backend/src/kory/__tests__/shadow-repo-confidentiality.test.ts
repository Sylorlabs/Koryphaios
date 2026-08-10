import { describe, expect, test } from 'bun:test';
import { shadowGitLogMetadata } from '../shadow-repo';

describe('ShadowRepo Git diagnostic confidentiality', () => {
  test('never copies repository hook output into log metadata', () => {
    const sentinel = 'ghp_SHADOW_REPOSITORY_SENTINEL_123456789';
    const output = `reference-transaction hook: token=${sentinel}\n${'hook output '.repeat(2_000)}`;
    const metadata = shadowGitLogMetadata('update-ref-copy', { success: false, output });

    expect(metadata).toEqual({
      gitOperation: 'update-ref-copy',
      success: false,
      outputLength: output.length,
    });
    expect(JSON.stringify(metadata)).not.toContain(sentinel);
    expect(Object.keys(metadata).sort()).toEqual(['gitOperation', 'outputLength', 'success']);
  });
});
