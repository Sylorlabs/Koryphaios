// Runtime (inference) verification — the check that actually answers "can
// this account generate?", which a catalog probe structurally cannot.
//
// A model catalog proves the endpoint is reachable and the response is
// catalog-shaped. It does not prove the key is scoped to inference, that the
// plan entitles API access, or that the selected model is available to this
// account. Gateways make this gap actively misleading: Command Code answers
// `GET /provider/v1/models` with HTTP 200 and its full catalog *without any
// credentials at all*, and only refuses on the completion POST with
// `permission_error` / `upgrade_required`. A connect flow that stops at the
// catalog therefore reports "Connected" for an account that cannot generate a
// single token.
//
// So a completed connect issues one real, minimal generation. It reuses the
// provider's own adapter via `streamResponse` so every provider's auth header,
// route family, and parameter shaping stay authoritative — this module never
// re-implements a wire format.
//
// Cost and blast radius are deliberately bounded:
//   • one request, `maxTokens: 1`, a single-word prompt
//   • a short deadline, because a slow provider is not a failed provider
//   • only for chat-shaped HTTP providers, and never on the polled
//     `GET /api/providers` auto-connect path (see `verifyRuntimeCompletion`)
//   • a *transient* rejection (rate limit, 5xx, timeout, overloaded) never
//     demotes a provider that the catalog already accepted. Only a definitive
//     refusal is allowed to fail a connect, because only a definitive refusal
//     is evidence about the account rather than about the moment.

import type { Provider, StreamRequest } from './types';
import type { ProviderConfig, ProviderName } from '@koryphaios/shared';
import { safeProviderDiagnostic } from './provider-diagnostics';

/** Cheap probe prompt. Content is irrelevant; only acceptance is measured. */
const PROBE_PROMPT = 'ping';

/** A generation probe is a liveness check, not a work request. */
const RUNTIME_VERIFICATION_TIMEOUT_MS = 20_000;

export type RuntimeVerificationOutcome =
  /** The provider generated. This is the only proof of account-level access. */
  | { kind: 'generated' }
  /**
   * The provider refused in a way that is a fact about the account, not the
   * moment: bad key, no API entitlement, plan excludes the model, model not
   * available to this key. Safe to surface as a connect failure.
   */
  | { kind: 'refused'; error: string }
  /**
   * The provider could not answer right now (rate limit, 5xx, timeout,
   * overloaded, network). Says nothing about the account, so it must not
   * demote a catalog-accepted provider.
   */
  | { kind: 'transient'; error: string }
  /** This provider is not eligible for a generation probe. */
  | { kind: 'skipped'; reason: string };

/**
 * Provider families that must never be sent a synthetic generation.
 *
 * - CLI harnesses and the managed app-server own their own auth and run real
 *   turns; `account` scope already means "the CLI's own authority confirmed
 *   this".
 * - Local endpoints are frequently busy loading a model, and a keyless local
 *   server has no account to prove.
 * - Non-chat APIs (transcription, image, embeddings, async agent control
 *   planes) have no completion to issue.
 * - Deployment/hosted-resource providers gate on a deployment or project that
 *   a synthetic generation cannot meaningfully prove, and their catalogs
 *   already verify the binding.
 */
function ineligibleReason(name: ProviderName, config: ProviderConfig): string | null {
  if (String(name).startsWith('remote-')) return 'remote agent provider';
  if (config.custom === true) {
    // A pinned non-chat wire adapter has no completion contract to probe.
    return config.adapter ? 'custom wire adapter without a chat contract' : null;
  }
  return null;
}

/** Model ids that are never a sensible verification target. */
function isUnprobeableModel(model: string): boolean {
  const id = model.trim().toLowerCase();
  return (
    id.length === 0 ||
    // Embedding/retrieval/rerank models answer a different contract and would
    // fail a chat probe for reasons that say nothing about the account.
    id.includes('embed') ||
    id.includes('rerank') ||
    id.includes('whisper') ||
    id.includes('tts') ||
    id.includes('dall-e') ||
    id.includes('stable-diffusion')
  );
}

/**
 * Choose the model to probe with. Prefers a model the user actually selected,
 * then the provider's own first model, skipping non-chat families. Returns
 * `null` when the catalog offers nothing probeable.
 */
export function selectVerificationModel(provider: Provider, preferred?: string): string | null {
  const candidates = [preferred, ...provider.listModels().map((model) => model.id)].filter(
    (id): id is string => typeof id === 'string' && id.trim().length > 0,
  );
  for (const candidate of candidates) {
    if (!isUnprobeableModel(candidate)) return candidate;
  }
  return null;
}

