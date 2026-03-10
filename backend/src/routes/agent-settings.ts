/**
 * Agent Settings API Routes
 * 
 * Provides endpoints for managing agent behavior, rule enforcement,
 * and workflow preferences. Rules are always enforced.
 */

import type { RouteHandler } from "./types";
import { json } from "./types";
import { PROJECT_ROOT } from "../runtime/paths";
import {
  loadAgentSettings,
  saveAgentSettings,
  resetAgentSettings,
  initializePreferences,
  readPreferences,
  writePreferences,
  assembleAgentContext,
  criticReview,
  getAgentSettingsStats,
  enforceRules,
  DEFAULT_AGENT_SETTINGS,
  type AgentSettings,
} from "../agent-settings";

export function createAgentSettingsRoutes(): RouteHandler[] {
  return [
    // =========================================================================
    // Agent Settings
    // =========================================================================
    
    // GET /api/agent/settings — Get agent settings
    {
      path: "/api/agent/settings",
      method: "GET",
      handler: async (req, params, ctx) => {
        const settings = loadAgentSettings(PROJECT_ROOT);
        return json({ 
          ok: true, 
          data: settings,
          message: "Rules are always enforced. Critic enforces based on enforcement level."
        }, 200);
      },
    },
    
    // PUT /api/agent/settings — Update agent settings
    {
      path: "/api/agent/settings",
      method: "PUT",
      handler: async (req, params, ctx) => {
        try {
          const body = await req.json() as Partial<AgentSettings>;
          const currentSettings = loadAgentSettings(PROJECT_ROOT);
          
          // Merge with defaults to ensure all fields exist
          const newSettings = { ...currentSettings, ...body };
          
          saveAgentSettings(PROJECT_ROOT, newSettings);
          
          return json({ 
            ok: true, 
            data: newSettings,
            message: "Agent settings updated. Rules remain enforced."
          }, 200);
        } catch (err: any) {
          return json({ 
            ok: false, 
            error: err.message ?? "Failed to save agent settings" 
          }, 500);
        }
      },
    },
    
    // POST /api/agent/settings/reset — Reset to defaults
    {
      path: "/api/agent/settings/reset",
      method: "POST",
      handler: async (req, params, ctx) => {
        const settings = resetAgentSettings(PROJECT_ROOT);
        return json({ 
          ok: true, 
          data: settings,
          message: "Agent settings reset to defaults. Rules still enforced."
        }, 200);
      },
    },
    
    // =========================================================================
    // Preferences.md
    // =========================================================================
    
    // GET /api/agent/preferences — Get preferences.md content
    {
      path: "/api/agent/preferences",
      method: "GET",
      handler: async (req, params, ctx) => {
        const prefs = readPreferences(PROJECT_ROOT);
        return json({ 
          ok: true, 
          data: {
            exists: prefs.exists,
            content: prefs.content,
            path: prefs.path,
          }
        }, 200);
      },
    },
    
    // PUT /api/agent/preferences — Update preferences.md
    {
      path: "/api/agent/preferences",
      method: "PUT",
      handler: async (req, params, ctx) => {
        try {
          const body = await req.json() as { content: string };
          
          if (typeof body.content !== "string") {
            return json({ ok: false, error: "content must be a string" }, 400);
          }
          
          writePreferences(PROJECT_ROOT, body.content);
          
          return json({ 
            ok: true, 
            message: "Preferences updated. Critic will enforce new rules."
          }, 200);
        } catch (err: any) {
          return json({ 
            ok: false, 
            error: err.message ?? "Failed to save preferences" 
          }, 500);
        }
      },
    },
    
    // POST /api/agent/preferences/init — Initialize with template
    {
      path: "/api/agent/preferences/init",
      method: "POST",
      handler: async (req, params, ctx) => {
        const prefs = initializePreferences(PROJECT_ROOT);
        return json({ 
          ok: true, 
          data: {
            exists: prefs.exists,
            content: prefs.content,
            path: prefs.path,
          },
          message: "Preferences initialized with comprehensive template."
        }, 200);
      },
    },
    
    // =========================================================================
    // Context Assembly
    // =========================================================================
    
    // GET /api/agent/context — Get assembled agent context
    {
      path: "/api/agent/context",
      method: "GET",
      handler: async (req, params, ctx) => {
        const settings = loadAgentSettings(PROJECT_ROOT);
        const context = assembleAgentContext(PROJECT_ROOT, settings);
        
        return json({ 
          ok: true, 
          data: context
        }, 200);
      },
    },
    
    // =========================================================================
    // Rule Enforcement
    // =========================================================================
    
    // POST /api/agent/enforce — Check code against rules
    {
      path: "/api/agent/enforce",
      method: "POST",
      handler: async (req, params, ctx) => {
        try {
          const body = await req.json() as { 
            code: string; 
            filePath: string;
          };
          
          if (typeof body.code !== "string" || typeof body.filePath !== "string") {
            return json({ ok: false, error: "code and filePath are required" }, 400);
          }
          
          const settings = loadAgentSettings(PROJECT_ROOT);
          const preferences = readPreferences(PROJECT_ROOT).content;
          
          const result = enforceRules(
            body.code,
            body.filePath,
            preferences,
            settings.ruleEnforcementLevel
          );
          
          return json({ 
            ok: true, 
            data: result
          }, 200);
        } catch (err: any) {
          return json({ 
            ok: false, 
            error: err.message ?? "Failed to enforce rules" 
          }, 500);
        }
      },
    },
    
    // POST /api/agent/critic-review — Critic reviews code
    {
      path: "/api/agent/critic-review",
      method: "POST",
      handler: async (req, params, ctx) => {
        try {
          const body = await req.json() as { 
            code: string;
            filePath: string;
            changeDescription: string;
          };
          
          if (typeof body.code !== "string" || typeof body.filePath !== "string") {
            return json({ ok: false, error: "code and filePath are required" }, 400);
          }
          
          const settings = loadAgentSettings(PROJECT_ROOT);
          const preferences = readPreferences(PROJECT_ROOT).content;
          
          // Read rules file
          let rules = "";
          try {
            const { readFileSync } = await import("node:fs");
            const { join } = await import("node:path");
            rules = readFileSync(join(PROJECT_ROOT, ".cursorrules"), "utf-8");
          } catch {
            // Rules file may not exist
          }
          
          const result = criticReview({
            code: body.code,
            filePath: body.filePath,
            changeDescription: body.changeDescription || "Code change",
            settings,
            preferences,
            rules,
          });
          
          return json({ 
            ok: true, 
            data: result
          }, 200);
        } catch (err: any) {
          return json({ 
            ok: false, 
            error: err.message ?? "Critic review failed" 
          }, 500);
        }
      },
    },
    
    // =========================================================================
    // Stats
    // =========================================================================
    
    // GET /api/agent/stats — Get agent settings statistics
    {
      path: "/api/agent/stats",
      method: "GET",
      handler: async (req, params, ctx) => {
        const stats = getAgentSettingsStats(PROJECT_ROOT);
        return json({ 
          ok: true, 
          data: stats
        }, 200);
      },
    },
    
    // GET /api/agent/defaults — Get default settings
    {
      path: "/api/agent/defaults",
      method: "GET",
      handler: async (req, params, ctx) => {
        return json({ 
          ok: true, 
          data: DEFAULT_AGENT_SETTINGS,
          message: "Default agent settings. Rules always enforced."
        }, 200);
      },
    },
  ];
}
