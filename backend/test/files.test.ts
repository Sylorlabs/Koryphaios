import { describe, it, expect, afterEach } from "bun:test";
import { WriteFileTool, ReadFileTool, DeleteFileTool, EditFileTool, PatchTool } from "../src/tools/files";
import { join } from "path";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";

describe("File Tools", () => {
    let tmpDir: string;

    const createCtx = (dir: string) => ({
        sessionId: "test",
        workingDirectory: dir,
        allowedPaths: ["."],
        recordChange: () => {},
        emitFileComplete: () => {},
        emitFileEdit: () => {}
    });

    afterEach(() => {
        if (tmpDir && existsSync(tmpDir)) {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it("should write a file asynchronously", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "test-files-"));
        const tool = new WriteFileTool();
        const filePath = "test.txt";
        const content = "Hello World";

        const ctx = createCtx(tmpDir);

        const result = await tool.run(ctx as any, {
            id: "1",
            name: "write_file",
            input: { path: filePath, content }
        });

        expect(result.isError).toBe(false);
        const written = readFileSync(join(tmpDir, filePath), "utf-8");
        expect(written).toBe(content);
    });

    it("should edit a file asynchronously", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "test-files-"));
        const writeTool = new WriteFileTool();
        const editTool = new EditFileTool();
        const filePath = "edit_test.txt";
        const content = "Hello World";
        const ctx = createCtx(tmpDir);

        await writeTool.run(ctx as any, {
            id: "1",
            name: "write_file",
            input: { path: filePath, content }
        });

        const result = await editTool.run(ctx as any, {
            id: "2",
            name: "edit_file",
            input: { path: filePath, old_str: "World", new_str: "Bun" }
        });

        expect(result.isError).toBe(false);
        const written = readFileSync(join(tmpDir, filePath), "utf-8");
        expect(written).toBe("Hello Bun");
    });

    it("should patch a file asynchronously", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "test-files-"));
        const writeTool = new WriteFileTool();
        const patchTool = new PatchTool();
        const filePath = "patch_test.txt";
        const content = "Line 1\nLine 2\nLine 3";
        const ctx = createCtx(tmpDir);

        await writeTool.run(ctx as any, {
            id: "1",
            name: "write_file",
            input: { path: filePath, content }
        });

        const result = await patchTool.run(ctx as any, {
            id: "2",
            name: "patch",
            input: {
                path: filePath,
                edits: [
                    { old_str: "Line 1", new_str: "New Line 1" },
                    { old_str: "Line 3", new_str: "New Line 3" }
                ]
            }
        });

        expect(result.isError).toBe(false);
        const written = readFileSync(join(tmpDir, filePath), "utf-8");
        expect(written).toBe("New Line 1\nLine 2\nNew Line 3");
    });
});
