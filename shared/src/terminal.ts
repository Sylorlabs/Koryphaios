// Integrated terminal (PTY) contract shared by the backend terminal service,
// the WebSocket transport and the frontend xterm.js view.
//
// Output bytes travel as base64 so arbitrary PTY bytes (partial UTF-8, escape
// sequences, binary) survive JSON. Every output chunk carries a per-terminal
// `seq`; a client that sees a gap refetches the scrollback to resynchronize.

/** `chat`: cwd is the chat's own checkout (isolated copy when it has one).
 *  `project`: cwd is the chat's project folder (the shared checkout). */
export type TerminalScope = 'chat' | 'project';

export type TerminalStatus = 'running' | 'exited';

export interface TerminalInfo {
  id: string;
  sessionId: string;
  scope: TerminalScope;
  name: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  status: TerminalStatus;
  exitCode: number | null;
  signal: string | null;
  createdAt: number;
  exitedAt: number | null;
  /** Sequence of the newest output chunk, 0 when nothing was written yet. */
  lastSeq: number;
}

export interface TerminalScrollback {
  terminalId: string;
  /** Sequence of the oldest retained chunk (equals throughSeq + 1 when empty). */
  fromSeq: number;
  /** Sequence of the newest chunk included in `data`. Live events with seq <= this are already in `data`. */
  throughSeq: number;
  /** Base64 of the retained raw PTY bytes, oldest first. */
  data: string;
  /** True when older output was evicted from the ring buffer. */
  truncated: boolean;
}

export interface TerminalOutputPayload {
  terminalId: string;
  seq: number;
  /** Base64 of the raw PTY bytes for this chunk. */
  data: string;
}

export interface TerminalExitPayload {
  terminalId: string;
  exitCode: number | null;
  signal: string | null;
}

/** WebSocket client command: keystrokes for a running terminal (`data` is UTF-8 text). */
export interface TerminalInputMessage {
  type: 'terminal.input';
  sessionId: string;
  terminalId: string;
  data: string;
}

/** WebSocket client command: new viewport size for a running terminal. */
export interface TerminalResizeMessage {
  type: 'terminal.resize';
  sessionId: string;
  terminalId: string;
  cols: number;
  rows: number;
}

export const TERMINAL_SCROLLBACK_BYTES = 2 * 1024 * 1024;
export const TERMINAL_MAX_PER_CHAT = 8;
export const TERMINAL_MAX_INPUT_BYTES = 16 * 1024;
export const TERMINAL_MIN_COLS = 2;
export const TERMINAL_MAX_COLS = 500;
export const TERMINAL_MIN_ROWS = 1;
export const TERMINAL_MAX_ROWS = 300;
