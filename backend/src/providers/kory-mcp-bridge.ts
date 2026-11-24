#!/usr/bin/env node
// Koryphaios control-plane MCP bridge server.
//
// A stdio MCP server that exposes ALL Koryphaios tools as `kory__<tool>` MCP
// tools. When a native CLI (devin, claude, codex, cursor, antigravity,
// grok, opencode) is configured to use this server, the CLI calls `kory__read_file`,
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

import { writeFileSync } from 'node:fs';
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import {
  proposeNoteRelationshipSchema,
  reviewNoteRelationshipSchema,
} from '../tools/note-relationship-schema';
import { validatedToolImages, type ToolImage } from '../tools/tool-images';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { roleIncludesTool } from '../tools/tool-roles';
import { MCP_DISCOVERY_SCHEMA, MCP_INVOCATION_SCHEMA } from '../tools/external-mcp-schemas';
import { readBridgeGrantScopeFromFile, signedBridgeHeadersFromFile } from './bridge-grant';

// Catalog startup should fail promptly; tools may wait for explicit human
// approval. Neither deadline is unlimited and neither bypasses backend policy.
export const BRIDGE_CATALOG_TIMEOUT_MS = 30_000;
export const BRIDGE_EXECUTE_TIMEOUT_MS = 5 * 60_000;
const bridgeProcessAbort = new AbortController();

function relayHeaders(): Record<string, string> {
  const token = process.env.KORY_BRIDGE_RELAY_TOKEN;
  return token ? { 'x-kory-bridge-relay': token } : {};
}

// ─── CLI arg parsing ───────────────────────────────────────────────────────

export function parseArgs(argv: string[]): {
  sessionId: string;
  role: string;
  backendUrl: string;
  backendId: string;
  authFile: string;
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
    sessionId: '',
    role: '',
    backendUrl:
      args['backend-url'] ||
      args.backendUrl ||
      process.env.KORY_BACKEND_URL ||
      'http://127.0.0.1:3001',
    backendId: args['backend-id'] || args.backendId || process.env.KORY_BACKEND_ID || 'local',
    authFile: args['auth-file'] || args.authFile || process.env.KORY_BRIDGE_AUTH_FILE || '',
  };
}

import { NOTE_WORKSPACE_TOOL_DEFINITIONS } from '@koryphaios/shared';

// ─── Kory tool catalog ────────────────────────────────────────────────────
// The name/role capability index for Koryphaios tools exposed to CLI harnesses.
// Every entry must map to backend/src/tools/. Runtime ListTools descriptions and
// schemas come from the authenticated /api/v1/mcp-bridge/catalog ToolRegistry
// endpoint, while /execute dispatches through that same registry.

export interface KoryToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  role: 'manager' | 'worker' | 'critic' | 'any';
}

