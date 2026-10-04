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
export const COMPUTER_TIERS = ['plan', 'ask', 'edits', 'guarded', 'yolo', 'custom'] as const;
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
    enabled: false,
    byTier: {
      // Plan is an approval posture, not a hidden second hard-deny layer.
      plan: all('ask'),
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
}
export interface ComputerPlatformStatus {
  platform: string;
  available: boolean;
  capabilities: ComputerCapability[];
  limitations: string[];
}
export type ComputerAction =
  | { kind: 'discover' }
  | { kind: 'observe'; target: ComputerTarget }
  | {
      kind: 'click';
      target: ComputerTarget;
      x: number;
      y: number;
      button?: 'left' | 'right' | 'middle';
    }
  | { kind: 'doubleClick'; target: ComputerTarget; x: number; y: number }
  | { kind: 'move'; target: ComputerTarget; x: number; y: number }
  | { kind: 'drag'; target: ComputerTarget; path: Array<{ x: number; y: number }> }
  | { kind: 'type'; target: ComputerTarget; text: string }
  | { kind: 'key'; target: ComputerTarget; key: string }
  | { kind: 'scroll'; target: ComputerTarget; delta: number }
  | { kind: 'wait'; target?: ComputerTarget; ms: number }
  | { kind: 'focus'; target: ComputerTarget };
export interface ComputerActionResult {
  targets?: ComputerTarget[];
  /** PNG data, transported only as authorized model-visible image content. */
  imageBase64?: string;
  text?: string;
}
export interface ComputerPlatformAdapter {
  status(): Promise<ComputerPlatformStatus>;
  execute(action: ComputerAction, signal?: AbortSignal): Promise<ComputerActionResult>;
}
