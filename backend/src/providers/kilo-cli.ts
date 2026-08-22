// Kilo Code provider — uses the Kilo AI Gateway OpenAI-compatible API.
//
// Kilo exposes a unified, OpenAI-compatible gateway at https://api.kilo.ai/api/gateway.
// Auth is a Bearer API key from app.kilo.ai. BYOK keys are handled by the gateway itself,
// so users only enter their Kilo API key here.

import type { ProviderConfig } from '@koryphaios/shared';
import { OpenAIProvider } from './openai';

export const KILO_BASE_URL = 'https://api.kilo.ai/api/gateway';

export class KiloCodeProvider extends OpenAIProvider {
  constructor(config: ProviderConfig) {
    super(config, 'kilocode', KILO_BASE_URL);
  }
}
