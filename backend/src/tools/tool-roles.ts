export type ToolExecutionRole = 'manager' | 'worker' | 'critic' | 'coder';
export type ToolRole = 'manager' | 'worker' | 'critic' | 'any';

const CRITIC_REVIEW_TOOLS = new Set([
  'read_file', 'grep', 'glob', 'ls', 'diff', 'view_image',
  'bash', 'web_search', 'web_fetch', 'delegate_to_worker', 'ask_manager', 'ask_user',
]);

/** Shared by the authoritative registry and the standalone CLI capability
 * index; this module must remain free of backend/database initialization. */
export function roleIncludesTool(toolName: string, role: ToolExecutionRole, toolRole?: ToolRole): boolean {
  const normalized = role === 'coder' ? 'worker' : role;
  if (normalized === 'critic')
    return CRITIC_REVIEW_TOOLS.has(toolName) || toolRole === 'critic' || toolRole === 'any';
  if (!toolRole || toolRole === 'any') return true;
  if (normalized === 'manager') return toolRole === 'manager' || toolRole === 'worker';
  return toolRole === normalized;
}
