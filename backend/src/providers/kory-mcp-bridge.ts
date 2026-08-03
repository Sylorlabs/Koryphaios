#!/usr/bin/env node
// Koryphaios control-plane MCP bridge server.
//
// A stdio MCP server that exposes ALL Koryphaios tools as `kory__<tool>` MCP
// tools. When a native CLI (devin, claude, codex, cline, cursor, antigravity,
// grok) is configured to use this server, the CLI calls `kory__read_file`,
// `kory__edit_file`, `kory__bash`, `kory__create_note`, `kory__delegate_to_worker`,
// etc. instead of its own native tools. Every call is proxied to the Koryphaios
// backend HTTP API (`POST /api/v1/mcp-bridge/execute`), which runs it through
// Kory's ToolRegistry → permission check → sandbox policy → execution.
//
// Koryphaios stays the single owner of tool execution, permissions, and
// orchestration. The CLI becomes a pluggable harness that only does LLM
// inference + emits tool calls.
//
// Usage:
//   node kory-mcp-bridge.js --session-id <sid> [--role manager|worker|critic]
//                           [--working-dir <dir>] [--backend-url <url>]
//
// The CLI spawns this as a subprocess (stdio MCP). Session ID correlates tool
// calls back to the Kory session that owns the turn.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

// ─── CLI arg parsing ───────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  sessionId: string;
  role: string;
  workingDir: string;
  backendUrl: string;
} {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '';
      args[key] = val;
    }
  }
  return {
    sessionId: args['session-id'] || args.sessionId || '',
    role: args['role'] || 'manager',
    workingDir: args['working-dir'] || args.workingDir || process.cwd(),
    backendUrl:
      args['backend-url'] ||
      args.backendUrl ||
      process.env.KORY_BACKEND_URL ||
      'http://127.0.0.1:3001',
  };
}

const config = parseArgs(process.argv);

// ─── Kory tool catalog ────────────────────────────────────────────────────
// The full set of Koryphaios tools exposed to CLI harnesses. Each entry maps
// to a tool registered in backend/src/tools/. The backend's /api/v1/mcp-bridge/execute
// endpoint dispatches by name through the ToolRegistry.

interface KoryToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  role: 'manager' | 'worker' | 'critic' | 'any';
}

