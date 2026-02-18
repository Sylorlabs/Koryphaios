import { describe, expect, test } from "bun:test";
import { serializeError, KoryphaiosError } from "./errors";

describe("serializeError", () => {
  test("serializes a standard Error", () => {
    const error = new Error("Something went wrong");
    const serialized = serializeError(error);

    expect(serialized.name).toBe("Error");
    expect(serialized.message).toBe("Something went wrong");
    expect(serialized.stack).toBeDefined();
    expect(Array.isArray(serialized.frames)).toBe(true);
    // topFrame might be undefined depending on where the test runs, but frames should not be empty generally if stack exists
    if (serialized.frames.length > 0) {
      expect(serialized.frames[0]).toBeDefined();
    }
  });

  test("serializes a KoryphaiosError", () => {
    const error = new KoryphaiosError("Custom error", "CUSTOM_CODE", 400, { foo: "bar" });
    const serialized = serializeError(error);

    expect(serialized.name).toBe("KoryphaiosError");
    expect(serialized.message).toBe("Custom error");
    expect(serialized.stack).toBeDefined();
  });

  test("serializes a string error", () => {
    const error = "Just a string error";
    const serialized = serializeError(error);

    expect(serialized.name).toBe("UnknownError");
    expect(serialized.message).toBe("Just a string error");
    expect(serialized.frames).toEqual([]);
  });

  test("serializes a number error", () => {
    const error = 12345;
    const serialized = serializeError(error);

    expect(serialized.name).toBe("UnknownError");
    expect(serialized.message).toBe("12345");
    expect(serialized.frames).toEqual([]);
  });

  test("serializes an object that is not an Error", () => {
    const error = { foo: "bar" };
    const serialized = serializeError(error);

    expect(serialized.name).toBe("UnknownError");
    expect(serialized.message).toBe("[object Object]");
    expect(serialized.frames).toEqual([]);
  });

  test("serializes an error with a cause", () => {
    const cause = new Error("Root cause");
    const error = new Error("Wrapper error");
    (error as any).cause = cause;

    const serialized = serializeError(error);

    expect(serialized.message).toBe("Wrapper error");
    expect(serialized.cause).toBe(cause);
  });

  test("parses stack frames correctly (Node/Bun format with function name)", () => {
    const error = new Error("Test error");
    error.stack = `Error: Test error
    at myFunction (/path/to/file.ts:10:20)
    at /path/to/other.ts:5:15`;

    const serialized = serializeError(error);

    expect(serialized.frames).toHaveLength(2);
    expect(serialized.frames[0]).toEqual({
      functionName: "myFunction",
      file: "/path/to/file.ts",
      line: 10,
      column: 20,
      raw: "at myFunction (/path/to/file.ts:10:20)",
    });
    expect(serialized.frames[1]).toEqual({
      file: "/path/to/other.ts",
      line: 5,
      column: 15,
      raw: "at /path/to/other.ts:5:15",
    });
  });

  test("identifies top project frame correctly", () => {
    const error = new Error("Test error");
    error.stack = `Error: Test error
    at node_modules/some-lib/index.js:1:1
    at /app/backend/src/my-code.ts:10:5
    at /app/shared/src/utils.ts:20:10`;

    const serialized = serializeError(error);

    expect(serialized.topFrame).toBeDefined();
    expect(serialized.topFrame?.file).toBe("/app/backend/src/my-code.ts");
  });

  test("falls back to first frame if no project frame found", () => {
    const error = new Error("Test error");
    error.stack = `Error: Test error
    at node_modules/lib/index.js:10:1
    at internal/process/task_queues.js:79:11`;

    const serialized = serializeError(error);

    expect(serialized.topFrame).toBeDefined();
    expect(serialized.topFrame?.raw).toContain("node_modules/lib/index.js");
  });
});
