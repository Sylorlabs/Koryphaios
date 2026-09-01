import { describe, expect, it } from 'bun:test';
import {
  classifyProviderDiagnostic,
  safeProviderDiagnostic,
  safeProviderFailureMessage,
  safeUpstreamDetail,
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

  it('classifies 422 as invalid_request', () => {
    expect(classifyProviderDiagnostic(new Error('validation failed'), 422)).toBe('invalid_request');
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
    expect(isParameterRejectionError(Object.assign(new Error('rate limited'), { status: 429 }))).toBe(
      false,
    );
    expect(isParameterRejectionError(Object.assign(new Error('unauthorized'), { status: 401 }))).toBe(
      false,
    );
  });
});
