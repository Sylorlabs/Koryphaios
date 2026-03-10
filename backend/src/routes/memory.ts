/**
 * Memory API Routes
 * 
 * Provides endpoints for managing:
 * - Universal (global) memory
 * - Project memory
 * - Session memory
 * - Rules (.cursorrules)
 * - Memory settings
 */

import type { RouteHandler } from "./types";
import { json } from "./types";
import { validateSessionId } from "../security";
import {
  readUniversalMemory,
  writeUniversalMemory,
  readProjectMemory,
  writeProjectMemory,
  readSessionMemory,
  writeSessionMemory,
  deleteSessionMemory,
  readRules,
  writeRules,
  loadMemorySettings,
  saveMemorySettings,
  assembleMemoryContext,
  formatMemoryForContext,
  getMemoryStats,
  initializeUniversalMemory,
  initializeProjectMemory,
  initializeSessionMemory,
  initializeRules,
  DEFAULT_MEMORY_SETTINGS,
  type MemorySettings,
} from "../memory/unified-memory";
import { PROJECT_ROOT } from "../runtime/paths";

export function createMemoryRoutes(): RouteHandler[] {
  return [
    // =========================================================================
    // Universal Memory
    // =========================================================================
    
    // GET /api/memory/universal — Get universal memory
    {
      path: "/api/memory/universal",
      method: "GET",
      handler: async (req, params, ctx) => {
        const memory = readUniversalMemory();
        return json({ 
          ok: true, 
          data: {
            exists: memory.exists,
            content: memory.content,
            path: memory.path,
            lastModified: memory.lastModified,
            size: memory.size,
          }
        }, 200);
      },
    },
    
    // PUT /api/memory/universal — Update universal memory
    {
      path: "/api/memory/universal",
      method: "PUT",
      handler: async (req, params, ctx) => {
        try {
          const body = await req.json() as { content: string };
          
          if (typeof body.content !== "string") {
            return json({ ok: false, error: "content must be a string" }, 400);
          }
          
          const memory = writeUniversalMemory(body.content);
          return json({ 
            ok: true, 
            data: {
              path: memory.path,
              lastModified: memory.lastModified,
              size: memory.size,
            }
          }, 200);
        } catch (err: any) {
          return json({ ok: false, error: err.message ?? "Failed to write universal memory" }, 500);
        }
      },
    },
    
    // POST /api/memory/universal/init — Initialize universal memory with template
    {
      path: "/api/memory/universal/init",
      method: "POST",
      handler: async (req, params, ctx) => {
        const memory = initializeUniversalMemory();
        return json({ 
          ok: true, 
          data: {
            exists: memory.exists,
            content: memory.content,
            path: memory.path,
            lastModified: memory.lastModified,
            size: memory.size,
          }
        }, 200);
      },
    },
    
    // =========================================================================
    // Project Memory
    // =========================================================================
    
    // GET /api/memory/project — Get project memory
    {
      path: "/api/memory/project",
      method: "GET",
      handler: async (req, params, ctx) => {
        const memory = readProjectMemory(PROJECT_ROOT);
        return json({ 
          ok: true, 
          data: {
            exists: memory.exists,
            content: memory.content,
            path: memory.path,
            lastModified: memory.lastModified,
            size: memory.size,
          }
        }, 200);
      },
    },
    
    // PUT /api/memory/project — Update project memory
    {
      path: "/api/memory/project",
      method: "PUT",
      handler: async (req, params, ctx) => {
        try {
          const body = await req.json() as { content: string };
          
          if (typeof body.content !== "string") {
            return json({ ok: false, error: "content must be a string" }, 400);
          }
          
          const memory = writeProjectMemory(PROJECT_ROOT, body.content);
          return json({ 
            ok: true, 
            data: {
              path: memory.path,
              lastModified: memory.lastModified,
              size: memory.size,
            }
          }, 200);
        } catch (err: any) {
          return json({ ok: false, error: err.message ?? "Failed to write project memory" }, 500);
        }
      },
    },
    
    // POST /api/memory/project/init — Initialize project memory with template
    {
      path: "/api/memory/project/init",
      method: "POST",
      handler: async (req, params, ctx) => {
        const memory = initializeProjectMemory(PROJECT_ROOT);
        return json({ 
          ok: true, 
          data: {
            exists: memory.exists,
            content: memory.content,
            path: memory.path,
            lastModified: memory.lastModified,
            size: memory.size,
          }
        }, 200);
      },
    },
    
    // =========================================================================
    // Session Memory
    // =========================================================================
    
    // GET /api/sessions/:id/memory — Get session memory
    {
      path: /^\/api\/sessions\/(?<id>[^/]+)\/memory$/,
      method: "GET",
      handler: async (req, params, ctx) => {
        const id = params.get("id");
        if (!id) return json({ ok: false, error: "Session ID required" }, 400);
        
        const validatedId = validateSessionId(id);
        if (!validatedId) return json({ ok: false, error: "Invalid session ID" }, 400);
        
        const memory = readSessionMemory(PROJECT_ROOT, validatedId);
        return json({ 
          ok: true, 
          data: {
            exists: memory.exists,
            content: memory.content,
            path: memory.path,
            lastModified: memory.lastModified,
            size: memory.size,
          }
        }, 200);
      },
    },
    
    // PUT /api/sessions/:id/memory — Update session memory
    {
      path: /^\/api\/sessions\/(?<id>[^/]+)\/memory$/,
      method: "PUT",
      handler: async (req, params, ctx) => {
        const id = params.get("id");
        if (!id) return json({ ok: false, error: "Session ID required" }, 400);
        
        const validatedId = validateSessionId(id);
        if (!validatedId) return json({ ok: false, error: "Invalid session ID" }, 400);
        
        try {
          const body = await req.json() as { content: string };
          
          if (typeof body.content !== "string") {
            return json({ ok: false, error: "content must be a string" }, 400);
          }
          
          const memory = writeSessionMemory(PROJECT_ROOT, validatedId, body.content);
          return json({ 
            ok: true, 
            data: {
              path: memory.path,
              lastModified: memory.lastModified,
              size: memory.size,
            }
          }, 200);
        } catch (err: any) {
          return json({ ok: false, error: err.message ?? "Failed to write session memory" }, 500);
        }
      },
    },
    
    // POST /api/sessions/:id/memory/init — Initialize session memory with template
    {
      path: /^\/api\/sessions\/(?<id>[^/]+)\/memory\/init$/,
      method: "POST",
      handler: async (req, params, ctx) => {
        const id = params.get("id");
        if (!id) return json({ ok: false, error: "Session ID required" }, 400);
        
        const validatedId = validateSessionId(id);
        if (!validatedId) return json({ ok: false, error: "Invalid session ID" }, 400);
        
        const memory = initializeSessionMemory(PROJECT_ROOT, validatedId);
        return json({ 
          ok: true, 
          data: {
            exists: memory.exists,
            content: memory.content,
            path: memory.path,
            lastModified: memory.lastModified,
            size: memory.size,
          }
        }, 200);
      },
    },
    
    // DELETE /api/sessions/:id/memory — Delete session memory
    {
      path: /^\/api\/sessions\/(?<id>[^/]+)\/memory$/,
      method: "DELETE",
      handler: async (req, params, ctx) => {
        const id = params.get("id");
        if (!id) return json({ ok: false, error: "Session ID required" }, 400);
        
        const validatedId = validateSessionId(id);
        if (!validatedId) return json({ ok: false, error: "Invalid session ID" }, 400);
        
        const success = deleteSessionMemory(PROJECT_ROOT, validatedId);
        if (success) {
          return json({ ok: true }, 200);
        } else {
          return json({ ok: false, error: "Failed to delete session memory" }, 500);
        }
      },
    },
    
    // =========================================================================
    // Rules (.cursorrules)
    // =========================================================================
    
    // GET /api/memory/rules — Get rules
    {
      path: "/api/memory/rules",
      method: "GET",
      handler: async (req, params, ctx) => {
        const rules = readRules(PROJECT_ROOT);
        return json({ 
          ok: true, 
          data: {
            exists: rules.exists,
            content: rules.content,
            path: rules.path,
            lastModified: rules.lastModified,
            size: rules.size,
          }
        }, 200);
      },
    },
    
    // PUT /api/memory/rules — Update rules
    {
      path: "/api/memory/rules",
      method: "PUT",
      handler: async (req, params, ctx) => {
        try {
          const body = await req.json() as { content: string };
          
          if (typeof body.content !== "string") {
            return json({ ok: false, error: "content must be a string" }, 400);
          }
          
          const rules = writeRules(PROJECT_ROOT, body.content);
          return json({ 
            ok: true, 
            data: {
              path: rules.path,
              lastModified: rules.lastModified,
              size: rules.size,
            }
          }, 200);
        } catch (err: any) {
          return json({ ok: false, error: err.message ?? "Failed to write rules" }, 500);
        }
      },
    },
    
    // POST /api/memory/rules/init — Initialize rules with template
    {
      path: "/api/memory/rules/init",
      method: "POST",
      handler: async (req, params, ctx) => {
        const rules = initializeRules(PROJECT_ROOT);
        return json({ 
          ok: true, 
          data: {
            exists: rules.exists,
            content: rules.content,
            path: rules.path,
            lastModified: rules.lastModified,
            size: rules.size,
          }
        }, 200);
      },
    },
    
    // =========================================================================
    // Settings
    // =========================================================================
    
    // GET /api/memory/settings — Get memory settings
    {
      path: "/api/memory/settings",
      method: "GET",
      handler: async (req, params, ctx) => {
        const settings = loadMemorySettings(PROJECT_ROOT);
        return json({ 
          ok: true, 
          data: settings
        }, 200);
      },
    },
    
    // PUT /api/memory/settings — Update memory settings
    {
      path: "/api/memory/settings",
      method: "PUT",
      handler: async (req, params, ctx) => {
        try {
          const body = await req.json() as Partial<MemorySettings>;
          const currentSettings = loadMemorySettings(PROJECT_ROOT);
          const newSettings = { ...currentSettings, ...body };
          
          saveMemorySettings(PROJECT_ROOT, newSettings);
          return json({ ok: true, data: newSettings }, 200);
        } catch (err: any) {
          return json({ ok: false, error: err.message ?? "Failed to save settings" }, 500);
        }
      },
    },
    
    // POST /api/memory/settings/reset — Reset to defaults
    {
      path: "/api/memory/settings/reset",
      method: "POST",
      handler: async (req, params, ctx) => {
        saveMemorySettings(PROJECT_ROOT, DEFAULT_MEMORY_SETTINGS);
        return json({ ok: true, data: DEFAULT_MEMORY_SETTINGS }, 200);
      },
    },
    
    // =========================================================================
    // Context Assembly
    // =========================================================================
    
    // GET /api/memory/context — Get assembled memory context
    {
      path: "/api/memory/context",
      method: "GET",
      handler: async (req, params, ctx) => {
        const url = new URL(req.url);
        const sessionId = url.searchParams.get("sessionId");
        
        const context = assembleMemoryContext(PROJECT_ROOT, sessionId);
        const formatted = formatMemoryForContext(context);
        
        return json({ 
          ok: true, 
          data: {
            context,
            formatted,
            tokenEstimate: Math.ceil(formatted.length / 4), // Rough estimate: 4 chars per token
          }
        }, 200);
      },
    },
    
    // =========================================================================
    // Stats
    // =========================================================================
    
    // GET /api/memory/stats — Get memory statistics
    {
      path: "/api/memory/stats",
      method: "GET",
      handler: async (req, params, ctx) => {
        const url = new URL(req.url);
        const sessionId = url.searchParams.get("sessionId");
        
        const stats = getMemoryStats(PROJECT_ROOT, sessionId ?? undefined);
        
        return json({ 
          ok: true, 
          data: stats
        }, 200);
      },
    },
  ];
}
