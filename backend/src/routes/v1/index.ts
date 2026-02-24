/**
 * API v1 Routes - Production Ready
 * 
 * Unified route handlers with:
 * - Rate limiting
 * - Input validation (Zod)
 * - Metrics collection
 * - Comprehensive audit logging
 * - Request ID propagation
 * - Security headers
 */

import { createApiKeyService } from "../../apikeys/service";
import { createUserCredentialsService } from "../../services/user-credentials";
import { createAuditLogService } from "../../services/audit";
import { getOrCreateLocalUser, getOrCreateGuestUser } from "../../auth/auth";
import { serverLog } from "../../logger";
import { initializeRedis, getRedisClient } from "../../redis/client";
import { SlidingWindowRateLimiter, TokenBucketRateLimiter } from "../../ratelimit";
import { getTierConfig } from "../../ratelimit/tiers";
import {
  validateBody,
  validateQuery,
  CreateCredentialSchema,
  UpdateCredentialSchema,
  DeleteCredentialSchema,
  RotateCredentialSchema,
  CreateApiKeySchema,
  UpdateApiKeySchema,
  QueryAuditSchema,
  SuspiciousActivitySchema,
} from "../../validation/schemas";
import {
  getMetricsRegistry,
  recordRateLimitHit,
  recordRateLimitAllowed,
  recordCredentialOperation,
  recordAuditEvent,
  httpMetricsMiddleware,
} from "../../metrics";
import type { RateLimitResult } from "../../ratelimit/types";
import { getReconciliation } from "../../credit-accountant";

// Services initialized lazily (after DB is ready in server main())
let _apiKeyService: ReturnType<typeof createApiKeyService> | null = null;
let _credentialsService: ReturnType<typeof createUserCredentialsService> | null = null;
let _auditService: ReturnType<typeof createAuditLogService> | null = null;
function getApiKeyService() {
  if (!_apiKeyService) _apiKeyService = createApiKeyService();
  return _apiKeyService;
}
function getCredentialsService() {
  if (!_credentialsService) _credentialsService = createUserCredentialsService();
  return _credentialsService;
}
function getAuditService() {
  if (!_auditService) _auditService = createAuditLogService();
  return _auditService;
}
const metrics = getMetricsRegistry();

// Rate limiters (initialized lazily)
let slidingLimiter: SlidingWindowRateLimiter | null = null;
let bucketLimiter: TokenBucketRateLimiter | null = null;
let rateLimitersInitialized = false;

async function initRateLimiters(): Promise<void> {
  if (rateLimitersInitialized) return;
  
  try {
    await initializeRedis({ fallbackToMemory: true });
    const redis = getRedisClient();
    
    slidingLimiter = new SlidingWindowRateLimiter(redis, {
      windowSeconds: 60,
      maxRequests: 100,
      algorithm: "sliding-window",
    });
    
    bucketLimiter = new TokenBucketRateLimiter(redis, {
      windowSeconds: 60,
      maxRequests: 100,
      algorithm: "token-bucket",
      burstSize: 20,
    });
    
    await slidingLimiter.initialize();
    await bucketLimiter.initialize();
    
    rateLimitersInitialized = true;
    serverLog.info("Rate limiters initialized");
  } catch (error) {
    serverLog.error({ error }, "Failed to initialize rate limiters, using memory fallback");
    rateLimitersInitialized = true; // Mark as initialized to prevent retries
  }
}

// Response helpers with security headers
function json(data: any, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "X-XSS-Protection": "1; mode=block",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
      ...headers,
    },
  });
}

// Generate request ID
function generateRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

// Authentication helper — no login required, always resolves to the local system user
async function authenticate(_req: Request): Promise<{
  success: boolean;
  userId?: string;
  scopes?: string[];
  rateLimitTier?: string;
  error?: Response;
  method?: 'local';
}> {
  try {
    const user = await getOrCreateLocalUser();
    return {
      success: true,
      userId: user.id,
      scopes: ["read", "write", "admin"],
      rateLimitTier: "local",
      method: "local",
    };
  } catch (err) {
    return {
      success: false,
      error: json({ error: "Service unavailable", message: "Local user initialization failed" }, 503),
    };
  }
}

