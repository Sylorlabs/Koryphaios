import { describe, expect, it } from 'bun:test';
import {
  classifyProviderDiagnostic,
  isContextLimitFailureMessage,
  isTransientStreamErrorText,
  providerStreamFailure,
  safeProviderDiagnostic,
  safeProviderFailureMessage,
  safeUpstreamDetail,
  transientExhaustedMessage,
} from '../provider-diagnostics';
import { isParameterRejectionError } from '../openai';

describe('provider diagnostics upstream detail', () => {
  it('extracts and bounds the upstream reason from an OpenAI SDK error', () => {
    const err = new Error(
      "400 status code (no body) - {'error': {'message': 'reasoning_effort is not supported for this model'}}",
    );
    const detail = safeUpstreamDetail(err);
    expect(detail).toContain('reasoning_effort is not supported');
    expect(detail.length).toBeLessThanOrEqual(221);
  });

  it('redacts secret-looking tokens', () => {
    const detail = safeUpstreamDetail(
      'auth failed for key sk-proj-abcdefgh12345678 and xai-abcdefgh1234567890',
    );
    expect(detail).not.toContain('sk-proj-abcdefgh');
    expect(detail).not.toContain('xai-abcdefgh');
    expect(detail).toContain('[redacted]');
  });

  it('includes the upstream detail in the invalid_request failure message', () => {
    const err = new Error("400 - {'error': {'message': 'Model not found grok-4.6'}}");
    (err as { status?: number }).status = 400;
    const diagnostic = safeProviderDiagnostic('xai', 'sdk', err);
    expect(diagnostic.category).toBe('invalid_request');
    expect(diagnostic.upstreamDetail).toContain('Model not found');
    const message = safeProviderFailureMessage('xai', diagnostic);
    expect(message).toContain('xAI rejected the request');
    expect(message).toContain('provider said:');
  });

  it('omits the detail clause when nothing readable is available', () => {
    const diagnostic = safeProviderDiagnostic('xai', 'http', '', { status: 400 });
    const message = safeProviderFailureMessage('xai', diagnostic);
    expect(message).not.toContain('provider said:');
  });

  it('surfaces the entitlement reason behind a bare 403 permission failure', () => {
    // Command Code answers every request on a non-API plan with an identical
    // 403, so "check the provider account" is unactionable without the reason.
    const err = new Error(
      "403 Your Go plan doesn't include API access. Upgrade to Provider or higher at https://commandcode.ai/billing to use these endpoints.",
    );
    Object.assign(err, { status: 403, code: 'upgrade_required' });
    const diagnostic = safeProviderDiagnostic('commandcode', 'sdk', err);
    expect(diagnostic.category).toBe('permission');
    const message = safeProviderFailureMessage('commandcode', diagnostic);
    expect(message).toContain("doesn't include API access");
  });

  it.each([
    ['authentication', 401],
    ['rate_limit', 429],
    ['permission', 403],
    ['timeout', 408],
  ] as const)('carries the upstream reason for %s failures', (category, status) => {
    const err = new Error(`${status} upstream account detail`);
    Object.assign(err, { status });
    const diagnostic = safeProviderDiagnostic('custom:gateway', 'sdk', err, { status });
    expect(diagnostic.category).toBe(category);
    expect(safeProviderFailureMessage('custom:gateway', diagnostic)).toContain(
      'upstream account detail',
    );
  });

  it('carries the upstream reason when a CLI adapter fails to launch', () => {
    const err = new Error('spawn claude ENOENT upstream account detail');
    const diagnostic = safeProviderDiagnostic('claude', 'spawn', err);
    expect(diagnostic.category).toBe('unavailable');
    expect(safeProviderFailureMessage('claude', diagnostic)).toContain('upstream account detail');
  });

  it('still redacts secrets carried in the detail clause', () => {
    const err = new Error('403 forbidden for key sk-proj-abcdefgh12345678');
    Object.assign(err, { status: 403 });
    const diagnostic = safeProviderDiagnostic('openai', 'sdk', err);
    const message = safeProviderFailureMessage('openai', diagnostic);
    expect(message).toContain('provider said:');
    expect(message).not.toContain('sk-proj-abcdefgh');
  });

  it('classifies 422 as invalid_request', () => {
    expect(classifyProviderDiagnostic(new Error('validation failed'), 422)).toBe('invalid_request');
  });

  it('classifies a conduit-style 413 route-limit envelope as context_limit', () => {
    const err = new Error(
      'Error:413 {"type":"error","error": {"type":"invalid_request_error","message":"The request exceeds this model route context limit. Reduce the request or select a model with a larger verified context window.","code":"contex...',
    );
    (err as { status?: number }).status = 413;
    const diagnostic = safeProviderDiagnostic('custom:conduit', 'sdk', err);
    expect(diagnostic.category).toBe('context_limit');
    const message = safeProviderFailureMessage('custom:conduit', diagnostic);
    expect(message).toContain('context limit');
    expect(message).not.toContain('invalid_request_error');
    expect(isContextLimitFailureMessage(message)).toBe(true);
  });

  it('detects context-limit text without a status code', () => {
    expect(
      classifyProviderDiagnostic(
        new Error('The request exceeds this model route context limit. Reduce the request.'),
      ),
    ).toBe('context_limit');
    expect(
      isContextLimitFailureMessage('Model reported the request exceeds its context limit'),
    ).toBe(true);
    expect(isContextLimitFailureMessage('Model not found grok-4.6')).toBe(false);
  });
});

