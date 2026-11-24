/**
 * Transport-neutral execution routing metadata. These values describe where
 * an operation belongs; they do not replace the target transport's authority
 * checks or turn a presentation/session id into a remote credential.
 */
export type ExecutionTarget =
  | { kind: 'local'; backendId: string }
  | { kind: 'linked-device'; deviceId: string; sessionId?: string }
  | { kind: 'remote-instance'; instanceId: string; sessionId: string }
  | { kind: 'collaboration'; collaborationId: string; tierId: string };

export const REMOTE_CAPABILITY_NAMES = [
  'sessions',
  'prompt_submission',
  'streaming',
  'cancellation',
  'questions',
  'approvals',
  'change_reviews',
  'workspace_navigation',
  'source_control',
  'notes',
  'memory',
  'goals',
  'checklists',
  'skills',
  'processes',
  'terminals',
  'providers',
  'model_selection',
  'attachments',
  'mcp',
  'computer_use',
  'voice',
  'images',
  'video',
  'billing',
  'device_administration',
] as const;
export type RemoteCapabilityName = (typeof REMOTE_CAPABILITY_NAMES)[number];

export type RemoteCapabilityState =
  | 'available'
  | 'unavailable'
  | 'unsupported'
  | 'offline'
  | 'permission_required'
  | 'approval_required'
  | 'not_configured'
  | 'stale'
  | 'busy'
  | 'expired';

export interface RemoteCapability {
  name: RemoteCapabilityName;
  state: RemoteCapabilityState;
  reason?: string;
  updatedAt?: number;
}

export type RemoteRouteScope = 'session' | 'workspace' | 'instance' | 'device' | 'controller';
export type RemoteRouteSideEffect = 'read' | 'write' | 'destructive' | 'credential' | 'admin';

export interface RemoteRouteDescriptor {
  id: string;
  methods: readonly string[];
  scope: RemoteRouteScope;
  capability: RemoteCapabilityName;
  sideEffect: RemoteRouteSideEffect;
  supportsMultipart: boolean;
  supportsBinaryResponse: boolean;
  pathPrefixes?: readonly string[];
}

const WORKBENCH_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;

/**
 * The route registry is the shared admission contract for target workbench
 * calls. It is intentionally descriptive: the receiving target still owns
 * authentication, session ownership, and capability enforcement.
 */
