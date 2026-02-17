import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, unlinkSync, mkdirSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { ReadFileTool, WriteFileTool, EditFileTool, DeleteFileTool, MoveFileTool, GlobTool, LsTool, DiffTool, PatchTool } from "../src/tools/files";

const TEST_DIR = "/tmp/koryphaios-file-test";

function createMockContext(overrides: any = {}) {
  return {
    workingDirectory: TEST_DIR,
    isSandboxed: false,
    allowedPaths: ["/"],
    emitFileEdit: undefined,
    emitFileComplete: undefined,
    recordChange: undefined,
    ...overrides,
  };
}

describe("File Tools", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe("WriteFileTool", () => {
    const tool = new WriteFileTool();

    test("writes file successfully", async () => {
      const result = await tool.run(createMockContext(), {
        id: "test-1",
        input: { path: "test.txt", content: "Hello World" },
      });

      expect(result.isError).toBe(false);
      expect(result.output).toContain("Wrote");
      expect(existsSync(join(TEST_DIR, "test.txt"))).toBe(true);
    });

    test("creates parent directories", async () => {
      const result = await tool.run(createMockContext(), {
        id: "test-2",
        input: { path: "nested/dir/file.txt", content: "content" },
      });

      expect(result.isError).toBe(false);
      expect(existsSync(join(TEST_DIR, "nested/dir/file.txt"))).toBe(true);
    });

    test("overwrites existing file", async () => {
      writeFileSync(join(TEST_DIR, "existing.txt"), "original");
      
      const result = await tool.run(createMockContext(), {
        id: "test-3",
        input: { path: "existing.txt", content: "new content" },
      });

      expect(result.isError).toBe(false);
      expect(readFileSync(join(TEST_DIR, "existing.txt"), "utf-8")).toBe("new content");
    });

    test("handles empty content", async () => {
      const result = await tool.run(createMockContext(), {
        id: "test-4",
        input: { path: "empty.txt", content: "" },
      });

      expect(result.isError).toBe(false);
    });
  });

  describe("ReadFileTool", () => {
    const tool = new ReadFileTool();

    test("reads file successfully", async () => {
      writeFileSync(join(TEST_DIR, "readme.md"), "Line 1\nLine 2\nLine 3");

      const result = await tool.run(createMockContext(), {
        id: "test-5",
        input: { path: "readme.md" },
      });

      expect(result.isError).toBe(false);
      expect(result.output).toContain("1. Line 1");
      expect(result.output).toContain("2. Line 2");
    });

    test("reads file with line range", async () => {
      writeFileSync(join(TEST_DIR, "lines.txt"), "Line 1\nLine 2\nLine 3\nLine 4\nLine 5");

      const result = await tool.run(createMockContext(), {
        id: "test-6",
        input: { path: "lines.txt", startLine: 2, endLine: 4 },
      });

      expect(result.isError).toBe(false);
      expect(result.output).toContain("2. Line 2");
      expect(result.output).toContain("3. Line 3");
      expect(result.output).toContain("4. Line 4");
    });

    test("returns error for missing file", async () => {
      const result = await tool.run(createMockContext(), {
        id: "test-7",
        input: { path: "nonexistent.txt" },
      });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("not found");
    });
  });

  describe("EditFileTool", () => {
    const tool = new EditFileTool();

    test("edits file successfully", async () => {
      writeFileSync(join(TEST_DIR, "edit-me.txt"), "Hello World");

      const result = await tool.run(createMockContext(), {
        id: "test-8",
        input: { path: "edit-me.txt", old_str: "World", new_str: "Universe" },
      });

      expect(result.isError).toBe(false);
      expect(readFileSync(join(TEST_DIR, "edit-me.txt"), "utf-8")).toBe("Hello Universe");
    });

    test("returns error when old_str not found", async () => {
      writeFileSync(join(TEST_DIR, "no-match.txt"), "Hello World");

      const result = await tool.run(createMockContext(), {
        id: "test-9",
        input: { path: "no-match.txt", old_str: "NotThere", new_str: "Something" },
      });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("not found");
    });

    test("returns error when old_str appears multiple times", async () => {
      writeFileSync(join(TEST_DIR, "multi.txt"), "foo bar foo");

      const result = await tool.run(createMockContext(), {
        id: "test-10",
        input: { path: "multi.txt", old_str: "foo", new_str: "baz" },
      });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("Must be unique");
    });
  });

  describe("DeleteFileTool", () => {
    const tool = new DeleteFileTool();

    test("deletes file successfully", async () => {
      writeFileSync(join(TEST_DIR, "to-delete.txt"), "content");

      const result = await tool.run(createMockContext(), {
        id: "test-11",
        input: { path: "to-delete.txt" },
      });

      expect(result.isError).toBe(false);
      expect(existsSync(join(TEST_DIR, "to-delete.txt"))).toBe(false);
    });

    test("returns error for missing file", async () => {
      const result = await tool.run(createMockContext(), {
        id: "test-12",
        input: { path: "missing.txt" },
      });

      expect(result.isError).toBe(true);
    });

    test("deletes empty directory", async () => {
      mkdirSync(join(TEST_DIR, "empty-dir"));

      const result = await tool.run(createMockContext(), {
        id: "test-13",
        input: { path: "empty-dir" },
      });

      expect(result.isError).toBe(false);
    });

    test("rejects non-empty directory", async () => {
      mkdirSync(join(TEST_DIR, "non-empty"));
      writeFileSync(join(TEST_DIR, "non-empty/file.txt"), "content");

      const result = await tool.run(createMockContext(), {
        id: "test-14",
        input: { path: "non-empty" },
      });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("Cannot delete");
    });
  });

  describe("MoveFileTool", () => {
    const tool = new MoveFileTool();

    test("moves file successfully", async () => {
      writeFileSync(join(TEST_DIR, "source.txt"), "content");

      const result = await tool.run(createMockContext(), {
        id: "test-15",
        input: { source: "source.txt", destination: "target.txt" },
      });

      expect(result.isError).toBe(false);
      expect(existsSync(join(TEST_DIR, "target.txt"))).toBe(true);
      expect(existsSync(join(TEST_DIR, "source.txt"))).toBe(false);
    });

    test("returns error when source not found", async () => {
      const result = await tool.run(createMockContext(), {
        id: "test-16",
        input: { source: "missing.txt", destination: "target.txt" },
      });

      expect(result.isError).toBe(true);
    });

    test("returns error when destination exists", async () => {
      writeFileSync(join(TEST_DIR, "file1.txt"), "content1");
      writeFileSync(join(TEST_DIR, "file2.txt"), "content2");

      const result = await tool.run(createMockContext(), {
        id: "test-17",
        input: { source: "file1.txt", destination: "file2.txt" },
      });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("already exists");
    });
  });

  describe("GlobTool", () => {
    const tool = new GlobTool();

    test("finds matching files", async () => {
      writeFileSync(join(TEST_DIR, "file1.ts"), "content");
      writeFileSync(join(TEST_DIR, "file2.ts"), "content");
      writeFileSync(join(TEST_DIR, "file3.js"), "content");

      const result = await tool.run(createMockContext(), {
        id: "test-18",
        input: { pattern: "*.ts" },
      });

      expect(result.isError).toBe(false);
      expect(result.output).toContain("file1.ts");
      expect(result.output).toContain("file2.ts");
      expect(result.output).not.toContain("file3.js");
    });

    test("handles nested patterns", async () => {
      mkdirSync(join(TEST_DIR, "src/utils"), { recursive: true });
      writeFileSync(join(TEST_DIR, "src/app.ts"), "content");
      writeFileSync(join(TEST_DIR, "src/utils/helper.ts"), "content");

      const result = await tool.run(createMockContext(), {
        id: "test-19",
        input: { pattern: "**/*.ts" },
      });

      expect(result.isError).toBe(false);
      expect(result.output).toContain("src/app.ts");
    });

    test("returns empty for no matches", async () => {
      const result = await tool.run(createMockContext(), {
        id: "test-20",
        input: { pattern: "*.nonexistent" },
      });

      expect(result.isError).toBe(false);
      expect(result.output).toContain("No files matched");
    });
  });

  describe("LsTool", () => {
    const tool = new LsTool();

    test("lists directory contents", async () => {
      mkdirSync(join(TEST_DIR, "subdir"));
      writeFileSync(join(TEST_DIR, "file.txt"), "content");

      const result = await tool.run(createMockContext(), {
        id: "test-21",
        input: {},
      });

      expect(result.isError).toBe(false);
      expect(result.output).toContain("subdir/");
      expect(result.output).toContain("file.txt");
    });

    test("respects depth parameter", async () => {
      mkdirSync(join(TEST_DIR, "level1"), { recursive: true });
      mkdirSync(join(TEST_DIR, "level1/level2"), { recursive: true });
      writeFileSync(join(TEST_DIR, "level1/deep.txt"), "content");

      const result = await tool.run(createMockContext(), {
        id: "test-22",
        input: { depth: 1 },
      });

      expect(result.isError).toBe(false);
      expect(result.output).toContain("level1/");
    });

    test("filters hidden files and node_modules", async () => {
      writeFileSync(join(TEST_DIR, ".hidden"), "content");
      writeFileSync(join(TEST_DIR, "normal.txt"), "content");
      mkdirSync(join(TEST_DIR, "node_modules"));
      writeFileSync(join(TEST_DIR, "node_modules/dep.js"), "content");

      const result = await tool.run(createMockContext(), {
        id: "test-23",
        input: {},
      });

      expect(result.isError).toBe(false);
      expect(result.output).not.toContain(".hidden");
      expect(result.output).not.toContain("node_modules");
    });
  });

  describe("DiffTool", () => {
    const tool = new DiffTool();

    test("shows diff between two files", async () => {
      writeFileSync(join(TEST_DIR, "old.txt"), "line 1\nline 2\nline 3");
      writeFileSync(join(TEST_DIR, "new.txt"), "line 1\nmodified line\nline 3");

      const result = await tool.run(createMockContext(), {
        id: "test-24",
        input: { path_a: "old.txt", path_b: "new.txt" },
      });

      expect(result.isError).toBe(false);
      expect(result.output).toContain("---");
      expect(result.output).toContain("+++");
    });

    test("shows diff with inline content", async () => {
      writeFileSync(join(TEST_DIR, "original.txt"), "Hello World");

      const result = await tool.run(createMockContext(), {
        id: "test-25",
        input: { path_a: "original.txt", new_content: "Hello Universe" },
      });

      expect(result.isError).toBe(false);
      expect(result.output).toContain("-Hello World");
      expect(result.output).toContain("+Hello Universe");
    });
  });

  describe("PatchTool", () => {
    const tool = new PatchTool();

    test("applies multiple edits atomically", async () => {
      writeFileSync(join(TEST_DIR, "patch-test.txt"), "foo bar baz");

      const result = await tool.run(createMockContext(), {
        id: "test-26",
        input: {
          path: "patch-test.txt",
          edits: [
            { old_str: "foo", new_str: "FOO" },
            { old_str: "bar", new_str: "BAR" },
          ],
        },
      });

      expect(result.isError).toBe(false);
      expect(readFileSync(join(TEST_DIR, "patch-test.txt"), "utf-8")).toBe("FOO BAR baz");
    });

    test("validates all edits before applying", async () => {
      writeFileSync(join(TEST_DIR, "patch-fail.txt"), "foo foo bar");

      const result = await tool.run(createMockContext(), {
        id: "test-27",
        input: {
          path: "patch-fail.txt",
          edits: [{ old_str: "foo", new_str: "FOO" }],
        },
      });

      expect(result.isError).toBe(true);
      expect(result.output).toContain("Must be unique");
    });
  });
});