// Check if user has required scope
function hasScope(scopes: string[], required: string): boolean {
  if (scopes.includes("admin")) return true;
  if (scopes.includes(required)) return true;
  if (required === "read" && scopes.includes("write")) return true;
  return false;
}

// Rate limiting helper
async function checkRateLimit(
  key: string,
  tier: string,
  algorithm: 'sliding-window' | 'token-bucket' = 'sliding-window'
): Promise<RateLimitResult & { headers: Record<string, string> }> {
  await initRateLimiters();
  
  const tierConfig = getTierConfig(tier);
  const limit = tierConfig.limits.user?.maxRequests || 60;
  
  let result: RateLimitResult;
  
  if (algorithm === 'token-bucket' && bucketLimiter) {
    result = await bucketLimiter.consume(`ratelimit:${key}`);
  } else if (slidingLimiter) {
    result = await slidingLimiter.check(`ratelimit:${key}`);
  } else {
    // Fallback: allow request
    result = { allowed: true, remaining: limit, resetTime: Date.now() + 60000, limit };
  }
  
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(Math.max(0, result.remaining)),
    'X-RateLimit-Reset': String(result.resetTime),
  };
  
  if (!result.allowed) {
    headers['Retry-After'] = String(result.retryAfter || 60);
    recordRateLimitHit(tier, algorithm);
  } else {
    recordRateLimitAllowed(tier);
  }
  
  return { ...result, headers };
}

// ─── Credentials Routes ─────────────────────────────────────────────────────

