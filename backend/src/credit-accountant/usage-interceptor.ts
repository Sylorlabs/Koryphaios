/**
 * HTTP-level usage interceptor: parses x-anthropic-usage (Anthropic) and
 * usage JSON body (OpenAI) from raw fetch responses and records to CreditAccountant.
 * Complements stream-based recording (registry usage_update) for non-streaming
 * and any response where the provider sends usage in headers/body.
 */

import { recordUsage } from "./index";

function safeRecordUsage(model: string, provider: string, tokensIn: number, tokensOut: number): void {
  try {
    recordUsage(model, provider, tokensIn, tokensOut);
  } catch {
    // CreditAccountant may not be initialized yet; ignore
  }
}

const ANTHROPIC_URL_SUBSTR = "anthropic";
const OPENAI_URL_SUBSTR = "openai.com";

type FetchImpl = typeof fetch;

function getRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function parseBodyForModel(body: BodyInit | null | undefined): string | undefined {
  if (body == null) return undefined;
  try {
    if (typeof body === "string") {
      const data = JSON.parse(body);
      return data?.model ?? undefined;
    }
    // ReadableStream / other: skip (we'd need to consume and re-create)
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns a fetch function that intercepts responses from Anthropic and OpenAI:
 * - Anthropic: reads x-anthropic-usage response header (JSON: input_tokens, output_tokens).
 * - OpenAI: for non-streaming JSON responses, reads response body and extracts usage.
 * Records usage via CreditAccountant and returns the original response.
 */
export function createUsageInterceptingFetch(realFetch: FetchImpl): FetchImpl {
  async function interceptingFetch(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const url = getRequestUrl(input);
    const isAnthropic = url.includes(ANTHROPIC_URL_SUBSTR);
    const isOpenAI = url.includes(OPENAI_URL_SUBSTR);

    const model =
      isAnthropic || isOpenAI
        ? parseBodyForModel(init?.body as BodyInit | null | undefined)
        : undefined;

    const response = await realFetch(input, init);

    if (!model) return response;

    if (isAnthropic) {
      const usageHeader = response.headers.get("x-anthropic-usage");
      if (usageHeader) {
        try {
          const u = JSON.parse(usageHeader) as { input_tokens?: number; output_tokens?: number };
          const in_ = Number(u?.input_tokens ?? 0);
          const out_ = Number(u?.output_tokens ?? 0);
          if (in_ > 0 || out_ > 0) {
            safeRecordUsage(model, "anthropic", in_, out_);
          }
        } catch {
          // ignore parse errors
        }
      }
      return response;
    }

    if (isOpenAI) {
      const contentType = response.headers.get("content-type") ?? "";
      const isJson = contentType.includes("application/json");
      const isStream = contentType.includes("stream") || response.body != null;
      // Only read body for non-streaming JSON (e.g. non-stream completions)
      if (isJson && !contentType.includes("text/event-stream")) {
        try {
          const cloned = response.clone();
          const data = (await cloned.json()) as {
            usage?: { prompt_tokens?: number; completion_tokens?: number };
            model?: string;
          };
          const usage = data?.usage;
          const m = data?.model ?? model;
          if (usage && (usage.prompt_tokens != null || usage.completion_tokens != null)) {
            const in_ = Number(usage.prompt_tokens ?? 0);
            const out_ = Number(usage.completion_tokens ?? 0);
            if (in_ > 0 || out_ > 0) {
              safeRecordUsage(m, "openai", in_, out_);
            }
          }
        } catch {
          // ignore: e.g. body already consumed
        }
      }
      return response;
    }

    return response;
  }
  return interceptingFetch as FetchImpl;
}
