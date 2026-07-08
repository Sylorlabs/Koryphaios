export type FeedbackCategory = 'bug' | 'idea' | 'question' | 'other';

export interface FeedbackSubmission {
  category: FeedbackCategory;
  message: string;
  email?: string;
  appVersion?: string;
  platform?: string;
  context?: {
    route?: string;
  };
}

export interface FeedbackDeliveryResult {
  ok: boolean;
  id?: string;
  error?: string;
}

const DEFAULT_FEEDBACK_ENDPOINT = 'https://koryphaios.com/api/feedback';

function validEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))
    );
  } catch {
    return false;
  }
}

export async function deliverFeedback(
  submission: FeedbackSubmission,
  options: {
    endpoint?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<FeedbackDeliveryResult> {
  const endpoint =
    options.endpoint?.trim() ||
    process.env.KORYPHAIOS_FEEDBACK_ENDPOINT?.trim() ||
    DEFAULT_FEEDBACK_ENDPOINT;

  if (!validEndpoint(endpoint)) {
    return { ok: false, error: 'Feedback delivery is not configured safely' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 12_000);

  try {
    const response = await (options.fetchImpl ?? fetch)(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `Koryphaios-Feedback/${submission.appVersion || 'unknown'}`,
      },
      body: JSON.stringify(submission),
      signal: controller.signal,
    });

    const payload = (await response.json().catch(() => null)) as FeedbackDeliveryResult | null;
    if (!response.ok || !payload?.ok) {
      return {
        ok: false,
        error:
          response.status === 429
            ? 'Too many feedback reports. Please try again later.'
            : 'Feedback could not be delivered right now',
      };
    }

    return { ok: true, id: payload.id };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof DOMException && error.name === 'AbortError'
          ? 'Feedback delivery timed out'
          : 'Feedback could not be delivered right now',
    };
  } finally {
    clearTimeout(timeout);
  }
}