export async function handleCredentials(
  req: Request,
  path: string,
  method: string,
  requestId: string
): Promise<Response | null> {
  const basePath = "/api/v1/credentials";
  if (!path.startsWith(basePath)) return null;

  // Authenticate
  const auth = await authenticate(req);
  if (!auth.success) return auth.error!;

  // Rate limiting
  const rateLimit = await checkRateLimit(auth.userId!, auth.rateLimitTier!, 'sliding-window');
  if (!rateLimit.allowed) {
    return json(
      { error: "Too Many Requests", retryAfter: rateLimit.retryAfter },
      429,
      rateLimit.headers
    );
  }

  const extraHeaders = { ...rateLimit.headers, 'X-Request-Id': requestId };

  // GET /api/v1/credentials - List credentials
  if (path === basePath && method === "GET") {
    const url = new URL(req.url);
    const provider = url.searchParams.get("provider") || undefined;
    const isActive = url.searchParams.get("isActive") !== "false";

    try {
      const credentials = await getCredentialsService().list(auth.userId!, {
        provider,
        isActive,
      });

      recordCredentialOperation('list', true);

      return json(
        {
          credentials: credentials.map((c) => ({
            id: c.id,
            provider: c.provider,
            type: c.type,
            isActive: c.isActive,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
            lastUsedAt: c.lastUsedAt,
            expiresAt: c.expiresAt,
          })),
        },
        200,
        extraHeaders
      );
    } catch (err: any) {
      serverLog.error({ err, requestId }, "Failed to list credentials");
      recordCredentialOperation('list', false);
      return json({ error: "Failed to list credentials" }, 500, extraHeaders);
    }
  }

  // POST /api/v1/credentials - Create credential
  if (path === basePath && method === "POST") {
    if (!hasScope(auth.scopes!, "write")) {
      return json({ error: "Forbidden", message: "write scope required" }, 403, extraHeaders);
    }

    // Check body size (max 10KB)
    const contentLength = parseInt(req.headers.get('content-length') || '0');
    if (contentLength > 10240) {
      return json({ error: "Request body too large (max 10KB)" }, 413, extraHeaders);
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400, extraHeaders);
    }

    const validation = validateBody(CreateCredentialSchema, body);
    if (!validation.success) {
      return json({ error: "Validation failed", details: validation.errors }, 400, extraHeaders);
    }

    try {
      const id = await getCredentialsService().create({
        userId: auth.userId!,
        provider: validation.data.provider,
        credential: validation.data.credential,
        metadata: validation.data.metadata,
      });

      recordCredentialOperation('create', true);
      await getAuditService().log({
        userId: auth.userId ?? null,
        action: 'credential_create',
        resourceType: 'credential',
        resourceId: id,
        success: true,
        metadata: { provider: validation.data.provider },
        timestamp: Date.now(),
      });

      return json({ id, message: "Credential stored securely" }, 201, extraHeaders);
    } catch (err: any) {
      serverLog.error({ err, requestId }, "Failed to create credential");
      recordCredentialOperation('create', false);
      return json({ error: "Failed to create credential" }, 500, extraHeaders);
    }
  }

  // Handle /api/v1/credentials/:id
  const idMatch = path.match(new RegExp(`^${basePath}/([^/]+)$`));
  if (idMatch) {
    const credentialId = idMatch[1];

    // GET /api/v1/credentials/:id - Get credential metadata
    if (method === "GET") {
      try {
        const credential = await getCredentialsService().getMetadata(auth.userId!, credentialId);
        if (!credential) {
          return json({ error: "Credential not found" }, 404, extraHeaders);
        }

        return json(
          {
            id: credential.id,
            provider: credential.provider,
            type: credential.type,
            isActive: credential.isActive,
            createdAt: credential.createdAt,
            updatedAt: credential.updatedAt,
            lastUsedAt: credential.lastUsedAt,
            expiresAt: credential.expiresAt,
          },
          200,
          extraHeaders
        );
      } catch (err: any) {
        serverLog.error({ err, requestId }, "Failed to get credential");
        return json({ error: "Failed to get credential" }, 500, extraHeaders);
      }
    }

    // PATCH /api/v1/credentials/:id - Update metadata
    if (method === "PATCH") {
      if (!hasScope(auth.scopes!, "write")) {
        return json({ error: "Forbidden", message: "write scope required" }, 403, extraHeaders);
      }

      let body;
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400, extraHeaders);
      }

      const validation = validateBody(UpdateCredentialSchema, body);
      if (!validation.success) {
        return json({ error: "Validation failed", details: validation.errors }, 400, extraHeaders);
      }

      try {
        const success = await getCredentialsService().updateMetadata(
          auth.userId!,
          credentialId,
          validation.data.metadata
        );

        if (!success) {
          return json({ error: "Credential not found" }, 404, extraHeaders);
        }

        recordCredentialOperation('update', true);
        return json({ message: "Credential updated" }, 200, extraHeaders);
      } catch (err: any) {
        serverLog.error({ err, requestId }, "Failed to update credential");
        recordCredentialOperation('update', false);
        return json({ error: "Failed to update credential" }, 500, extraHeaders);
      }
    }

    // DELETE /api/v1/credentials/:id - Delete credential
    if (method === "DELETE") {
      if (!hasScope(auth.scopes!, "write")) {
        return json({ error: "Forbidden", message: "write scope required" }, 403, extraHeaders);
      }

      let body = {};
      try {
        body = await req.json().catch(() => ({}));
      } catch {
        // Empty body is ok
      }

      const validation = validateBody(DeleteCredentialSchema, body);
      if (!validation.success) {
        return json({ error: "Validation failed", details: validation.errors }, 400, extraHeaders);
      }

      try {
        const success = await getCredentialsService().delete(
          auth.userId!,
          credentialId,
          validation.data?.reason
        );

        if (!success) {
          return json({ error: "Credential not found" }, 404, extraHeaders);
        }

        recordCredentialOperation('delete', true);
        await getAuditService().log({
          userId: auth.userId ?? null,
          action: 'credential_delete',
          resourceType: 'credential',
          resourceId: credentialId,
          success: true,
          reason: validation.data?.reason,
          timestamp: Date.now(),
        });

        return json({ message: "Credential deleted" }, 200, extraHeaders);
      } catch (err: any) {
        serverLog.error({ err, requestId }, "Failed to delete credential");
        recordCredentialOperation('delete', false);
        return json({ error: "Failed to delete credential" }, 500, extraHeaders);
      }
    }
  }

  // POST /api/v1/credentials/:id/rotate - Rotate credential
  const rotateMatch = path.match(new RegExp(`^${basePath}/([^/]+)/rotate$`));
  if (rotateMatch && method === "POST") {
    if (!hasScope(auth.scopes!, "write")) {
      return json({ error: "Forbidden", message: "write scope required" }, 403, extraHeaders);
    }

    const credentialId = rotateMatch[1];

    let body = {};
    try {
      body = await req.json().catch(() => ({}));
    } catch {
      // Empty body is ok
    }

    const validation = validateBody(RotateCredentialSchema, body);
    if (!validation.success) {
      return json({ error: "Validation failed", details: validation.errors }, 400, extraHeaders);
    }

    try {
      const newId = await getCredentialsService().rotate(
        auth.userId!,
        credentialId,
        validation.data?.reason
      );

      if (!newId) {
        return json({ error: "Credential not found" }, 404, extraHeaders);
      }

      recordCredentialOperation('rotate', true);
      await getAuditService().log({
        userId: auth.userId ?? null,
        action: 'credential_rotate',
        resourceType: 'credential',
        resourceId: credentialId,
        success: true,
        metadata: { newId },
        timestamp: Date.now(),
      });

      return json(
        {
          message: "Credential rotated successfully",
          oldId: credentialId,
          newId,
        },
        200,
        extraHeaders
      );
    } catch (err: any) {
      serverLog.error({ err, requestId }, "Failed to rotate credential");
      recordCredentialOperation('rotate', false);
      return json({ error: "Failed to rotate credential" }, 500, extraHeaders);
    }
  }

  // GET /api/v1/credentials/:id/audit - Get audit trail
  const auditMatch = path.match(new RegExp(`^${basePath}/([^/]+)/audit$`));
  if (auditMatch && method === "GET") {
    const credentialId = auditMatch[1];

    try {
      // Verify ownership
      const credential = await getCredentialsService().getMetadata(auth.userId!, credentialId);
      if (!credential) {
        return json({ error: "Credential not found" }, 404, extraHeaders);
      }

      const auditTrail = await getAuditService().getCredentialAccessHistory(credentialId);

      return json(
        {
          credentialId,
          accessCount: auditTrail.length,
          trail: auditTrail.map((entry) => ({
            action: entry.action,
            timestamp: entry.timestamp,
            ipAddress: entry.ipAddress,
            userAgent: entry.userAgent,
            success: entry.success,
            reason: entry.reason,
          })),
        },
        200,
        extraHeaders
      );
    } catch (err: any) {
      serverLog.error({ err, requestId }, "Failed to get audit trail");
      return json({ error: "Failed to get audit trail" }, 500, extraHeaders);
    }
  }

  return null;
}

