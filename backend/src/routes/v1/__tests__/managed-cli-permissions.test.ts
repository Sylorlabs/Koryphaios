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
      expect(managedNativeToolDecision(tool, {}, 'antigravity')).toMatchObject({
        decision: 'block',
        koryEquivalent: equivalent,
      });
      expect(managedNativeToolDecision(tool, {}, 'antigravity').reason).toContain('call_mcp_tool');
      expect(managedNativeToolDecision(tool, {}, 'antigravity').reason).toContain(
        `ToolName="${equivalent}"`,
      );
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

describe('devin managed native tool boundary', () => {
  test('approves namespaced kory MCP calls — the signed bridge authorizes them', () => {
    expect(managedNativeToolDecision('mcp__kory__kory__read_file').decision).toBe('approve');
    expect(managedNativeToolDecision('mcp__kory__kory__delegate_to_worker').decision).toBe(
      'approve',
    );
    expect(managedNativeToolDecision('MCP__KORY__KORY__BASH').decision).toBe('approve');
  });

  test('blocks namespaced calls to any other MCP server', () => {
    expect(managedNativeToolDecision('mcp__github__list_issues').decision).toBe('block');
    expect(managedNativeToolDecision('mcp__evil__kory__bash').decision).toBe('block');
  });

  test("gates devin's own MCP dispatcher the same way as agy's", () => {
    expect(
      managedNativeToolDecision('mcp_call_tool', {
        server_name: 'kory',
        tool_name: 'kory__bash',
      }).decision,
    ).toBe('approve');
    expect(
      managedNativeToolDecision('mcp_call_tool', {
        server_name: 'other',
        tool_name: 'kory__bash',
      }).decision,
    ).toBe('block');
    expect(managedNativeToolDecision('mcp_call_tool', {}).decision).toBe('block');
  });

  test('redirects lowercase devin native tools to their kory equivalents', () => {
    for (const [tool, equivalent] of [
      ['exec', 'kory__bash'],
      ['read', 'kory__read_file'],
      ['glob', 'kory__glob'],
      ['grep', 'kory__grep'],
      ['find_file_by_name', 'kory__glob'],
      ['webfetch', 'kory__web_fetch'],
      ['web_search', 'kory__web_search'],
      ['apply_patch', 'kory__edit_file'],
    ] as const) {
      expect(managedNativeToolDecision(tool)).toMatchObject({
        decision: 'block',
        koryEquivalent: equivalent,
      });
    }
  });

  test('blocks devin scope escalation and native subagents', () => {
    expect(managedNativeToolDecision('request_scope').decision).toBe('block');
    for (const tool of ['run_subagent', 'read_subagent', 'task', 'spawn']) {
      expect(managedNativeToolDecision(tool).decision).toBe('block');
      expect(managedNativeToolDecision(tool).reason).toContain('kory__delegate_to_worker');
    }
  });

  test('approves devin bookkeeping tools that carry no host authority', () => {
    for (const tool of ['mcp_list_tools', 'mcp_list_servers', 'exit_plan_mode', 'todo_write']) {
      expect(managedNativeToolDecision(tool).decision).toBe('approve');
    }
  });
});

describe('managed native tool denial redirect text', () => {
  test('phrases the redirect in each provider harness vocabulary', () => {
    // Devin hook names are lowercase and it dispatches via mcp_call_tool.
    expect(managedNativeToolDecision('exec', {}, 'devin')).toMatchObject({
      decision: 'block',
      koryEquivalent: 'kory__bash',
      reason:
        'Native tool "exec" is denied and must not be retried. Call mcp_call_tool with ' +
        'server_name="kory", tool_name="kory__bash", and arguments containing the equivalent ' +
        'operation. Koryphaios owns host tool execution and permission checks.',
    });
    // Claude Code sees the bridge server as mcp__kory__<tool>.
    expect(managedNativeToolDecision('Bash', {}, 'claude')).toMatchObject({
      decision: 'block',
      koryEquivalent: 'kory__bash',
      reason:
        'Native tool "Bash" is disabled and must not be retried. Call the kory MCP tool ' +
        '"kory__bash" (exposed to you as mcp__kory__kory__bash) with the equivalent arguments. ' +
        'Koryphaios owns host tool execution and permission checks.',
    });
    // Antigravity keeps its call_mcp_tool dispatcher phrasing.
    expect(managedNativeToolDecision('run_command', {}, 'antigravity')).toMatchObject({
      decision: 'block',
      koryEquivalent: 'kory__bash',
      reason:
        'Native agy tool "run_command" is denied and must not be retried. Call call_mcp_tool ' +
        'with ServerName="kory", ToolName="kory__bash", and Arguments containing the equivalent ' +
        'operation. Koryphaios owns host tool execution and permission checks.',
    });
    // Missing or unknown providers get the generic phrasing.
    for (const provider of [undefined, 'cursor']) {
      expect(managedNativeToolDecision('Bash', {}, provider)).toMatchObject({
        decision: 'block',
        koryEquivalent: 'kory__bash',
        reason:
          'Native tool "Bash" is denied and must not be retried. Call the "kory__bash" tool on ' +
          'the kory MCP server with the equivalent arguments. Koryphaios owns host tool ' +
          'execution and permission checks.',
      });
    }
  });
});
