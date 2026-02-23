// File tools — read, write, edit, list, grep, glob.
// Ported from OpenCode's tools/file.go, view.go, write.go, edit.go, grep.go, glob.go, ls.go.

import { readFileSync, existsSync, statSync, readdirSync, mkdirSync, rmdirSync, unlinkSync, renameSync, copyFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, dirname, resolve, sep, relative, isAbsolute } from "node:path";
import type { Tool, ToolContext, ToolCallInput, ToolCallOutput } from "./registry";

/**
 * Resolve a path and ensure it is under the working directory (prevents path traversal).
 * Returns { allowed, path } or { allowed: false, reason }.
 */
function resolvePathUnderRoot(workingDirectory: string, filePath: string): { allowed: boolean; path?: string; reason?: string } {
  const root = resolve(workingDirectory);
  const absPath = filePath.startsWith("/") ? resolve(filePath) : resolve(root, filePath);
  const rel = relative(root, absPath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { allowed: false, reason: "Path is outside working directory" };
  }
  return { allowed: true, path: absPath };
}

/**
 * Helper to enforce scoped filesystem access.
 * When allowedPaths is empty, only paths under workingDirectory are allowed (via resolvePathUnderRoot).
 * When allowedPaths is set, path must also be under one of the allowed paths.
 */
function checkPathAccess(absPath: string, ctx: ToolContext): boolean {
  const normalizedPath = resolve(absPath);
  const root = resolve(ctx.workingDirectory);
  const relToRoot = relative(root, normalizedPath);
  if (relToRoot.startsWith("..") || isAbsolute(relToRoot)) return false;

  if (!ctx.allowedPaths || ctx.allowedPaths.length === 0) return true;

  return ctx.allowedPaths.some(p => {
    const absAllowed = resolve(ctx.workingDirectory, p);
    return normalizedPath === absAllowed || normalizedPath.startsWith(absAllowed + sep);
  });
}

// ─── Read File ──────────────────────────────────────────────────────────────

export class ReadFileTool implements Tool {
  readonly name = "read_file";
  readonly role = "any" as const; // manager, worker, critic
  readonly description = `Read the contents of a file. Returns the file content with line numbers. Use this to examine source code, configuration files, or any text file.`;

  readonly inputSchema = {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or relative path to the file." },
      startLine: { type: "number", description: "Start line number (1-indexed). Optional." },
      endLine: { type: "number", description: "End line number (1-indexed, inclusive). Optional." },
    },
    required: ["path"],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const { path: filePath, startLine, endLine } = call.input as {
      path: string;
      startLine?: number;
      endLine?: number;
    };

    const resolved = resolvePathUnderRoot(ctx.workingDirectory, filePath);
    if (!resolved.allowed || !resolved.path) {
      return {
        callId: call.id,
        name: this.name,
        output: `Error: ${resolved.reason ?? "Invalid path"}`,
        isError: true,
        durationMs: 0,
      };
    }
    const absPath = resolved.path;

    if (!checkPathAccess(absPath, ctx)) {
      return {
        callId: call.id,
        name: this.name,
        output: `Error: Access denied. This agent is not authorized to read path: ${filePath}. Ask the Manager for access.`,
        isError: true,
        durationMs: 0
      };
    }

    if (!existsSync(absPath)) {
      return { callId: call.id, name: this.name, output: `File not found: ${absPath}`, isError: true, durationMs: 0 };
    }

    try {
      const content = readFileSync(absPath, "utf-8");
      let lines = content.split("\n");

      if (startLine !== undefined || endLine !== undefined) {
        const start = (startLine ?? 1) - 1;
        const end = endLine ?? lines.length;
        lines = lines.slice(start, end);
        const numbered = lines.map((l, i) => `${start + i + 1}. ${l}`).join("\n");
        return { callId: call.id, name: this.name, output: numbered, isError: false, durationMs: 0 };
      }

      const numbered = lines.map((l, i) => `${i + 1}. ${l}`).join("\n");
      return { callId: call.id, name: this.name, output: numbered, isError: false, durationMs: 0 };
    } catch (err: any) {
      return { callId: call.id, name: this.name, output: `Error reading file: ${err.message}`, isError: true, durationMs: 0 };
    }
  }
}

// ─── Write File ─────────────────────────────────────────────────────────────

