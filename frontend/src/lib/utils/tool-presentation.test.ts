import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NOTE_TOOL_NAMES } from '@koryphaios/shared';
import type { FeedEntryLocal } from '$lib/types';
import { toolPresentation } from './tool-presentation';
import { activityGlyphs, activityGlyphOrder } from '$lib/components/activity-glyphs';
import { setSessionMcpToolRegistry } from '$lib/stores/mcp-tool-registry.svelte';
import { notifySessionRemoved } from '$lib/stores/session-removal';

function entry(name: string, input: Record<string, unknown> = {}, output?: string): FeedEntryLocal {
  return {
    id: 'tool',
    timestamp: 100,
    agentId: 'kory-manager',
    agentName: 'Kory',
    glowClass: '',
    text: '',
    type: output === undefined ? 'tool_call' : 'tool_result',
    metadata: {
      toolCall: { id: 'call', name, input },
      ...(output !== undefined && { toolResult: { callId: 'call', name, output, isError: false } }),
    },
  };
}

describe('tool activity presentation', () => {
  it('preserves exact identifiers and does not display invented placeholder tool names', () => {
    expect(toolPresentation(entry('custom_lookup', {}, 'done'))).toMatchObject({
      toolName: 'custom_lookup',
      target: 'custom_lookup',
    });
    expect(toolPresentation(entry('generic', {}, 'done'))).toMatchObject({
      toolName: '',
      action: 'Completed',
      target: 'Tool name unavailable',
    });
    const knownCall = entry('kory__read_file', { path: 'README.md' }, 'done');
    (knownCall.metadata!.toolResult as { name: string }).name = 'generic';
    expect(toolPresentation(knownCall)).toMatchObject({
      toolName: 'kory__read_file',
      target: 'README.md',
    });
  });

  it('displays sandbox tool identifiers and recognizes Codex native action inputs', () => {
    expect(
      toolPresentation(entry('freebuff_sandbox__read_file', { path: 'src/a.ts' }, 'done')),
    ).toMatchObject({ toolName: 'read_file', kind: 'file', action: 'Read', target: 'a.ts' });
    expect(
      toolPresentation(entry('command_execution', { command: 'git status' }, 'clean')),
    ).toMatchObject({
      toolName: 'command_execution',
      kind: 'command',
      target: 'git status',
      icon: 'git',
    });
    expect(
      toolPresentation(
        entry('file_change', { changes: [{ path: 'src/a.ts', diff: '+new' }] }, 'done'),
      ),
    ).toMatchObject({ kind: 'file', paths: ['src/a.ts'], target: 'a.ts' });
  });

  it('marks a page fetch with its own icon instead of the web-search globe', () => {
    expect(
      toolPresentation(entry('kory__web_fetch', { url: 'https://example.com/a' })),
    ).toMatchObject({
      action: 'Fetching',
      icon: 'fetch',
      intent: 'read',
      target: 'https://example.com/a',
    });
    expect(
      toolPresentation(entry('read_url', { url: 'https://example.com/a' }, 'body')),
    ).toMatchObject({
      action: 'Fetched',
      icon: 'fetch',
    });
    // Searching the web still belongs to the globe.
    expect(toolPresentation(entry('web_search', { query: 'theme tokens' }, 'hits')).icon).toBe(
      'web',
    );
  });

  it('turns a computer-use result into an inspectable target and action receipt', () => {
    const item = entry(
      'computer_click',
      { appId: 'com.example.Editor', windowId: 'window-7', elementId: 'save-1' },
      JSON.stringify({
        computerUse: {
          version: 1,
          action: 'computer_click',
          status: 'completed',
          target: { appId: 'com.example.Editor', windowId: 'window-7', title: 'Editor', pid: 42 },
          elementId: 'save-1',
          message: 'Clicked Save',
        },
      }),
    );
    expect(toolPresentation(item)).toMatchObject({
      action: 'Clicked',
      target: 'Editor · com.example.Editor',
      computerUse: { elementId: 'save-1', status: 'completed' },
    });
  });

  it.each(NOTE_TOOL_NAMES)('recognizes %s in both running and completed MCP forms', (name) => {
    const running = toolPresentation(entry(`mcp__kory__kory__${name}`));
    const completed = toolPresentation(entry(`functions.kory__${name}`, {}, '{}'));
    expect(running.workspace).toBe(true);
    expect(completed.workspace).toBe(true);
    expect(running.icon).not.toBe('tool');
    expect(running.action).not.toBe('Using');
    expect(completed.action).not.toBe('Used');
    expect(completed.action).not.toBe(running.action);
    expect(completed.icon).toBe(running.icon);
    expect(completed.intent).toBe(running.intent);
  });

  it.each([
    ['read_note', { title: 'Research' }, 'Reading', 'Read', 'note', 'note Research'],
    ['create_note', { title: 'Research' }, 'Creating', 'Created', 'note', 'note Research'],
    [
      'update_note',
      { id: 'n1', newTitle: 'Findings' },
      'Editing',
      'Edited',
      'note',
      'note Findings',
    ],
    ['delete_note', { title: 'Research' }, 'Trashing', 'Trashed', 'note', 'note Research'],
    ['read_note_base', { baseId: 'b1' }, 'Reading', 'Read', 'base', 'Base b1'],
    ['query_note_base', { baseName: 'Projects' }, 'Querying', 'Queried', 'base', 'Base Projects'],
    ['create_note_base', { name: 'Projects' }, 'Creating', 'Created', 'base', 'Base Projects'],
    [
      'update_note_base',
      { baseId: 'b1', name: 'Projects' },
      'Editing',
      'Edited',
      'base',
      'Base Projects',
    ],
    ['get_note_graph_summary', {}, 'Reading', 'Read', 'network', 'note network'],
    [
      'link_notes',
      { fromTitle: 'Research', toTitle: 'Findings' },
      'Linking',
      'Linked',
      'network',
      'notes · Research → Findings',
    ],
    [
      'create_note_canvas',
      { document: { name: 'Sprint' } },
      'Creating',
      'Created',
      'canvas',
      'canvas Sprint',
    ],
    [
      'patch_note_canvas',
      { noteId: 'n1', name: 'Sprint' },
      'Editing',
      'Edited',
      'canvas',
      'canvas Sprint',
    ],
    [
      'set_note_property',
      { noteId: 'n1', key: 'priority' },
      'Updating',
      'Updated',
      'properties',
      'property priority · n1',
    ],
    [
      'add_note_attachment',
      { noteId: 'n1', filename: 'evidence.md' },
      'Adding',
      'Added',
      'attachment',
      'note attachment · evidence.md',
    ],
  ] as const)(
    'describes %s with its own surface and action',
    (name, input, running, completed, icon, target) => {
      expect(toolPresentation(entry(name, input))).toMatchObject({ action: running, icon, target });
      expect(toolPresentation(entry(name, input, '{}'))).toMatchObject({
        action: completed,
        icon,
        target,
      });
    },
  );

  it('uses returned Base and canvas names when reading by ID', () => {
    expect(
      toolPresentation(entry('read_note_base', { baseId: 'b1' }, '{"name":"Projects"}')).target,
    ).toBe('Base Projects');
    expect(
      toolPresentation(
        entry('read_note_canvas', { noteId: 'n1' }, '{"document":{"name":"Sprint"}}'),
      ).target,
    ).toBe('canvas Sprint');
  });

  it('distinguishes file creation, editing and deletion patches', () => {
    const created = toolPresentation(
      entry(
        'apply_patch',
        { patchText: '*** Begin Patch\n*** Add File: src/new.ts\n+new\n*** End Patch' },
        'done',
      ),
    );
    const edited = toolPresentation(
      entry(
        'apply_patch',
        { patchText: '*** Begin Patch\n*** Update File: src/new.ts\n-old\n+new\n*** End Patch' },
        'done',
      ),
    );
    const deleted = toolPresentation(
      entry(
        'apply_patch',
        { patchText: '*** Begin Patch\n*** Delete File: src/new.ts\n*** End Patch' },
        'done',
      ),
    );
    expect(created).toMatchObject({ action: 'Created', icon: 'file-create', target: 'new.ts' });
    expect(edited).toMatchObject({ action: 'Edited', icon: 'file-edit', target: 'new.ts' });
    expect(deleted).toMatchObject({ action: 'Deleted', icon: 'file-delete', target: 'new.ts' });
  });

  it.each([
    ['kory__grep', { pattern: 'theme' }, 'search', 'theme'],
    ['kory__read_file', { path: 'src/theme.ts' }, 'file-read', 'theme.ts'],
    ['kory__bash', { command: 'bun run check' }, 'command', 'bun run check'],
  ])('resolves a failed MCP dispatcher to %s', (destination, args, icon, target) => {
    const item = entry(
      'call_mcp_tool',
      { tool_name: destination, arguments: args },
      'Access denied',
    );
    (item.metadata!.toolResult as { isError: boolean }).isError = true;
    expect(toolPresentation(item)).toMatchObject({
      toolName: destination,
      input: args,
      failed: true,
      icon,
      target,
    });
  });

  it('recovers a failed destination from the exact validation diagnostic in a legacy transcript', () => {
    const item = entry(
      'call_mcp_tool',
      {},
      "Input validation error: Invalid arguments for tool kory__grep: data must have required property 'pattern'",
    );
    (item.metadata!.toolResult as { isError: boolean }).isError = true;
    expect(toolPresentation(item)).toMatchObject({ name: 'grep', icon: 'search', failed: true });
  });

  it('does not guess a tool from an unrelated path-access error', () => {
    const item = entry(
      'call_mcp_tool',
      {},
      'Error: Access denied. Path is outside allowed directories',
    );
    (item.metadata!.toolResult as { isError: boolean }).isError = true;
    expect(toolPresentation(item).name).toBe('call_mcp_tool');
  });

  it('accepts recorded camelCase dispatch and serialized arguments', () => {
    const item = entry(
      'call_mcp_tool',
      { toolName: 'kory__grep', arguments: '{"pattern":"theme"}' },
      'found',
    );
    expect(toolPresentation(item)).toMatchObject({ name: 'grep', input: { pattern: 'theme' } });
  });

  it('shows the external MCP server for a namespaced or archived call', () => {
    expect(toolPresentation(entry('mcp__github__list_issues', {}, 'done'))).toMatchObject({
      name: 'list_issues',
      mcpServer: 'github',
      mcpIdentity: 'github MCP · list_issues',
    });
  });

  it.each(['mcp__kory__kory__read_file', 'kory__read_file'])(
    'presents the internal bridge %s as a native file action',
    (name) => {
      expect(toolPresentation(entry(name, { path: 'README.md' }, 'Readme'))).toMatchObject({
        name: 'read_file',
        mcpServer: 'kory',
        mcpIdentity: '',
        internalBridge: true,
        nativeActivity: true,
        action: 'Read',
        target: 'README.md',
        icon: 'file-read',
      });
    },
  );

  it('shows the actual server and destination for a successful dispatcher call', () => {
    expect(
      toolPresentation(
        entry(
          'call_mcp_tool',
          {
            server_name: 'github',
            tool_name: 'list_issues',
            arguments: { repo: 'app' },
          },
          'issues',
        ),
      ),
    ).toMatchObject({
      name: 'list_issues',
      mcpServer: 'github',
      target: 'github MCP · list_issues',
      input: { repo: 'app' },
    });
  });

  it.each([
    ['read_file', { path: 'src/main.ts' }, 'Reading', 'Read', 'main.ts', 'file-read'],
    [
      'edit_file',
      { path: 'src/main.ts', old_str: 'old', new_str: 'new' },
      'Editing',
      'Edited',
      'main.ts',
      'file-edit',
    ],
    ['bash', { command: 'bun test' }, 'Running', 'Ran', 'bun test', 'command'],
    ['grep', { pattern: 'theme' }, 'Searching', 'Searched', 'theme', 'search'],
    ['ls', { path: 'src' }, 'Listing', 'Listed', 'src', 'folder'],
  ] as const)(
    'presents Antigravity %s as an operation without changing its recorded identity',
    (name, args, running, completed, target, icon) => {
      const input = { ServerName: 'kory', ToolName: `kory__${name}`, Arguments: args };
      const pending = entry('call_mcp_tool', input);
      const original = structuredClone(pending);
      expect(toolPresentation(pending)).toMatchObject({
        name,
        toolName: `kory__${name}`,
        mcpServer: 'kory',
        mcpIdentity: '',
        nativeActivity: true,
        action: running,
        target,
        icon,
        input: args,
      });
      expect(pending).toEqual(original);
      expect(toolPresentation(entry('call_mcp_tool', input, 'done'))).toMatchObject({
        action: completed,
        target,
        icon,
        mcpIdentity: '',
      });
    },
  );

  it('keeps unknown internal operations readable and unresolved dispatchers generic', () => {
    expect(toolPresentation(entry('kory__inspect_runtime'))).toMatchObject({
      target: 'inspect runtime',
      mcpIdentity: '',
      nativeActivity: true,
    });
    const unresolved = entry('call_mcp_tool', { ServerName: 'kory' });
    expect(toolPresentation(unresolved)).toMatchObject({
      name: 'call_mcp_tool',
      action: 'Running',
      target: 'tool',
      fields: [],
      mcpIdentity: '',
    });
  });

  it('makes a missing server/tool identity explicit without inventing a destination', () => {
    expect(toolPresentation(entry('call_mcp_tool', {}, 'output saved'))).toMatchObject({
      mcpServer: '',
      target: 'MCP tool · identity unavailable',
    });
  });

  it('resolves Antigravity native MCP argument casing to the named tool', () => {
    const item = entry(
      'call_mcp_tool',
      {
        ServerName: 'kory',
        ToolName: 'kory__rename_session',
        Arguments: { title: 'Rename support' },
      },
      'Session renamed to: Rename support',
    );
    expect(toolPresentation(item)).toMatchObject({
      name: 'rename_session',
      mcpServer: 'kory',
      mcpIdentity: '',
      input: { title: 'Rename support' },
      target: 'Rename support',
    });
  });

  it.each([
    'mcp_Research_team_lookup_topic',
    'mcp__Research_team__lookup_topic',
    'mcp__kory__kory__mcp_Research_team_lookup_topic',
  ])('resolves %s against the chat registration, including nested bridge calls', (name) => {
    const item = entry(name, {}, 'found');
    item.metadata!.sessionId = 'registry-chat';
    setSessionMcpToolRegistry('registry-chat', [
      { name: 'Research_team', tools: ['lookup_topic'] },
    ]);
    expect(toolPresentation(item)).toMatchObject({
      name: 'lookup_topic',
      mcpServer: 'Research_team',
      target: 'Research_team MCP · lookup_topic',
    });
    notifySessionRemoved('registry-chat');
  });

  it('uses disconnected registrations without borrowing another chat registry', () => {
    const item = entry('mcp_research_team_lookup_topic', {}, 'found');
    item.metadata!.sessionId = 'registry-a';
    setSessionMcpToolRegistry('registry-a', [{ name: 'research_team' }]);
    setSessionMcpToolRegistry('registry-b', [{ name: 'research', tools: ['team_lookup_topic'] }]);
    expect(toolPresentation(item).mcpIdentity).toBe('research_team MCP · lookup_topic');
    item.metadata!.sessionId = 'registry-b';
    expect(toolPresentation(item).mcpIdentity).toBe('research MCP · team_lookup_topic');
    notifySessionRemoved('registry-b');
    expect(toolPresentation(item).mcpServer).toBe('');
    notifySessionRemoved('registry-a');
  });

  it('presents MCP registration management as a native action', () => {
    expect(
      toolPresentation(
        entry('kory__manage_mcp_server', { action: 'add', name: 'research_team' }, 'added'),
      ),
    ).toMatchObject({
      nativeActivity: true,
      action: 'Added MCP server',
      target: 'research_team',
      mcpIdentity: '',
    });
  });

  it('presents manager delegation as an inspectable agent action', () => {
    expect(
      toolPresentation(
        entry('delegate_to_worker', {
          agentId: 'worker-1',
          agentName: 'Backend agent',
          domain: 'backend',
          task: 'Build the API',
        }),
      ),
    ).toMatchObject({ action: 'Delegating', icon: 'agent', target: 'Backend agent' });
    expect(
      toolPresentation(
        entry(
          'delegate_to_worker',
          {
            agentId: 'worker-1',
            agentName: 'Backend agent',
            domain: 'backend',
            task: 'Build the API',
          },
          'done',
        ),
      ),
    ).toMatchObject({ action: 'Delegated', icon: 'agent', target: 'Backend agent' });
  });

  it('assigns dedicated icons to context retrieval and Git commands while running and completed', () => {
    expect(
      toolPresentation(entry('fetch_context', { query: 'activity icon behavior' })),
    ).toMatchObject({ icon: 'context', complete: false });
    expect(
      toolPresentation(entry('fetch_context', { query: 'activity icon behavior' }, 'context')),
    ).toMatchObject({ icon: 'context', complete: true });
    expect(toolPresentation(entry('command_execution', { command: 'git status' }))).toMatchObject({
      icon: 'git',
      complete: false,
    });
    expect(
      toolPresentation(entry('command_execution', { command: 'git status' }, 'clean')),
    ).toMatchObject({ icon: 'git', complete: true });
  });

  it('keeps all 26 activity glyphs on smooth cubic-bezier curves with refined icon geometry', () => {
    expect(activityGlyphOrder).toHaveLength(26);
    const css = readFileSync(resolve(__dirname, '../components/activity-glyphs.css'), 'utf8');
    expect(css).not.toContain('steps(');
    expect(activityGlyphs['file-edit'].svg.match(/class="agi-ink"/g)).toHaveLength(1);
    expect(activityGlyphs['file-move'].svg).toContain('agi-move-right');
    expect(activityGlyphs['file-move'].svg).toContain('agi-move-left');
    expect(activityGlyphs.folder.svg).not.toContain('agi-dim');
    expect(activityGlyphs.web.svg).not.toContain('agi-land');
    expect(activityGlyphs.fetch.svg).toContain('agi-fetch-stream');
    expect(activityGlyphs.attachment.svg).toContain('agi-attach-photo');
    expect(activityGlyphs.attachment.svg).toContain('agi-clip');
    expect(activityGlyphs.git.svg).toContain('agi-git-flow');
  });

  it('gives a skill its own mark instead of a file, note or generic tool icon', () => {
    const skill = activityGlyphs.skill;
    expect(skill.svg).toContain('agi-tassel');
    const pending = toolPresentation(
      entry('kory__load_skill_detail', { name: 'frontend-engineering' }),
    );
    const done = toolPresentation(
      entry('load_skill_detail', { name: 'frontend-engineering' }, 'guidance'),
    );
    expect(pending).toMatchObject({
      icon: 'skill',
      action: 'Using skill',
      target: '“frontend-engineering”',
    });
    expect(done).toMatchObject({
      icon: 'skill',
      action: 'Used skill',
      target: '“frontend-engineering”',
    });
  });

  it('never marks a tool with a wrench', () => {
    // Two wrench marks were retired: an amber lucide Wrench tapping a wall for
    // tool_calling, and a wrench-and-bolt glyph for the generic tool icon. Both
    // implied one hardware action for every tool, and neither read as "running".
    // The generic mark is a cog and tool_calling is a terminal prompt, so any
    // wrench in the glyph map or the status-icon markup is a regression.
    const glyphs = readFileSync(resolve(__dirname, '../components/activity-glyphs.ts'), 'utf8');
    expect(glyphs).not.toMatch(/agi-wrench|agi-wall|agi-impact/);
    expect(glyphs).not.toMatch(/\bwrench\b/i);

    expect(activityGlyphs.tool.svg).toContain('agi-cog-group');
    expect(activityGlyphOrder).toContain('tool');

    const status = readFileSync(
      resolve(__dirname, '../components/AnimatedStatusIcon.svelte'),
      'utf8',
    );
    // The explanatory comment names the retired icon, so strip comments first.
    const markup = status.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(markup).not.toMatch(/lucide-svelte\/icons\/wrench/);
    expect(markup).not.toMatch(/wrench-icon|wrench-tap|tool-tapping/);
    expect(markup).toContain('tool-command');

    // The stylesheet is a third place the mark lived: the strike, flex and tap
    // keyframes animated the retired glyph, so dropping only the markup leaves
    // dead rules that reintroduce the motion the moment a class name returns.
    const stylesheet = readFileSync(
      resolve(__dirname, '../components/activity-glyphs.css'),
      'utf8',
    );
    expect(stylesheet).not.toMatch(/agi-wrench|agi-wall|agi-impact/);
    expect(stylesheet).not.toMatch(/\bwrench\b/i);
    expect(stylesheet).toContain('agi-cog-turn');
  });
});
