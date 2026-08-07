import { describe, expect, it } from 'bun:test';
import { WebSearchTool } from '../web';
import type { ToolContext } from '../registry';

const context: ToolContext = {
  sessionId: 'web-search-test',
  workingDirectory: process.cwd(),
};

describe('WebSearchTool connected CLI adapter', () => {
  it('prefers an eligible connected CLI result', async () => {
    let received = '';
    const controller = new AbortController();
    const signalContext = { ...context, signal: controller.signal };
    let receivedSignal: AbortSignal | undefined;
    const tool = new WebSearchTool(async ({ query, maxResults, context: receivedContext }) => {
      received = `${query}:${maxResults}`;
      receivedSignal = receivedContext.signal;
      return 'Provider: grok\n\nExample — https://example.com';
    });
    const result = await tool.run(signalContext, {
      id: 'search-1',
      name: 'web_search',
      input: { query: 'current example', maxResults: 3 },
    });

    expect(received).toBe('current example:3');
    expect(receivedSignal).toBe(controller.signal);
    expect(result.isError).toBe(false);
    expect(result.output).toContain('connected CLI research');
    expect(result.output).toContain('https://example.com');
  });

  it('fails validation before invoking a connected CLI', async () => {
    let called = false;
    const tool = new WebSearchTool(async () => {
      called = true;
      return 'unexpected';
    });
    const result = await tool.run(context, {
      id: 'search-2',
      name: 'web_search',
      input: { query: '   ' },
    });

    expect(called).toBe(false);
    expect(result.isError).toBe(true);
  });
});