export const REMOTE_ROUTE_DESCRIPTORS: readonly RemoteRouteDescriptor[] = [
  {
    id: 'health',
    methods: ['GET'],
    scope: 'controller',
    capability: 'sessions',
    sideEffect: 'read',
    supportsMultipart: false,
    supportsBinaryResponse: false,
    pathPrefixes: ['/api/health'],
  },
  {
    id: 'sessions',
    methods: [...WORKBENCH_METHODS],
    scope: 'session',
    capability: 'sessions',
    sideEffect: 'write',
    supportsMultipart: false,
    supportsBinaryResponse: false,
    // The collection route is local-only; only a target-owned session may be
    // projected across the workbench boundary.
    pathPrefixes: ['/api/sessions/'],
  },
  {
    id: 'messages',
    methods: ['GET', 'POST'],
    scope: 'session',
    capability: 'prompt_submission',
    sideEffect: 'write',
    supportsMultipart: false,
    supportsBinaryResponse: false,
    pathPrefixes: ['/api/messages'],
  },
  {
    id: 'git',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    scope: 'workspace',
    capability: 'source_control',
    sideEffect: 'write',
    supportsMultipart: false,
    supportsBinaryResponse: false,
    pathPrefixes: ['/api/git'],
  },
  {
    id: 'project',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    scope: 'workspace',
    capability: 'workspace_navigation',
    sideEffect: 'write',
    supportsMultipart: true,
    supportsBinaryResponse: true,
    pathPrefixes: ['/api/project'],
  },
  {
    id: 'processes',
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    scope: 'session',
    capability: 'processes',
    sideEffect: 'write',
    supportsMultipart: false,
    supportsBinaryResponse: false,
    pathPrefixes: ['/api/processes'],
  },
  {
    id: 'goals',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    scope: 'workspace',
    capability: 'goals',
    sideEffect: 'write',
    supportsMultipart: false,
    supportsBinaryResponse: false,
    pathPrefixes: ['/api/goals'],
  },
  {
    id: 'notes',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    scope: 'workspace',
    capability: 'notes',
    sideEffect: 'write',
    supportsMultipart: true,
    supportsBinaryResponse: true,
    pathPrefixes: ['/api/notes'],
  },
  {
    id: 'checklists',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    scope: 'workspace',
    capability: 'checklists',
    sideEffect: 'write',
    supportsMultipart: false,
    supportsBinaryResponse: false,
    pathPrefixes: ['/api/checklists'],
  },
  {
    id: 'agent',
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    scope: 'session',
    capability: 'sessions',
    sideEffect: 'write',
    supportsMultipart: false,
    supportsBinaryResponse: false,
    pathPrefixes: ['/api/agent'],
  },
  {
    id: 'memory',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    scope: 'workspace',
    capability: 'memory',
    sideEffect: 'write',
    supportsMultipart: false,
    supportsBinaryResponse: false,
    pathPrefixes: ['/api/memory'],
  },
  {
    id: 'images',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    scope: 'workspace',
    capability: 'images',
    sideEffect: 'write',
    supportsMultipart: true,
    supportsBinaryResponse: true,
    pathPrefixes: ['/api/images'],
  },
  {
    id: 'video',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    scope: 'workspace',
    capability: 'video',
    sideEffect: 'write',
    supportsMultipart: false,
    supportsBinaryResponse: true,
    pathPrefixes: ['/api/video'],
  },
  {
    id: 'voice',
    methods: ['GET', 'POST'],
    scope: 'workspace',
    capability: 'voice',
    sideEffect: 'write',
    supportsMultipart: true,
    supportsBinaryResponse: true,
    pathPrefixes: ['/api/voice'],
  },
  {
    id: 'billing',
    methods: ['GET', 'POST'],
    scope: 'controller',
    capability: 'billing',
    sideEffect: 'read',
    supportsMultipart: false,
    supportsBinaryResponse: false,
    pathPrefixes: ['/api/billing', '/api/usage'],
  },
  {
    id: 'desktop-ui',
    methods: ['GET', 'POST', 'PUT'],
    scope: 'device',
    capability: 'device_administration',
    sideEffect: 'write',
    supportsMultipart: false,
    supportsBinaryResponse: false,
    pathPrefixes: ['/api/desktop-ui'],
  },
  {
    id: 'computer-use',
    methods: ['GET', 'POST'],
    scope: 'session',
    capability: 'computer_use',
    sideEffect: 'write',
    supportsMultipart: false,
    supportsBinaryResponse: true,
    pathPrefixes: ['/api/v1/computer-use'],
  },
  {
    id: 'mcp',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    scope: 'session',
    capability: 'mcp',
    sideEffect: 'write',
    supportsMultipart: false,
    supportsBinaryResponse: false,
    pathPrefixes: ['/api/v1/mcp-registry', '/api/v1/mcp-servers'],
  },
  {
    id: 'appearance',
    methods: [...WORKBENCH_METHODS],
    scope: 'controller',
    capability: 'workspace_navigation',
    sideEffect: 'write',
    supportsMultipart: false,
    supportsBinaryResponse: false,
    pathPrefixes: ['/api/appearance'],
  },
  {
    id: 'workspace',
    methods: [...WORKBENCH_METHODS],
    scope: 'workspace',
    capability: 'workspace_navigation',
    sideEffect: 'write',
    supportsMultipart: false,
    supportsBinaryResponse: false,
    pathPrefixes: ['/api/workspace'],
  },
  {
    id: 'collaboration',
    methods: [...WORKBENCH_METHODS],
    scope: 'controller',
    capability: 'sessions',
    sideEffect: 'write',
    supportsMultipart: false,
    supportsBinaryResponse: false,
    pathPrefixes: ['/api/collab'],
  },
  {
    id: 'mode',
    methods: [...WORKBENCH_METHODS],
    scope: 'session',
    capability: 'sessions',
    sideEffect: 'write',
    supportsMultipart: false,
    supportsBinaryResponse: false,
    pathPrefixes: ['/api/mode'],
  },
  {
    id: 'native-commands',
    methods: [...WORKBENCH_METHODS],
    scope: 'session',
    capability: 'processes',
    sideEffect: 'write',
    supportsMultipart: false,
    supportsBinaryResponse: false,
    pathPrefixes: ['/api/native-commands'],
  },
  {
    id: 'agent-messages',
    methods: [...WORKBENCH_METHODS],
    scope: 'session',
    capability: 'sessions',
    sideEffect: 'write',
    supportsMultipart: false,
    supportsBinaryResponse: false,
    pathPrefixes: ['/api/v1/agent-messages'],
  },
  {
    id: 'spend-caps',
    methods: [...WORKBENCH_METHODS],
    scope: 'controller',
    capability: 'billing',
    sideEffect: 'write',
    supportsMultipart: false,
    supportsBinaryResponse: false,
    pathPrefixes: ['/api/spend-caps'],
  },
];

