// Terminal operations. Every function takes the chat's terminal table
// (`SessionRuntime.terminals`), so a terminal id from one chat cannot resolve
// in another: isolation is structural, not a string comparison that could be
// forgotten. Output is published to the owning chat's subscribers only.

import { existsSync, statSync } from 'node:fs';
import { nanoid } from 'nanoid';
import {
  TERMINAL_MAX_INPUT_BYTES,
  TERMINAL_MAX_PER_CHAT,
  type TerminalInfo,
  type TerminalScope,
  type TerminalScrollback,
  type WSMessage,
} from '@koryphaios/shared';
import { ConflictError, NotFoundError, ValidationError } from '../errors/types';
import { interactiveShell } from '../runtime/platform';
import { wsManager } from '../ws/ws-manager';
import { TerminalSession } from './terminal-session';

export type TerminalTable = Map<string, TerminalSession>;

export interface CreateTerminalInput {
  sessionId: string;
  scope: TerminalScope;
  cwd: string;
  cols: number;
  rows: number;
  name?: string;
  /** Test seam: replaces the interactive shell. */
  command?: string;
  args?: string[];
  env?: Record<string, string | undefined>;
}

/** Delivers a session-scoped live message to subscribed clients only. */
export type TerminalPublisher = (sessionId: string, message: WSMessage) => void;

const defaultPublisher: TerminalPublisher = (sessionId, message) => {
  wsManager?.broadcastEphemeralToSession(sessionId, message);
};

export class TerminalService {
  constructor(private readonly publish: TerminalPublisher = defaultPublisher) {}

  create(table: TerminalTable, input: CreateTerminalInput): TerminalSession {
    if (!input.cwd || !existsSync(input.cwd) || !statSync(input.cwd).isDirectory()) {
      throw new ValidationError(
        'The terminal folder does not exist. Open the chat again and retry.',
      );
    }
    if (table.size >= TERMINAL_MAX_PER_CHAT) {
      throw new ConflictError(
        `This chat already has ${TERMINAL_MAX_PER_CHAT} terminals. Close one first.`,
      );
    }
    const shell = input.command
      ? { command: input.command, args: input.args ?? [] }
      : interactiveShell();
    const id = nanoid(12);
    const sessionId = input.sessionId;
    const session = new TerminalSession({
      id,
      sessionId,
      scope: input.scope,
      name: input.name?.trim() || `Terminal ${table.size + 1}`,
      cwd: input.cwd,
      command: shell.command,
      args: shell.args,
      cols: input.cols,
      rows: input.rows,
      env: input.env,
      publish: (message) => this.publish(sessionId, message),
    });
    table.set(id, session);
    return session;
  }

  get(table: TerminalTable, id: string): TerminalSession {
    const session = table.get(id);
    if (!session) throw new NotFoundError('Terminal', id);
    return session;
  }

  list(table: TerminalTable): TerminalInfo[] {
    return [...table.values()].map((session) => session.info());
  }

  write(table: TerminalTable, id: string, data: string): boolean {
    if (typeof data !== 'string') throw new ValidationError('Terminal input must be text.');
    if (Buffer.byteLength(data, 'utf8') > TERMINAL_MAX_INPUT_BYTES) {
      throw new ValidationError('Terminal input is too large.');
    }
    return this.get(table, id).write(data);
  }

  resize(table: TerminalTable, id: string, cols: number, rows: number): boolean {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
      throw new ValidationError('Terminal size must be numeric.');
    }
    return this.get(table, id).resize(cols, rows);
  }

  kill(table: TerminalTable, id: string, signal: NodeJS.Signals = 'SIGTERM'): TerminalInfo {
    const session = this.get(table, id);
    session.kill(signal);
    return session.info();
  }

  /** Stops a running shell if needed and forgets the terminal. */
  remove(table: TerminalTable, id: string): void {
    const session = this.get(table, id);
    session.dispose();
    table.delete(id);
  }

  scrollback(table: TerminalTable, id: string): TerminalScrollback {
    return this.get(table, id).scrollback();
  }

  /** Teardown for session deletion and backend shutdown. Sends no events. */
  disposeAll(table: TerminalTable): void {
    for (const session of table.values()) session.dispose();
    table.clear();
  }
}

export const terminalService = new TerminalService();
