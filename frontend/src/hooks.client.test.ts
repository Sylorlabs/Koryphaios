import { afterEach, describe, expect, test, vi } from 'vitest';

import { handleError } from './hooks.client';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('client error hook confidentiality', () => {
  test('keeps a synthetic error out of the pre-layout console sink', async () => {
    const sentinel = 'SYNTHETIC_PRIVATE_CLIENT_ERROR_a186';
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const invoke = handleError as unknown as (input: {
      error: unknown;
      message: string;
      status: number;
    }) => Promise<{ message: string; statusCode: number }>;

    const result = await invoke({
      error: new TypeError(sentinel),
      message: sentinel,
      status: 500,
    });

    expect(result).toEqual({ message: sentinel, statusCode: 500 });
    expect(consoleError).toHaveBeenCalledWith('[SvelteKit client error]', {
      status: 500,
      errorClass: 'TypeError',
      messageBytes: new TextEncoder().encode(sentinel).byteLength,
    });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(sentinel);
  });
});
