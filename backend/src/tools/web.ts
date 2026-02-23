// Web search and fetch tools.
// WebSearchTool uses DuckDuckGo HTML (no API key required).
// WebFetchTool fetches URLs with SSRF protection — validates each hop before following redirects.

import { validateUrl } from "../security";
import type { Tool, ToolCallInput, ToolContext, ToolCallOutput } from "./registry";

const MAX_REDIRECTS = 5;
const DEFAULT_MAX_LENGTH = 10_000;
const USER_AGENT = "Koryphaios/1.0 (AI Agent; +https://github.com/micahcooley/Koryphaios)";

// ─── Web Search ──────────────────────────────────────────────────────────────

/** Web search using DuckDuckGo HTML (no API key required). */
export class WebSearchTool implements Tool {
  readonly name = "web_search";
  readonly role = "worker" as const; // manager + worker only (not critic)
  readonly description =
    "Search the web for current information. Returns snippets from search results. Use this liberally — agents perform better when they can verify information.";

  readonly inputSchema = {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "The search query." },
      maxResults: { type: "number", description: "Max results to return (default: 5, max: 10)." },
    },
    required: ["query"],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const query = call.input.query as string;
    const maxResults = Math.min((call.input.maxResults as number) || 5, 10);

    if (!query || typeof query !== "string" || query.trim().length === 0) {
      return { callId: call.id, name: this.name, output: "Error: query must be a non-empty string.", isError: true, durationMs: 0 };
    }

    try {
      const encoded = encodeURIComponent(query.trim());
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encoded}`;

      const resp = await fetch(searchUrl, {
        headers: { "User-Agent": USER_AGENT },
        signal: ctx.signal,
        redirect: "follow",
      });

      if (!resp.ok) {
        return { callId: call.id, name: this.name, output: `Search failed: HTTP ${resp.status}`, isError: true, durationMs: 0 };
      }

      const html = await resp.text();
      const results = parseSearchResults(html, maxResults);

      if (results.length === 0) {
        return { callId: call.id, name: this.name, output: `No results found for: ${query}`, isError: false, durationMs: 0 };
      }

      const output = results
        .map((r, i) => `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.snippet}`)
        .join("\n\n");

      return {
        callId: call.id,
        name: this.name,
        output: `Search results for "${query}":\n\n${output}`,
        isError: false,
        durationMs: 0,
      };
    } catch (err: any) {
      return { callId: call.id, name: this.name, output: `Search error: ${err.message}`, isError: true, durationMs: 0 };
    }
  }
}

// ─── Web Fetch ───────────────────────────────────────────────────────────────

/**
 * Fetch a URL and extract readable text content.
 *
 * Security: validates the URL and every redirect hop against the SSRF blocklist
 * before following. Uses manual redirect handling (redirect: "manual") so we
 * can inspect each Location header before following it.
 */
export class WebFetchTool implements Tool {
  readonly name = "web_fetch";
  readonly role = "worker" as const;
  readonly description =
    "Fetch a URL and extract readable text content. Good for reading documentation, API references, or any web page. Blocked for private/internal network addresses.";

  readonly inputSchema = {
    type: "object" as const,
    properties: {
      url: { type: "string", description: "The URL to fetch. Must be a public http/https URL." },
      maxLength: { type: "number", description: `Max characters to return (default: ${DEFAULT_MAX_LENGTH}).` },
    },
    required: ["url"],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const url = call.input.url as string;
    const maxLength = (call.input.maxLength as number) || DEFAULT_MAX_LENGTH;

    if (!url || typeof url !== "string") {
      return { callId: call.id, name: this.name, output: "Error: url must be a non-empty string.", isError: true, durationMs: 0 };
    }

    // Validate the initial URL before any network activity
    const initialCheck = await validateUrl(url);
    if (!initialCheck.safe) {
      return {
        callId: call.id,
        name: this.name,
        output: `Blocked: ${initialCheck.reason}`,
        isError: true,
        durationMs: 0,
      };
    }

    try {
      const text = await this.fetchWithSafeRedirects(url, ctx.signal);
      const contentType = ""; // determined inside fetchWithSafeRedirects

      let output: string;
      if (text.trimStart().startsWith("{") || text.trimStart().startsWith("[")) {
        // Likely JSON
        output = text.slice(0, maxLength);
      } else if (/<html/i.test(text.slice(0, 200))) {
        output = extractTextFromHTML(text).slice(0, maxLength);
      } else {
        output = text.slice(0, maxLength);
      }

      return {
        callId: call.id,
        name: this.name,
        output: `Content from ${url}:\n\n${output}`,
        isError: false,
        durationMs: 0,
      };
    } catch (err: any) {
      return { callId: call.id, name: this.name, output: `Fetch error: ${err.message}`, isError: true, durationMs: 0 };
    }
  }

  /**
   * Fetch a URL following redirects manually, validating each hop for SSRF safety.
   */
  private async fetchWithSafeRedirects(url: string, signal?: AbortSignal): Promise<string> {
    let currentUrl = url;
    let hops = 0;

    while (hops < MAX_REDIRECTS) {
      const resp = await fetch(currentUrl, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html, application/json, text/plain, */*",
        },
        signal,
        redirect: "manual", // Never auto-follow — we validate each hop
      });

      // Handle redirects
      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get("location");
        if (!location) {
          throw new Error(`Redirect response (${resp.status}) missing Location header`);
        }

        // Resolve relative redirects against the current URL
        const nextUrl = new URL(location, currentUrl).toString();

        // Validate the redirect destination before following
        const check = await validateUrl(nextUrl);
        if (!check.safe) {
          throw new Error(`Redirect blocked: ${check.reason}`);
        }

        currentUrl = nextUrl;
        hops++;
        continue;
      }

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      }

      return await resp.text();
    }

    throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
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

  // DuckDuckGo HTML search results use class="result__body" as block separators
  const resultBlocks = html.split('class="result__body"');

  for (let i = 1; i < resultBlocks.length && results.length < max; i++) {
    const block = resultBlocks[i];

    // Extract title and URL from anchor
    const titleMatch = block.match(/class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/s);
    const snippetMatch = block.match(/class="result__snippet"[^>]*>(.*?)<\/(?:span|td)/s);

    if (titleMatch) {
      let url = titleMatch[1];
      // DuckDuckGo wraps URLs in a redirect — extract the actual destination
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
  // Remove non-content blocks
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "");

  // Convert block elements to newlines for readability
  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<\/tr>/gi, "\n");

  // Strip remaining tags and decode entities
  text = stripHTML(text);

  // Normalize whitespace
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}