export function remoteRouteDescriptor(
  path: string,
  method = 'GET',
): RemoteRouteDescriptor | undefined {
  const normalizedMethod = method.toUpperCase();
  return REMOTE_ROUTE_DESCRIPTORS.find(
    (descriptor) =>
      descriptor.methods.includes(normalizedMethod) &&
      descriptor.pathPrefixes?.some((prefix) =>
        prefix.endsWith('/')
          ? path.startsWith(prefix) && path.length > prefix.length
          : path === prefix || path.startsWith(`${prefix}/`),
      ),
  );
}

export function remoteRouteDescriptorById(id: string): RemoteRouteDescriptor | undefined {
  return REMOTE_ROUTE_DESCRIPTORS.find((descriptor) => descriptor.id === id);
}

export function isRemoteRouteAllowed(path: string, method = 'GET'): boolean {
  return remoteRouteDescriptor(path, method) !== undefined;
}

export type RemoteOperationState =
  | 'queued'
  | 'sent'
  | 'accepted'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'outcome_uncertain'
  | 'expired'
  | 'rejected';

export type RemoteTargetState =
  'connected' | 'reconnecting' | 'offline' | 'resuming' | 'stale' | 'revoked' | 'expired';

export function isExecutionTarget(value: unknown): value is ExecutionTarget {
  if (!value || typeof value !== 'object') return false;
  const target = value as Record<string, unknown>;
  if (typeof target.kind !== 'string') return false;
  if (target.kind === 'local') return typeof target.backendId === 'string' && !!target.backendId;
  if (target.kind === 'linked-device') {
    return (
      typeof target.deviceId === 'string' &&
      !!target.deviceId &&
      (target.sessionId === undefined || typeof target.sessionId === 'string')
    );
  }
  if (target.kind === 'remote-instance') {
    return (
      typeof target.instanceId === 'string' &&
      !!target.instanceId &&
      typeof target.sessionId === 'string' &&
      !!target.sessionId
    );
  }
  if (target.kind === 'collaboration') {
    return (
      typeof target.collaborationId === 'string' &&
      !!target.collaborationId &&
      typeof target.tierId === 'string' &&
      !!target.tierId
    );
  }
  return false;
}

/** A bridge is currently hosted by the local backend only. Remote MCP
 * transports must establish their own target-side grant before they can use
 * this boundary; they must not masquerade as a local target. */
export function isLocalExecutionTarget(value: unknown, backendId: string): boolean {
  return isExecutionTarget(value) && value.kind === 'local' && value.backendId === backendId;
}

export function capabilityIsAvailable(capability: RemoteCapability | undefined): boolean {
  return capability?.state === 'available';
}
