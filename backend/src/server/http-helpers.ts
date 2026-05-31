import type { APIResponse } from '@koryphaios/shared';

export function json(
  data: APIResponse,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

/** Merge CORS headers into a Response so cross-origin clients (e.g. dev frontend) can read it. */
export function withCors(res: Response, corsHeaders: Record<string, string>): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

const MAX_JSON_BODY_BYTES = 1 * 1024 * 1024; // 1 MB

/** Parse JSON body with size limit; on failure return 400 Response. Caller must merge corsHeaders. */
export async function parseJson<T>(
  req: Request,
  corsHeaders: Record<string, string>,
): Promise<{ ok: true; data: T } | { ok: false; res: Response }> {
  const contentLength = parseInt(req.headers.get('content-length') ?? '0', 10);
  if (contentLength > MAX_JSON_BODY_BYTES) {
    return {
      ok: false,
      res: json({ ok: false, error: 'Request body too large' }, 413, corsHeaders),
    };
  }
  try {
    const data = (await req.json()) as T;
    return { ok: true, data };
  } catch {
    return {
      ok: false,
      res: json({ ok: false, error: 'Invalid or missing JSON body' }, 400, corsHeaders),
    };
  }
}