export class WriteFileTool implements Tool {
  readonly name = "write_file";
  readonly role = "worker" as const; // manager + worker only (not critic)
  readonly description = `Create a new file or overwrite an existing file with the provided content. Creates parent directories if they don't exist.`;

  readonly inputSchema = {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to write." },
      content: { type: "string", description: "The full content to write to the file." },
    },
    required: ["path", "content"],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const { path: filePath, content } = call.input as { path: string; content: string };
    const resolved = resolvePathUnderRoot(ctx.workingDirectory, filePath);
    if (!resolved.allowed || !resolved.path) {
      return {
        callId: call.id,
        name: this.name,
        output: `Error: ${resolved.reason ?? "Invalid path"}`,
        isError: true,
        durationMs: 0,
      };
    }
    const absPath = resolved.path;

    if (!checkPathAccess(absPath, ctx)) {
      return {
        callId: call.id,
        name: this.name,
        output: `Error: Access denied. This agent is not authorized to write to path: ${filePath}.`,
        isError: true,
        durationMs: 0
      };
    }

    try {
      mkdirSync(dirname(absPath), { recursive: true });

      // Stream content to UI in chunks for Cursor-style live preview
      if (ctx.emitFileEdit) {
        const CHUNK_SIZE = 80; // ~80 chars per emit for smooth animation
        let sent = 0;
        while (sent < content.length) {
          const chunk = content.slice(sent, sent + CHUNK_SIZE);
          sent += chunk.length;
          ctx.emitFileEdit({ path: absPath, delta: chunk, totalLength: sent, operation: "create" });
          // Yield to event loop every few chunks for smooth streaming
          if (sent % (CHUNK_SIZE * 5) === 0) {
            await new Promise(r => setTimeout(r, 0));
          }
        }
      }

      await writeFile(absPath, content, "utf-8");
      const lines = content.split("\n").length;

      if (ctx.emitFileComplete) {
        ctx.emitFileComplete({ path: absPath, totalLines: lines, operation: "create" });
      }

      if (ctx.recordChange) {
        ctx.recordChange({
          path: absPath,
          linesAdded: lines,
          linesDeleted: 0,
          operation: "create",
        });
      }

      return {
        callId: call.id,
        name: this.name,
        output: `Wrote ${lines} lines to ${absPath}`,
        isError: false,
        durationMs: 0,
      };
    } catch (err: any) {
      return { callId: call.id, name: this.name, output: `Error writing file: ${err.message}`, isError: true, durationMs: 0 };
    }
  }
}

// ─── Edit File (string replacement) ─────────────────────────────────────────

export class EditFileTool implements Tool {
  readonly name = "edit_file";
  readonly role = "worker" as const;
  readonly description = `Edit an existing file by replacing a specific string with new content. The old_str must match exactly one location in the file. Include enough context to make the match unique.`;

  readonly inputSchema = {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to edit." },
      old_str: { type: "string", description: "The exact string to find and replace." },
      new_str: { type: "string", description: "The replacement string." },
    },
    required: ["path", "old_str", "new_str"],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const { path: filePath, old_str, new_str } = call.input as {
      path: string;
      old_str: string;
      new_str: string;
    };
    const resolved = resolvePathUnderRoot(ctx.workingDirectory, filePath);
    if (!resolved.allowed || !resolved.path) {
      return {
        callId: call.id,
        name: this.name,
        output: `Error: ${resolved.reason ?? "Invalid path"}`,
        isError: true,
        durationMs: 0,
      };
    }
    const absPath = resolved.path;

    if (!checkPathAccess(absPath, ctx)) {
      return {
        callId: call.id,
        name: this.name,
        output: `Error: Access denied. This agent is not authorized to edit path: ${filePath}.`,
        isError: true,
        durationMs: 0
      };
    }

    if (!existsSync(absPath)) {
      return { callId: call.id, name: this.name, output: `File not found: ${absPath}`, isError: true, durationMs: 0 };
    }

