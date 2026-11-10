import { describe, expect, test } from 'bun:test';
import { RemoteOperationLedger } from './remote-operation-ledger';

describe('RemoteOperationLedger', () => {
  test('deduplicates command retries and exposes uncertain outcomes', () => {
    const ledger = new RemoteOperationLedger();
    const target = { kind: 'local' as const, backendId: 'local' };
    const first = ledger.accept('command-1', 'operation-1', target, { path: '/api/messages' });
    expect(ledger.accept('command-1', 'operation-1', target, { path: '/api/messages' })).toEqual(
      first,
    );
    expect(ledger.transition('command-1', 'outcome_uncertain').state).toBe('outcome_uncertain');
    expect(ledger.get('command-1')?.cursor).toBe('operation-1:2');
    expect(() => ledger.accept('command-1', 'operation-1', target, { path: '/different' })).toThrow(
      'reused',
    );
  });
});