/**
 * Classify a provider-reported failure into a refusal (about the account) or a
 * transient condition (about the moment). Mirrors the taxonomy the user-facing
 * diagnostics already use so one error never reads two ways.
 */
function classifyRejection(
  providerName: ProviderName,
  value: unknown,
  fallbackMessage: string,
): { kind: 'refused' | 'transient'; error: string } {
  const diagnostic = safeProviderDiagnostic(providerName, 'sdk', value);
  const detail = diagnostic.upstreamDetail ?? '';

  // A refusal is specific: the provider told us this key/account/model may not
  // do this. Anything vaguer is treated as transient so a bad minute never
  // marks a working provider as broken.
  const REFUSAL =
    /\b(?:upgrade_required|upgrade required|insufficient[_ ]?(?:quota|credit|permission)|billing|payment|required|payment method|not entitled|no api access|does not include api|permission[_ ]error|forbidden|access denied|unauthorized|invalid[_ ]api[_ ]key|model .*(?:not found|not available|not supported|not enabled)|no access to model)\b/i;
  const TRANSIENT =
    /\b(?:rate limit|too many requests|quota exceeded|overloaded|capacity|try again|timeout|timed out|deadline|service unavailable|bad gateway|internal server error|ECONNRESET|ECONNREFUSED|fetch failed|socket|network)\b/i;

  if (TRANSIENT.test(detail) || TRANSIENT.test(fallbackMessage)) {
    return { kind: 'transient', error: fallbackMessage };
  }
  if (
    diagnostic.category === 'authentication' ||
    diagnostic.category === 'permission' ||
    diagnostic.category === 'invalid_request' ||
    REFUSAL.test(detail) ||
    REFUSAL.test(fallbackMessage)
  ) {
    return { kind: 'refused', error: fallbackMessage };
  }
  // Unrecognized: a provider that fails a generation without saying why is
  // treated as transient. Claiming a broken account on an ambiguous error is
  // worse than admitting we did not learn anything.
  return { kind: 'transient', error: fallbackMessage };
}

/**
 * Issue one minimal generation against an already-catalog-verified provider.
 *
 * `provider` must be the real adapter built by the registry so the request uses
 * the same auth and routing the user's messages will use — that is the whole
 * point: the check must exercise the path that actually fails.
 */
export async function verifyRuntimeCompletion(
  providerName: ProviderName,
  provider: Provider,
  options: { preferredModel?: string } = {},
): Promise<RuntimeVerificationOutcome> {
  // `listModels()` hydrates asynchronously and returns [] on the first call
  // while the catalog fetch is still in flight. A connect that lands in that
  // window would otherwise skip the generation and quietly report a
  // catalog-only verdict — the exact gap this module exists to close. Settle
  // the catalog first.
  if (provider.listModels().length === 0 && provider.refreshModels) {
    try {
      await provider.refreshModels(true);
    } catch {
      // A catalog that cannot be refreshed leaves the skip below to report.
    }
  }

  const model = selectVerificationModel(provider, options.preferredModel);
  if (!model) {
    return {
      kind: 'skipped',
      reason: 'no chat model in the provider catalog to verify against',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUNTIME_VERIFICATION_TIMEOUT_MS);
  try {
    const stream = provider.streamResponse({
      model,
      systemPrompt: '',
      maxTokens: 1,
      signal: controller.signal,
      // A verification turn is not a session and must not persist provider
      // transcripts or spend the user's routing budget.
      forceFreshConversation: true,
      messages: [{ role: 'user', content: PROBE_PROMPT }],
    } as StreamRequest);

    for await (const event of stream) {
      if (event.type === 'error') {
        const message =
          typeof (event as { error?: unknown }).error === 'string'
            ? (event as { error: string }).error
            : 'The provider rejected the verification request.';
        return classifyRejection(providerName, message, message);
      }
      // Any real generation event proves the account can generate. `done` is
      // sufficient — the probe never needs the token itself.
      if (event.type === 'content_delta' || event.type === 'complete') {
        return { kind: 'generated' };
      }
    }
    return {
      kind: 'transient',
      error: 'The provider closed the verification stream without a response.',
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const aborted = controller.signal.aborted;
    return aborted
      ? {
          kind: 'transient',
          error: `The provider did not answer within ${RUNTIME_VERIFICATION_TIMEOUT_MS / 1000}s.`,
        }
      : classifyRejection(providerName, error, message);
  } finally {
    clearTimeout(timer);
  }
}