const KORY_TOOLS: KoryToolDef[] = [
  // ── Filesystem tools ──
  {
    name: 'kory__read_file',
    description: 'Read a file from the working directory.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    role: 'any',
  },
  {
    name: 'kory__write_file',
    description: 'Write content to a file (create or overwrite).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    role: 'worker',
  },
  {
    name: 'kory__edit_file',
    description: 'Edit a file by replacing old_string with new_string.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    role: 'worker',
  },
  {
    name: 'kory__batch_edit',
    description: 'Apply multiple edits to a single file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: { old_string: { type: 'string' }, new_string: { type: 'string' } },
          },
        },
      },
      required: ['path', 'edits'],
    },
    role: 'worker',
  },
  {
    name: 'kory__delete_file',
    description: 'Delete a file.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    role: 'worker',
  },
  {
    name: 'kory__move_file',
    description: 'Move or rename a file.',
    inputSchema: {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' } },
      required: ['from', 'to'],
    },
    role: 'worker',
  },
  {
    name: 'kory__diff',
    description: 'Show the diff between two files.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      required: ['a', 'b'],
    },
    role: 'any',
  },
  {
    name: 'kory__patch',
    description: 'Apply a unified diff patch.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, patch: { type: 'string' } },
      required: ['path', 'patch'],
    },
    role: 'worker',
  },

  // ── Search tools ──
  {
    name: 'kory__grep',
    description: 'Search file contents with ripgrep.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
        glob: { type: 'string' },
      },
      required: ['pattern'],
    },
    role: 'any',
  },
  {
    name: 'kory__glob',
    description: 'Find files by glob pattern.',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string' }, path: { type: 'string' } },
      required: ['pattern'],
    },
    role: 'any',
  },
  {
    name: 'kory__ls',
    description: 'List directory contents.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    role: 'any',
  },

  // ── Shell ──
  {
    name: 'kory__bash',
    description: 'Execute a shell command (sandboxed by Kory policy).',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string' }, timeout: { type: 'number' } },
      required: ['command'],
    },
    role: 'worker',
  },
  {
    name: 'kory__shell_manage',
    description: 'Manage background shell sessions.',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string' }, shell_id: { type: 'string' } },
      required: ['action'],
    },
    role: 'worker',
  },

  // ── Web ──
  {
    name: 'kory__web_search',
    description: 'Search the web.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    role: 'any',
  },
  {
    name: 'kory__web_fetch',
    description: 'Fetch a URL and return its content.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    role: 'any',
  },

  // ── Notes (Obsidian-style knowledge graph) ──
  {
    name: 'kory__create_note',
    description: 'Create a new note in the Koryphaios knowledge graph.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['title', 'content'],
    },
    role: 'any',
  },
  {
    name: 'kory__read_note',
    description: 'Read a note by title or ID.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, id: { type: 'string' } },
      required: [],
    },
    role: 'any',
  },
  {
    name: 'kory__update_note',
    description: 'Update an existing note.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        content: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
    },
    role: 'any',
  },
  {
    name: 'kory__delete_note',
    description: 'Delete a note.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    role: 'any',
  },
  {
    name: 'kory__link_notes',
    description: 'Create a wikilink between two notes.',
    inputSchema: {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' }, type: { type: 'string' } },
      required: ['from', 'to'],
    },
    role: 'any',
  },
  {
    name: 'kory__unlink_notes',
    description: 'Remove a wikilink between notes.',
    inputSchema: {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' } },
      required: ['from', 'to'],
    },
    role: 'any',
  },
  {
    name: 'kory__recall_notes',
    description: 'Recall notes relevant to a query from the knowledge graph.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'number' } },
      required: ['query'],
    },
    role: 'any',
  },
  {
    name: 'kory__search_notes',
    description: 'Full-text search across all notes.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'number' } },
      required: ['query'],
    },
    role: 'any',
  },
  {
    name: 'kory__list_notes',
    description: 'List notes, optionally filtered by tag.',
    inputSchema: {
      type: 'object',
      properties: { tag: { type: 'string' }, limit: { type: 'number' } },
    },
    role: 'any',
  },
  {
    name: 'kory__get_note_backlinks',
    description: 'Get notes that link to a given note.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    role: 'any',
  },
  {
    name: 'kory__get_note_graph_summary',
    description: 'Get a summary of the note graph structure.',
    inputSchema: { type: 'object', properties: {} },
    role: 'any',
  },
  {
    name: 'kory__render_note',
    description: 'Render a note to HTML.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    role: 'any',
  },

  // ── Context management ──
  {
    name: 'kory__fetch_context',
    description:
      'Fetch the current context composition (system prompt, files, notes) and token estimates.',
    inputSchema: { type: 'object', properties: {} },
    role: 'any',
  },
  {
    name: 'kory__prune_context',
    description: 'Prune context segments to free token budget.',
    inputSchema: {
      type: 'object',
      properties: { segments: { type: 'array', items: { type: 'string' } } },
      required: ['segments'],
    },
    role: 'any',
  },

  // ── Interaction ──
  {
    name: 'kory__ask_user',
    description: 'Ask the user a question and wait for a response.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' } },
      },
      required: ['question'],
    },
    role: 'any',
  },
  {
    name: 'kory__ask_manager',
    description: 'Ask the manager agent a question (for worker agents).',
    inputSchema: {
      type: 'object',
      properties: { question: { type: 'string' } },
      required: ['question'],
    },
    role: 'worker',
  },
  {
    name: 'kory__delegate_to_worker',
    description:
      'Delegate a task to a Koryphaios worker agent. Use this instead of native subagents.',
    inputSchema: {
      type: 'object',
      properties: { task: { type: 'string' }, domain: { type: 'string' } },
      required: ['task'],
    },
    role: 'manager',
  },
  {
    name: 'kory__delegate_to_jules',
    description: 'Delegate a task to Google Jules (cloud async agent).',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string' },
        createPr: { type: 'boolean' },
        branch: { type: 'string' },
      },
      required: ['task'],
    },
    role: 'manager',
  },

  // ── Goals ──
  {
    name: 'kory__create_goal',
    description: 'Create a scoped goal for the current session.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, description: { type: 'string' } },
      required: ['title', 'description'],
    },
    role: 'manager',
  },

  // ── Git ──
  {
    name: 'kory__git_status',
    description: 'Get git status of the working directory.',
    inputSchema: { type: 'object', properties: {} },
    role: 'any',
  },
  {
    name: 'kory__git_diff',
    description: 'Get git diff (staged or unstaged).',
    inputSchema: { type: 'object', properties: { staged: { type: 'boolean' } } },
    role: 'any',
  },
  {
    name: 'kory__git_commit',
    description: 'Stage and commit changes.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
      },
      required: ['message'],
    },
    role: 'worker',
  },
  {
    name: 'kory__commit_and_create_pr',
    description: 'Commit changes and create a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['message'],
    },
    role: 'manager',
  },

  // ── Image ──
  {
    name: 'kory__view_image',
    description: 'View an image file.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    role: 'any',
  },
];

