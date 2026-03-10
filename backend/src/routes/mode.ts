/**
 * Mode API Routes
 * 
 * GET  /api/mode - Get current mode and configuration
 * PUT  /api/mode - Set mode (beginner/advanced)
 * POST /api/mode/toggle - Toggle between modes
 */

import type { RouteHandler, RouteContext } from "./types";
import { getModeManager } from "../mode";
import type { UIMode } from "@koryphaios/shared";
import { z } from "zod";

interface Context {
  req: Request;
  params: Map<string, string>;
}

const SetModeSchema = z.object({
  mode: z.enum(["beginner", "advanced"]),
});

/**
 * Get current mode and configuration
 */
export async function getMode(ctx: Context): Promise<Response> {
  const modeManager = getModeManager();
  
  return new Response(
    JSON.stringify({
      mode: modeManager.getMode(),
      config: modeManager.getModeConfig(),
      context: modeManager.getModeContext(),
      shouldWarnNoGit: modeManager.shouldWarnNoGitRepo(),
      noGitWarning: modeManager.shouldWarnNoGitRepo() 
        ? modeManager.getNoGitRepoWarning() 
        : null,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}

/**
 * Set the UI mode
 */
export async function setMode(ctx: Context): Promise<Response> {
  const body = await ctx.req.json();
  const parsed = SetModeSchema.safeParse(body);
  
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ 
        error: "Invalid mode", 
        details: parsed.error.issues 
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
  
  const modeManager = getModeManager();
  modeManager.setMode(parsed.data.mode);
  
  return new Response(
    JSON.stringify({
      mode: modeManager.getMode(),
      config: modeManager.getModeConfig(),
      message: `Switched to ${parsed.data.mode} mode`,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}

/**
 * Toggle between beginner and advanced mode
 */
export async function toggleMode(ctx: Context): Promise<Response> {
  const modeManager = getModeManager();
  const newMode = modeManager.toggleMode();
  
  return new Response(
    JSON.stringify({
      mode: newMode,
      config: modeManager.getModeConfig(),
      message: `Switched to ${newMode} mode`,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}

/**
 * Create mode routes
 */
export function createModeRoutes(): RouteHandler[] {
  return [
    {
      method: "GET",
      path: "/api/mode",
      handler: async (req, params, ctx) => {
        return getMode({ req, params, ...ctx } as Context);
      },
    },
    {
      method: "PUT",
      path: "/api/mode",
      handler: async (req, params, ctx) => {
        return setMode({ req, params, ...ctx } as Context);
      },
    },
    {
      method: "POST",
      path: "/api/mode/toggle",
      handler: async (req, params, ctx) => {
        return toggleMode({ req, params, ...ctx } as Context);
      },
    },
  ];
}
