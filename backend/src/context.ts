import { ProviderRegistry } from './providers';
import { ToolRegistry } from './tools';
import { KoryManager } from './kory/manager';
import { SessionStore } from './stores/session-store';
import { MessageStore } from './stores/message-store';
import { TaskStore } from './stores/task-store';
import { GoalStore } from './stores/goal-store';
import { WSManager } from './ws/ws-manager';
import { MCPManager } from './mcp/client';
import { TimeTravelService } from './services/timetravel';
import type { AppConfig } from './config-schema';

export interface AppContext {
  config: AppConfig;
  providers: ProviderRegistry;
  tools: ToolRegistry;
  mcpManagerPromise: Promise<MCPManager>;
  sessions: SessionStore;
  messages: MessageStore;
  tasks: TaskStore;
  goals: GoalStore;
  kory: KoryManager;
  wsManager: WSManager;
  timeTravel: TimeTravelService;
}

let context: AppContext | null = null;

export function setContext(ctx: AppContext) {
  context = ctx;
}

export function getContext(): AppContext {
  if (!context) {
    throw new Error('AppContext not initialized. Call setContext first.');
  }
  return context;
}
