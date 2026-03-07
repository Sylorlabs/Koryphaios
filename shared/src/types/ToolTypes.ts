// Tool Types
// Domain: Tool system types for tool calls and results

export type ToolName =
  | "bash"
  | "read_file"
  | "write_file"
  | "edit_file"
  | "delete_file"
  | "move_file"
  | "patch"
  | "diff"
  | "grep"
  | "glob"
  | "ls"
  | "web_fetch"
  | "web_search"
  | "ask_user"
  | "ask_manager"
  | "agent"
  | "shell_manage"
  | (string & {}); // MCP tools: allows dynamic names while preserving autocomplete for known tools

export interface ToolCall {
  id: string;
  name: ToolName;
  input: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  name: ToolName;
  output: string;
  isError: boolean;
  durationMs: number;
}
