/** Read display-only CLI tool evidence without inventing an executable name. */
export function recordedToolName(record: Record<string, unknown>): string | undefined {
  const fn =
    record.function && typeof record.function === 'object'
      ? (record.function as Record<string, unknown>)
      : {};
  for (const value of [
    record.toolName,
    record.tool_name,
    record.function_name,
    fn.name,
    record.name,
  ]) {
    if (typeof value !== 'string') continue;
    const name = value.trim();
    if (name && !/^(?:tool|generic|unknown|unknown_tool|freebuff_tool)$/i.test(name)) return name;
  }
  return undefined;
}

/** Kory's tool feed expects an object, even when a CLI records JSON as text. */
export function recordedToolInput(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        return parsed as Record<string, unknown>;
    } catch {
      /* Preserve non-JSON input below. */
    }
    return value ? { input: value } : {};
  }
  return value == null ? {} : { input: value };
}

export function recordedToolOutput(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value ?? '') ?? '');
}

/** MCP dispatchers publish their destination in the input, not the step kind. */
export function recordedToolIdentity(name: string | undefined, input: Record<string, unknown>) {
  if (name && /^(?:call_mcp_tool|mcp|mcp_tool_call)$/i.test(name)) {
    const destination = recordedToolName({ tool_name: input.tool_name, toolName: input.toolName });
    if (destination) {
      return {
        name: destination,
        input: recordedToolInput(input.arguments ?? input.args ?? input.input),
      };
    }
  }
  return { name, input };
}