// ─── API Keys Routes ────────────────────────────────────────────────────────

export async function handleApiKeys(
  req: Request,
  path: string,
  method: string,
  requestId: string
): Promise<Response | null> {
  const basePath = "/api/v1/keys";
  if (!path.startsWith(basePath)) return null;

  const extraHeadersBase: Record<string, string> = { 'X-Request-Id': requestId };

  // Resolve auth: guest when no Bearer token (no account required), otherwise JWT/API key
  const authHeader = req.headers.get("authorization");
  let auth: Awaited<ReturnType<typeof authenticate>>;
  if (!authHeader?.startsWith("Bearer ")) {
    try {
      const guest = await getOrCreateGuestUser();
      auth = {
        success: true,
        userId: guest.id,
        scopes: ['read', 'write'],
        rateLimitTier: 'free',
      };
    } catch (err: any) {
      serverLog.error({ err, requestId }, "Guest user unavailable for API keys");
      return json({ error: "Service unavailable" }, 503, extraHeadersBase);
    }
  } else {
    auth = await authenticate(req);
  }
  if (!auth.success) return auth.error!;

  // Rate limiting (stricter for key operations)
  const rateLimit = await checkRateLimit(auth.userId!, auth.rateLimitTier!, 'token-bucket');
  if (!rateLimit.allowed) {
    return json(
      { error: "Too Many Requests", retryAfter: rateLimit.retryAfter },
      429,
      rateLimit.headers
    );
  }

  const extraHeaders = { ...rateLimit.headers, ...extraHeadersBase };

  // GET /api/v1/keys - List API keys
  if (path === basePath && method === "GET") {
    try {
      const keys = await getApiKeyService().listForUser(auth.userId!);

      return json(
        {
          keys: keys.map((k) => ({
            id: k.id,
            name: k.name,
            prefix: k.prefix,
            scopes: k.scopes,
            rateLimitTier: k.rateLimitTier,
            expiresAt: k.expiresAt,
            lastUsedAt: k.lastUsedAt,
            usageCount: k.usageCount,
            isActive: k.isActive,
            createdAt: k.createdAt,
          })),
        },
        200,
        extraHeaders
      );
    } catch (err: any) {
      serverLog.error({ err, requestId }, "Failed to list API keys");
      return json({ error: "Failed to list API keys" }, 500, extraHeaders);
    }
  }

  // POST /api/v1/keys - Create API key
  if (path === basePath && method === "POST") {
    if (!hasScope(auth.scopes!, "write")) {
      return json({ error: "Forbidden", message: "write scope required" }, 403, extraHeaders);
    }

    // Check body size
    const contentLength = parseInt(req.headers.get('content-length') || '0');
    if (contentLength > 10240) {
      return json({ error: "Request body too large (max 10KB)" }, 413, extraHeaders);
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400, extraHeaders);
    }

    const validation = validateBody(CreateApiKeySchema, body);
    if (!validation.success) {
      return json({ error: "Validation failed", details: validation.errors }, 400, extraHeaders);
    }

    try {
      const apiKey = await getApiKeyService().create({
        userId: auth.userId!,
        name: validation.data.name,
        scopes: validation.data.scopes,
        rateLimitTier: validation.data.rateLimitTier,
        expiresInDays: validation.data.expiresInDays,
        metadata: validation.data.metadata,
      });

      await getAuditService().log({
        userId: auth.userId ?? null,
        action: 'api_key_create',
        resourceType: 'api_key',
        resourceId: apiKey.id,
        success: true,
        metadata: { scopes: apiKey.scopes, rateLimitTier: apiKey.rateLimitTier },
        timestamp: Date.now(),
      });

      return json(
        {
          id: apiKey.id,
          name: apiKey.name,
          key: apiKey.plaintextKey,
          prefix: apiKey.prefix,
          scopes: apiKey.scopes,
          rateLimitTier: apiKey.rateLimitTier,
          expiresAt: apiKey.expiresAt,
          createdAt: apiKey.createdAt,
          warning: "This key will only be shown once. Store it securely.",
        },
        201,
        extraHeaders
      );
    } catch (err: any) {
      serverLog.error({ err, requestId }, "Failed to create API key");
      return json({ error: "Failed to create API key" }, 500, extraHeaders);
    }
  }

  // Handle /api/v1/keys/:id
  const idMatch = path.match(new RegExp(`^${basePath}/([^/]+)$`));
  if (idMatch) {
    const keyId = idMatch[1];

    // GET /api/v1/keys/:id - Get API key details
    if (method === "GET") {
      try {
        const key = await getApiKeyService().get(auth.userId!, keyId);
        if (!key) {
          return json({ error: "API key not found" }, 404, extraHeaders);
        }

        return json(
          {
            id: key.id,
            name: key.name,
            prefix: key.prefix,
            scopes: key.scopes,
            rateLimitTier: key.rateLimitTier,
            expiresAt: key.expiresAt,
            lastUsedAt: key.lastUsedAt,
            usageCount: key.usageCount,
            isActive: key.isActive,
            createdAt: key.createdAt,
          },
          200,
          extraHeaders
        );
      } catch (err: any) {
        serverLog.error({ err, requestId }, "Failed to get API key");
        return json({ error: "Failed to get API key" }, 500, extraHeaders);
      }
    }

    // PATCH /api/v1/keys/:id - Update API key
    if (method === "PATCH") {
      if (!hasScope(auth.scopes!, "write")) {
        return json({ error: "Forbidden", message: "write scope required" }, 403, extraHeaders);
      }

      let body;
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400, extraHeaders);
      }

      const validation = validateBody(UpdateApiKeySchema, body);
      if (!validation.success) {
        return json({ error: "Validation failed", details: validation.errors }, 400, extraHeaders);
      }

      try {
        const success = await getApiKeyService().update(auth.userId!, keyId, {
          name: validation.data.name,
          scopes: validation.data.scopes,
          rateLimitTier: validation.data.rateLimitTier,
        });

        if (!success) {
          return json({ error: "API key not found" }, 404, extraHeaders);
        }

        await getAuditService().log({
          userId: auth.userId ?? null,
          action: 'api_key_update',
          resourceType: 'api_key',
          resourceId: keyId,
          success: true,
          timestamp: Date.now(),
        });

        return json({ message: "API key updated" }, 200, extraHeaders);
      } catch (err: any) {
        serverLog.error({ err, requestId }, "Failed to update API key");
        return json({ error: "Failed to update API key" }, 500, extraHeaders);
      }
    }

    // DELETE /api/v1/keys/:id - Revoke API key
    if (method === "DELETE") {
      if (!hasScope(auth.scopes!, "write")) {
        return json({ error: "Forbidden", message: "write scope required" }, 403, extraHeaders);
      }

      try {
        const success = await getApiKeyService().revoke(auth.userId!, keyId);

        if (!success) {
          return json({ error: "API key not found" }, 404, extraHeaders);
        }

        await getAuditService().log({
          userId: auth.userId ?? null,
          action: 'api_key_revoke',
          resourceType: 'api_key',
          resourceId: keyId,
          success: true,
          timestamp: Date.now(),
        });

        return json({ message: "API key revoked" }, 200, extraHeaders);
      } catch (err: any) {
        serverLog.error({ err, requestId }, "Failed to revoke API key");
        return json({ error: "Failed to revoke API key" }, 500, extraHeaders);
      }
    }
  }

  return null;
}

