import { afterEach, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import type { WSMessage } from '@koryphaios/shared';
import { ValidationError, NotFoundError, ConflictError } from '../../errors/types';
import { isUnix } from '../../runtime/platform';
import { SessionRuntime } from '../../kory/services/SessionRuntime';
import { ScrollbackRing, TerminalSession } from '../terminal-session';
import { TerminalService, type TerminalTable } from '../terminal-service';

interface Recorded {
  sessionId: string;
  message: WSMessage;
}

function harness() {
  const recorded: Recorded[] = [];
  const service = new TerminalService((sessionId, message) =>
    recorded.push({ sessionId, message }),
  );
  return { recorded, service };
}

function sh(script: string) {
  return { command: '/bin/sh', args: ['-c', script] };
}

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await Bun.sleep(20);
  }
}

function outputOf(recorded: Recorded[], terminalId: string): Uint8Array {
  const chunks = recorded
    .filter((r) => r.message.type === 'terminal.output')
    .map((r) => r.message.payload as { terminalId: string; data: string })
    .filter((p) => p.terminalId === terminalId)
    .map((p) => Buffer.from(p.data, 'base64'));
  return Buffer.concat(chunks);
}

function exitOf(recorded: Recorded[], terminalId: string) {
  const exit = recorded.find(
    (r) =>
      r.message.type === 'terminal.exit' &&
      (r.message.payload as { terminalId: string }).terminalId === terminalId,
  );
  return exit?.message.payload as { exitCode: number | null; signal: string | null } | undefined;
}

const cwd = tmpdir();
const tables: TerminalTable[] = [];
afterEach(() => {
  for (const table of tables.splice(0)) for (const t of table.values()) t.dispose();
});

function newTable(): TerminalTable {
  const table: TerminalTable = new Map();
  tables.push(table);
  return table;
}

describe('terminal PTY lifecycle', () => {
  test('spawns a shell and streams its output and exit', async () => {
    const { recorded, service } = harness();
    const table = newTable();
    const term = service.create(table, {
      sessionId: 's1',
      scope: 'chat',
      cwd,
      cols: 80,
      rows: 24,
      ...sh('echo terminal-ok'),
    });
    await until(() => !term.isRunning);
    expect(Buffer.from(outputOf(recorded, term.id)).toString('utf8')).toContain('terminal-ok');
    expect(exitOf(recorded, term.id)).toMatchObject({ exitCode: 0, signal: null });
    expect(term.info()).toMatchObject({ status: 'exited', exitCode: 0, sessionId: 's1' });
  });

  test('resize reaches the PTY before the shell reads it', async () => {
    const { recorded, service } = harness();
    const table = newTable();
    const term = service.create(table, {
      sessionId: 's1',
      scope: 'chat',
      cwd,
      cols: 80,
      rows: 24,
      ...sh('read line; stty size; exit 0'),
    });
    expect(service.resize(table, term.id, 120, 40)).toBe(true);
    expect(term.info()).toMatchObject({ cols: 120, rows: 40 });
    service.write(table, term.id, 'go\n');
    await until(() => !term.isRunning);
    expect(Buffer.from(outputOf(recorded, term.id)).toString('utf8')).toContain('40 120');
  });

  test('kill ends a running shell and reports the signal', async () => {
    const { recorded, service } = harness();
    const table = newTable();
    const term = service.create(table, {
      sessionId: 's1',
      scope: 'chat',
      cwd,
      cols: 80,
      rows: 24,
      command: '/bin/sleep',
      args: ['30'],
    });
    expect(term.isRunning).toBe(true);
    service.kill(table, term.id, 'SIGTERM');
    await until(() => !term.isRunning);
    expect(exitOf(recorded, term.id)?.signal).toBe('SIGTERM');
    expect(service.list(table)[0]).toMatchObject({ status: 'exited', signal: 'SIGTERM' });
  });

  test('remove stops a running shell and forgets it', async () => {
    const { service } = harness();
    const table = newTable();
    const term = service.create(table, {
      sessionId: 's1',
      scope: 'chat',
      cwd,
      cols: 80,
      rows: 24,
      command: '/bin/sleep',
      args: ['30'],
    });
    service.remove(table, term.id);
    expect(table.has(term.id)).toBe(false);
    await until(() => !term.isRunning);
  });

  test('output bytes survive base64 round trip unchanged, including non-UTF-8 bytes', async () => {
    const { recorded, service } = harness();
    const table = newTable();
    const term = service.create(table, {
      sessionId: 's1',
      scope: 'chat',
      cwd,
      cols: 80,
      rows: 24,
      ...sh("printf '\\377\\376A'"),
    });
    await until(() => !term.isRunning);
    const bytes = outputOf(recorded, term.id);
    expect(bytes.includes(0xff)).toBe(true);
    expect(bytes.includes(0xfe)).toBe(true);
  });

  test('rejects input larger than the cap and non-text input', () => {
    const { service } = harness();
    const table = newTable();
    const term = service.create(table, {
      sessionId: 's1',
      scope: 'chat',
      cwd,
      cols: 80,
      rows: 24,
      command: '/bin/sleep',
      args: ['30'],
    });
    expect(() => service.write(table, term.id, 'x'.repeat(16 * 1024 + 1))).toThrow(ValidationError);
    expect(() => service.write(table, term.id, 42 as unknown as string)).toThrow(ValidationError);
    service.remove(table, term.id);
  });

  test('refuses a missing folder and caps terminals per chat', () => {
    const { service } = harness();
    const table = newTable();
    expect(() =>
      service.create(table, {
        sessionId: 's1',
        scope: 'chat',
        cwd: '/definitely/missing/kory-cwd',
        cols: 80,
        rows: 24,
        command: '/bin/sleep',
        args: ['1'],
      }),
    ).toThrow(ValidationError);
    for (let i = 0; i < 8; i += 1) {
      service.create(table, {
        sessionId: 's1',
        scope: 'chat',
        cwd,
        cols: 80,
        rows: 24,
        command: '/bin/sleep',
        args: ['30'],
      });
    }
    expect(() =>
      service.create(table, {
        sessionId: 's1',
        scope: 'chat',
        cwd,
        cols: 80,
        rows: 24,
        command: '/bin/sleep',
        args: ['30'],
      }),
    ).toThrow(ConflictError);
  });

  test('uses the login shell from the environment on Unix', () => {
    if (!isUnix()) return;
    const previous = process.env.SHELL;
    process.env.SHELL = '/bin/sh';
    try {
      const { service } = harness();
      const table = newTable();
      const term = service.create(table, {
        sessionId: 's1',
        scope: 'chat',
        cwd,
        cols: 80,
        rows: 24,
        command: undefined,
        args: undefined,
      } as never);
      expect(term.info().shell.startsWith('/bin/sh')).toBe(true);
      service.remove(table, term.id);
    } finally {
      if (previous === undefined) delete process.env.SHELL;
      else process.env.SHELL = previous;
    }
  });
});

