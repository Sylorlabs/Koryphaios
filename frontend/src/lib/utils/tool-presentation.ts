import type { FeedEntryLocal } from '$lib/types';
import {
  noteToolPresentation,
  type ToolIntent,
  type WorkspaceIcon,
  type WorkspaceSurface,
} from './note-tool-presentation';
import { getSessionMcpToolRegistry } from '$lib/stores/mcp-tool-registry.svelte';
import { resolveRegisteredMcpTool } from './mcp-tool-identity';
import type { ComputerUseReceipt } from '@koryphaios/shared';

export type ToolIcon =
  | WorkspaceIcon
  | 'file-read'
  | 'file-create'
  | 'file-edit'
  | 'file-delete'
  | 'file-move'
  | 'command'
  | 'search'
  | 'folder'
  | 'web'
  | 'fetch'
  | 'checklist'
  | 'critic'
  | 'agent'
  | 'session'
  | 'git'
  | 'context'
  | 'skill'
  | 'tool';

function withoutToolNamespace(name: string): string {
  return (
    name
      .replace(/^freebuff_sandbox__/, '')
      .replace(/^mcp__.+?__/, '')
      .replace(/^.*kory__/, '')
      .split(/[./]/)
      .pop() ?? ''
  );
}

export function normalizeToolName(name: string): string {
  return withoutToolNamespace(name).toLowerCase();
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function displayToolName(value: unknown): string {
  const name = text(value)
    .trim()
    .replace(/^freebuff_sandbox__/, '');
  return /^(?:tool|generic|unknown|unknown_tool|freebuff_tool)$/i.test(name) ? '' : name;
}

function objectInput(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function computerReceipt(value: unknown): ComputerUseReceipt | undefined {
  const parsed = objectInput(value);
  const receipt =
    parsed?.computerUse &&
    typeof parsed.computerUse === 'object' &&
    !Array.isArray(parsed.computerUse)
      ? (parsed.computerUse as Record<string, unknown>)
      : undefined;
  return receipt && receipt.version === 1 && typeof receipt.action === 'string'
    ? (receipt as unknown as ComputerUseReceipt)
    : undefined;
}

export function toolPresentation(entry: FeedEntryLocal) {
  const call = entry.metadata?.toolCall as
    { name?: string; input?: Record<string, unknown> } | undefined;
  const result = entry.metadata?.toolResult as
    | { name?: string; output?: string; isError?: boolean; computerUse?: ComputerUseReceipt }
    | undefined;
  let toolName = displayToolName(result?.name) || displayToolName(call?.name);
  let input = call?.input ?? objectInput(entry.metadata?.toolInputPreview) ?? {};
  const computerUse = result?.computerUse ?? computerReceipt(result?.output);
  const dispatcher = ['call_mcp_tool', 'invoke_mcp_tool'].includes(normalizeToolName(toolName));
  const dispatcherInput = dispatcher ? input : undefined;
  const recordedMcpServer = toolName.match(/^mcp__(.+?)__/i)?.[1] ?? '';
  let mcpServer = recordedMcpServer;
  if (dispatcher) {
    // Older CLI transcripts persisted the MCP dispatcher. Prefer the actual
    // destination recorded on the call; validation diagnostics can recover it
    // even when a denied call did not retain its arguments.
    const destination =
      text(input.tool_name) ||
      text(input.toolName) ||
      text(input.ToolName) ||
      (call?.name && normalizeToolName(call.name) !== 'call_mcp_tool' ? call.name : '');
    const diagnosticName = result?.isError
      ? text(result.output || entry.text).match(
          /\bInvalid arguments for tool\s+['"`]?([\w./-]+)/i,
        )?.[1]
      : undefined;
    toolName = destination || diagnosticName || toolName;
    mcpServer =
      text(input.server_name) || text(input.serverName) || text(input.ServerName) || mcpServer;
    input =
      objectInput(input.arguments) ??
      objectInput(input.Arguments) ??
      objectInput(input.args) ??
      input;
  }
  let name = normalizeToolName(toolName);
  const servers = getSessionMcpToolRegistry(entry.metadata?.sessionId);
  // A registered MCP can itself be called through Kory's CLI bridge. Resolve
  // the destination registration rather than showing the outer bridge as the
  // server which performed the work.
  const registered =
    resolveRegisteredMcpTool(toolName, servers) ||
    resolveRegisteredMcpTool(withoutToolNamespace(toolName), servers);
  if (registered) {
    mcpServer = registered.server;
    name = registered.tool;
  }
  const registryAlias = name.startsWith('mcp_') && !name.startsWith('mcp__');
  if (registryAlias && !registered) mcpServer = '';
  // The bridge's reserved kory__ namespace carries its server identity even
  // in older saved events which only retained the destination name.
  if (!mcpServer && !registryAlias && /(?:^|[.__/])kory__/.test(toolName)) mcpServer = 'kory';
  const isMcp = dispatcher || registryAlias || !!mcpServer;
  // Kory is transport for native operations. Resolve external registrations
  // first so a nested bridge call keeps the actual server's attribution.
  const internalBridge = !registered && !registryAlias && mcpServer.toLowerCase() === 'kory';
  const unresolvedInternal = internalBridge && ['call_mcp_tool', 'invoke_mcp_tool'].includes(name);
  const nativeActivity =
    internalBridge || (!isMcp && (name === 'rename_session' || name === 'manage_mcp_server'));
  const displayName = internalBridge
    ? unresolvedInternal
      ? 'Tool'
      : name.replace(/_/g, ' ') || 'Tool'
    : name;
  const mcpIdentity =
    isMcp && !nativeActivity
      ? `${mcpServer ? `${mcpServer} MCP` : 'MCP tool'} · ${name === 'call_mcp_tool' ? 'identity unavailable' : name}`
      : '';
  const path = text(
    input.path ??
      input.file_path ??
      input.filepath ??
      input.target_file ??
      input.TargetFile ??
      input.AbsolutePath,
  );
  const command = text(
    input.command ??
      input.cmd ??
      input.commandLine ??
      input.command_line ??
      input.CommandLine ??
      input.script ??
      input.shell_command,
  );
  const query = text(
    input.pattern ?? input.regex ?? input.query ?? input.q ?? input.search ?? input.url,
  );
  const patch = text(input.patchText ?? input.patch ?? input.diff ?? input.input);
  const patchPaths = [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map(
    (match) => match[1],
  );
  const files = Array.isArray(input.files)
    ? input.files
    : Array.isArray(input.changes)
      ? input.changes
      : [];
  const paths = path
    ? [path]
    : patchPaths.length
      ? [...new Set(patchPaths)]
      : files.flatMap((file) => {
          const filePath =
            typeof file === 'object' && file
              ? text((file as Record<string, unknown>).path)
              : text(file);
          return filePath ? [filePath] : [];
        });
  const complete = entry.type === 'tool_result';
  const failed = result?.isError === true;
  const commandIsLong = command.length > 88;
  let action = toolName ? (complete ? 'Used' : 'Using') : complete ? 'Completed' : 'Running';
  let target = internalBridge ? displayName : toolName || 'Tool name unavailable';
  let kind: 'file' | 'command' | 'search' | 'other' | WorkspaceSurface = 'other';
  let icon: ToolIcon = 'tool';
  let intent: ToolIntent = 'use';
  const workspace = noteToolPresentation(name, input, text(result?.output), complete);

  if (unresolvedInternal) {
    action = complete ? 'Completed' : 'Running';
    target = 'tool';
  } else if (computerUse) {
    const labels: Record<string, [string, string]> = {
      computer_status: ['Checking computer status', 'Checked computer status'],
      computer_list_apps: ['Discovering applications', 'Discovered applications'],
      computer_observe: ['Observing', 'Observed'],
      computer_list_elements: ['Listing controls', 'Listed controls'],
      computer_click: ['Clicking', 'Clicked'],
      computer_double_click: ['Double-clicking', 'Double-clicked'],
      computer_move: ['Moving pointer', 'Moved pointer'],
      computer_drag: ['Dragging', 'Dragged'],
      computer_type: ['Typing into', 'Typed into'],
      computer_key: ['Sending key', 'Sent key'],
      computer_scroll: ['Scrolling', 'Scrolled'],
      computer_focus: ['Focusing', 'Focused'],
      computer_wait: ['Waiting', 'Waited'],
    };
    const [running, completed] = labels[name] ?? ['Used', 'computer'];
    action = complete ? (failed ? `${completed} failed` : completed) : running;
    target = computerUse.target
      ? `${computerUse.target.title || computerUse.target.appId} · ${computerUse.target.appId}`
      : computerUse.action.replace(/^computer_/, '').replace(/_/g, ' ');
    icon = 'tool';
    intent = 'use';
  } else if (name === 'rename_session') {
    action = complete ? 'Renamed session' : 'Renaming session';
    target =
      text(input.title) ||
      text(result?.output).match(/^Session renamed to:\s*(.+)$/)?.[1] ||
      'this chat';
    icon = 'session';
    intent = 'edit';
  } else if (name === 'manage_mcp_server') {
    const actions: Record<string, [string, string]> = {
      list: ['Listing', 'Listed'],
      add: ['Adding MCP server', 'Added MCP server'],
      update: ['Updating MCP server', 'Updated MCP server'],
      remove: ['Removing MCP server', 'Removed MCP server'],
      test: ['Testing MCP server', 'Tested MCP server'],
      reload: ['Reloading MCP server', 'Reloaded MCP server'],
    };
    action = actions[text(input.action)]?.[complete ? 1 : 0] ?? 'Managing MCP servers';
    target = text(input.name) || 'MCP servers';
  } else if (name === 'load_skill_detail') {
    // A skill is guidance, not a file or a note: it gets its own mark and
    // names the skill that was loaded instead of the tool that read it.
    action = complete ? 'Used skill' : 'Using skill';
    icon = 'skill';
    target = text(input.name) ? `“${text(input.name)}”` : 'skill';
  } else if (name === 'fetch_context') {
    action = complete ? 'Fetched context' : 'Fetching context';
    target = text(input.query) || 'conversation context';
    icon = 'context';
    intent = 'read';
  } else if (name === 'critic_review') {
    icon = 'critic';
    intent = 'review';
    action = 'Critic';
    target = complete ? (failed ? 'failed' : 'completed') : 'running';
  } else if (name === 'delegate_to_worker') {
    action = complete ? (failed ? 'Delegation failed' : 'Delegated') : 'Delegating';
    icon = 'agent';
    target = text(input.agentName) || text(input.domain) || 'agent';
  } else if (workspace) {
    kind = workspace.surface;
    ({ action, target, icon, intent } = workspace);
  } else if (/checklist/.test(name)) {
    const creating = name.startsWith('create_');
    const reading = /^(read|list)_/.test(name);
    const deleting = name.startsWith('delete_');
    action = creating
      ? complete
        ? 'Created'
        : 'Creating'
      : reading
        ? complete
          ? 'Read'
          : 'Reading'
        : deleting
          ? complete
            ? 'Deleted'
            : 'Deleting'
          : complete
            ? 'Updated'
            : 'Updating';
    icon = 'checklist';
    intent = creating ? 'create' : reading ? 'read' : deleting ? 'delete' : 'edit';
    target = text(input.title) || 'checklist';
  } else if (/^(read|read_file|view_file|view_image|read_note)$/.test(name)) {
    action = complete ? 'Read' : 'Reading';
    kind = 'file';
    icon = 'file-read';
    intent = 'read';
  } else if (/^(write|write_file|write_to_file|create_note)$/.test(name)) {
    action = complete ? 'Wrote' : 'Writing';
    kind = 'file';
    icon = 'file-edit';
    intent = 'edit';
  } else if (name === 'create_file') {
    action = complete ? 'Created' : 'Creating';
    kind = 'file';
    icon = 'file-create';
    intent = 'create';
  } else if (/edit|replace|patch|^diff$|file_change|update_note/.test(name)) {
    action = complete ? 'Edited' : 'Editing';
    kind = 'file';
    icon = 'file-edit';
    intent = 'edit';
    if (
      patch &&
      /^\*\*\* Add File:/m.test(patch) &&
      !/^\*\*\* (Update|Delete) File:/m.test(patch)
    ) {
      action = complete ? 'Created' : 'Creating';
      icon = 'file-create';
      intent = 'create';
    } else if (
      patch &&
      /^\*\*\* Delete File:/m.test(patch) &&
      !/^\*\*\* (Update|Add) File:/m.test(patch)
    ) {
      action = complete ? 'Deleted' : 'Deleting';
      icon = 'file-delete';
      intent = 'delete';
    }
  } else if (name === 'delete_file') {
    action = complete ? 'Deleted' : 'Deleting';
    kind = 'file';
    icon = 'file-delete';
    intent = 'delete';
  } else if (name === 'move_file') {
    action = complete ? 'Moved' : 'Moving';
    kind = 'file';
    icon = 'file-move';
    intent = 'edit';
    const source = text(input.source ?? input.src);
    const destination = text(input.dest ?? input.destination);
    target =
      [source, destination]
        .filter(Boolean)
        .map((item) => item.split(/[/\\]/).pop())
        .join(' → ') || 'file';
  } else if (
    command ||
    /^(bash|shell|shell_manage|run_terminal_command|run_command|command_execution|exec|terminal)$/.test(
      name,
    )
  ) {
    action = complete ? 'Ran' : 'Running';
    kind = 'command';
    icon = /^git(?:\s|$)/i.test(command.trim()) ? 'git' : 'command';
    target = command || 'command';
  } else if (/grep|glob|search|find|recall/.test(name)) {
    action = complete ? 'Searched' : 'Searching';
    kind = 'search';
    icon = /web/.test(name) ? 'web' : 'search';
    intent = 'search';
    target = query || 'workspace';
  } else if (/^ls$|list_directory/.test(name)) {
    action = complete ? 'Listed' : 'Listing';
    icon = 'folder';
    intent = 'list';
    target = path || 'workspace';
  } else if (/web_fetch|read_url/.test(name)) {
    action = complete ? 'Fetched' : 'Fetching';
    // A fetch has its own mark: reusing the globe made "read this page" look
    // identical to "search the web".
    icon = 'fetch';
    intent = 'read';
    target = query || 'page';
  } else if (name === 'record_work_note') {
    action = complete ? 'Recorded' : 'Recording';
    target = text(input.title) || 'work note';
  }

  if (kind === 'file' && name !== 'move_file') {
    target =
      paths.length > 1
        ? `${paths.length} files`
        : paths[0]?.split(/[/\\]/).pop() || text(input.title) || 'file';
  }
  const oldText = text(
    input.old_string ?? input.old_str ?? input.oldText ?? input.old_text ?? input.TargetContent,
  );
  const newText = text(
    input.new_string ??
      input.new_str ??
      input.newText ??
      input.new_text ??
      input.ReplacementContent,
  );
  const changes =
    kind === 'file' && /edit|replace|patch|diff/.test(name)
      ? patch ||
        (oldText || newText
          ? [
              ...(oldText ? oldText.split('\n').map((line) => `- ${line}`) : []),
              ...(newText ? newText.split('\n').map((line) => `+ ${line}`) : []),
            ].join('\n')
          : '')
      : '';
  const content = text(input.content ?? input.contents ?? input.code);
  const output = text(result?.output) || (failed ? entry.text : '');
  const hiddenKeys = new Set([
    'path',
    'file_path',
    'filepath',
    'target_file',
    'TargetFile',
    'AbsolutePath',
  ]);
  if (internalBridge && input === dispatcherInput) {
    for (const key of [
      'server_name',
      'serverName',
      'ServerName',
      'tool_name',
      'toolName',
      'ToolName',
    ]) {
      hiddenKeys.add(key);
    }
  }
  const fields = Object.entries(input).filter(
    ([key, value]) => !hiddenKeys.has(key) && value !== undefined,
  );
  // Keep secondary parameters available without repeating the command or diff.
  const primaryKeys = new Set([
    'command',
    'cmd',
    'commandLine',
    'command_line',
    'CommandLine',
    'script',
    'shell_command',
    'workdir',
    'workingDirectory',
    'cwd',
    'old_string',
    'old_str',
    'oldText',
    'old_text',
    'TargetContent',
    'new_string',
    'new_str',
    'newText',
    'new_text',
    'ReplacementContent',
    'content',
    'contents',
    'code',
    'patchText',
    'patch',
    'diff',
    'input',
  ]);
  const additionalFields =
    failed && kind !== 'command' ? fields : fields.filter(([key]) => !primaryKeys.has(key));
  const workingDirectory = text(input.workdir ?? input.workingDirectory ?? input.cwd);
  if (isMcp && kind === 'other' && !workspace && name !== 'critic_review' && !nativeActivity) {
    target = mcpIdentity;
  }
  return {
    name,
    toolName,
    displayName,
    mcpServer,
    mcpIdentity,
    internalBridge,
    nativeActivity,
    action,
    failureLabel:
      name === 'rename_session' ? 'Rename session failed' : `${displayName || 'Tool'} failed`,
    target: target.replace(/\s+/g, ' ').trim(),
    kind,
    icon,
    intent,
    workspace: workspace !== null,
    input,
    paths,
    command,
    commandIsLong,
    output,
    changes,
    content,
    fields,
    additionalFields,
    failed,
    complete,
    workingDirectory,
    computerUse,
  };
}