    try {
      const content = readFileSync(absPath, "utf-8");
      const occurrences = content.split(old_str).length - 1;

      if (occurrences === 0) {
        return { callId: call.id, name: this.name, output: `old_str not found in ${absPath}`, isError: true, durationMs: 0 };
      }
      if (occurrences > 1) {
        return {
          callId: call.id,
          name: this.name,
          output: `old_str found ${occurrences} times in ${absPath}. Must be unique. Add more context.`,
          isError: true,
          durationMs: 0,
        };
      }

      const newContent = content.replace(old_str, new_str);

      // Stream the replacement region to UI
      if (ctx.emitFileEdit && new_str.length > 0) {
        const CHUNK_SIZE = 80;
        let sent = 0;
        while (sent < new_str.length) {
          const chunk = new_str.slice(sent, sent + CHUNK_SIZE);
          sent += chunk.length;
          ctx.emitFileEdit({ path: absPath, delta: chunk, totalLength: sent, operation: "edit" });
          if (sent % (CHUNK_SIZE * 5) === 0) {
            await new Promise(r => setTimeout(r, 0));
          }
        }
      }

      await writeFile(absPath, newContent, "utf-8");

      if (ctx.emitFileComplete) {
        ctx.emitFileComplete({ path: absPath, totalLines: newContent.split("\n").length, operation: "edit" });
      }

      if (ctx.recordChange) {
        ctx.recordChange({
          path: absPath,
          linesAdded: new_str.split("\n").length,
          linesDeleted: old_str.split("\n").length,
          operation: "edit",
        });
      }

      return {
        callId: call.id,
        name: this.name,
        output: `Edited ${absPath}: replaced 1 occurrence`,
        isError: false,
        durationMs: 0,
      };
    } catch (err: any) {
      return { callId: call.id, name: this.name, output: `Error editing file: ${err.message}`, isError: true, durationMs: 0 };
    }
  }
}

// ─── Grep (ripgrep wrapper) ─────────────────────────────────────────────────

export class GrepTool implements Tool {
  readonly name = "grep";
  readonly role = "any" as const; // manager, worker, critic (read-only)
  readonly description = `Search for a pattern in file contents using ripgrep (rg). Returns matching file paths and lines. Fast parallel search across large codebases.`;

  readonly inputSchema = {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for." },
      path: { type: "string", description: "Directory or file to search in. Defaults to working directory." },
      glob: { type: "string", description: "File glob to filter (e.g., '*.ts', '*.cpp')." },
      contextLines: { type: "number", description: "Lines of context around matches." },
      caseSensitive: { type: "boolean", description: "Case-sensitive search. Default: true." },
      maxResults: { type: "number", description: "Maximum number of results. Default: 50." },
    },
    required: ["pattern"],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const { pattern, path, glob, contextLines, caseSensitive, maxResults } = call.input as {
      pattern: string;
      path?: string;
      glob?: string;
      contextLines?: number;
      caseSensitive?: boolean;
      maxResults?: number;
    };

    const pathResolved = resolvePathUnderRoot(ctx.workingDirectory, path ?? ".");
    if (!pathResolved.allowed || !pathResolved.path) {
      return { callId: call.id, name: this.name, output: `Error: ${pathResolved.reason ?? "Invalid path"}`, isError: true, durationMs: 0 };
    }
    const searchPath = pathResolved.path;
    const args = ["rg", "--no-heading", "--line-number", "--color", "never"];
    if (caseSensitive === false) args.push("-i");
    if (contextLines) args.push(`-C`, String(contextLines));
    if (glob) args.push(`-g`, glob);
    args.push(`-m`, String(maxResults ?? 50));
    args.push(pattern, searchPath);

    try {
      const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      if (exitCode === 1 && !stdout) {
        return { callId: call.id, name: this.name, output: "No matches found.", isError: false, durationMs: 0 };
      }
      if (exitCode > 1) {
        return { callId: call.id, name: this.name, output: `rg error: ${stderr}`, isError: true, durationMs: 0 };
      }

      return { callId: call.id, name: this.name, output: stdout.trim(), isError: false, durationMs: 0 };
    } catch {
      return { callId: call.id, name: this.name, output: "ripgrep (rg) not found. Install with: apt install ripgrep", isError: true, durationMs: 0 };
    }
  }
}

// ─── Glob ───────────────────────────────────────────────────────────────────

export class GlobTool implements Tool {
  readonly name = "glob";
  readonly role = "any" as const; // manager, worker, critic (read-only)
  readonly description = `Find files matching a glob pattern. Returns file paths relative to the working directory.`;

