/**
 * Express Type Stubs
 * 
 * Minimal type definitions for Express compatibility.
 * The project uses Bun.serve() but some modules may reference Express types.
 */

declare module 'express' {
  import type { IncomingMessage, ServerResponse } from 'http';
  
  export interface Request extends IncomingMessage {
    params: Record<string, string>;
    query: Record<string, string | string[]>;
    body: any;
    headers: IncomingMessage['headers'];
    ip?: string;
    connection: IncomingMessage['connection'] & { remoteAddress?: string };
    authenticatedUser?: {
      id: string;
      type: 'api_key' | 'jwt';
      scopes: string[];
      rateLimitTier: string;
    };
    apiKey?: any;
    path?: string;
  }
  
  export interface Response extends ServerResponse {
    status(code: number): Response;
    json(body: any): Response;
    setHeader(name: string, value: string | number): Response;
  }
  
  export interface NextFunction {
    (err?: any): void;
  }
  
  export interface Router {
    use(...handlers: any[]): Router;
    get(path: string, ...handlers: any[]): Router;
    post(path: string, ...handlers: any[]): Router;
    patch(path: string, ...handlers: any[]): Router;
    delete(path: string, ...handlers: any[]): Router;
  }
  
  export function Router(): Router;
  export default function express(): any;
}