export const KORY_TOOLS: KoryToolDef[] = [
  {
    name: 'kory__manage_review_agents', role: 'critic',
    description: 'Manage specialists owned by this Critic review.',
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['list', 'message', 'cancel'] },
      agentId: { type: 'string' }, message: { type: 'string' },
    }, required: ['action'] },
  },
  ...NOTE_WORKSPACE_TOOL_DEFINITIONS.map((tool): KoryToolDef => ({ name: `kory__${tool.name}`, description: tool.description, inputSchema: { type: 'object' }, role: tool.category === 'read' ? 'any' : 'worker' })),
  // Runtime schemas/descriptions are fetched from the authoritative registry.
  ...[
    'status',
    'list_apps',
    'list_elements',
    'observe',
    'click',
    'double_click',
    'move',
    'drag',
    'type',
    'key',
    'scroll',
    'wait',
    'focus',
    'place_window',
    'sequence',
  ].map((action) => {
    const targeted = !['status', 'list_apps'].includes(action);
    const properties: Record<string, unknown> = targeted
      ? {
          appId: { type: 'string', minLength: 1, maxLength: 1024 },
          windowId: { type: 'string', minLength: 1, maxLength: 256 },
        }
      : {};
    const required = targeted ? ['appId', 'windowId'] : [];
    const extras: Record<string, Record<string, unknown>> = {
      click: {
        x: { type: 'integer', minimum: 0, maximum: 100000 },
        y: { type: 'integer', minimum: 0, maximum: 100000 },
      },
      type: { text: { type: 'string', minLength: 1, maxLength: 10000 } },
      double_click: {
        x: { type: 'integer', minimum: 0, maximum: 100000 },
        y: { type: 'integer', minimum: 0, maximum: 100000 },
      },
      move: {
        x: { type: 'integer', minimum: 0, maximum: 100000 },
        y: { type: 'integer', minimum: 0, maximum: 100000 },
      },
      drag: { path: { type: 'array', minItems: 2, maxItems: 100 } },
      key: { key: { type: 'string', minLength: 1, maxLength: 80 } },
      scroll: { delta: { type: 'integer', minimum: -100, maximum: 100 } },
      wait: { ms: { type: 'integer', minimum: 0, maximum: 10000 } },
      place_window: { hidden: { type: 'boolean' } },
      sequence: {
        steps: { type: 'array', minItems: 1, maxItems: 64 },
        observationId: { type: 'string', minLength: 1, maxLength: 128 },
        background: { type: 'boolean' },
      },
    };
    Object.assign(properties, extras[action] ?? {});
    required.push(...Object.keys(extras[action] ?? {}));
    return {
      name: `kory__computer_${action}`,
      description: `Permissioned computer ${action}; native support varies. Separate tier, role and app grants required; explicit role settings decide whether it asks or runs.`,
      inputSchema: { type: 'object', properties, required, additionalProperties: false },
      // Role authorization is enforced by the dedicated computer policy and
      // editable role matrix, not a static tool-role filter.
      role: 'any' as const,
    };
  }),
  // ── Filesystem tools ──
  {
    name: 'kory__read_file',
    description: 'Read a file from the working directory.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        startLine: { type: 'number' },
        endLine: { type: 'number' },
        start_line: { type: 'number' },
        end_line: { type: 'number' },
      },
      required: ['path'],
    },
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
    description: 'Edit a file by replacing old_str with new_str.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_str: { type: 'string' },
        new_str: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['path'],
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
    role: 'worker',
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
    role: 'manager',
  },

  // ── Web ──
  {
    name: 'kory__web_search',
    description: 'Search the web.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    role: 'worker',
  },
  {
    name: 'kory__web_fetch',
    description: 'Fetch a URL and return its content.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    role: 'worker',
  },

  // ── Notes (Koryphaios knowledge network) ──
  {
    name: 'kory__record_work_note',
    description: 'Record an evidence-backed work result with Koryphaios-owned run provenance.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        summary: { type: 'string' },
        status: {
          type: 'string',
          enum: ['completed', 'partial', 'blocked', 'decision'],
        },
        objective: { type: 'string' },
        decisions: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] },
        changedFiles: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] },
        commands: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] },
        tests: {
          anyOf: [
            {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  outcome: { type: 'string', enum: ['pass', 'fail', 'not-run'] },
                  evidence: { type: 'string' },
                },
                required: ['name', 'outcome'],
              },
            },
            { type: 'array', items: { type: 'string' } },
            { type: 'string' },
          ],
        },
        evidence: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] },
        risks: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] },
        followUps: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] },
        relatedNotes: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] },
        includeInContext: { type: 'boolean' },
      },
      required: ['title', 'summary', 'status'],
    },
    role: 'worker',
  },
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
    role: 'worker',
  },
  {
    name: 'kory__read_note',
    description: 'Read a note by title or ID, including its current revision.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, id: { type: 'string' } },
      required: [],
    },
    role: 'any',
  },
  {
    name: 'kory__get_note_properties',
    description:
      'Read bounded typed YAML properties from one project note; malformed frontmatter fails closed.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        noteId: { type: 'string', minLength: 1, maxLength: 512 },
      },
      required: ['noteId'],
    },
    role: 'any',
  },
  {
    name: 'kory__query_note_base',
    description:
      'Query an existing saved project Base by ID or unique name with bounded deterministic pagination. Exactly one of baseId or baseName is required (enforced server-side).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        baseId: { type: 'string', minLength: 1, maxLength: 512 },
        baseName: { type: 'string', minLength: 1, maxLength: 120 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        offset: { type: 'integer', minimum: 0, maximum: 100000 },
      },
    },
    role: 'any',
  },
  {
    name: 'kory__set_note_property',
    description: 'Set one typed YAML property with a mandatory authoritative note revision.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        noteId: { type: 'string', minLength: 1, maxLength: 512 },
        expectedRevision: { type: 'integer', minimum: 1 },
        key: { type: 'string', minLength: 1, maxLength: 80 },
        type: {
          type: 'string',
          enum: ['text', 'number', 'checkbox', 'date', 'datetime', 'list', 'tags'],
        },
        value: {
          oneOf: [
            { type: 'string', maxLength: 2048 },
            { type: 'number' },
            { type: 'boolean' },
            {
              type: 'array',
              maxItems: 100,
              items: { type: 'string', maxLength: 2048 },
            },
          ],
        },
      },
      required: ['noteId', 'expectedRevision', 'key', 'type', 'value'],
    },
    role: 'worker',
  },
  {
    name: 'kory__update_note',
    description: 'Update an existing note at an authoritative expected revision.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        content: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        expectedRevision: { type: 'integer', minimum: 1 },
      },
      required: ['id', 'expectedRevision'],
    },
    role: 'worker',
  },
  {
    name: 'kory__delete_note',
    description: 'Move a note to recoverable trash.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    role: 'worker',
  },
  {
    name: 'kory__link_notes',
    description: 'Create a wikilink between two notes.',
    inputSchema: {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' }, type: { type: 'string' } },
      required: ['from', 'to'],
    },
    role: 'worker',
  },
  {
    name: 'kory__unlink_notes',
    description: 'Remove a wikilink between notes.',
    inputSchema: {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' } },
      required: ['from', 'to'],
    },
    role: 'worker',
  },
  {
    name: 'kory__propose_note_relationship',
    description:
      'Propose one revision-bound typed evidence relationship; never accepts it as fact.',
    inputSchema: proposeNoteRelationshipSchema,
    role: 'worker',
  },
  {
    name: 'kory__review_note_relationship',
    description:
      'Accept or reject a proposed relationship. Always requires separate human approval.',
    inputSchema: reviewNoteRelationshipSchema,
    role: 'worker',
  },
  {
    name: 'kory__retrieve_note_context',
    description:
      'Retrieve bounded relevant project-note excerpts with lexical/semantic seeds and explainable graph paths. Read-only; never creates relationships.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 2000 },
        seedIds: {
          type: 'array',
          maxItems: 8,
          items: { type: 'string', minLength: 1, maxLength: 2048 },
        },
        limit: { type: 'integer', minimum: 1, maximum: 12 },
        maxHops: { type: 'integer', minimum: 0, maximum: 2 },
        maxChars: { type: 'integer', minimum: 256, maximum: 16000 },
        excerptChars: { type: 'integer', minimum: 128, maximum: 2000 },
        semantic: { type: 'boolean' },
      },
      required: ['query'],
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
    description: 'Prune old tool output context. Managers use archive ids; workers and Critics can prune their own context with keepRecent.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        keepRecent: { type: 'number', minimum: 4, maximum: 100 },
      },
    },
    role: 'any',
  },
  {
    name: 'kory__manage_context',
    description:
      'Report, hide, summarize, restore, re-policy or compact this agent\'s own tool-output context. Hiding and summarizing change only what the agent reads; the transcript keeps the full output.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['report', 'hide', 'summarize', 'restore', 'set_policy', 'compact'],
        },
        ids: { type: 'array', items: { type: 'string' } },
        tool: { type: 'string' },
        mode: { type: 'string', enum: ['full', 'summary', 'hidden'] },
        summary: { type: 'string' },
        keepRecent: { type: 'number', minimum: 2, maximum: 100 },
      },
      required: ['action'],
    },
    role: 'any',
  },

  {
    name: 'kory__schedule_monitor',
    description:
      'Create, list, or cancel a durable recurring monitor in this chat. A monitor wakes this session with a fresh turn on the chosen cadence (default every 5 minutes).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'cancel'] },
        prompt: { type: 'string', maxLength: 8000 },
        intervalMinutes: { type: 'number', exclusiveMinimum: 0 },
        monitorId: { type: 'string' },
      },
      required: ['action'],
    },
    role: 'manager',
  },

  // ── Checkpoints ──
  {
    name: 'kory__ghost_commit',
    description: 'Create a private Time Travel checkpoint of the current working state.',
    inputSchema: {
      type: 'object',
      properties: { label: { type: 'string' } },
      required: ['label'],
    },
    role: 'worker',
  },

  // ── Interaction ──
  {
    name: 'kory__request_critic_review',
    description: 'In Critic Auto mode, request an independent Critic review of your proposed answer. Pass compareGroupId to have the Critic rank a compare group.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', minLength: 1, maxLength: 500 },
        compareGroupId: { type: 'string', minLength: 1, maxLength: 64 },
      },
      required: ['reason'],
      additionalProperties: false,
    },
    role: 'manager',
  },
  {
    name: 'kory__rename_session',
    description: 'Rename the current chat with a concise, descriptive title as its topic evolves.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    },
    role: 'manager',
  },
  {
    name: 'kory__fork_chat',
    description:
      'Fork a chat into a new chat from a finished point of its history (default: the latest finished message). The original chat is not changed. Returns the new chat id.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        messageId: { type: 'string' },
        title: { type: 'string' },
      },
    },
    role: 'manager',
  },
  {
    name: 'kory__ask_user',
    description:
      "Ask the user a question and wait for their answer. Use it whenever you are unsure, the request is ambiguous, or a decision would materially change the result. Provide 2-4 short options with your recommendation first; the UI always offers a custom-answer box, so do not add an 'Other' option.",
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: '2-4 short answer choices, recommended first',
        },
      },
      required: ['question'],
    },
    role: 'manager',
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
      'Delegate a task to a Koryphaios worker agent. Use this instead of native subagents. Set worktree false for read-only research and true for work that edits files; omit it to follow the chat setting. model accepts any connected provider:model. wait:false returns an agentId at once and delivers the result later; compare.groupId groups attempts under different models for ranking.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string' },
        domain: { type: 'string' },
        model: { type: 'string' },
        worktree: { type: 'boolean' },
        wait: { type: 'boolean' },
        compare: {
          type: 'object',
          properties: { groupId: { type: 'string', minLength: 1, maxLength: 64 } },
          required: ['groupId'],
        },
      },
      required: ['task'],
    },
    role: 'any',
  },
  {
    name: 'kory__wait_for_agents',
    description:
      'Join worker agents started with kory__delegate_to_worker wait:false. Omit agentIds to wait for every outstanding worker.',
    inputSchema: {
      type: 'object',
      properties: {
        agentIds: { type: 'array', items: { type: 'string' }, maxItems: 50 },
        timeoutSec: { type: 'number', minimum: 1, maximum: 1800 },
      },
    },
    role: 'manager',
  },
  {
    name: 'kory__manage_agents',
    description:
      'List and control workers spawned in this chat: message, cancel, change controls, or prune context.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'message', 'cancel', 'set_controls', 'prune_context'] },
        agentId: { type: 'string' },
        message: { type: 'string' },
        model: { type: 'string' },
        reasoningLevel: { type: 'string' },
        keepRecent: { type: 'number', minimum: 2, maximum: 100 },
      },
      required: ['action'],
    },
    role: 'manager',
  },
  {
    name: 'kory__send_agent_message',
    description:
      'Send an asynchronous message to another agent. You may message the manager or a named sub-agent of any other chat (by project name or exact chat id via toSessionId — use kory__list_sessions to find chat ids) and any agent in your own chat. Messages to other chats may need user approval depending on the permission mode; messaging within your own chat is always allowed. Use request_manager_relay to ask your manager to forward a request.',
    inputSchema: {
      type: 'object',
      properties: {
        toSessionId: { type: 'string' },
        toProject: { type: 'string' },
        toAgent: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
        replyToMessageId: { type: 'string' },
      },
      required: ['body'],
    },
    role: 'any',
  },
  {
    name: 'kory__request_manager_relay',
    description:
      'Ask your own manager to forward a request to another project manager. Sub-agents cannot contact other projects directly.',
    inputSchema: {
      type: 'object',
      properties: {
        toProject: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['toProject', 'body'],
    },
    role: 'worker',
  },
  {
    name: 'kory__list_agent_messages',
    description: 'Read inter-agent messages and replies for the current session and agent.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    role: 'any',
  },
  {
    name: 'kory__list_sessions',
    description:
      'List open chats (id, title, folder, isolated copy, runtime state, message count, last update). Use a chat id with kory__send_agent_message (toSessionId) or kory__read_session.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        scope: { type: 'string', enum: ['all', 'this_folder'] },
        limit: { type: 'number' },
      },
    },
    role: 'any',
  },
  {
    name: 'kory__read_session',
    description:
      "Read a chat's transcript by id, including archived chats. Returns the newest page of the active conversation; page older messages with the 'before' cursor.",
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        limit: { type: 'number' },
        before: { type: 'string' },
        includeTools: { type: 'boolean' },
      },
      required: ['sessionId'],
    },
    role: 'any',
  },
  {
    name: 'kory__isolate_chat',
    description:
      "Move this chat out of its project folder into an independent Git copy starting from the folder's last commit, when sibling chats could collide with your edits. The turn ends right after; the host continues the task in the copy. Never isolate for read-only work or when the task needs uncommitted folder changes.",
    inputSchema: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      required: ['reason'],
    },
    role: 'manager',
  },
  {
    name: 'kory__merge_chat_back',
    description:
      "Merge the work this chat did in its own copy back into the project folder and run there again. Only for chats isolated via kory__isolate_chat. Requires user approval outside YOLO mode; conflicts abort and keep the chat isolated.",
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
    },
    role: 'manager',
  },

  {
    name: 'kory__create_chat',
    description:
      "Create a new chat in this project, optionally starting it with a first message (start: true). The new chat is marked as created by you. Requires user approval outside YOLO mode.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        workingDirectory: { type: 'string' },
        model: { type: 'string' },
        initialMessage: { type: 'string' },
        start: { type: 'boolean' },
      },
    },
    role: 'manager',
  },
  {
    name: 'kory__send_to_chat',
    description:
      "Send a message to another chat in this project. An idle chat starts a turn; a busy one queues the message on its steering queue. Delivered as coming from your agent, not the user. Requires user approval outside YOLO mode. Use kory__wait_for_chat for the reply.",
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' }, message: { type: 'string' } },
      required: ['sessionId', 'message'],
    },
    role: 'manager',
  },
  {
    name: 'kory__wait_for_chat',
    description:
      'Wait for a run in another chat in this project to settle, up to timeoutSec (default 300, max 1800). Returns the final state and the last assistant reply.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' }, timeoutSec: { type: 'number', minimum: 1, maximum: 1800 } },
      required: ['sessionId'],
    },
    role: 'any',
  },
  {
    name: 'kory__interrupt_chat',
    description:
      "Stop a run in another chat in this project, the same way the user's Stop does. Requires user approval outside YOLO mode. Give a reason; it appears in that chat's transcript.",
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' }, reason: { type: 'string' } },
      required: ['sessionId', 'reason'],
    },
    role: 'manager',
  },
  {
    name: 'kory__search_chats',
    description:
      'Search the chats in this project by title or message text (case-insensitive). Returns chat ids, states and snippets. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'number' } },
      required: ['query'],
    },
    role: 'any',
  },
  {
    name: 'kory__archive_chat',
    description:
      'Archive another idle chat in this project. Its history is kept and it can be restored. Requires user approval outside YOLO mode.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' } },
      required: ['sessionId'],
    },
    role: 'manager',
  },

  {
    name: 'kory__list_linked_devices',
    description: 'List user-authorized linked desktops available to the session manager, with names, OS, and connectivity.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    role: 'manager',
  },
  {
    name: 'kory__control_linked_device',
    description: 'Route work to a user-authorized desktop through its Kory manager. Use workspace/session IDs discovered on that device, never local paths. Cannot approve remote prompts or change device grants.',
    inputSchema: { type: 'object', properties: { deviceId: { type: 'string' }, operation: { type: 'string', enum: ['workspaces','folders','sessions','snapshot','create_chat','prompt','cancel'] }, input: { type: 'object', properties: { workspaceId: {type:'string'}, sessionId: {type:'string'}, title: {type:'string'}, content: {type:'string'} }, additionalProperties: false } }, required: ['deviceId','operation'], additionalProperties: false },
    role: 'manager',
  },
  // ── Goals ──
  {
    name: 'kory__create_goal',
    description:
      'Create a durable Goal Mode goal only when the user explicitly asks to create, track, or turn work into a goal.',
    inputSchema: {
      type: 'object',
      properties: {
        objective: { type: 'string' },
        scope: { type: 'string', enum: ['workspace', 'project', 'session'] },
        planningDepth: { type: 'string', enum: ['minimal', 'adaptive', 'structured'] },
      },
      required: ['objective'],
    },
    role: 'manager',
  },
  {
    name: 'kory__update_goal',
    description: 'Update a goal (status, checklist evidence, verification).',
    inputSchema: {
      type: 'object',
      properties: {
        goalId: { type: 'string' },
        status: { type: 'string' },
        checklistItemId: { type: 'string' },
        evidence: { type: 'string' },
      },
      required: ['goalId'],
    },
    role: 'manager',
  },

  // ── Checklists ──
  {
    name: 'kory__create_checklist',
    description: 'Create a checklist to track multi-step work.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        items: { type: 'array', items: { type: 'string' } },
        scope: { type: 'string', enum: ['workspace', 'project', 'session'] },
      },
      required: ['title'],
    },
    role: 'any',
  },
  {
    name: 'kory__list_checklists',
    description: 'List checklists visible in this chat with their progress.',
    inputSchema: {
      type: 'object',
      properties: { includeArchived: { type: 'boolean' } },
    },
    role: 'any',
  },
  {
    name: 'kory__read_checklist',
    description: 'Read one checklist and its items.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    role: 'any',
  },
  {
    name: 'kory__add_checklist_item',
    description: 'Append one or more items to a checklist.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        items: { type: 'array', items: { type: 'string' } },
      },
      required: ['id', 'items'],
    },
    role: 'any',
  },
  {
    name: 'kory__check_checklist_item',
    description: 'Mark a checklist item done, skipped, or pending again.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        itemId: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'done', 'skipped'] },
      },
      required: ['id', 'itemId'],
    },
    role: 'any',
  },
  {
    name: 'kory__update_checklist',
    description: "Replace a checklist's title or its whole item plan.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        items: { type: 'array', items: { type: 'object' } },
        archive: { type: 'boolean' },
      },
      required: ['id'],
    },
    role: 'any',
  },
  {
    name: 'kory__delete_checklist',
    description: 'Permanently delete a checklist and its items.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    role: 'any',
  },
  {
    name: 'kory__edit_goal_checklist',
    description:
      'Reshape a Goal Mode plan: add, rename, reorder, or delete checks. Cannot complete a check.',
    inputSchema: {
      type: 'object',
      properties: {
        goalId: { type: 'string' },
        items: { type: 'array', items: { type: 'object' } },
      },
      required: ['goalId', 'items'],
    },
    role: 'any',
  },

  // ── Workflows ──
  {
    name: 'kory__list_workflows',
    description: 'List registered host-owned workflows before selecting one to start.',
    inputSchema: { type: 'object', properties: {} },
    role: 'manager',
  },
  {
    name: 'kory__start_workflow',
    description:
      'Start a registered host-owned task workflow when the user explicitly asks or safe automatic selection is clearly relevant. Call list_workflows first when the exact ID or name is unknown. Workflows cannot grant tools, create Goals, or change permissions.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string' },
        workflow: { type: 'string' },
        name: { type: 'string' },
        task: { type: 'string' },
        goalId: { type: 'string' },
      },
      required: ['task'],
    },
    role: 'manager',
  },
  {
    name: 'kory__create_workflow_draft',
    description:
      'Inside an active Goal item, create an inactive declarative workflow draft for explicit human review and activation.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        stages: {
          type: 'array',
          items: {
            type: 'object',
            properties: { label: { type: 'string' }, description: { type: 'string' } },
            required: ['label', 'description'],
          },
        },
      },
      required: ['name', 'description', 'stages'],
    },
    role: 'manager',
  },
  {
    name: 'kory__update_workflow',
    description:
      'Record stage evidence or a genuine blocker for a workflow run. The host advances stages; this does not complete a Goal.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        evidence: { type: 'string' },
        status: { type: 'string', enum: ['evidence', 'blocked'] },
      },
      required: ['runId', 'evidence', 'status'],
    },
    role: 'manager',
  },

  // ── Resource capacity ──
  {
    name: 'kory__get_resource_budget',
    description:
      'Read provider-reported API balances and subscription quota windows. Missing data is unknown, never zero; no subscription dollar balance is inferred.',
    inputSchema: { type: 'object', properties: {} },
    role: 'any',
  },
  {
    name: 'kory__get_model_pricing',
    description:
      'Read per-model price facts before choosing a route: input, output and cache prices per 1M tokens, context window, and the price source (catalog, models.dev, provider-reported, openrouter-equivalent, or unknown). Pass models as provider:model ids, or a provider to list its catalog. Unknown prices are null, never zero.',
    inputSchema: {
      type: 'object',
      properties: {
        models: { type: 'array', items: { type: 'string' } },
        provider: { type: 'string' },
      },
    },
    role: 'any',
  },
  {
    name: 'kory__get_usage_summary',
    description:
      'Read spend so far: USD where prices are known (tokens always), per provider and model, enforced spend caps and current windows, and subscription or balance states with freshness. scope: session (default), project, today or month; sessionId picks the chat. Unknown values are null, never zero.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['session', 'project', 'today', 'month'] },
        sessionId: { type: 'string' },
      },
    },
    role: 'any',
  },

  // ── Skills ──
  {
    name: 'kory__load_skill_detail',
    description:
      'Load the full instructions for an active local Koryphaios skill when the compact system-prompt representation omitted detail needed for the current task.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        source: { type: 'string', enum: ['personal', 'project'] },
      },
      required: ['name'],
    },
    role: 'any',
  },
  {
    name: 'kory__manage_skill_feeding',
    description:
      "Control which skills the host feeds into the chat's system prompt: report the fed/blocked/in-context state, block skills so the feeder stops injecting them, or unblock. Conversation control-plane only; never touches the workspace.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['report', 'block', 'unblock'] },
        skills: {
          anyOf: [
            { type: 'array', items: { type: 'string' } },
            { type: 'string' },
          ],
        },
        reason: { type: 'string' },
      },
      required: ['action'],
    },
    role: 'any',
  },

  // ── MCP diagnostics ──
  {
    name: 'kory__detect-errors',
    description: 'Detect MCP server errors from logs or runtime state.',
    inputSchema: { type: 'object', properties: { serverName: { type: 'string' } }, required: [] },
    role: 'worker',
  },
  {
    name: 'kory__analyze-error',
    description: 'Analyze an MCP error and return a structured diagnosis.',
    inputSchema: {
      type: 'object',
      properties: { error: { type: 'string' }, serverName: { type: 'string' } },
      required: ['error'],
    },
    role: 'worker',
  },
  {
    name: 'kory__suggest-fixes',
    description: 'Suggest fixes for a detected MCP error.',
    inputSchema: {
      type: 'object',
      properties: { error: { type: 'string' }, diagnosis: { type: 'string' } },
      required: ['error'],
    },
    role: 'worker',
  },

  // ── Git ──
  {
    name: 'kory__git_inspect',
    description: 'Inspect the current chat Git state, commit details, or GitHub PRs.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        ref: { type: 'string' },
        number: { type: 'integer' },
      },
      required: ['action'],
    },
    role: 'manager',
  },
  {
    name: 'kory__git_switch',
    description:
      'Switch only the current chat checkout to a branch, commit, or PR, with dirty-work and concurrency guards.',
    inputSchema: {
      type: 'object',
      properties: {
        expectedHead: { type: 'string' },
        expectedBranch: { type: ['string', 'null'] },
        target: { type: 'object' },
      },
      required: ['expectedHead', 'expectedBranch', 'target'],
    },
    role: 'manager',
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
    role: 'worker',
  },

  // ── Image ──
  {
    name: 'kory__view_image',
    description: 'View an image file.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    role: 'worker',
  },

  // ── Video ──
  {
    name: 'kory__generate_video',
    description:
      'Generate a short video clip from a text description through a connected video provider ' +
      '(Luma, Kling AI, Prodia, Replicate). Generation is asynchronous and usually takes 30s to ' +
      'several minutes and is billed per clip, so confirm the provider and model with the user ' +
      'first unless they already specified one. The clip is saved to the video gallery and shown ' +
      'to the user; the agent cannot view video frames.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'What the video shows, including motion and camera.',
        },
        provider: {
          type: 'string',
          description: 'Provider id. Omit to use the only connected provider.',
        },
        model: { type: 'string', description: 'Provider model id. Omit for the provider default.' },
        duration: { type: 'string', description: 'Clip length such as "5s" or "10s".' },
        aspectRatio: { type: 'string', description: 'Frame shape such as "16:9" or "9:16".' },
        negativePrompt: { type: 'string', description: 'What to avoid in the clip.' },
      },
      required: ['prompt'],
    },
    role: 'manager',
  },

  // ── External long-term memory ──
  {
    name: 'kory__remember',
    description:
      'Store a durable fact in external long-term memory (Mem0 or Letta). Only for information ' +
      'that stays true across sessions — preferences, decisions, recurring constraints. Never ' +
      'store secrets or credentials. Does nothing unless external memory is enabled in Settings.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'One self-contained fact.' } },
      required: ['text'],
    },
    role: 'any',
  },
  {
    name: 'kory__recall',
    description:
      'Search external long-term memory (Mem0 or Letta) for facts relevant to a query, recovering ' +
      'knowledge from earlier sessions or other machines.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you are trying to remember.' },
        limit: { type: 'number', description: 'Maximum memories to return.' },
      },
      required: ['query'],
    },
    role: 'any',
  },
  {
    name: 'kory__forget',
    description:
      'Delete specific memories from external long-term memory by id. Cannot be undone, so ' +
      'confirm with the user first. Project memory files are unaffected.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Memory ids from recall.' },
      },
      required: ['ids'],
    },
    role: 'manager',
  },

  // ── MCP server management ──
  { name: 'kory__list_mcp_tools', description: 'Discover this project’s custom MCP tools and exact input schemas.', inputSchema: MCP_DISCOVERY_SCHEMA, role: 'worker' },
  { name: 'kory__invoke_mcp_tool', description: 'Invoke a discovered custom MCP tool, including tools added mid-turn.', inputSchema: MCP_INVOCATION_SCHEMA, role: 'worker' },
  {
    name: 'kory__manage_mcp_server',
    description:
      'Manage user-pluggable MCP servers: list, add, update, remove, test-connect, or reload. ' +
      'Env vars (including tokens) are stored in the 0600 secret store, never in koryphaios.json. ' +
       'Mutations are blocked in planning interaction mode.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'add', 'update', 'remove', 'test', 'reload'],
          description: 'What to do with the MCP server',
        },
        name: { type: 'string', maxLength: 64 },
        type: { type: 'string', enum: ['stdio', 'sse'] },
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        env: { type: 'object', additionalProperties: { type: 'string' } },
        url: { type: 'string' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
      },
      required: ['action'],
    },
    role: 'manager',
  },
];

