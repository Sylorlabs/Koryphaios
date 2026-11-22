/**
 * Project scoped agent permission preset control for evaluation runs.
 *
 * Evaluation fixtures build, render and screenshot, and the guarded preset refuses that shell: the
 * backend records `SHELL_METACHARACTERS` and `EXECUTABLE_NOT_ALLOWED` and the subject's turn ends
 * without an artifact. The preset is stored per project, so an evaluation run sets it, and must put
 * back exactly the field it changed even when the run fails.
 */

export const EVAL_PERMISSION_MODES = ['yolo', 'guarded', 'edits', 'ask', 'custom'] as const;

export type EvalPermissionMode = (typeof EVAL_PERMISSION_MODES)[number];

function baseUrlFor(port: string): string {
  return `http://127.0.0.1:${port}`;
}

async function bearerToken(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin' }),
  });
  if (!response.ok) throw new Error(`Admin session failed with ${String(response.status)}`);
  const body = (await response.json()) as { data?: { bearerToken?: string } };
  const token = body.data?.bearerToken;
  if (!token) throw new Error('Admin session returned no bearer token');
  return token;
}

/** Reads the project's current preset so a caller can restore it. */
export async function readPermissionMode(port = process.env.KORYPHAIOS_PORT ?? '3001'): Promise<
  string | undefined
> {
  const baseUrl = baseUrlFor(port);
  const token = await bearerToken(baseUrl);
  const response = await fetch(`${baseUrl}/api/agent/settings`, {
    headers: { authorization: token },
  });
  if (!response.ok) throw new Error(`Reading agent settings failed with ${String(response.status)}`);
  const body = (await response.json()) as { data?: { permissionMode?: string } };
  return body.data?.permissionMode;
}

/** Sets the project's preset and returns the previous value, which the caller must restore. */
export async function applyPermissionMode(
  mode: EvalPermissionMode,
  port = process.env.KORYPHAIOS_PORT ?? '3001',
): Promise<string | undefined> {
  const baseUrl = baseUrlFor(port);
  const token = await bearerToken(baseUrl);
  const readResponse = await fetch(`${baseUrl}/api/agent/settings`, {
    headers: { authorization: token },
  });
  if (!readResponse.ok) {
    throw new Error(`Reading agent settings failed with ${String(readResponse.status)}`);
  }
  const previous = ((await readResponse.json()) as { data?: { permissionMode?: string } }).data
    ?.permissionMode;
  const writeResponse = await fetch(`${baseUrl}/api/agent/settings`, {
    method: 'PUT',
    headers: { authorization: token, 'content-type': 'application/json' },
    body: JSON.stringify({ permissionMode: mode }),
  });
  if (!writeResponse.ok) {
    throw new Error(`Writing agent settings failed with ${String(writeResponse.status)}`);
  }
  return previous;
}

/** Puts a preset back. Never throws: a failed restore is reported, not fatal to the run. */
export async function restorePermissionMode(
  previous: string | undefined,
  port = process.env.KORYPHAIOS_PORT ?? '3001',
): Promise<void> {
  if (previous === undefined) return;
  const baseUrl = baseUrlFor(port);
  const token = await bearerToken(baseUrl);
  const response = await fetch(`${baseUrl}/api/agent/settings`, {
    method: 'PUT',
    headers: { authorization: token, 'content-type': 'application/json' },
    body: JSON.stringify({ permissionMode: previous }),
  });
  if (!response.ok) {
    console.warn(
      `[eval-permission] restoring preset ${JSON.stringify(previous)} failed with ${String(response.status)}`,
    );
  }
}

export function isEvalPermissionMode(value: string): value is EvalPermissionMode {
  return (EVAL_PERMISSION_MODES as readonly string[]).includes(value);
}
