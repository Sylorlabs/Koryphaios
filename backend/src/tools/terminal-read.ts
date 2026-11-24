// `read_terminal`: an agent reads recent output from one of its own chat's
// integrated terminals. Read-only, scoped to the calling chat's terminal table,
// and gated by permission-policy (asks by default in every mode).
//
// This is the only agent path into a user terminal. The banned-name screen and
// the shell sandbox apply to agent-initiated tools; the user's own terminal is
// neither screened nor sandboxed, because the user typed the commands there.

import type { TerminalSession } from '../terminal/terminal-session';
import type { Tool, ToolCallInput, ToolCallOutput, ToolContext } from './registry';

const MAX_OUTPUT_CHARS = 60_000;
const DEFAULT_LINES = 200;
const MAX_LINES = 1000;

/** Resolves a chat's terminal table without creating a runtime. */
export type TerminalTableLookup = (sessionId: string) => Map<string, TerminalSession> | undefined;

let lookup: TerminalTableLookup | null = null;

/** Wire the chat-scoped terminal lookup. Called once during backend bootstrap. */
export function configureTerminalReads(next: TerminalTableLookup): void {
  lookup = next;
}

/** Drop the wiring (tests, shutdown). */
export function resetTerminalReads(): void {
  lookup = null;
}

// CSI, OSC, and two-byte ESC sequences.
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Plain text from raw PTY bytes: control sequences removed, CRLF folded to LF,
 *  and bare carriage returns (progress-bar redraws) dropped. */
export function plainTerminalText(bytes: Uint8Array): string {
  return new TextDecoder()
    .decode(bytes)
    .replace(ANSI_PATTERN, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '');
}

function fail(call: ToolCallInput, name: string, message: string): ToolCallOutput {
  return { callId: call.id, name, output: `Error: ${message}`, isError: true, durationMs: 0 };
}

export class ReadTerminalTool implements Tool {
  readonly name = 'read_terminal';
  readonly role = 'any' as const;
  readonly description =
    "Read the recent output of one of this chat's integrated terminals (its id is shown in the terminal panel). Read-only. The user approves each read unless they have allowed this tool.";
  readonly inputSchema = {
    type: 'object',
    properties: {
      terminalId: { type: 'string', description: 'The terminal id, from the terminal panel.' },
      lines: {
        type: 'number',
        description: `Trailing lines of output to return (default ${DEFAULT_LINES}, max ${MAX_LINES}).`,
      },
    },
    required: ['terminalId'],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const input = call.input as { terminalId?: unknown; lines?: unknown };
    if (typeof input.terminalId !== 'string' || !input.terminalId.trim()) {
      return fail(call, this.name, 'terminalId is required.');
    }
    if (!lookup) return fail(call, this.name, 'Terminals are not available in this runtime.');
    const table = lookup(ctx.sessionId);
    const session = table?.get(input.terminalId.trim());
    if (!session) {
      return fail(call, this.name, 'No terminal with that id in this chat.');
    }
    const requested =
      typeof input.lines === 'number' && Number.isFinite(input.lines)
        ? Math.floor(input.lines)
        : DEFAULT_LINES;
    const lines = Math.min(Math.max(requested, 1), MAX_LINES);
    const text = plainTerminalText(session.retainedBytes());
    const tail = text.split('\n').slice(-lines).join('\n');
    const bounded =
      tail.length > MAX_OUTPUT_CHARS ? tail.slice(tail.length - MAX_OUTPUT_CHARS) : tail;
    const info = session.info();
    const state =
      info.status === 'running' ? 'running' : `exited, code ${info.exitCode ?? 'unknown'}`;
    return {
      callId: call.id,
      name: this.name,
      output: `Terminal ${info.name} (${state}, cwd ${info.cwd}):\n${bounded}`,
      isError: false,
      durationMs: 0,
    };
  }
}
