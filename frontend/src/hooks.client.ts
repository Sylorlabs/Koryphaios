// Client-side hooks — handle errors so we don't get a white screen
import type { HandleClientError } from '@sveltejs/kit';

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function errorClass(value: unknown): string {
  if (value === null) return 'null';
  const builtins: ReadonlyArray<readonly [string, new (...args: never[]) => Error]> = [
    ['EvalError', EvalError],
    ['RangeError', RangeError],
    ['ReferenceError', ReferenceError],
    ['SyntaxError', SyntaxError],
    ['TypeError', TypeError],
    ['URIError', URIError],
  ];
  for (const [name, constructor] of builtins) {
    try {
      if (value instanceof constructor) return name;
    } catch {
      return 'unknown';
    }
  }
  try {
    return value instanceof Error ? 'Error' : typeof value;
  } catch {
    return 'unknown';
  }
}

export const handleError: HandleClientError = async ({ error, message, status }) => {
  console.error('[SvelteKit client error]', {
    status: typeof status === 'number' ? status : 500,
    errorClass: errorClass(error),
    messageBytes: utf8Bytes(message),
  });
  // Return so the error page can display something; prevents blank screen
  let publicMessage = message;
  try {
    if (error instanceof Error) publicMessage = error.message;
  } catch {
    // A hostile thrown Proxy must not prevent SvelteKit from rendering its
    // already-sanitized fallback message.
  }
  return {
    message: publicMessage,
    statusCode: status ?? 500,
  };
};