describe('transient stream error detection', () => {
  // Reported verbatim from a custom Anthropic-kind route: the SDK throws this
  // from an open `event: error` frame, so there is no HTTP status to retry on.
  const SSE_API_ERROR =
    'SSE Error: {"type":"error","error":{"type":"api_error","message":"Temporary service interruption. Retry the last turn; your conversation and tool state are preserved."}}';
  const AUTH_ENVELOPE =
    'SSE Error: {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}';
  const REJECTION_ENVELOPE =
    'SSE Error: {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: 4096 > 1024, too large"}}';

  it('treats a statusless in-stream api_error as retryable', () => {
    const err = new Error(`Error:{"type":"error","error":{"type":"api_error"}}:${SSE_API_ERROR}`);
    expect((err as { status?: number }).status).toBeUndefined();
    expect(isTransientStreamErrorText(err)).toBe(true);
    expect(isTransientStreamErrorText(SSE_API_ERROR)).toBe(true);
  });

  it('matches the untyped gateway prose for the same condition', () => {
    expect(isTransientStreamErrorText('Temporary service interruption. Retry the turn.')).toBe(
      true,
    );
    expect(isTransientStreamErrorText('{"type":"overloaded_error"}')).toBe(true);
    expect(isTransientStreamErrorText('Please try again later')).toBe(true);
  });

  it('leaves rejections and empty text alone', () => {
    expect(
      isTransientStreamErrorText(
        '{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens is too large"}}',
      ),
    ).toBe(false);
    expect(
      isTransientStreamErrorText(
        'The request exceeds this model route context limit. Reduce the request.',
      ),
    ).toBe(false);
    expect(isTransientStreamErrorText('')).toBe(false);
    expect(isTransientStreamErrorText(undefined)).toBe(false);
  });

  it('sends the user back to the turn instead of to Settings', () => {
    const diagnostic = safeProviderDiagnostic('custom:conduit', 'sdk', new Error(SSE_API_ERROR));
    expect(diagnostic.category).toBe('provider_failure');
    const message = safeProviderFailureMessage('custom:conduit', diagnostic);
    expect(message).toContain('temporary upstream service error');
    expect(message).not.toContain('inspect provider status');
    expect(message).toContain('Retry the turn');
  });

  it('records the retry verdict even when the detail clause is truncated', () => {
    // The decisive token sits past the 220-char display bound, so a consumer that
    // re-matched `upstreamDetail` would lose the retry.
    const padded = `${SSE_API_ERROR} ${'trace=abcdefghij '.repeat(40)}`;
    const diagnostic = safeProviderDiagnostic('custom:conduit', 'sdk', new Error(padded));
    expect(diagnostic.upstreamDetail?.length).toBeLessThanOrEqual(221);
    expect(diagnostic.transient).toBe(true);
    expect(safeProviderFailureMessage('custom:conduit', diagnostic)).toContain(
      'temporary upstream service error',
    );
  });

  it('marks credential and request rejections as not transient', () => {
    expect(safeProviderDiagnostic('anthropic', 'sdk', new Error(AUTH_ENVELOPE)).transient).toBe(
      false,
    );
    expect(safeProviderDiagnostic('custom:x', 'sdk', new Error(REJECTION_ENVELOPE)).transient).toBe(
      false,
    );
  });

  it('builds a ready-to-yield event that carries the flag from the raw error', () => {
    const failure = providerStreamFailure('custom:conduit', 'sdk', new Error(SSE_API_ERROR));
    expect(failure.event.type).toBe('error');
    expect(failure.event.errorTransient).toBe(true);
    expect(failure.diagnostic.transient).toBe(true);

    const rejected = providerStreamFailure('custom:conduit', 'sdk', new Error(REJECTION_ENVELOPE));
    expect(rejected.event.errorTransient).toBe(false);

    // A 5xx status is transient even when the body is empty.
    const empty5xx = providerStreamFailure('custom:conduit', 'http', '', { status: 503 });
    expect(empty5xx.event.errorTransient).toBe(true);
  });

  it('states the attempt count when the retry budget is spent', () => {
    const message = transientExhaustedMessage('Gateway dropped the stream.', 3);
    expect(message).toContain('Gateway dropped the stream.');
    expect(message).toContain('3 attempts');
    expect(transientExhaustedMessage('Gateway dropped the stream.', 1)).toContain('1 attempt ');
  });
});

describe('parameter rejection detection', () => {
  it('detects 400/422 statuses', () => {
    const err = Object.assign(new Error('Bad request'), { status: 400 });
    expect(isParameterRejectionError(err)).toBe(true);
    expect(isParameterRejectionError(Object.assign(new Error('x'), { status: 422 }))).toBe(true);
  });

  it('detects unsupported-parameter messages without a status', () => {
    expect(
      isParameterRejectionError(new Error("Extra inputs are not permitted: 'reasoning_effort'")),
    ).toBe(true);
    expect(isParameterRejectionError(new Error('reasoning_effort is not supported'))).toBe(true);
  });

  it('does not misclassify rate limits or auth failures', () => {
    expect(
      isParameterRejectionError(Object.assign(new Error('rate limited'), { status: 429 })),
    ).toBe(false);
    expect(
      isParameterRejectionError(Object.assign(new Error('unauthorized'), { status: 401 })),
    ).toBe(false);
  });
});
