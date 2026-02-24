// Git routes — handles git operations

import type { RouteHandler, RouteDependencies } from "./types";
import { json } from "./types";

export function createGitRoutes(deps: RouteDependencies): RouteHandler[] {
    const { kory } = deps;

    return [
        // GET /api/git/status — Get git status
        {
            path: "/api/git/status",
            method: "GET",
            handler: async (req, _params, ctx) => {
                const status = await kory.git.getStatus();
                const branch = await kory.git.getBranch();
                const { ahead, behind } = await kory.git.getAheadBehind();
                return json({ ok: true, data: { status, branch, ahead, behind } }, 200);
            },
        },

        // GET /api/git/diff — Get file diff
        {
            path: "/api/git/diff",
            method: "GET",
            handler: async (req, _params, ctx) => {
                const url = new URL(req.url);
                const file = url.searchParams.get("file");
                const staged = url.searchParams.get("staged") === "true";

                if (!file) {
                    return json({ ok: false, error: "file parameter required" }, 400);
                }

                const diff = await kory.git.getDiff(file, staged);
                return json({ ok: true, data: { diff } }, 200);
            },
        },

        // GET /api/git/file — Get file content
        {
            path: "/api/git/file",
            method: "GET",
            handler: async (req, _params, ctx) => {
                const url = new URL(req.url);
                const file = url.searchParams.get("path");

                if (!file) {
                    return json({ ok: false, error: "path parameter required" }, 400);
                }

                const content = await kory.git.getFileContent(file);
                return json({ ok: content !== null, data: { content } }, 200);
            },
        },

        // POST /api/git/stage — Stage or unstage file
        {
            path: "/api/git/stage",
            method: "POST",
            handler: async (req, _params, ctx) => {
                const body = await req.json() as { file: string; unstage?: boolean };

                if (!body.file) {
                    return json({ ok: false, error: "file required" }, 400);
                }

                const success = body.unstage
                    ? await kory.git.unstageFile(body.file)
                    : await kory.git.stageFile(body.file);

                return json({ ok: success }, success ? 200 : 500);
            },
        },

        // POST /api/git/restore — Restore file
        {
            path: "/api/git/restore",
            method: "POST",
            handler: async (req, _params, ctx) => {
                const body = await req.json() as { file: string };

                if (!body.file) {
                    return json({ ok: false, error: "file required" }, 400);
                }

                const success = await kory.git.restoreFile(body.file);
                return json({ ok: success }, success ? 200 : 500);
            },
        },

        // POST /api/git/commit — Commit changes
        {
            path: "/api/git/commit",
            method: "POST",
            handler: async (req, _params, ctx) => {
                const body = await req.json() as { message: string };

                if (!body.message) {
                    return json({ ok: false, error: "message required" }, 400);
                }

                const success = await kory.git.commit(body.message);
                return json({ ok: success }, success ? 200 : 500);
            },
        },

        // GET /api/git/branches — List branches
        {
            path: "/api/git/branches",
            method: "GET",
            handler: async (req, _params, ctx) => {
                const { output } = (kory.git as any).runGit(["branch", "--format=%(refname:short)"]);
                const branches = output.split("\n").filter(Boolean);
                return json({ ok: true, data: { branches } }, 200);
            },
        },

        // POST /api/git/checkout — Checkout branch
        {
            path: "/api/git/checkout",
            method: "POST",
            handler: async (req, _params, ctx) => {
                const body = await req.json() as { branch: string; create?: boolean };

                if (!body.branch) {
                    return json({ ok: false, error: "branch required" }, 400);
                }

                const success = await kory.git.checkout(body.branch, body.create);
                return json({ ok: success }, success ? 200 : 500);
            },
        },

        // POST /api/git/merge — Merge branch
        {
            path: "/api/git/merge",
            method: "POST",
            handler: async (req, _params, ctx) => {
                const body = await req.json() as { branch: string };

                if (!body.branch) {
                    return json({ ok: false, error: "branch required" }, 400);
                }

                const result = await kory.git.merge(body.branch);
                const conflicts = result.hasConflicts ? await kory.git.getConflicts() : [];

                return json({
                    ok: result.success,
                    data: { output: result.output, conflicts, hasConflicts: result.hasConflicts }
                }, 200);
            },
        },

        // POST /api/git/push — Push changes
        {
            path: "/api/git/push",
            method: "POST",
            handler: async (req, _params, ctx) => {
                const result = await kory.git.push();
                return json({ ok: result.success, error: result.output }, result.success ? 200 : 500);
            },
        },

        // POST /api/git/pull — Pull changes
        {
            path: "/api/git/pull",
            method: "POST",
            handler: async (req, _params, ctx) => {
                const result = await kory.git.pull();
                const hasConflicts = result.output.includes("CONFLICT")
                    || result.output.includes("Automatic merge failed");
                const conflicts = hasConflicts ? await kory.git.getConflicts() : [];

                return json({
                    ok: result.success,
                    data: { output: result.output, conflicts, hasConflicts }
                }, 200);
            },
        },
    ];
}