describe('scrollback restore', () => {
  test('a reconnecting client restores from scrollback and resumes by sequence', async () => {
    const { recorded, service } = harness();
    const table = newTable();
    const term = service.create(table, {
      sessionId: 's1',
      scope: 'chat',
      cwd,
      cols: 80,
      rows: 24,
      ...sh('echo one; echo two; echo three'),
    });
    await until(() => !term.isRunning);
    const scrollback = service.scrollback(table, term.id);
    expect(scrollback.truncated).toBe(false);
    const restored = Buffer.from(scrollback.data, 'base64').toString('utf8');
    expect(restored).toContain('one');
    expect(restored).toContain('three');
    // Live events with seq <= throughSeq are already in the restored bytes.
    const live = recorded
      .filter((r) => r.message.type === 'terminal.output')
      .map((r) => r.message.payload as { seq: number });
    expect(live.map((p) => p.seq)).toEqual(live.map((_, i) => i + 1));
    expect(scrollback.throughSeq).toBe(live[live.length - 1]!.seq);
    expect(scrollback.fromSeq).toBe(1);
  });

  test('ring buffer evicts oldest chunks past its byte cap and reports truncation', () => {
    const ring = new ScrollbackRing(10);
    ring.append(1, new TextEncoder().encode('aaaa'));
    ring.append(2, new TextEncoder().encode('bbbb'));
    ring.append(3, new TextEncoder().encode('cccc'));
    const snap = ring.snapshot(3);
    expect(new TextDecoder().decode(snap.bytes)).toBe('bbbbcccc');
    expect(snap.fromSeq).toBe(2);
    expect(snap.throughSeq).toBe(3);
    expect(snap.truncated).toBe(true);
  });

  test('a single chunk larger than the cap keeps only its newest bytes', () => {
    const ring = new ScrollbackRing(4);
    ring.append(1, new TextEncoder().encode('0123456789'));
    expect(new TextDecoder().decode(ring.snapshot(1).bytes)).toBe('6789');
  });

  test('an empty ring reports the next sequence as the start', () => {
    const snap = new ScrollbackRing(8).snapshot(5);
    expect(snap).toMatchObject({ fromSeq: 6, throughSeq: 5, truncated: false });
    expect(snap.bytes.byteLength).toBe(0);
  });
});

describe('session isolation', () => {
  test('a terminal id from one chat does not resolve in another chat', () => {
    const { service } = harness();
    const chatA = newTable();
    const chatB = newTable();
    const term = service.create(chatA, {
      sessionId: 'chat-a',
      scope: 'chat',
      cwd,
      cols: 80,
      rows: 24,
      command: '/bin/sleep',
      args: ['30'],
    });
    expect(() => service.get(chatB, term.id)).toThrow(NotFoundError);
    expect(() => service.write(chatB, term.id, 'echo nope\n')).toThrow(NotFoundError);
    expect(() => service.kill(chatB, term.id)).toThrow(NotFoundError);
    expect(() => service.scrollback(chatB, term.id)).toThrow(NotFoundError);
    expect(service.list(chatB)).toEqual([]);
    service.remove(chatA, term.id);
  });

  test('live output is published against the owning chat only', async () => {
    const { recorded, service } = harness();
    const table = newTable();
    const term = service.create(table, {
      sessionId: 'chat-a',
      scope: 'chat',
      cwd,
      cols: 80,
      rows: 24,
      ...sh('echo hi'),
    });
    await until(() => !term.isRunning);
    expect(recorded.length).toBeGreaterThan(0);
    expect(new Set(recorded.map((r) => r.sessionId))).toEqual(new Set(['chat-a']));
    expect(recorded.every((r) => r.message.sessionId === 'chat-a')).toBe(true);
  });

  test('deleting a chat disposes its terminals through SessionRuntime', async () => {
    const { service } = harness();
    const runtime = new SessionRuntime();
    const term = service.create(runtime.terminals, {
      sessionId: 'chat-a',
      scope: 'chat',
      cwd,
      cols: 80,
      rows: 24,
      command: '/bin/sleep',
      args: ['30'],
    });
    expect(term).toBeInstanceOf(TerminalSession);
    runtime.dispose();
    expect(runtime.terminals.size).toBe(0);
    await until(() => !term.isRunning);
  });
});
