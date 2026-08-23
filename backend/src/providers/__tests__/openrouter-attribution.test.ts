import { describe, expect, it } from 'bun:test';
import {
  buildAuthHeaders,
  OPENROUTER_ATTRIBUTION_HEADERS,
  withOpenRouterAttribution,
} from '../api-endpoints';

describe('OpenRouter app-attribution headers', () => {
  it('exposes the required HTTP-Referer, X-OpenRouter-Title, and category headers', () => {
    expect(OPENROUTER_ATTRIBUTION_HEADERS['HTTP-Referer']).toBeTruthy();
    expect(OPENROUTER_ATTRIBUTION_HEADERS['X-OpenRouter-Title']).toBeTruthy();
    expect(OPENROUTER_ATTRIBUTION_HEADERS['X-OpenRouter-Categories']).toContain('agent');
  });

  it('withOpenRouterAttribution returns defaults when no user headers are provided', () => {
    const headers = withOpenRouterAttribution();
    expect(headers['HTTP-Referer']).toBe(OPENROUTER_ATTRIBUTION_HEADERS['HTTP-Referer']);
    expect(headers['X-OpenRouter-Title']).toBe(
      OPENROUTER_ATTRIBUTION_HEADERS['X-OpenRouter-Title'],
    );
  });

  it('withOpenRouterAttribution lets user-configured headers override defaults', () => {
    const headers = withOpenRouterAttribution({
      'X-OpenRouter-Title': 'My Custom App',
      'X-Custom': 'custom-value',
    });
    expect(headers['X-OpenRouter-Title']).toBe('My Custom App');
    expect(headers['X-Custom']).toBe('custom-value');
    // Non-overridden defaults are preserved
    expect(headers['HTTP-Referer']).toBe(OPENROUTER_ATTRIBUTION_HEADERS['HTTP-Referer']);
  });

  it('buildAuthHeaders includes attribution headers for openrouter', () => {
    const { headers } = buildAuthHeaders('openrouter', { apiKey: 'sk-or-v1-test' });
    expect(headers['Authorization']).toBe('Bearer sk-or-v1-test');
    expect(headers['HTTP-Referer']).toBe(OPENROUTER_ATTRIBUTION_HEADERS['HTTP-Referer']);
    expect(headers['X-OpenRouter-Title']).toBe(
      OPENROUTER_ATTRIBUTION_HEADERS['X-OpenRouter-Title'],
    );
    expect(headers['X-OpenRouter-Categories']).toBe(
      OPENROUTER_ATTRIBUTION_HEADERS['X-OpenRouter-Categories'],
    );
  });

  it('buildAuthHeaders does not add attribution headers to non-openrouter providers', () => {
    const { headers } = buildAuthHeaders('openai', { apiKey: 'sk-test' });
    expect(headers['HTTP-Referer']).toBeUndefined();
    expect(headers['X-OpenRouter-Title']).toBeUndefined();
  });
});