/** Match the authoritative ToolRegistry role filter without loading the backend. */
export function toolsForRole(role: string): KoryToolDef[] {
  const r = role === 'coder' ? 'worker' : role;
  if (r !== 'manager' && r !== 'worker' && r !== 'critic') return [];
  return KORY_TOOLS.filter((tool) => roleIncludesTool(tool.name.replace(/^kory__/, ''), r, tool.role));
}

// ─── Backend proxy ─────────────────────────────────────────────────────────

export type RuntimeKoryToolDef = Omit<KoryToolDef, 'role'>;

export async function fetchAuthoritativeToolCatalog(
  config: ReturnType<typeof parseArgs>,
): Promise<RuntimeKoryToolDef[]> {
  if (
    !config.sessionId ||
    !['manager', 'worker', 'coder', 'critic'].includes(config.role) ||
    !config.authFile
  ) {
    throw new Error('Kory bridge catalog authorization is unavailable');
  }
  try {
    const path = '/api/v1/mcp-bridge/catalog';
    const body = {
      sessionId: config.sessionId,
      role: config.role,
      target: { kind: 'local' as const, backendId: config.backendId },
    };
    const response = await fetch(`${config.backendUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...signedBridgeHeadersFromFile(config.authFile, 'mcp', 'POST', path, body),
        ...relayHeaders(),
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.any([bridgeProcessAbort.signal, AbortSignal.timeout(BRIDGE_CATALOG_TIMEOUT_MS)]),
    });
    if (!response.ok) throw new Error('Catalog request rejected');
    const payload = (await response.json()) as { tools?: unknown };
    if (!payload || !Array.isArray(payload.tools)) throw new Error('Invalid catalog');
    const tools = payload.tools.filter(
      (tool): tool is RuntimeKoryToolDef =>
        !!tool &&
        typeof tool === 'object' &&
        typeof (tool as RuntimeKoryToolDef).name === 'string' &&
        (tool as RuntimeKoryToolDef).name.startsWith('kory__') &&
        typeof (tool as RuntimeKoryToolDef).description === 'string' &&
        !!(tool as RuntimeKoryToolDef).inputSchema &&
        typeof (tool as RuntimeKoryToolDef).inputSchema === 'object',
    );
    // An authenticated empty list is valid. An invalid nonempty list is not
    // evidence that this session has no tools: fail readiness instead.
    if (tools.length !== payload.tools.length) throw new Error('Invalid catalog entries');
    // Duplicate names do not prevent serving the authenticated tool set.
    return tools.filter(
      (tool, index) => tools.findIndex((candidate) => candidate.name === tool.name) === index,
    );
  } catch {
    throw new Error('Kory bridge authoritative catalog is unavailable');
  }
}

async function proxyToolCall(
  config: ReturnType<typeof parseArgs>,
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ content: string; isError: boolean; images?: ToolImage[] }> {
  if (!config.sessionId) {
    return {
      content: 'Kory MCP bridge: no session ID provided. Tool calls cannot be routed.',
      isError: true,
    };
  }
  // Strip the kory__ prefix to get the Kory tool name.
  const koryName = toolName.replace(/^kory__/, '');
  try {
    if (!config.authFile) {
      return { content: 'Kory MCP bridge authorization is unavailable.', isError: true };
    }
    const path = '/api/v1/mcp-bridge/execute';
    const body = {
      sessionId: config.sessionId,
      toolName: koryName,
      input,
      role: config.role,
      target: { kind: 'local' as const, backendId: config.backendId },
    };
    const resp = await fetch(`${config.backendUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...signedBridgeHeadersFromFile(config.authFile, 'mcp', 'POST', path, body),
        ...relayHeaders(),
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.any([bridgeProcessAbort.signal, AbortSignal.timeout(BRIDGE_EXECUTE_TIMEOUT_MS)]),
    });
    if (!resp.ok) {
      return {
        content: `Kory backend rejected the tool request (HTTP ${resp.status}).`,
        isError: true,
      };
    }
    const data = (await resp.json()) as { output?: unknown; isError?: unknown; images?: unknown };
    if (
      typeof data.output !== 'string' ||
      (data.isError !== undefined && typeof data.isError !== 'boolean')
    ) {
      return {
        content: 'Kory backend returned an invalid tool result.',
        isError: true,
      };
    }
    return {
      content: data.output,
      isError: data.isError ?? false,
      images: data.isError ? [] : validatedToolImages(data.images),
    };
  } catch {
    return {
      content: 'Kory backend or private authorization is unavailable.',
      isError: true,
    };
  }
}

