import type { SessionToken } from './local-auth';
import { localAuth } from './local-auth';

type ResponseSetter = {
  status?: number | string;
};

export function buildLocalBearerToken(session: { sessionId: string; signature: string }): string {
  return `Bearer ${session.sessionId}:${session.signature}`;
}

export function validateLocalBearerToken(token: string | null | undefined): SessionToken | null {
  const validation = localAuth.validateRequest(token ?? null);
  return validation.valid ? validation.session ?? null : null;
}

export function requireLocalRouteAuth(
  request: Request,
  set?: ResponseSetter,
): SessionToken | null {
  const session = validateLocalBearerToken(request.headers.get('authorization'));
  if (session) return session;
  if (set) set.status = 401;
  return null;
}
