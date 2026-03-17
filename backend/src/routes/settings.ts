/**
 * Settings API Routes
 * 
 * Provides endpoints for app-wide settings and configuration.
 * Wraps agent settings and other configuration.
 */

import type { RouteHandler } from "./types";
import { json } from "./types";
import { PROJECT_ROOT } from "../runtime/paths";
import {
  loadAgentSettings,
  readPreferences,
  type AgentSettings,
} from "../agent-settings";

// App-wide settings interface
interface AppSettings {
  agent: AgentSettings;
  preferences: {
    exists: boolean;
    content: string;
    path: string;
  };
  version: string;
}

export function createSettingsRoutes(): RouteHandler[] {
  return [
    // =========================================================================
    // App Settings
    // =========================================================================
    
    // GET /api/settings — Get all app settings
    {
      path: "/api/settings",
      method: "GET",
      handler: async (req, params, ctx) => {
        try {
          const agentSettings = loadAgentSettings(PROJECT_ROOT);
          const preferences = readPreferences(PROJECT_ROOT);
          
          const settings: AppSettings = {
            agent: agentSettings,
            preferences: {
              exists: preferences.exists,
              content: preferences.content,
              path: preferences.path,
            },
            version: "1.0.0",
          };
          
          return json({ 
            ok: true, 
            data: settings 
          }, 200);
        } catch (err: any) {
          return json({ 
            ok: false, 
            error: err.message ?? "Failed to load settings" 
          }, 500);
        }
      },
    },
    
    // PUT /api/settings — Update app settings
    {
      path: "/api/settings",
      method: "PUT",
      handler: async (req, params, ctx) => {
        try {
          const body = await req.json() as Partial<AppSettings>;
          
          // Currently only agent settings can be updated via this endpoint
          // Preferences should use /api/agent/preferences
          const currentSettings = loadAgentSettings(PROJECT_ROOT);
          
          if (body.agent) {
            const { saveAgentSettings } = await import("../agent-settings");
            const newSettings = { ...currentSettings, ...body.agent };
            saveAgentSettings(PROJECT_ROOT, newSettings);
          }
          
          return json({ 
            ok: true, 
            message: "Settings updated" 
          }, 200);
        } catch (err: any) {
          return json({ 
            ok: false, 
            error: err.message ?? "Failed to save settings" 
          }, 500);
        }
      },
    },
  ];
}
