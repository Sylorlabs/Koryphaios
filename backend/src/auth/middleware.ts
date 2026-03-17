// Authentication Middleware - Zero-Trust Local Architecture
// Validates every request using HMAC-based session tokens

import { localAuth } from './local-auth';
import { serverLog } from '../logger';
import { generateCorrelationId } from '../errors';

// Routes that don't require authentication (public endpoints)
const PUBLIC_PATHS = [
  '/api/health',
  '/health',
  '/health/live',
  '/health/ready',
  '/api/auth/setup',     // Initial setup endpoint
  '/api/auth/session',   // Create new session
];

// Routes that require specific permissions
const PROTECTED_ROUTES: Array<{
  pattern: RegExp;
  permission: string;
}> = [
  // Tools require explicit permission
  { pattern: /^\/api\/messages$/, permission: 'tools:execute' },
  { pattern: /^\/api\/sessions/, permission: 'sessions:manage' },
  { pattern: /^\/api\/providers/, permission: 'providers:manage' },
  { pattern: /^\/api\/agents/, permission: 'agents:manage' },
  { pattern: /^\/api\/git/, permission: 'git:execute' },
  { pattern: /^\/ws$/, permission: 'websocket:connect' },
];

export interface AuthContext {
  readonly requestId: string;
  readonly authenticated: boolean;
  readonly sessionId?: string;
  readonly permissions?: string[];
  readonly error?: string;
}

/**
 * Check if path is public (no auth required)
 */
function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some(path => 
    pathname === path || pathname.startsWith(path + '/')
  );
}

/**
 * Get required permission for a path
 */
function getRequiredPermission(pathname: string): string | null {
  for (const route of PROTECTED_ROUTES) {
    if (route.pattern.test(pathname)) {
      return route.permission;
    }
  }
  // Default permission for unspecified routes
  return 'general:access';
}

/**
 * Create authentication middleware
 */
export function createAuthMiddleware() {
  return async (req: Request, pathname: string): Promise<{ 
    context: AuthContext; 
    response?: Response 
  }> => {
    const requestId = generateCorrelationId();
    
    // Allow public paths
    if (isPublicPath(pathname)) {
      return {
        context: {
          requestId,
          authenticated: false,
        }
      };
    }
    
    // Extract auth header
    const authHeader = req.headers.get('Authorization') || 
                      req.headers.get('X-Koryphaios-Auth');
    
    // Validate authentication
    const validation = localAuth.validateRequest(authHeader);
    
    if (!validation.valid) {
      serverLog.warn({ 
        requestId, 
        pathname,
        error: validation.error 
      }, 'Authentication failed');
      
      return {
        context: {
          requestId,
          authenticated: false,
          error: validation.error,
        },
        response: new Response(
          JSON.stringify({ 
            ok: false, 
            error: 'Unauthorized: ' + validation.error,
            requestId,
          }),
          { 
            status: 401, 
            headers: {
              'Content-Type': 'application/json',
              'WWW-Authenticate': 'Bearer'
            }
          }
        )
      };
    }
    
    const session = validation.session!;
    
    // Check required permission
    const requiredPermission = getRequiredPermission(pathname);
    if (requiredPermission && !localAuth.hasPermission(session, requiredPermission)) {
      serverLog.warn({
        requestId,
        pathname,
        sessionId: session.id.slice(0, 8),
        required: requiredPermission,
        has: session.permissions,
      }, 'Permission denied');
      
      return {
        context: {
          requestId,
          authenticated: true,
          sessionId: session.id,
          permissions: session.permissions,
          error: 'Forbidden: insufficient permissions',
        },
        response: new Response(
          JSON.stringify({
            ok: false,
            error: `Forbidden: requires '${requiredPermission}' permission`,
            requestId,
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        )
      };
    }
    
    // Authentication successful
    return {
      context: {
        requestId,
        authenticated: true,
        sessionId: session.id,
        permissions: session.permissions,
      }
    };
  };
}

/**
 * WebSocket authentication handler
 * Validates the initial upgrade request
 */
export async function validateWebSocketAuth(req: Request): Promise<{
  valid: boolean;
  sessionId?: string;
  error?: string;
}> {
  // Extract token from query string or header
  const url = new URL(req.url);
  const token = url.searchParams.get('token') || 
                req.headers.get('Authorization') ||
                req.headers.get('X-Koryphaios-Auth');
  
  const validation = localAuth.validateRequest(token);
  
  if (!validation.valid) {
    return { valid: false, error: validation.error };
  }
  
  // Check websocket permission
  if (!localAuth.hasPermission(validation.session!, 'websocket:connect')) {
    return { valid: false, error: 'Missing websocket permission' };
  }
  
  return {
    valid: true,
    sessionId: validation.session!.id,
  };
}

/**
 * Create a new session (for auth endpoints)
 */
export function handleCreateSession(permissions?: string[]): {
  sessionId: string;
  signature: string;
  expiresAt: number;
} {
  const session = localAuth.createSession(permissions);
  const sessionData = localAuth['sessions'].get(session.sessionId);
  
  return {
    sessionId: session.sessionId,
    signature: session.signature,
    expiresAt: sessionData?.expiresAt || Date.now() + 24 * 60 * 60 * 1000,
  };
}

// Export auth middleware instance
export const authMiddleware = createAuthMiddleware();