/** Filter tools by role. Critic gets read-only; worker gets build tools; manager gets all. */
function toolsForRole(role: string): KoryToolDef[] {
  const r = role === 'coder' ? 'worker' : role;
  return KORY_TOOLS.filter((t) => {
    const tr = t.role as string | undefined;
    if (!tr || tr === 'any') return true;
    if (r === 'critic') return tr === 'critic' || tr === 'any';
    if (r === 'manager') return tr === 'manager' || tr === 'worker' || tr === 'any';
    if (r === 'worker') return tr === 'worker' || tr === 'any';
    return true;
  });
}

// ─── Backend proxy ─────────────────────────────────────────────────────────

async function proxyToolCall(
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  if (!config.sessionId) {
    return {
      content: 'Kory MCP bridge: no session ID provided. Tool calls cannot be routed.',
      isError: true,
    };
  }
  // Strip the kory__ prefix to get the Kory tool name.
  const koryName = toolName.replace(/^kory__/, '');
  try {
    const resp = await fetch(`${config.backendUrl}/api/v1/mcp-bridge/execute`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.KORY_LOCAL_AUTH ? { authorization: process.env.KORY_LOCAL_AUTH } : {}),
      },
      body: JSON.stringify({
        sessionId: config.sessionId,
        toolName: koryName,
        input,
        role: config.role,
        workingDirectory: config.workingDir,
      }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return {
        content: `Kory backend error (${resp.status}): ${text.slice(0, 500)}`,
        isError: true,
      };
    }
    const data = (await resp.json()) as { output?: string; isError?: boolean };
    return { content: data.output ?? '', isError: data.isError ?? false };
  } catch (err: any) {
    return { content: `Kory backend unreachable: ${err?.message ?? String(err)}`, isError: true };
  }
}

// ─── MCP server ────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'kory-control-plane', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolsForRole(config.role).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (!name?.startsWith('kory__')) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
  const result = await proxyToolCall(name, (args ?? {}) as Record<string, unknown>);
  return {
    content: [{ type: 'text', text: result.content }],
    isError: result.isError,
  };
});

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr only (stdout is the MCP channel).
  process.stderr.write(
    `[kory-mcp-bridge] session=${config.sessionId} role=${config.role} backend=${config.backendUrl}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[kory-mcp-bridge] fatal: ${err}\n`);
  process.exit(1);
});
