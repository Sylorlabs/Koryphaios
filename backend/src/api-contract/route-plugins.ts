// The HTTP surface the generated API contract describes.
//
// Each entry mirrors one `.use(...)` in `backend/src/server.ts`, in the same
// order. `server.ts` remains the runtime truth; `route-plugins.test.ts` fails
// if this list and the server's `.use` chain drift apart, so a route added to
// the server without being listed here cannot silently skip the contract.
//
// Modules are imported lazily so that importing this file has no side effects
// (the database and auth key are opened only when a caller asks for the plugins).

export interface ApiRoutePluginEntry {
  /** Name of the `.use(...)` argument in `server.ts`. */
  readonly name: string;
  /** Module path relative to `backend/src/`. */
  readonly module: string;
  /** Export to read from that module. A factory is called with no arguments. */
  readonly export: string;
  readonly factory?: boolean;
}

export const API_ROUTE_PLUGINS: readonly ApiRoutePluginEntry[] = [
  { name: 'systemRoutes', module: 'routes/v1/system', export: 'systemRoutes' },
  { name: 'sessionRoutes', module: 'routes/v1/sessions', export: 'sessionRoutes' },
  { name: 'scheduleRoutes', module: 'routes/v1/schedules', export: 'scheduleRoutes' },
  { name: 'feedRoutes', module: 'routes/v1/feed', export: 'feedRoutes' },
  { name: 'messageRoutes', module: 'routes/v1/messages', export: 'messageRoutes' },
  { name: 'providerRoutes', module: 'routes/v1/providers', export: 'providerRoutes' },
  { name: 'agentRoutes', module: 'routes/v1/agents', export: 'agentRoutes' },
  { name: 'collaborationRoutes', module: 'routes/collaboration', export: 'collaborationRoutes' },
  { name: 'deviceRoutes', module: 'routes/v1/devices', export: 'deviceRoutes' },
  { name: 'authRoutes', module: 'routes/v1/auth', export: 'authRoutes' },
  {
    name: 'agentSettingsRoutes',
    module: 'routes/v1/agent-settings',
    export: 'agentSettingsRoutes',
  },
  {
    name: 'createComputerUseRoutes()',
    module: 'routes/v1/computer-use',
    export: 'createComputerUseRoutes',
    factory: true,
  },
  { name: 'gitRoutes', module: 'routes/v1/git', export: 'gitRoutes' },
  {
    name: 'sessionReviewRoutes',
    module: 'routes/v1/session-review',
    export: 'sessionReviewRoutes',
  },
  { name: 'memoryRoutes', module: 'routes/v1/memory', export: 'memoryRoutes' },
  { name: 'spendRoutes', module: 'routes/v1/spend', export: 'spendRoutes' },
  { name: 'spendCapsRoutes', module: 'routes/v1/spend-caps', export: 'spendCapsRoutes' },
  { name: 'billingRoutes', module: 'routes/v1/billing', export: 'billingRoutes' },
  { name: 'processRoutes', module: 'routes/v1/processes', export: 'processRoutes' },
  { name: 'terminalRoutes', module: 'routes/v1/terminals', export: 'terminalRoutes' },
  { name: 'notesRoutes', module: 'routes/v1/notes', export: 'notesRoutes' },
  { name: 'workspaceRoutes', module: 'routes/v1/workspace', export: 'workspaceRoutes' },
  { name: 'goalRoutes', module: 'routes/v1/goals', export: 'goalRoutes' },
  { name: 'checklistRoutes', module: 'routes/v1/checklists', export: 'checklistRoutes' },
  {
    name: 'nativeCommandRoutes',
    module: 'routes/v1/native-commands',
    export: 'nativeCommandRoutes',
  },
  { name: 'mcpBridgeRoutes', module: 'routes/v1/mcp-bridge', export: 'mcpBridgeRoutes' },
  { name: 'mcpServerRoutes', module: 'routes/v1/mcp-servers', export: 'mcpServerRoutes' },
  { name: 'mcpRegistryRoutes', module: 'routes/v1/mcp-registry', export: 'mcpRegistryRoutes' },
  { name: 'voiceRoutes', module: 'routes/v1/voice', export: 'voiceRoutes' },
  { name: 'imageRoutes', module: 'routes/v1/images', export: 'imageRoutes' },
  { name: 'videoRoutes', module: 'routes/v1/video', export: 'videoRoutes' },
  { name: 'usageRoutes', module: 'routes/v1/usage', export: 'usageRoutes' },
  { name: 'agentMessageRoutes', module: 'routes/v1/agent-messages', export: 'agentMessageRoutes' },
  { name: 'appearanceRoutes', module: 'routes/v1/appearance', export: 'appearanceRoutes' },
  { name: 'desktopUiRoutes', module: 'routes/v1/desktop-ui', export: 'desktopUiRoutes' },
  { name: 'runRoutes', module: 'routes/v1/runs', export: 'runRoutes' },
  { name: 'updateRoutes', module: 'routes/v1/updates', export: 'updateRoutes' },
  {
    name: 'cliChatImportRoutes',
    module: 'routes/v1/cli-chat-import',
    export: 'cliChatImportRoutes',
  },
];

/** Loads every plugin in server order. Importing route modules opens the database module, so callers set up the environment first. */
export async function loadApiRoutePlugins(): Promise<Array<{ name: string; plugin: unknown }>> {
  const loaded: Array<{ name: string; plugin: unknown }> = [];
  for (const entry of API_ROUTE_PLUGINS) {
    const mod = (await import(`../${entry.module}`)) as Record<string, unknown>;
    const exported = mod[entry.export];
    if (exported === undefined) {
      throw new Error(
        `API route plugin ${entry.name}: ${entry.module} does not export ${entry.export}`,
      );
    }
    const plugin = entry.factory ? (exported as () => unknown)() : exported;
    loaded.push({ name: entry.name, plugin });
  }
  return loaded;
}
