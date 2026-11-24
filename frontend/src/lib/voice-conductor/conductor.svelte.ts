// Reactive façade over the conductor controller. The composer hands it
// utterances, the HUD reads `state`, and the page registers a host so steering
// uses the composer's model selection.

import {
  createConductorController,
  type ConductorActions,
  type ConductorState,
  type VoiceConductorController,
} from './controller';
import { createDictationRouter, type CaptureMode, type DictationRouter } from './router';
import { conductorSettings } from './settings.svelte';
import type { ConductorHost } from './store-actions';

let state = $state<ConductorState>({ hud: null, busy: false });
let controller: VoiceConductorController | null = null;
let controllerPromise: Promise<VoiceConductorController> | null = null;
let host: ConductorHost | null = null;
let actionsOverride: ConductorActions | null = null;

async function getController(): Promise<VoiceConductorController> {
  if (controller) return controller;
  controllerPromise ??= (async () => {
    const actions =
      actionsOverride ?? (await import('./store-actions')).createStoreActions(() => host);
    controller = createConductorController(actions, (next) => {
      state = next;
    });
    return controller;
  })();
  return controllerPromise;
}

export const voiceConductor = {
  get state(): ConductorState {
    return state;
  },
  get enabled(): boolean {
    return conductorSettings.current.enabled;
  },
  get awaitingConfirmation(): boolean {
    return controller?.awaitingConfirmation ?? false;
  },

  /** Router for one capture, configured from the current settings. */
  createRouter(mode: CaptureMode, onModeChange?: (mode: CaptureMode) => void): DictationRouter {
    const settings = conductorSettings.current;
    return createDictationRouter(
      mode,
      {
        conductorEnabled: settings.enabled,
        wakePhraseEnabled: settings.wakePhraseEnabled,
        wakePhrase: settings.wakePhrase,
        awaitingConfirmation: controller?.awaitingConfirmation ?? false,
      },
      onModeChange,
    );
  },

  async handleUtterance(text: string): Promise<void> {
    if (!conductorSettings.current.enabled) return;
    await (await getController()).handleUtterance(text);
  },
  async confirm() {
    await (await getController()).confirm();
  },
  async undo() {
    await (await getController()).undo();
  },
  dismiss() {
    controller?.dismiss();
  },

  setHost(next: ConductorHost | null) {
    host = next;
  },

  /** Tests: swap in fake actions and start from a clean controller. */
  resetForTesting(actions: ConductorActions | null = null) {
    controller?.dispose();
    controller = null;
    controllerPromise = null;
    actionsOverride = actions;
    state = { hud: null, busy: false };
  },
};
