import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import type {
  ExecutionTarget,
  RemoteOperationReceipt,
  RemoteProtocolOperationState,
} from '@koryphaios/shared';
import { getDb } from '../db';

type OperationRow = {
  command_id: string;
  operation_id: string;
  target: string;
  state: RemoteProtocolOperationState;
  cursor: number;
  payload_hash: string;
  issued_at: number;
  accepted_at: number | null;
  completed_at: number | null;
  error: string | null;
};

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(',')}}`;
}

function payloadHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function isTerminal(state: RemoteProtocolOperationState): boolean {
  return ['completed', 'failed', 'cancelled', 'expired', 'rejected'].includes(state);
}

/** Durable protocol-v2 command ledger. One command ID is one mutation attempt. */
export class RemoteOperationLedger {
  constructor(private readonly database: Database = new Database(':memory:')) {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS remote_operations (
        command_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        target TEXT NOT NULL,
        state TEXT NOT NULL,
        cursor INTEGER NOT NULL,
        payload_hash TEXT NOT NULL,
        issued_at INTEGER NOT NULL,
        accepted_at INTEGER,
        completed_at INTEGER,
        error TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_remote_operations_operation
        ON remote_operations(operation_id, cursor);
    `);
  }

  accept(
    commandId: string,
    operationId: string,
    target: ExecutionTarget,
    payload: unknown,
  ): RemoteOperationReceipt {
    const hash = payloadHash(payload);
    const existing = this.row(commandId);
    if (existing) {
      if (existing.payload_hash !== hash || existing.operation_id !== operationId)
        throw new Error('Remote command ID was reused with different operation data');
      return this.public(existing);
    }
    const now = Date.now();
    const cursor = this.nextCursor(operationId);
    this.database.run(
      `INSERT INTO remote_operations
       (command_id, operation_id, target, state, cursor, payload_hash, issued_at, accepted_at, updated_at)
       VALUES (?, ?, ?, 'accepted', ?, ?, ?, ?, ?)`,
      [commandId, operationId, JSON.stringify(target), cursor, hash, now, now, now],
    );
    return this.public(this.row(commandId)!);
  }

  transition(
    commandId: string,
    state: RemoteProtocolOperationState,
    error?: string,
  ): RemoteOperationReceipt {
    const existing = this.row(commandId);
    if (!existing) throw new Error('Unknown remote command');
    if (isTerminal(existing.state)) {
      if (existing.state !== state) throw new Error('Remote operation is already terminal');
      return this.public(existing);
    }
    const now = Date.now();
    const completedAt = isTerminal(state) ? now : existing.completed_at;
    this.database.run(
      `UPDATE remote_operations
       SET state = ?, cursor = ?, error = ?, completed_at = ?, updated_at = ?
       WHERE command_id = ?`,
      [
        state,
        this.nextCursor(existing.operation_id),
        error ? error.slice(0, 2048) : existing.error,
        completedAt,
        now,
        commandId,
      ],
    );
    return this.public(this.row(commandId)!);
  }

  get(commandId: string): RemoteOperationReceipt | undefined {
    const row = this.row(commandId);
    return row ? this.public(row) : undefined;
  }

  replay(operationId: string, afterCursor = 0): RemoteOperationReceipt[] {
    return this.database
      .query<OperationRow, [string, number]>(
        `SELECT command_id, operation_id, target, state, cursor, payload_hash,
                issued_at, accepted_at, completed_at, error
         FROM remote_operations WHERE operation_id = ? AND cursor > ? ORDER BY cursor`,
      )
      .all(operationId, Math.max(0, Math.floor(afterCursor)))
      .map((row) => this.public(row));
  }

  private row(commandId: string): OperationRow | null {
    return this.database
      .query<OperationRow, [string]>(
        `SELECT command_id, operation_id, target, state, cursor, payload_hash,
                issued_at, accepted_at, completed_at, error
         FROM remote_operations WHERE command_id = ?`,
      )
      .get(commandId);
  }

  private nextCursor(operationId: string): number {
    const row = this.database
      .query<{ max_cursor: number | null }, [string]>(
        'SELECT MAX(cursor) AS max_cursor FROM remote_operations WHERE operation_id = ?',
      )
      .get(operationId);
    return (row?.max_cursor ?? 0) + 1;
  }

  private public(row: OperationRow): RemoteOperationReceipt {
    return {
      protocol: 2,
      commandId: row.command_id,
      operationId: row.operation_id,
      target: JSON.parse(row.target) as ExecutionTarget,
      state: row.state,
      cursor: `${row.operation_id}:${row.cursor}`,
      acceptedAt: row.accepted_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      error: row.error ?? undefined,
    };
  }
}

let defaultLedger: RemoteOperationLedger | undefined;
export function getRemoteOperationLedger(): RemoteOperationLedger {
  return (defaultLedger ??= new RemoteOperationLedger(getDb()));
}
