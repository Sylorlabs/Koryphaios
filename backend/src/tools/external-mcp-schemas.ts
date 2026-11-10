// Standalone CLI metadata must not import backend initialization or credentials.
export const MCP_DISCOVERY_SCHEMA = {
  type: 'object', properties: { server_name: { type: 'string' } }, additionalProperties: false,
};
export const MCP_INVOCATION_SCHEMA = {
  type: 'object', properties: {
    server_name: { type: 'string', minLength: 1 },
    tool_name: { type: 'string', minLength: 1 },
    arguments: { type: 'object', additionalProperties: true },
  }, required: ['server_name', 'tool_name', 'arguments'], additionalProperties: false,
};
