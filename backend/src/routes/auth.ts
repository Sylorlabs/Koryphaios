// Authentication Routes - Session management and setup

import type { RouteHandler, RouteDependencies } from './types';
import { json } from './types';
import { localAuth } from '../auth/local-auth';
import { serverLog } from '../logger';
import { generateCorrelationId } from '../errors';

export function createAuthRoutes(_deps: RouteDependencies): RouteHandler[] {
  return [
    // GET /api/auth/status - Check authentication status
    {
      path: '/api/auth/status',
      method: 'GET',
      handler: async (req, _params, ctx) => {
        const authHeader = req.headers.get('Authorization');
        const validation = localAuth.validateRequest(authHeader);
        
        return json({
          ok: true,
          data: {
            authenticated: validation.valid,
            session: validation.session ? {
              id: validation.session.id.slice(0, 8) + '...',
              created: validation.session.created,
              expiresAt: validation.session.expiresAt,
              permissions: validation.session.permissions,
            } : null,
          }
        }, 200);
      },
    },
    
    // POST /api/auth/session - Create new session
    {
      path: '/api/auth/session',
      method: 'POST',
      handler: async (req, _params, ctx) => {
        try {
          const body = await req.json().catch(() => ({}));
          
          // Validate request origin (should be from local frontend)
          const origin = req.headers.get('Origin');
          const requestId = generateCorrelationId();
          
          // Log session creation attempt
          serverLog.info({ 
            requestId, 
            origin,
            permissions: body.permissions 
          }, 'Creating new auth session');
          
          // Create session with requested permissions (or default)
          const permissions = Array.isArray(body.permissions) 
            ? body.permissions 
            : ['*']; // Default to all permissions for now
          
          const session = localAuth.createSession(permissions);
          const sessionData = localAuth['sessions'].get(session.sessionId);
          
          return json({
            ok: true,
            data: {
              sessionId: session.sessionId,
              signature: session.signature,
              expiresAt: sessionData?.expiresAt,
            }
          }, 201);
          
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          serverLog.error({ err }, 'Failed to create session');
          return json({ ok: false, error: message }, 500);
        }
      },
    },
    
    // DELETE /api/auth/session - Revoke session
    {
      path: '/api/auth/session',
      method: 'DELETE',
      handler: async (req, _params, ctx) => {
        const authHeader = req.headers.get('Authorization');
        const validation = localAuth.validateRequest(authHeader);
        
        if (!validation.valid) {
          return json({ ok: false, error: 'Unauthorized' }, 401);
        }
        
        // Revoke the session
        localAuth.revokeSession(validation.session!.id);
        
        return json({
          ok: true,
          message: 'Session revoked successfully'
        }, 200);
      },
    },
    
    // GET /api/auth/setup - Get setup token (one-time display)
    {
      path: '/api/auth/setup',
      method: 'GET',
      handler: async (req, _params, ctx) => {
        const requestId = generateCorrelationId();
        
        // Check if this is first-time setup by looking for existing sessions
        const sessions = localAuth.listSessions();
        const isFirstSetup = sessions.length === 0;
        
        serverLog.info({ 
          requestId, 
          isFirstSetup,
          clientIp: req.headers.get('X-Forwarded-For') || 'local'
        }, 'Setup token requested');
        
        return json({
          ok: true,
          data: {
            setupToken: localAuth.getSetupToken(),
            isFirstSetup,
            message: isFirstSetup 
              ? 'First-time setup. Save this token in your password manager.'
              : 'Setup already complete.',
          }
        }, 200);
      },
    },
    
    // GET /api/auth/sessions - List active sessions (admin only)
    {
      path: '/api/auth/sessions',
      method: 'GET',
      handler: async (req, _params, ctx) => {
        const authHeader = req.headers.get('Authorization');
        const validation = localAuth.validateRequest(authHeader);
        
        if (!validation.valid) {
          return json({ ok: false, error: 'Unauthorized' }, 401);
        }
        
        // Check for admin permission
        if (!localAuth.hasPermission(validation.session!, 'admin:sessions')) {
          return json({ ok: false, error: 'Forbidden: requires admin permission' }, 403);
        }
        
        const sessions = localAuth.listSessions();
        
        return json({
          ok: true,
          data: {
            sessions,
            count: sessions.length,
          }
        }, 200);
      },
    },
    
    // DELETE /api/auth/sessions/:id - Revoke specific session (admin only)
    {
      path: /^\/api\/auth\/sessions\/(?<id>[^/]+)$/,
      method: 'DELETE',
      handler: async (req, params, ctx) => {
        const authHeader = req.headers.get('Authorization');
        const validation = localAuth.validateRequest(authHeader);
        
        if (!validation.valid) {
          return json({ ok: false, error: 'Unauthorized' }, 401);
        }
        
        if (!localAuth.hasPermission(validation.session!, 'admin:sessions')) {
          return json({ ok: false, error: 'Forbidden' }, 403);
        }
        
        const sessionId = params.get('id');
        if (!sessionId) {
          return json({ ok: false, error: 'Missing session ID' }, 400);
        }
        
        const revoked = localAuth.revokeSession(sessionId);
        
        if (!revoked) {
          return json({ ok: false, error: 'Session not found' }, 404);
        }
        
        return json({
          ok: true,
          message: 'Session revoked'
        }, 200);
      },
    },
  ];
}