// ─── Audit Routes ───────────────────────────────────────────────────────────

export async function handleAudit(
  req: Request,
  path: string,
  method: string,
  requestId: string
): Promise<Response | null> {
  const basePath = "/api/v1/audit";
  if (!path.startsWith(basePath)) return null;

  // Authenticate
  const auth = await authenticate(req);
  if (!auth.success) return auth.error!;

  const extraHeaders = { 'X-Request-Id': requestId };

  // GET /api/v1/audit/me - Get current user's activity
  if (path === `${basePath}/me` && method === "GET") {
    try {
      const url = new URL(req.url);
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 100);

      const activity = await getAuditService().getUserActivity(auth.userId!, limit);

      return json(
        {
          userId: auth.userId,
          entries: activity.map((entry) => ({
            action: entry.action,
            resourceType: entry.resourceType,
            resourceId: entry.resourceId,
            timestamp: entry.timestamp,
            success: entry.success,
            reason: entry.reason,
          })),
        },
        200,
        extraHeaders
      );
    } catch (err: any) {
      serverLog.error({ err, requestId }, "Failed to get user activity");
      return json({ error: "Failed to get user activity" }, 500, extraHeaders);
    }
  }

  // GET /api/v1/audit/suspicious - Check for suspicious activity (admin only)
  if (path === `${basePath}/suspicious` && method === "GET") {
    if (!hasScope(auth.scopes!, "admin")) {
      return json({ error: "Forbidden", message: "admin scope required" }, 403, extraHeaders);
    }

    const url = new URL(req.url);
    const queryValidation = validateQuery(
      SuspiciousActivitySchema,
      url.searchParams
    );

    if (!queryValidation.success) {
      return json(
        { error: "Validation failed", details: queryValidation.errors },
        400,
        extraHeaders
      );
    }

    try {
      const result = await getAuditService().detectSuspiciousActivity(
        queryValidation.data.userId
      );

      return json(
        {
          userId: queryValidation.data.userId,
          suspicious: result.suspicious,
          reasons: result.reasons,
        },
        200,
        extraHeaders
      );
    } catch (err: any) {
      serverLog.error({ err, requestId }, "Failed to detect suspicious activity");
      return json({ error: "Failed to detect suspicious activity" }, 500, extraHeaders);
    }
  }

  // GET /api/v1/audit - Query audit logs
  if (path === basePath && method === "GET") {
    const url = new URL(req.url);
    const isAdmin = hasScope(auth.scopes!, "admin");

    // Validate query parameters
    const queryValidation = validateQuery(QueryAuditSchema, url.searchParams);
    if (!queryValidation.success) {
      return json(
        { error: "Validation failed", details: queryValidation.errors },
        400,
        extraHeaders
      );
    }

    // Build query
    const query: any = {};

    // Non-admins can only see their own logs
    if (!isAdmin) {
      query.userId = auth.userId;
    } else if (queryValidation.data.userId) {
      query.userId = queryValidation.data.userId;
    }

    if (queryValidation.data.action) query.action = queryValidation.data.action;
    if (queryValidation.data.resourceType) query.resourceType = queryValidation.data.resourceType;
    if (queryValidation.data.resourceId) query.resourceId = queryValidation.data.resourceId;
    if (queryValidation.data.startTime) query.startTime = queryValidation.data.startTime;
    if (queryValidation.data.endTime) query.endTime = queryValidation.data.endTime;
    if (queryValidation.data.success !== undefined) query.success = queryValidation.data.success === 'true';

    query.limit = queryValidation.data.limit;
    query.offset = queryValidation.data.offset;

    try {
      const result = await getAuditService().query(query);

      return json(
        {
          entries: result.entries,
          total: result.total,
          hasMore: result.hasMore,
          limit: query.limit,
          offset: query.offset,
        },
        200,
        extraHeaders
      );
    } catch (err: any) {
      serverLog.error({ err, requestId }, "Failed to query audit logs");
      return json({ error: "Failed to query audit logs" }, 500, extraHeaders);
    }
  }

  return null;
}

