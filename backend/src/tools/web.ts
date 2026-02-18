// Web search tool — uses DuckDuckGo HTML search + fetch for page content.
// Agents perform significantly better when they can verify facts online.

import type { Tool, ToolCallInput, ToolContext, ToolCallOutput } from "./registry";
import { validateUrl } from "../security";

/** Web search using DuckDuckGo HTML (no API key required). */
export class WebSearchTool implements Tool {
  readonly name = "web_search";
  readonly description = "Search the web for current information. Returns snippets from search results. Use this liberally — agents perform better when they can verify information.";
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "The search query" },
      maxResults: { type: "number", description: "Max results to return (default: 5)" },
    },
    required: ["query"],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const query = call.input.query as string;
    const maxResults = (call.input.maxResults as number) || 5;

    try {
      const encoded = encodeURIComponent(query);
      const url = `https://html.duckduckgo.com/html/?q=${encoded}`;

      const resp = await fetch(url, {
        headers: {
          "User-Agent": "Koryphaios/1.0 (AI Agent Web Search)",
        },
        signal: ctx.signal,
      });

      if (!resp.ok) {
        return { callId: call.id, name: this.name, output: `Search failed: ${resp.status}`, isError: true, durationMs: 0 };
      }

      const html = await resp.text();
      const results = parseSearchResults(html, maxResults);

      if (results.length === 0) {
        return { callId: call.id, name: this.name, output: `No results found for: ${query}`, isError: false, durationMs: 0 };
      }

      const output = results
        .map((r, i) => `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.snippet}`)
        .join("\n\n");

      return { callId: call.id, name: this.name, output: `Search results for "${query}":\n\n${output}`, isError: false, durationMs: 0 };
    } catch (err: any) {
      return { callId: call.id, name: this.name, output: `Search error: ${err.message}`, isError: true, durationMs: 0 };
    }
  }
}

/** Fetch and extract readable text from a URL. */
export class WebFetchTool implements Tool {
  readonly name = "web_fetch";
  readonly description = "Fetch a URL and extract readable text content. Good for reading documentation, API references, or any web page.";
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      url: { type: "string", description: "The URL to fetch" },
      maxLength: { type: "number", description: "Max characters to return (default: 10000)" },
    },
    required: ["url"],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const url = call.input.url as string;
    const maxLength = (call.input.maxLength as number) || 10000;

    try {
      // 1. Validate initial URL before fetching (SSRF prevention)
      let currentUrl = url;
      let validation = await validateUrl(currentUrl);
      if (!validation.safe) {
        return { callId: call.id, name: this.name, output: `Access denied: ${validation.reason}`, isError: true, durationMs: 0 };
      }

      // 2. Fetch with manual redirect handling to prevent SSRF via open redirects
      let resp = await fetch(currentUrl, {
        headers: {
          "User-Agent": "Koryphaios/1.0 (AI Agent Web Fetch)",
          Accept: "text/html, application/json, text/plain",
        },
        signal: ctx.signal,
        redirect: "manual",
      });

      // Follow redirects manually, validating each hop (max 5)
      let redirectCount = 0;
      const maxRedirects = 5;

      while (resp.status >= 300 && resp.status < 400 && redirectCount < maxRedirects) {
        const location = resp.headers.get("location");
        if (!location) break;

        try {
          const nextUrl = new URL(location, currentUrl).toString();

          // Validate each redirect target
          validation = await validateUrl(nextUrl);
          if (!validation.safe) {
            return { callId: call.id, name: this.name, output: `Access denied (redirect): ${validation.reason}`, isError: true, durationMs: 0 };
          }

          currentUrl = nextUrl;
          redirectCount++;

          resp = await fetch(currentUrl, {
            headers: {
              "User-Agent": "Koryphaios/1.0 (AI Agent Web Fetch)",
              Accept: "text/html, application/json, text/plain",
            },
            signal: ctx.signal,
            redirect: "manual",
          });
        } catch {
          return { callId: call.id, name: this.name, output: `Invalid redirect URL: ${location}`, isError: true, durationMs: 0 };
        }
      }

      if (resp.status >= 300 && resp.status < 400) {
        return { callId: call.id, name: this.name, output: `Fetch failed: Too many redirects or missing Location header`, isError: true, durationMs: 0 };
      }

      if (!resp.ok) {
        return { callId: call.id, name: this.name, output: `Fetch failed: ${resp.status} ${resp.statusText}`, isError: true, durationMs: 0 };
      }

      const contentType = resp.headers.get("content-type") ?? "";
      const text = await resp.text();

      let output: string;
      if (contentType.includes("json")) {
        output = text.slice(0, maxLength);
      } else if (contentType.includes("html")) {
        output = extractTextFromHTML(text).slice(0, maxLength);
      } else {
        output = text.slice(0, maxLength);
      }

      return { callId: call.id, name: this.name, output: `Content from ${url}:\n\n${output}`, isError: false, durationMs: 0 };
    } catch (err: any) {
      return { callId: call.id, name: this.name, output: `Fetch error: ${err.message}`, isError: true, durationMs: 0 };
    }
  }
}

// ─── HTML Parsing Helpers ────────────────────────────────────────────────────

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function parseSearchResults(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];

  // DuckDuckGo HTML search results use class="result__a" for links and class="result__snippet" for snippets
  const resultBlocks = html.split('class="result__body"');

  for (let i = 1; i < resultBlocks.length && results.length < max; i++) {
    const block = resultBlocks[i];

    // Extract title and URL from anchor
    const titleMatch = block.match(/class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/s);
    const snippetMatch = block.match(/class="result__snippet"[^>]*>(.*?)<\/(?:span|td)/s);

    if (titleMatch) {
      let url = titleMatch[1];
      // DuckDuckGo wraps URLs in a redirect, extract the actual URL
      const uddgMatch = url.match(/uddg=([^&]+)/);
      if (uddgMatch) {
        url = decodeURIComponent(uddgMatch[1]);
      }

      results.push({
        title: stripHTML(titleMatch[2]).trim(),
        url,
        snippet: snippetMatch ? stripHTML(snippetMatch[1]).trim() : "",
      });
    }
  }

  return results;
}

function stripHTML(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTextFromHTML(html: string): string {
  // Remove script and style blocks
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "");

  // Convert common block elements to newlines
  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<\/tr>/gi, "\n");

  // Strip remaining tags
  text = stripHTML(text);

  // Clean up whitespace
  text = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");

  return text;
}
