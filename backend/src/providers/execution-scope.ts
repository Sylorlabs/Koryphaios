import { AsyncLocalStorage } from 'node:async_hooks';
import type { ModelDef, ProviderName } from '@koryphaios/shared';
import type { Provider } from './types';

/** Per-run provider authority. Never modifies the instance's persistent registry. */
export interface ProviderExecutionScope {
  sessionId: string;
  providers: Map<ProviderName, Provider>;
  antigravityHome?: string;
  antigravityModels?: ModelDef[];
  assertActive: () => void;
}
const scopes = new AsyncLocalStorage<ProviderExecutionScope>();
const sessionScopes = new Map<string, ProviderExecutionScope>();
export function bindProviderExecutionScope(scope: ProviderExecutionScope): () => void {
  sessionScopes.set(scope.sessionId, scope);
  return () => { if (sessionScopes.get(scope.sessionId) === scope) sessionScopes.delete(scope.sessionId); };
}
export function withSessionProviderExecutionScope<T>(sessionId: string, operation: () => T): T {
  const scope = sessionScopes.get(sessionId);
  return scope ? withProviderExecutionScope(scope, operation) : operation();
}
export function currentProviderExecutionScope(): ProviderExecutionScope | undefined {
  const scope = scopes.getStore();
  scope?.assertActive();
  return scope;
}
export function withProviderExecutionScope<T>(scope: ProviderExecutionScope, operation: () => T): T {
  scope.assertActive();
  return scopes.run(scope, operation);
}