// ─── Billing / Credits Routes ───────────────────────────────────────────────

export async function handleBilling(
  req: Request,
  path: string,
  method: string,
  requestId: string
): Promise<Response | null> {
  const basePath = "/api/v1/billing";
  if (!path.startsWith(basePath)) return null;

  const auth = await authenticate(req);
  if (!auth.success) return auth.error!;

  const extraHeaders = { "X-Request-Id": requestId };

  // GET /api/v1/billing/credits — Local estimate vs cloud reality, drift
  const pathNorm = path.replace(/\/+$/, '') || '/';
  if (pathNorm === `${basePath}/credits` && method === "GET") {
    try {
      const data = getReconciliation();
      return json(
        {
          localEstimate: data.localEstimate,
          cloudReality: data.cloudReality,
          driftPercent: data.driftPercent,
          highlightDrift: data.highlightDrift,
        },
        200,
        extraHeaders
      );
    } catch (err: any) {
      serverLog.error({ err, requestId }, "Failed to get billing credits");
      return json({ error: "Failed to get billing credits" }, 500, extraHeaders);
    }
  }

  return null;
}

// ─── Main Router ────────────────────────────────────────────────────────────

export async function handleV1Routes(
  req: Request,
  path: string,
  method: string
): Promise<Response | null> {
  const requestId = generateRequestId();
  
  // Add request ID to log context
  serverLog.debug({ requestId, path, method }, "V1 route handling");

  // Wrap with metrics middleware
  const startTime = Date.now();
  
  try {
    // Try each handler in order
    const handlers = [
      handleCredentials,
      handleApiKeys,
      handleAudit,
      handleBilling,
    ];

    for (const handler of handlers) {
      const result = await handler(req, path, method, requestId);
      if (result !== null) {
        // Record metrics
        const duration = (Date.now() - startTime) / 1000;
        metrics.observeHistogram('http_request_duration_seconds', { method, route: path }, duration);
        metrics.incCounter('http_requests_total', { method, route: path, status: String(result.status) });
        
        // Add request ID to response headers
        const headers = new Headers(result.headers);
        headers.set('X-Request-Id', requestId);
        
        return new Response(result.body, {
          status: result.status,
          headers,
        });
      }
    }

    return null;
  } catch (error: any) {
    serverLog.error({ error, requestId, path, method }, "Unhandled error in v1 routes");
    
    // Record error metrics
    const duration = (Date.now() - startTime) / 1000;
    metrics.observeHistogram('http_request_duration_seconds', { method, route: path }, duration);
    metrics.incCounter('http_requests_total', { method, route: path, status: '500' });
    
    return json(
      { error: "Internal server error", requestId },
      500,
      { 'X-Request-Id': requestId }
    );
  }
}
