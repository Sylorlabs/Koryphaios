// Router — combines all route modules and handles request routing

import type { RouteHandler, RouteDependencies, Middleware, MiddlewareContext } from "./types";
import { json, extractParams } from "./types";
import { createSessionRoutes } from "./sessions";
import { createProviderRoutes } from "./providers";
import { createMessageRoutes } from "./messages";
import { createGitRoutes } from "./git";
import { getCorsHeaders, RateLimiter, validateSessionId } from "../security";
import { RATE_LIMIT } from "../constants";
import { requireSessionAuth } from "../auth";
import { handleError, generateCorrelationId } from "../errors";
import type { WSMessage, APIResponse } from "@koryphaios/shared";

export interface RouterConfig {
    rateLimiter: RateLimiter;
}

export class Router {
    private routes: RouteHandler[] = [];
    private middlewares: Middleware[] = [];
    private rateLimiter: RateLimiter;

    constructor(deps: RouteDependencies, config: RouterConfig) {
        this.rateLimiter = config.rateLimiter;
        this.registerRoutes(deps);
    }

    private registerRoutes(deps: RouteDependencies) {
        this.routes = [
            ...createSessionRoutes(deps),
            ...createProviderRoutes(deps),
            ...createMessageRoutes(deps),
            ...createGitRoutes(deps),
        ];
    }

    /**
     * Add middleware that runs before route handlers
     */
    use(middleware: Middleware) {
        this.middlewares.push(middleware);
    }

    /**
     * Match a request to a route handler
     */
    private matchRoute(method: string, pathname: string): { handler: RouteHandler; params: Map<string, string> } | null {
        for (const route of this.routes) {
            const methods = Array.isArray(route.method) ? route.method : [route.method];
            if (!methods.includes(method)) continue;

            if (typeof route.path === "string") {
                if (route.path === pathname) {
                    return { handler: route, params: new Map() };
                }
            } else {
                const match = route.path.exec(pathname);
                if (match) {
                    return { handler: route, params: extractParams(route.path, pathname) };
                }
            }
        }
        return null;
    }

    /**
     * Handle an incoming HTTP request
     */
    async handle(req: Request): Promise<Response> {
        const url = new URL(req.url);
        const method = req.method;
        const origin = req.headers.get("origin");
        const requestId = generateCorrelationId();
        const corsHeaders = getCorsHeaders(origin);

        // Handle CORS preflight
        if (method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders });
        }

        // Rate limiting
        const clientIp = req.headers.get("x-forwarded-for") ?? "local";
        const rateCheck = this.rateLimiter.check(clientIp);
        if (!rateCheck.allowed) {
            return json({ ok: false, error: "Rate limit exceeded" }, 429, corsHeaders);
        }

        const ctx: MiddlewareContext = {
            req,
            url,
            method,
            origin,
            clientIp,
            requestId,
        };

        try {
            // Run middlewares then route handler
            return await this.runMiddlewares(ctx, async () => {
                const match = this.matchRoute(method, url.pathname);

                if (!match) {
                    return json({ ok: false, error: "Not found" }, 404, corsHeaders);
                }

                const routeCtx = {
                    requestId,
                    sessionId: "", // Will be set by auth middleware
                    origin,
                    clientIp,
                };

                return match.handler.handler(req, match.params, routeCtx);
            });
        } catch (err) {
            const handled = handleError(err, { requestId, method, path: url.pathname, query: url.search });
            return json({ ok: false, error: `${handled.message} (requestId=${requestId})` }, handled.statusCode, corsHeaders);
        }
    }

    /**
     * Run middleware chain
     */
    private async runMiddlewares(ctx: MiddlewareContext, final: () => Promise<Response>): Promise<Response> {
        let index = 0;

        const next = async (): Promise<Response> => {
            if (index < this.middlewares.length) {
                const middleware = this.middlewares[index++];
                return middleware(ctx, next);
            }
            return final();
        };

        return next();
    }
}

/**
 * Create auth middleware
 */
export function authMiddleware(): Middleware {
    return async (ctx: MiddlewareContext, next: () => Promise<Response>) => {
        // Skip auth for public routes
        const publicPaths = ["/api/health", "/health/live", "/health/ready", "/api/auth/session"];

        if (publicPaths.some((p) => ctx.url.pathname === p || ctx.url.pathname.startsWith(p))) {
            return next();
        }

        try {
            const sessionId = requireSessionAuth(ctx.req);
            ctx.requestId = sessionId; // Store for context
            return next();
        } catch (err: any) {
            const corsHeaders = getCorsHeaders(ctx.origin);
            return json({ ok: false, error: "Unauthorized: Invalid or missing session token" }, 401, corsHeaders);
        }
    };
}