  readonly inputSchema = {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern (e.g., '**/*.ts', 'src/**/*.svelte')." },
      path: { type: "string", description: "Base directory. Defaults to working directory." },
    },
    required: ["pattern"],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const { pattern, path: basePath } = call.input as { pattern: string; path?: string };
    const pathResolved = resolvePathUnderRoot(ctx.workingDirectory, basePath ?? ".");
    if (!pathResolved.allowed || !pathResolved.path) {
      return { callId: call.id, name: this.name, output: `Error: ${pathResolved.reason ?? "Invalid path"}`, isError: true, durationMs: 0 };
    }
    const cwd = pathResolved.path;

    try {
      const glob = new Bun.Glob(pattern);
      const matches: string[] = [];
      for await (const match of glob.scan({ cwd, onlyFiles: true })) {
        matches.push(match);
        if (matches.length >= 500) break;
      }

      if (matches.length === 0) {
        return { callId: call.id, name: this.name, output: "No files matched.", isError: false, durationMs: 0 };
      }

      return {
        callId: call.id,
        name: this.name,
        output: matches.join("\n") + (matches.length >= 500 ? "\n[truncated at 500 results]" : ""),
        isError: false,
        durationMs: 0,
      };
    } catch (err: any) {
      return { callId: call.id, name: this.name, output: `Glob error: ${err.message}`, isError: true, durationMs: 0 };
    }
  }
}

// ─── Directory Listing ──────────────────────────────────────────────────────

export class LsTool implements Tool {
  readonly name = "ls";
  readonly role = "any" as const; // manager, worker, critic (read-only)
  readonly description = `List files and directories at a given path. Returns names with type indicators (/ for directories).`;

  readonly inputSchema = {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path to list. Defaults to working directory." },
      depth: { type: "number", description: "Recursion depth. Default: 1 (immediate children only)." },
    },
    required: [],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const { path: dirPath, depth } = call.input as { path?: string; depth?: number };
    const absPath = dirPath
      ? (() => {
          const res = resolvePathUnderRoot(ctx.workingDirectory, dirPath);
          return res.allowed && res.path ? res.path : null;
        })()
      : ctx.workingDirectory;
    if (dirPath && !absPath) {
      return { callId: call.id, name: this.name, output: "Error: Path is outside working directory", isError: true, durationMs: 0 };
    }

    if (!existsSync(absPath!)) {
      return { callId: call.id, name: this.name, output: `Path not found: ${absPath}`, isError: true, durationMs: 0 };
    }

    try {
      const entries = this.listDir(absPath!, depth ?? 1, 0);
      return { callId: call.id, name: this.name, output: entries.join("\n"), isError: false, durationMs: 0 };
    } catch (err: any) {
      return { callId: call.id, name: this.name, output: `Error listing: ${err.message}`, isError: true, durationMs: 0 };
    }
  }

  private listDir(dirPath: string, maxDepth: number, currentDepth: number): string[] {
    if (currentDepth >= maxDepth) return [];

    const entries = readdirSync(dirPath, { withFileTypes: true });
    const result: string[] = [];
    const indent = "  ".repeat(currentDepth);

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules" || entry.name === ".git") continue;

      if (entry.isDirectory()) {
        result.push(`${indent}${entry.name}/`);
        result.push(...this.listDir(join(dirPath, entry.name), maxDepth, currentDepth + 1));
      } else {
        result.push(`${indent}${entry.name}`);
      }
    }

    return result;
  }
}

// ─── Delete File ────────────────────────────────────────────────────────────

export class DeleteFileTool implements Tool {
  readonly name = "delete_file";
  readonly role = "worker" as const;
  readonly description = `Delete a file or empty directory. Cannot delete non-empty directories for safety.`;

  readonly inputSchema = {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file or empty directory to delete." },
    },
    required: ["path"],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const { path: filePath } = call.input as { path: string };
    const resolved = resolvePathUnderRoot(ctx.workingDirectory, filePath);
    if (!resolved.allowed || !resolved.path) {
      return {
        callId: call.id,
        name: this.name,
        output: `Error: ${resolved.reason ?? "Invalid path"}`,
        isError: true,
        durationMs: 0,
      };
    }
    const absPath = resolved.path;

    if (!checkPathAccess(absPath, ctx)) {
      return {
        callId: call.id,
        name: this.name,
        output: `Error: Access denied. This agent is not authorized to delete path: ${filePath}.`,
        isError: true,
        durationMs: 0
      };
    }

