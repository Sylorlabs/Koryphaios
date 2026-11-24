/** Computer-use permissions are separate from generic tool approval and OS consent. */
export const COMPUTER_CAPABILITIES = [
  'discover',
  'observe',
  'interact',
  'manageWindows',
  'clipboardRead',
  'clipboardWrite',
  'transfer',
  'sensitive',
] as const;
export type ComputerCapability = (typeof COMPUTER_CAPABILITIES)[number];
export type ComputerPermission = 'allow' | 'ask' | 'block';
export const COMPUTER_ROLES = ['manager', 'worker', 'critic'] as const;
export type ComputerRole = (typeof COMPUTER_ROLES)[number];
export const COMPUTER_TIERS = ['ask', 'edits', 'guarded', 'yolo', 'custom'] as const;
export type ComputerTier = (typeof COMPUTER_TIERS)[number];
export interface ComputerAppPermission {
  appId: string;
  label: string;
  capabilities: Partial<Record<ComputerCapability, ComputerPermission>>;
}
export interface ComputerUseSettings {
  enabled: boolean;
  /** Permission presets and orchestration roles are independent gates. */
  byTier: Record<ComputerTier, Record<ComputerCapability, ComputerPermission>>;
  byRole: Record<ComputerRole, Record<ComputerCapability, ComputerPermission>>;
  apps: ComputerAppPermission[];
}
export function defaultComputerUseSettings(): ComputerUseSettings {
  const all = (permission: ComputerPermission) =>
    Object.fromEntries(COMPUTER_CAPABILITIES.map((c) => [c, permission])) as Record<
      ComputerCapability,
      ComputerPermission
    >;
  return {
    // The feature is available by default, while every capability remains
    // gated by the preset, agent role, OS consent, and explicit app grants.
    enabled: true,
    byTier: {
      ask: all('ask'),
      edits: all('ask'),
      guarded: all('ask'),
      // YOLO skips Kory approval prompts. OS consent, unsupported operations,
      // invalid targets and explicit blocks still fail normally.
      yolo: all('allow'),
      custom: all('ask'),
    },
    byRole: {
      manager: all('ask'),
      worker: all('ask'),
      critic: { ...all('block'), discover: 'ask', observe: 'ask' },
    },
    apps: [],
  };
}
export interface ComputerTarget {
  /** OS-resolved identity; never trust an agent-supplied display label. */
  appId: string;
  windowId: string;
  title: string;
  pid: number;
  scope?: 'window' | 'desktop';
  /** Keep the window out of the person's way; capture still reads its pixels. */
  hidden?: boolean;
}
export interface ComputerElement {
  /** Short-lived identifier returned by element discovery for this window. */
  elementId: string;
  role: string;
  name?: string;
  value?: string;
  description?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  enabled: boolean;
  actions: string[];
}
export interface ComputerPlatformStatus {
  platform: string;
  available: boolean;
  capabilities: ComputerCapability[];
  limitations: string[];
  /** Exact operations available; broad capabilities alone do not imply action support. */
  actions?: string[];
}
export type ComputerAction =
  | { kind: 'discover' }
  | { kind: 'listElements'; target: ComputerTarget }
  | { kind: 'observe'; target: ComputerTarget }
  | {
      kind: 'click';
      target: ComputerTarget;
      /** Deliver to the window's process without moving the pointer or taking focus. */
      background?: boolean;
      elementId?: string;
      x?: number;
      y?: number;
      button?: 'left' | 'right' | 'middle';
    }
  | {
      kind: 'doubleClick';
      target: ComputerTarget;
      background?: boolean;
      elementId?: string;
      x?: number;
      y?: number;
    }
  | {
      kind: 'move';
      target: ComputerTarget;
      elementId?: string;
      x?: number;
      y?: number;
      background?: boolean;
    }
  | {
      kind: 'drag';
      target: ComputerTarget;
      background?: boolean;
      elementId?: string;
      path: Array<{ x: number; y: number }>;
    }
  | {
      kind: 'type';
      target: ComputerTarget;
      elementId?: string;
      text: string;
      background?: boolean;
    }
  | {
      kind: 'key';
      target: ComputerTarget;
      elementId?: string;
      key: string;
      background?: boolean;
    }
  | {
      kind: 'scroll';
      target: ComputerTarget;
      elementId?: string;
      delta: number;
      background?: boolean;
    }
  | { kind: 'wait'; target?: ComputerTarget; ms: number }
  | { kind: 'focus'; target: ComputerTarget; background?: boolean }
  /** Move a window off screen so the task runs out of the person's way, or put it back. */
  | { kind: 'place'; target: ComputerTarget; hidden: boolean }
  | {
      /**
       * Many actions in one native round trip. `observationId` reuses one observation so a
       * long, rapid run (drawing, for example) does not re-analyze the window between steps.
       */
      kind: 'sequence';
      steps: ComputerStep[];
      observationId?: string;
      background?: boolean;
    };
/** One step of a queue. Each step names its own window, so a queue can span several. */
export type ComputerStep =
  | {
      kind: 'click';
      target: ComputerTarget;
      elementId?: string;
      x?: number;
      y?: number;
      button?: 'left' | 'right' | 'middle';
    }
  | { kind: 'doubleClick'; target: ComputerTarget; elementId?: string; x?: number; y?: number }
  | { kind: 'move'; target: ComputerTarget; elementId?: string; x?: number; y?: number }
  | {
      kind: 'drag';
      target: ComputerTarget;
      elementId?: string;
      path: Array<{ x: number; y: number }>;
    }
  | { kind: 'type'; target: ComputerTarget; elementId?: string; text: string }
  | { kind: 'key'; target: ComputerTarget; elementId?: string; key: string }
  | { kind: 'scroll'; target: ComputerTarget; elementId?: string; delta: number }
  | { kind: 'wait'; ms: number };

export interface ComputerActionResult {
  targets?: ComputerTarget[];
  elements?: ComputerElement[];
  /** PNG data, transported only as authorized model-visible image content. */
  imageBase64?: string;
  text?: string;
  /** One observation handle; pass it back as `observationId` to run a queue without re-observing. */
  observationId?: string;
  /** Present when the window changed outside this action: the agent must re-observe. */
  interference?: { kind: 'user-input' | 'window-changed'; message: string };
  /** Per step outcome for a queue. */
  steps?: Array<{ index: number; status: 'done' | 'failed'; message?: string }>;
}
/** Display evidence, not authority to perform or repeat an action. No typed text or pixels. */
export interface ComputerUseReceipt {
  version: 1;
  action: string;
  status: 'completed' | 'failed';
  target?: ComputerTarget;
  elementId?: string;
  x?: number;
  y?: number;
  button?: string;
  path?: Array<{ x: number; y: number }>;
  key?: string;
  delta?: number;
  ms?: number;
  textLength?: number;
  message: string;
  elements?: Array<Pick<ComputerElement, 'elementId' | 'role' | 'name' | 'enabled' | 'actions'>>;
  targets?: ComputerTarget[];
  screenshot?: { id: string; expiresAt: number };
}
export interface ComputerPlatformAdapter {
  status(): Promise<ComputerPlatformStatus>;
  execute(action: ComputerAction, signal?: AbortSignal): Promise<ComputerActionResult>;
}
