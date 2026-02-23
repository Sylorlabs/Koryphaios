/**
 * API Key Authentication Middleware
 * 
 * Express middleware for authenticating requests via API keys.
 * 
 * Features:
 * - Extracts API key from Authorization header or query param
 * - Validates key against database
 * - Checks required scopes
 * - Attaches user info to request
 * - Integrates with rate limiting
 * - Comprehensive error responses
 */

import type { Request, Response, NextFunction } from 'express';
import { createApiKeyService, ApiKeyService, ApiKey, ApiKeyScope } from './service';
import { serverLog } from '../logger';

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      apiKey?: ApiKey;
      authenticatedUser?: {
        id: string;
        type: 'api_key' | 'jwt';
        scopes: string[];
        rateLimitTier: string;
      };
    }
  }
}

export interface ApiKeyMiddlewareOptions {
  /**
   * Required scopes for this route
   */
  requiredScopes?: ApiKeyScope[];
  
  /**
   * Whether to allow JWT authentication as fallback
   */
  allowJwtFallback?: boolean;
  
  /**
   * Whether to skip authentication (for public routes)
   */
  optional?: boolean;
  
  /**
   * Custom key extractor
   */
  extractKey?: (req: Request) => string | undefined;
  
  /**
   * Rate limit tier override
   */
  rateLimitTier?: string;
}

// Default key extractor - checks header, then query param
function defaultExtractKey(req: Request): string | undefined {
  // Check Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader) {
    // Bearer token format
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    if (bearerMatch) {
      return bearerMatch[1];
    }
    
    // Direct API key format (for backward compatibility)
    if (authHeader.startsWith('kor_')) {
      return authHeader;
    }
  }
  
  // Check query parameter
  const apiKey = req.query.api_key;
  if (typeof apiKey === 'string') {
    return apiKey;
  }
  
  // Check custom header
  const customHeader = req.headers['x-api-key'];
  if (typeof customHeader === 'string') {
    return customHeader;
  }
  
  return undefined;
}

/**
 * Create API key authentication middleware
 */
export function apiKeyAuth(options: ApiKeyMiddlewareOptions = {}) {
  const apiKeyService = createApiKeyService();
  const extractKey = options.extractKey || defaultExtractKey;
  
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const key = extractKey(req);
      
      if (!key) {
        if (options.optional) {
          return next();
        }
        
        res.status(401).json({
          error: 'Authentication required',
          message: 'API key missing. Provide via Authorization: Bearer <key> or X-API-Key header',
        });
        return;
      }
      
      // Validate the key
      const result = await apiKeyService.validate(key);
      
      if (!result.valid) {
        res.status(401).json({
          error: 'Authentication failed',
          message: result.error || 'Invalid API key',
        });
        return;
      }
      
      const apiKey = result.key!;
      
      // Check required scopes
      if (options.requiredScopes && options.requiredScopes.length > 0) {
        const hasScope = options.requiredScopes.every(scope => 
          apiKeyService.hasScope(apiKey, scope)
        );
        
        if (!hasScope) {
          res.status(403).json({
            error: 'Forbidden',
            message: `Insufficient permissions. Required: ${options.requiredScopes.join(', ')}`,
          });
          return;
        }
      }
      
      // Attach to request
      req.apiKey = apiKey;
      req.authenticatedUser = {
        id: apiKey.userId,
        type: 'api_key',
        scopes: apiKey.scopes,
        rateLimitTier: options.rateLimitTier || apiKey.rateLimitTier,
      };
      
      next();
    } catch (error) {
      serverLog.error({ error }, 'API key authentication error');
      res.status(500).json({
        error: 'Internal server error',
        message: 'Authentication check failed',
      });
    }
  };
}

/**
 * Require specific scopes
 */
export function requireScopes(...scopes: ApiKeyScope[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.authenticatedUser) {
      res.status(401).json({
        error: 'Authentication required',
        message: 'Must authenticate before checking permissions',
      });
      return;
    }
    
    const apiKeyService = createApiKeyService();
    
    // If authenticated via API key
    if (req.apiKey) {
      const hasAllScopes = scopes.every(scope => 
        apiKeyService.hasScope(req.apiKey!, scope)
      );
      
      if (!hasAllScopes) {
        res.status(403).json({
          error: 'Forbidden',
          message: `Insufficient permissions. Required: ${scopes.join(', ')}`,
        });
        return;
      }
    }
    
    // If authenticated via JWT, check would be done elsewhere
    next();
  };
}

/**
 * Combined JWT + API key authentication
 * Tries JWT first, falls back to API key
 */
export function flexibleAuth(options: ApiKeyMiddlewareOptions = {}) {
  const apiKeyMiddleware = apiKeyAuth({ ...options, optional: true });
  
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Try API key first
    await apiKeyMiddleware(req, res, (err?: any) => {
      if (err) return next(err);
      
      // If API key authenticated, continue
      if (req.authenticatedUser) {
        return next();
      }
      
      // Try JWT if enabled
      if (options.allowJwtFallback !== false) {
        // JWT middleware would be applied separately
        // This just passes through to let JWT middleware handle it
        return next();
      }
      
      // No authentication and not optional
      if (!options.optional) {
        return res.status(401).json({
          error: 'Authentication required',
          message: 'Valid API key or JWT token required',
        });
      }
      
      next();
    });
  };
}

/**
 * Get rate limit key for authenticated request
 * Returns user ID if authenticated, IP otherwise
 */
export function getRateLimitKey(req: Request): { 
  key: string; 
  tier: string;
  isAuthenticated: boolean;
} {
  if (req.authenticatedUser) {
    return {
      key: req.authenticatedUser.id,
      tier: req.authenticatedUser.rateLimitTier,
      isAuthenticated: true,
    };
  }
  
  // Fall back to IP address
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  return {
    key: ip,
    tier: 'anonymous',
    isAuthenticated: false,
  };
}