    if (!existsSync(absPath)) {
      return { callId: call.id, name: this.name, output: `Path not found: ${absPath}`, isError: true, durationMs: 0 };
    }

    try {
      const stat = statSync(absPath);
      if (stat.isDirectory()) {
        const entries = readdirSync(absPath);
        if (entries.length > 0) {
          return { callId: call.id, name: this.name, output: `Cannot delete non-empty directory: ${absPath} (${entries.length} entries). Remove contents first.`, isError: true, durationMs: 0 };
        }
        rmdirSync(absPath);
        return { callId: call.id, name: this.name, output: `Deleted empty directory: ${absPath}`, isError: false, durationMs: 0 };
      }

      const content = readFileSync(absPath, "utf-8");
      const lines = content.split("\n").length;

      unlinkSync(absPath);

      if (ctx.recordChange) {
        ctx.recordChange({
          path: absPath,
          linesAdded: 0,
          linesDeleted: lines,
          operation: "delete",
        });
      }

      return { callId: call.id, name: this.name, output: `Deleted file: ${absPath}`, isError: false, durationMs: 0 };
    } catch (err: any) {
      return { callId: call.id, name: this.name, output: `Error deleting: ${err.message}`, isError: true, durationMs: 0 };
    }
  }
}

// ─── Move / Rename File ─────────────────────────────────────────────────────

export class MoveFileTool implements Tool {
  readonly name = "move_file";
  readonly role = "worker" as const;
  readonly description = `Move or rename a file or directory. Creates parent directories for the destination if needed.`;

  readonly inputSchema = {
    type: "object",
    properties: {
      source: { type: "string", description: "Source path to move from." },
      destination: { type: "string", description: "Destination path to move to." },
    },
    required: ["source", "destination"],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const { source, destination } = call.input as { source: string; destination: string };
    const resSrc = resolvePathUnderRoot(ctx.workingDirectory, source);
    const resDest = resolvePathUnderRoot(ctx.workingDirectory, destination);
    if (!resSrc.allowed || !resSrc.path || !resDest.allowed || !resDest.path) {
      return {
        callId: call.id,
        name: this.name,
        output: `Error: ${resSrc.reason ?? resDest.reason ?? "Invalid path"}`,
        isError: true,
        durationMs: 0,
      };
    }
    const absSrc = resSrc.path;
    const absDest = resDest.path;

    if (!checkPathAccess(absSrc, ctx) || !checkPathAccess(absDest, ctx)) {
      return {
        callId: call.id,
        name: this.name,
        output: `Error: Access denied. Authorized paths for this agent: ${ctx.allowedPaths?.join(', ') || 'none'}`,
        isError: true,
        durationMs: 0
      };
    }

    if (!existsSync(absSrc)) {
      return { callId: call.id, name: this.name, output: `Source not found: ${absSrc}`, isError: true, durationMs: 0 };
    }

    if (existsSync(absDest)) {
      return { callId: call.id, name: this.name, output: `Destination already exists: ${absDest}`, isError: true, durationMs: 0 };
    }

    try {
      mkdirSync(dirname(absDest), { recursive: true });
      renameSync(absSrc, absDest);
      return { callId: call.id, name: this.name, output: `Moved: ${absSrc} → ${absDest}`, isError: false, durationMs: 0 };
    } catch (err: any) {
      // renameSync fails across devices — fallback to copy+delete for files
      if (err.code === "EXDEV") {
        try {
          const stat = statSync(absSrc);
          if (stat.isDirectory()) {
            return { callId: call.id, name: this.name, output: `Cannot move directory across filesystems: ${err.message}`, isError: true, durationMs: 0 };
          }
          copyFileSync(absSrc, absDest);
          unlinkSync(absSrc);
          return { callId: call.id, name: this.name, output: `Moved (cross-device): ${absSrc} → ${absDest}`, isError: false, durationMs: 0 };
        } catch (copyErr: any) {
          return { callId: call.id, name: this.name, output: `Error moving file: ${copyErr.message}`, isError: true, durationMs: 0 };
        }
      }
      return { callId: call.id, name: this.name, output: `Error moving: ${err.message}`, isError: true, durationMs: 0 };
    }
  }
}

// ─── Diff Tool ──────────────────────────────────────────────────────────────

export class DiffTool implements Tool {
  readonly name = "diff";
  readonly role = "worker" as const;
  readonly description = `Show a unified diff between two files, or between the current content and provided new content. Useful for reviewing changes before applying them.`;

