import { describe, expect, test } from 'bun:test';
import { managedNativeToolDecision } from '../mcp-bridge';

describe('managed CLI native tool boundary', () => {
  test('redirects native host capabilities to Kory MCP regardless of preset', () => {
    expect(managedNativeToolDecision('Bash')).toMatchObject({
      decision: 'block',
      koryEquivalent: 'kory__bash',
    });
    expect(managedNativeToolDecision('Write')).toMatchObject({
      decision: 'block',
      koryEquivalent: 'kory__write_file',
    });
  });

  test('fails closed for unknown native capabilities', () => {
    expect(managedNativeToolDecision('mystery_host_tool').decision).toBe('block');
  });

  test('allows agy dispatcher only for session-authorized Kory bridge tools', () => {
    expect(
      managedNativeToolDecision('call_mcp_tool', {
        ServerName: 'kory',
        ToolName: 'kory__bash',
        Arguments: { command: 'pwd' },
      }).decision,
    ).toBe('approve');
    expect(
      managedNativeToolDecision('call_mcp_tool', {
        ServerName: 'kory',
        ToolName: 'kory__suggest-fixes',
        Arguments: {},
      }).decision,
    ).toBe('approve');
    for (const input of [
      undefined,
      {},
      { ServerName: 'other', ToolName: 'kory__bash' },
      { ServerName: 'kory', ToolName: 'native_bash' },
      { ServerName: 'kory', ToolName: 'kory__bash; command' },
    ]) {
      expect(managedNativeToolDecision('call_mcp_tool', input).decision).toBe('block');
    }
  });

  test('allows only provider-local bookkeeping and internal generation without host authority', () => {
    expect(managedNativeToolDecision('manage_task').decision).toBe('approve');
    expect(managedNativeToolDecision('finish').decision).toBe('approve');
    expect(managedNativeToolDecision('generate_image').decision).toBe('approve');
    expect(managedNativeToolDecision('Generate_Image').decision).toBe('approve');
    expect(managedNativeToolDecision('image_gen').decision).toBe('approve');
  });

  test('keeps delegation inside Koryphaios', () => {
    expect(managedNativeToolDecision('Agent')).toMatchObject({
      decision: 'block',
    });
  });

  // agy names its tools after the CORTEX step type, so the Claude spellings
  // above never matched its real surface. Before this mapping existed, agy's
  // native tools all fell to the unknown-tool default — denied, but with no
  // kory__ equivalent named, so the agent had no route to recover through.
  test('redirects agy step-type tool names to their Kory equivalents', () => {
    for (const [tool, equivalent] of [
      ['run_command', 'kory__bash'],
      ['RunCommand', 'kory__bash'],
      ['view_file', 'kory__read_file'],
      ['write_to_file', 'kory__write_file'],
      ['replace_file_content', 'kory__edit_file'],
      ['multi_replace_file_content', 'kory__batch_edit'],
      ['search_web', 'kory__web_search'],
      ['read_url_content', 'kory__web_fetch'],
    ] as const) {
      expect(managedNativeToolDecision(tool)).toMatchObject({
        decision: 'block',
        koryEquivalent: equivalent,
      });
      expect(managedNativeToolDecision(tool).reason).toContain('call_mcp_tool');
      expect(managedNativeToolDecision(tool).reason).toContain(`ToolName="${equivalent}"`);
    }
  });

  test('blocks agy subagent and orchestration tools', () => {
    for (const tool of ['invoke_subagent', 'define_subagent', 'send_message', 'manage_subagents']) {
      expect(managedNativeToolDecision(tool).decision).toBe('block');
    }
  });

  test('still fails closed for an unlisted agy native tool', () => {
    const decision = managedNativeToolDecision('browser_click_element');
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('browser_click_element');
  });

  test('allows agy view_file only on internal mcp schema and brain step paths', () => {
    expect(
      managedNativeToolDecision('view_file', {
        AbsolutePath:
          '/Users/test/.koryphaios/antigravity-home/.gemini/antigravity-cli/mcp/kory/kory__read_file.json',
      }).decision,
    ).toBe('approve');
    expect(
      managedNativeToolDecision('view_file', {
        AbsolutePath:
          '/Users/test/.koryphaios/antigravity-home/.gemini/antigravity-cli/brain/conv-1/output.txt',
      }).decision,
    ).toBe('approve');
    expect(
      managedNativeToolDecision('view_file', {
        AbsolutePath:
          '/Users/test/.koryphaios/antigravity-home/.gemini/antigravity-cli/antigravity-oauth-token',
      }).decision,
    ).toBe('block');
    expect(
      managedNativeToolDecision('view_file', {
        AbsolutePath: '/workspace/project/README.md',
      }).decision,
    ).toBe('block');
  });
});
