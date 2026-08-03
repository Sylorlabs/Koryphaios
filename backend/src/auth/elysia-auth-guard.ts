import type { Elysia } from 'elysia';
import { validateLocalBearerToken } from './local-route-auth';
import type { SessionToken } from './local-auth';

/**
 * Authentication guard for Elysia routes.
 *
 * Replaces the 184 per-route `requireLocalRouteAuth(request, set)` checks.
 *
 * IMPORTANT: Elysia 1.4.x does NOT short-circuit route handlers when
 * `onBeforeHandle` or `.guard()` is defined inside a `.use()`d plugin.
 * The guard MUST be applied INLINE on the main app instance, not via a
 * separate plugin. Use `applyAuthGuard(app)` to install it.
 *
 * Routes that should NOT require auth (e.g. /api/auth/*, /api/health) must
 * be registered BEFORE calling `applyAuthGuard`.
 *
 * The validated session token is available as `ctx.session` in route handlers.
 */

const UNAUTHED_PATHS = new Set([
  '/api/health',
  '/api/auth/login',
  '/api/auth/status',
  '/api/auth/me',
]);

/**
 * Derive function: validates the bearer token and adds `session` to the context.
 * Applied inline via `.derive(authGuardDerive)`.
 */
export const authGuardDerive = ({ request }: { request: Request }) => ({
  session: validateLocalBearerToken(request.headers.get('authorization')) as SessionToken | null,
});

/**
 * Before-handle guard: rejects requests without a valid session.
 * Applied inline via `.guard({ beforeHandle: authGuardBeforeHandle })`.
 */
export const authGuardBeforeHandle = ({
  request,
  set,
  session,
}: {
  request: Request;
  set: { status?: number | string };
  session: SessionToken | null;
}) => {
  const url = new URL(request.url);
  if (UNAUTHED_PATHS.has(url.pathname)) return;
  if (!session) {
    set.status = 401;
    return { ok: false, error: 'Unauthorized' };
  }
};

/**
 * Apply the auth guard to an Elysia instance INLINE.
 *
 * Usage in server.ts:
 *   const app = applyAuthGuard(
 *     new Elysia()
 *       .use(cors(...))
 *       .use(authRoutes)  // ← register unauthenticated routes BEFORE the guard
 *   )
 *   .use(sessionRoutes)   // ← guarded routes AFTER
 *   .use(messageRoutes)
 *
 * The `.derive()` + `.guard()` must be chained inline on the same Elysia
 * instance that registers the routes — Elysia 1.4.x does not propagate
 * `.guard()` short-circuit behavior through `.use()`d plugins.
 */
export function applyAuthGuard(app: any): any {
  return app.derive(authGuardDerive).guard({ beforeHandle: authGuardBeforeHandle as any });
}