  readonly inputSchema = {
    type: "object",
    properties: {
      path_a: { type: "string", description: "Path to the first file (or the file to diff against new content)." },
      path_b: { type: "string", description: "Path to the second file. If omitted, use 'new_content' instead." },
      new_content: { type: "string", description: "New content to diff against the file at path_a." },
    },
    required: ["path_a"],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const { path_a, path_b, new_content } = call.input as {
      path_a: string;
      path_b?: string;
      new_content?: string;
    };

    const resA = resolvePathUnderRoot(ctx.workingDirectory, path_a);
    if (!resA.allowed || !resA.path) {
      return { callId: call.id, name: this.name, output: `Error: ${resA.reason ?? "Invalid path"}`, isError: true, durationMs: 0 };
    }
    const absA = resA.path;

    if (!existsSync(absA)) {
      return { callId: call.id, name: this.name, output: `File not found: ${absA}`, isError: true, durationMs: 0 };
    }

    try {
      if (path_b) {
        const resB = resolvePathUnderRoot(ctx.workingDirectory, path_b);
        if (!resB.allowed || !resB.path) {
          return { callId: call.id, name: this.name, output: `Error: ${resB.reason ?? "Invalid path"}`, isError: true, durationMs: 0 };
        }
        const absB = resB.path;
        if (!existsSync(absB)) {
          return { callId: call.id, name: this.name, output: `File not found: ${absB}`, isError: true, durationMs: 0 };
        }

        const proc = Bun.spawn(["diff", "-u", "--label", path_a, "--label", path_b, absA, absB], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const stdout = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;

        if (exitCode === 0) {
          return { callId: call.id, name: this.name, output: "Files are identical.", isError: false, durationMs: 0 };
        }

        return { callId: call.id, name: this.name, output: stdout, isError: false, durationMs: 0 };
      } else if (new_content !== undefined) {
        // Diff file content vs new content using a temp approach
        const oldContent = readFileSync(absA, "utf-8");
        const oldLines = oldContent.split("\n");
        const newLines = new_content.split("\n");

        const diff = generateUnifiedDiff(path_a, oldLines, newLines);
        if (!diff) {
          return { callId: call.id, name: this.name, output: "No differences.", isError: false, durationMs: 0 };
        }

        return { callId: call.id, name: this.name, output: diff, isError: false, durationMs: 0 };
      } else {
        return { callId: call.id, name: this.name, output: "Provide either path_b or new_content.", isError: true, durationMs: 0 };
      }
    } catch (err: any) {
      return { callId: call.id, name: this.name, output: `Diff error: ${err.message}`, isError: true, durationMs: 0 };
    }
  }
}

// ─── Patch Tool ─────────────────────────────────────────────────────────────

export class PatchTool implements Tool {
  readonly name = "patch";
  readonly role = "worker" as const;
  readonly description = `Apply a multi-edit patch to a file. Each edit specifies old_str to find and new_str to replace it with. All edits are validated before any are applied (atomic). More efficient than multiple edit_file calls.`;

  readonly inputSchema = {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to patch." },
      edits: {
        type: "array",
        description: "Array of edits to apply.",
        items: {
          type: "object",
          properties: {
            old_str: { type: "string", description: "Exact string to find." },
            new_str: { type: "string", description: "Replacement string." },
          },
          required: ["old_str", "new_str"],
        },
      },
    },
    required: ["path", "edits"],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const { path: filePath, edits } = call.input as {
      path: string;
      edits: Array<{ old_str: string; new_str: string }>;
    };

    const resolved = resolvePathUnderRoot(ctx.workingDirectory, filePath);
    if (!resolved.allowed || !resolved.path) {
      return {
        callId: call.id,
        name: this.name,
        output: `Error: ${resolved.reason ?? "Invalid path"}`,
        isError: true,
        durationMs: 0,
      };
    }
    const absPath = resolved.path;

    if (!checkPathAccess(absPath, ctx)) {
      return {
        callId: call.id,
        name: this.name,
        output: `Error: Access denied. Path ${filePath} is not in your authorized scope.`,
        isError: true,
        durationMs: 0
      };
    }

    if (!existsSync(absPath)) {
      return { callId: call.id, name: this.name, output: `File not found: ${absPath}`, isError: true, durationMs: 0 };
    }

