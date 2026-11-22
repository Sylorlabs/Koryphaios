import { describe, expect, it } from 'vitest';
import { codeBuddyMcpArgs } from '../codebuddy';

/**
 * The kory MCP server only reaches a CodeBuddy turn through an explicit
 * `--mcp-config`. Writing a user-scope file is not equivalent: the CLI reads
 * `$HOME/.codebuddy/.mcp.json` (verified with `codebuddy mcp add --scope
 * user`), and this adapter previously wrote `$HOME/.codebuddy/.codebuddy.json`,
 * so no kory__ tool was ever discovered.
 *
 * `--strict-mcp-config` is the other half: without it the user's own MCP
 * servers stay in the turn, which is not Koryphaios's tool surface.
 */
describe('CodeBuddy MCP flags', () => {
  it('passes the config path and restricts MCP to it', () => {
    expect(codeBuddyMcpArgs('/tmp/turn.mcp-config.json')).toEqual([
      '--mcp-config',
      '/tmp/turn.mcp-config.json',
      '--strict-mcp-config',
    ]);
  });

  it('keeps the flags adjacent so the path always belongs to --mcp-config', () => {
    const args = codeBuddyMcpArgs('/tmp/x.json');
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/tmp/x.json');
    expect(args).toContain('--strict-mcp-config');
  });
});