// ─── Server factory ────────────────────────────────────────────────────────

const bridgeRegistrations = new WeakMap<McpServer, Map<string, { signature: string; remove(): void }>>();

/** Reconcile the authenticated catalog using SDK registration handles. The SDK
 * emits tools/list_changed for additions, removals and schema replacements. */
export function updateBridgeToolCatalog(
  server: McpServer,
  tools: RuntimeKoryToolDef[],
  proxy: (toolName: string, input: Record<string, unknown>) => Promise<{ content: string; isError: boolean; images?: ToolImage[] }>,
): void {
  const registrations = bridgeRegistrations.get(server)!;
  const names = new Set(tools.map((tool) => tool.name));
  for (const [name, registered] of registrations) {
    if (!names.has(name)) { registered.remove(); registrations.delete(name); }
  }
  for (const tool of tools) {
    const signature = JSON.stringify(tool);
    const previous = registrations.get(tool.name);
    if (previous?.signature === signature) continue;
    previous?.remove();
    registrations.delete(tool.name);
    try {
      const registered = server.registerTool(tool.name, {
        description: tool.description, inputSchema: fromJsonSchema(tool.inputSchema),
      }, async (args: unknown) => {
        const result = await proxy(tool.name, (args ?? {}) as Record<string, unknown>);
        return {
          content: [
            { type: 'text' as const, text: result.content },
            ...(!result.isError ? validatedToolImages(result.images) : []).map((image) => ({ type: 'image' as const, ...image })),
          ], isError: result.isError,
        };
      });
      registrations.set(tool.name, { signature, remove: () => registered.remove() });
    } catch (error) {
      process.stderr.write(`[kory-mcp-bridge] skipped invalid tool schema ${tool.name}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}

/**
 * Build a v2 McpServer wired with the bridge's tools via the high-level
 * registerTool API. Each tool's JSON Schema is wrapped with fromJsonSchema()
 * so the SDK validates every call against the schema before the proxy handler
 * runs — the same automatic validation that Zod-based tools get, but for
 * the dynamic JSON Schemas fetched from the backend catalog at runtime.
 *
 * Exported so protocol tests can drive the server through a real Client
 * without spawning a subprocess or providing a bridge grant file.
 */
export function buildServer(
  allowedTools: RuntimeKoryToolDef[],
  proxy: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<{ content: string; isError: boolean; images?: ToolImage[] }>,
  options: { loadCatalog?: () => Promise<RuntimeKoryToolDef[]>; refreshIntervalMs?: number } = {},
): McpServer {
  const server = new McpServer(
    { name: 'kory-control-plane', version: '1.0.0' },
    { capabilities: { tools: { listChanged: true } } },
  );

  bridgeRegistrations.set(server, new Map());
  let closed = false;
  let pending: Promise<void> | undefined;
  const refresh = (): Promise<void> => {
    if (!options.loadCatalog || closed) return Promise.resolve();
    return pending ??= options.loadCatalog().then((tools) => {
      if (!closed) updateBridgeToolCatalog(server, tools, dispatch);
    }).catch(() => {
      // Retain only the last authenticated catalog on a transient failure.
      // Every execution still authenticates against the current backend state.
    }).finally(() => { pending = undefined; });
  };
  const dispatch: typeof proxy = async (name, input) => {
    const result = await proxy(name, input);
    if (name === 'kory__manage_mcp_server') await refresh();
    return result;
  };
  updateBridgeToolCatalog(server, allowedTools, dispatch);
  if (options.loadCatalog) {
    const timer = setInterval(() => { void refresh(); }, options.refreshIntervalMs ?? 2_000);
    timer.unref?.();
    const previousClose = server.server.onclose;
    server.server.onclose = () => { closed = true; clearInterval(timer); previousClose?.(); };
  }

  return server;
}

// Compatibility alias for callers/tests that use the descriptive factory
// name. The executable path intentionally calls buildServer directly.
export const createBridgeServer = buildServer;

// ─── Main ──────────────────────────────────────────────────────────────────

export async function runBridge(): Promise<void> {
  const onParentClosed = () => {
    bridgeProcessAbort.abort();
  };
  process.stdin.once('end', onParentClosed);
  process.stdin.once('close', onParentClosed);
  process.once('SIGTERM', onParentClosed);
  process.once('SIGINT', onParentClosed);
  const config = parseArgs(process.argv);
  try {
    const scope = readBridgeGrantScopeFromFile(config.authFile);
    config.sessionId = scope.sessionId;
    config.role = scope.role;
  } catch {
    process.stderr.write('[kory-mcp-bridge] private authorization unavailable\n');
    process.exitCode = 1;
    return;
  }
  const allowedTools = await fetchAuthoritativeToolCatalog(config);
  if (process.argv.includes('--probe')) {
    process.stdout.write(`${JSON.stringify({ ready: true, toolCount: allowedTools.length })}\n`);
    return;
  }
  const readyPath = process.env.KORY_BRIDGE_READY_FILE;
  if (readyPath) {
    writeFileSync(readyPath, JSON.stringify({ ready: true, toolCount: allowedTools.length }), {
      mode: 0o600,
    });
  }

  // serveStdio owns the stdio transport and serves the 2026-07-28 protocol
  // revision by default, with 2025-era fallback for legacy clients.
  // buildServer() returns a McpServer with tools registered via the
  // high-level registerTool API using fromJsonSchema() for automatic
  // input validation of the dynamic backend-provided JSON Schemas.
  serveStdio(() =>
    buildServer(allowedTools, (toolName, input) => proxyToolCall(config, toolName, input), {
      loadCatalog: () => fetchAuthoritativeToolCatalog(config),
    }),
  );
  // stdout is reserved for the MCP channel; do not echo session or endpoint
  // metadata to inherited diagnostics.
}

if (import.meta.main) {
  runBridge().catch(() => {
    process.stderr.write('[kory-mcp-bridge] fatal error\n');
    process.exit(1);
  });
}