    if (!edits || edits.length === 0) {
      return { callId: call.id, name: this.name, output: "No edits provided.", isError: true, durationMs: 0 };
    }

    try {
      let content = readFileSync(absPath, "utf-8");

      // Validate all edits first (atomic check)
      for (let i = 0; i < edits.length; i++) {
        const occurrences = content.split(edits[i].old_str).length - 1;
        if (occurrences === 0) {
          return { callId: call.id, name: this.name, output: `Edit ${i + 1}: old_str not found in ${absPath}`, isError: true, durationMs: 0 };
        }
        if (occurrences > 1) {
          return { callId: call.id, name: this.name, output: `Edit ${i + 1}: old_str found ${occurrences} times. Must be unique.`, isError: true, durationMs: 0 };
        }
      }

      // Apply all edits
      let totalAdded = 0;
      let totalDeleted = 0;
      for (const edit of edits) {
        totalAdded += edit.new_str.split("\n").length;
        totalDeleted += edit.old_str.split("\n").length;
        content = content.replace(edit.old_str, edit.new_str);
      }

      await writeFile(absPath, content, "utf-8");

      if (ctx.recordChange) {
        ctx.recordChange({
          path: absPath,
          linesAdded: totalAdded,
          linesDeleted: totalDeleted,
          operation: "edit",
        });
      }

      return {
        callId: call.id,
        name: this.name,
        output: `Applied ${edits.length} edit(s) to ${absPath}`,
        isError: false,
        durationMs: 0,
      };
    } catch (err: any) {
      return { callId: call.id, name: this.name, output: `Patch error: ${err.message}`, isError: true, durationMs: 0 };
    }
  }
}

// ─── Unified Diff Helper ────────────────────────────────────────────────────

function generateUnifiedDiff(fileName: string, oldLines: string[], newLines: string[]): string | null {
  // Simple line-by-line diff using LCS-based approach
  const hunks: string[] = [];
  hunks.push(`--- a/${fileName}`);
  hunks.push(`+++ b/${fileName}`);

  let hasChanges = false;
  let i = 0, j = 0;

  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      i++;
      j++;
      continue;
    }

    // Found a difference — build a hunk with context
    const contextStart = Math.max(0, i - 3);
    let oldEnd = i;
    let newEnd = j;

    // Scan ahead to find the end of the changed region
    while (oldEnd < oldLines.length || newEnd < newLines.length) {
      if (oldEnd < oldLines.length && newEnd < newLines.length && oldLines[oldEnd] === newLines[newEnd]) {
        // Check if we have enough matching lines to end the hunk
        let matchCount = 0;
        while (
          oldEnd + matchCount < oldLines.length &&
          newEnd + matchCount < newLines.length &&
          oldLines[oldEnd + matchCount] === newLines[newEnd + matchCount]
        ) {
          matchCount++;
          if (matchCount >= 6) break;
        }
        if (matchCount >= 6) break;
        oldEnd += matchCount || 1;
        newEnd += matchCount || 1;
      } else if (oldEnd < oldLines.length && (newEnd >= newLines.length || oldLines[oldEnd] !== newLines[newEnd])) {
        oldEnd++;
      } else {
        newEnd++;
      }
    }

    const contextEnd = Math.min(Math.max(oldEnd, newEnd) + 3, Math.max(oldLines.length, newLines.length));
    const oldContextEnd = Math.min(oldEnd + 3, oldLines.length);
    const newContextEnd = Math.min(newEnd + 3, newLines.length);

    hunks.push(`@@ -${contextStart + 1},${oldContextEnd - contextStart} +${contextStart + 1},${newContextEnd - contextStart} @@`);

    // Context before
    for (let c = contextStart; c < i; c++) {
      hunks.push(` ${oldLines[c]}`);
    }

    // Changed lines
    for (let c = i; c < oldEnd; c++) {
      hunks.push(`-${oldLines[c]}`);
      hasChanges = true;
    }
    for (let c = j; c < newEnd; c++) {
      hunks.push(`+${newLines[c]}`);
      hasChanges = true;
    }

    // Context after
    for (let c = oldEnd; c < oldContextEnd; c++) {
      hunks.push(` ${oldLines[c]}`);
    }

    i = oldContextEnd;
    j = newContextEnd;
  }

  return hasChanges ? hunks.join("\n") : null;
}
