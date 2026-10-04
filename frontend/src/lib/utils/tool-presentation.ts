import type { FeedEntryLocal } from '$lib/types';

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function toolPresentation(entry: FeedEntryLocal) {
  const call = entry.metadata?.toolCall as { name?: string; input?: Record<string, unknown> } | undefined;
  const result = entry.metadata?.toolResult as { name?: string; output?: string; isError?: boolean } | undefined;
  const name = text(result?.name || call?.name).replace(/^.*kory__/, '').toLowerCase();
  const input = call?.input ?? {};
  const path = text(input.path ?? input.file_path ?? input.filepath ?? input.target_file ?? input.TargetFile ?? input.AbsolutePath);
  const command = text(input.command ?? input.cmd ?? input.commandLine ?? input.command_line ?? input.CommandLine ?? input.script ?? input.shell_command);
  const query = text(input.pattern ?? input.regex ?? input.query ?? input.q ?? input.search ?? input.url);
  const patch = text(input.patchText ?? input.patch ?? input.diff ?? input.input);
  const patchPaths = [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((match) => match[1]);
  const files = Array.isArray(input.files) ? input.files : [];
  const paths = path ? [path] : patchPaths.length ? [...new Set(patchPaths)] : files.flatMap((file) => {
    const filePath = typeof file === 'object' && file ? text((file as Record<string, unknown>).path) : text(file);
    return filePath ? [filePath] : [];
  });
  const complete = entry.type === 'tool_result';
  const failed = result?.isError === true;
  let action = complete ? 'Used' : 'Using';
  let target = name.replace(/_/g, ' ') || 'tool';
  let kind: 'file' | 'command' | 'search' | 'other' = 'other';

  if (/^(read|read_file|view_file|view_image|read_note)$/.test(name)) {
    action = complete ? 'Read' : 'Reading';
    kind = 'file';
  } else if (/^(write|write_file|write_to_file|create_note)$/.test(name)) {
    action = complete ? 'Wrote' : 'Writing';
    kind = 'file';
  } else if (/edit|replace|patch|^diff$|update_note/.test(name)) {
    action = complete ? 'Edited' : 'Editing';
    kind = 'file';
  } else if (name === 'delete_file') {
    action = complete ? 'Deleted' : 'Deleting';
    kind = 'file';
  } else if (name === 'move_file') {
    action = complete ? 'Moved' : 'Moving';
    kind = 'file';
    const source = text(input.source ?? input.src);
    const destination = text(input.dest ?? input.destination);
    target = [source, destination].filter(Boolean).map((item) => item.split(/[/\\]/).pop()).join(' → ') || 'file';
  } else if (command || /^(bash|shell|shell_manage|run_terminal_command|run_command|terminal)$/.test(name)) {
    action = complete ? 'Ran' : 'Running';
    kind = 'command';
    target = command || 'command';
  } else if (/grep|glob|search|find|recall/.test(name)) {
    action = complete ? 'Searched' : 'Searching';
    kind = 'search';
    target = query || 'workspace';
  } else if (/^ls$|list_directory/.test(name)) {
    action = complete ? 'Listed' : 'Listing';
    target = path || 'workspace';
  } else if (/web_fetch|read_url/.test(name)) {
    action = complete ? 'Fetched' : 'Fetching';
    target = query || 'page';
  } else if (/checklist/.test(name)) {
    action = complete ? 'Updated' : 'Updating';
    target = text(input.title) || 'checklist';
  } else if (name === 'record_work_note') {
    action = complete ? 'Recorded' : 'Recording';
    target = text(input.title) || 'work note';
  }

  if (kind === 'file' && name !== 'move_file') {
    target = paths.length > 1 ? `${paths.length} files` : paths[0]?.split(/[/\\]/).pop() || text(input.title) || 'file';
  }
  const oldText = text(input.old_string ?? input.old_str ?? input.oldText ?? input.old_text ?? input.TargetContent);
  const newText = text(input.new_string ?? input.new_str ?? input.newText ?? input.new_text ?? input.ReplacementContent);
  const changes = kind === 'file' && /edit|replace|patch|diff/.test(name)
    ? patch || (oldText || newText ? [
      ...oldText.split('\n').filter((line, index) => oldText || index > 0).map((line) => `- ${line}`),
      ...newText.split('\n').filter((line, index) => newText || index > 0).map((line) => `+ ${line}`),
    ].join('\n') : '')
    : '';
  const content = text(input.content ?? input.contents ?? input.code);
  const output = text(result?.output) || (failed ? entry.text : '');
  const hiddenKeys = new Set(['path', 'file_path', 'filepath', 'target_file', 'TargetFile', 'AbsolutePath']);
  const fields = Object.entries(input).filter(([key, value]) => !hiddenKeys.has(key) && value !== undefined);
  return { name, action, target: target.replace(/\s+/g, ' ').trim(), kind, paths, command, changes, content, output, fields, failed, complete };
}
