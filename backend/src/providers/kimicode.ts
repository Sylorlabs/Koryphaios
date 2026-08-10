import OpenAI from 'openai';
import type { ProviderConfig } from '@koryphaios/shared';
import { createUsageInterceptingFetch } from '../credit-accountant';
import { OpenAIProvider } from './openai';
import type { ProviderEvent, StreamRequest, ProviderToolDef } from './types';
import { discoverCliAccounts, type DiscoveredCliAccount } from './cli-accounts';
import {
  createKimiCodeCliMarker,
  isKimiCodeMarker,
  isKimiCodeAuthMarker,
  isKimiCodeCliMarker,
  kimiCodeMarkerProfileDir,
  loadKimiCodeAuthState,
  resolveKimiCodeAccessToken,
} from './kimicode-auth';
import { getCliBridge } from './cli-bridges';
import { KORY_DIRECT_TOOL_HARNESS_NOTE } from './cli-bridges';

const KIMICODE_BASE_URL = 'https://api.kimi.com/coding/v1';

export class KimiCodeProvider extends OpenAIProvider {
  private currentAccessToken: string | null = null;
  private currentProfileKey: string | null = null;
  private kimiClient: OpenAI | null = null;

  constructor(config: ProviderConfig) {
    super(config, 'kimicode', config.baseUrl ?? KIMICODE_BASE_URL);
  }

  // ── Multi-account discovery (mirrors CodexCliProvider) ───────────────────
  // Kimi Code stores OAuth sessions at ~/.kimi* dirs. The user can have
  // several Kimi accounts (work/personal) isolated as ~/.kimi, ~/.kimi2, …
  // and pick + order them via fallbackOrder, exactly like Codex CLI profiles.

  private accounts(): DiscoveredCliAccount[] {
    const discovered = discoverCliAccounts().filter((account) => account.provider === 'kimicode');
    const selectedOrder = this.config.fallbackOrder ?? [];
    if (selectedOrder.length === 0) return discovered;
    const byId = new Map(discovered.map((account) => [account.id, account]));
    return selectedOrder
      .map((id) => byId.get(id))
      .filter((account): account is DiscoveredCliAccount => !!account);
  }

  /** The authToken to use for this request. Prefer the explicitly configured
   *  authToken (managed session or activated CLI account); fall back to the
   *  first discovered CLI profile so the provider lights up with zero config
   *  after `kimi login`. */
  private resolveActiveAuthToken(): string | null {
    const configured = this.config.authToken?.trim();
    if (configured) return configured;
    const account = this.accounts()[0];
    return account ? createKimiCodeCliMarker(account.profileDir) : null;
  }

  override isAvailable(): boolean {
    if (this.config.disabled) return false;
    const authToken = this.resolveActiveAuthToken();
    if (!authToken) return false;
    // A raw token (non-marker) is always considered available.
    if (!isKimiCodeMarker(authToken)) return true;
    // Markers require an on-disk session to be usable.
    const profileDir = kimiCodeMarkerProfileDir(authToken);
    if (!profileDir) return false;
    return !!loadKimiCodeAuthState(profileDir)?.accessToken;
  }

  protected override async prepareForModelDiscovery(): Promise<void> {
    await this.ensureAccessToken();
  }

  protected override get client(): OpenAI {
    if (!this.kimiClient) {
      this.kimiClient = new OpenAI({
        apiKey: this.currentAccessToken || 'placeholder-awaiting-kimi-auth',
        baseURL: this.config.baseUrl ?? KIMICODE_BASE_URL,
        defaultHeaders: this.config.headers,
        fetch: createUsageInterceptingFetch(globalThis.fetch),
      });
    }
    return this.kimiClient;
  }

  override async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    await this.ensureAccessToken();
    // Inject the Koryphaios harness note into the system prompt via the
    // KimiCodeCliBridge (Phase 1). KimiCode is API-based so the bridge
    // packages the system instructions for the API request.
    const kimiBridge = getCliBridge('kimicode');
    const bridgeConfig = kimiBridge?.buildAgentConfig({
      provider: 'kimicode',
      role: request.harnessRole ?? 'manager',
      sandbox: request.sandbox,
      workingDirectory: request.workingDirectory?.trim() || process.cwd(),
      sessionId: request.sessionId,
      systemPrompt: request.systemPrompt ?? '',
      tools: request.tools ?? [],
    });
    // Kimi uses direct OpenAI-compatible function calls, not the MCP subprocess.
    // Keep the manager-supplied ToolRegistry definitions (already role-filtered)
    // so returned tool names execute directly and cannot drift from authority.
    const koryProviderTools: ProviderToolDef[] = request.tools ?? [];
    const augmentedRequest: StreamRequest = {
      ...request,
      systemPrompt: bridgeConfig?.systemInstructions?.length
        ? bridgeConfig.systemInstructions.filter(Boolean).join('\n\n')
        : request.systemPrompt?.trim()
          ? `${request.systemPrompt}\n\n${KORY_DIRECT_TOOL_HARNESS_NOTE}`
          : KORY_DIRECT_TOOL_HARNESS_NOTE,
      tools: koryProviderTools,
    };
    yield* super.streamResponse(augmentedRequest);
  }

  private async ensureAccessToken(): Promise<void> {
    const authToken = this.resolveActiveAuthToken();
    if (!authToken) {
      throw new Error(
        'Kimi Code is not signed in. Run `kimi login` in your terminal, or sign in from Settings.',
      );
    }
    const accessToken = await resolveKimiCodeAccessToken(authToken);
    if (!accessToken) {
      if (isKimiCodeAuthMarker(authToken)) {
        throw new Error('Kimi Code session expired. Sign in with Kimi Code again.');
      }
      if (isKimiCodeCliMarker(authToken)) {
        throw new Error('Kimi Code CLI session expired. Run `kimi login` in your terminal.');
      }
      throw new Error('Kimi Code auth token not found.');
    }
    // Invalidate the cached OpenAI client when the token (or the profile
    // it came from) changes, so account switches take effect immediately.
    const profileKey = kimiCodeMarkerProfileDir(authToken) ?? authToken;
    if (accessToken !== this.currentAccessToken || profileKey !== this.currentProfileKey) {
      this.currentAccessToken = accessToken;
      this.currentProfileKey = profileKey;
      this.kimiClient = null;
    }
  }
}
