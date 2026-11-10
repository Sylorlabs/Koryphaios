import { describe, expect, it } from 'vitest';
import { resolveRegisteredMcpTool } from './mcp-tool-identity';

describe('registered MCP aliases', () => {
  it('prefers exact discovered tool evidence over overlapping server prefixes', () => {
    expect(resolveRegisteredMcpTool('mcp_research_team_lookup', [
      { name: 'research', tools: ['team_lookup'] },
      { name: 'research_team', tools: ['other'] },
    ])).toEqual({ server: 'research', tool: 'team_lookup' });
  });

  it('does not invent an identity for an ambiguous discovered alias', () => {
    expect(resolveRegisteredMcpTool('mcp_research_team_lookup', [
      { name: 'research', tools: ['team_lookup'] },
      { name: 'research_team', tools: ['lookup'] },
    ])).toBeNull();
  });

  it('uses the longest configured prefix when catalogs are unavailable', () => {
    expect(resolveRegisteredMcpTool('mcp_research_team_lookup', [
      { name: 'research' }, { name: 'research_team' },
    ])).toEqual({ server: 'research_team', tool: 'lookup' });
    expect(resolveRegisteredMcpTool('mcp_research_team_', [{ name: 'research_team' }])).toBeNull();
    expect(resolveRegisteredMcpTool('mcp_unknown_lookup', [{ name: 'research_team' }])).toBeNull();
  });
});
