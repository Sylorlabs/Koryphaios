import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const list = JSON.parse(readFileSync(new URL('./stale-sources.json', import.meta.url), 'utf8'));
const concurrency = 6;

function title(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return null;
  return match[1].replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function textOf(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

async function probe(entry) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(entry.url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) koryphaios-source-verifier/1.0',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    const contentType = response.headers.get('content-type') ?? '';
    const body = await response.text();
    const bytes = Buffer.from(body, 'utf8');
    const plain = textOf(body);
    return {
      skill: entry.skill,
      url: entry.url,
      status: response.status,
      finalUrl: response.url,
      redirected: response.url !== entry.url,
      contentType,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      title: title(body),
      textChars: plain.length,
      elapsedMs: Date.now() - started,
      excerpt: plain.slice(0, 300),
    };
  } catch (error) {
    return {
      skill: entry.skill,
      url: entry.url,
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

const results = [];
let cursor = 0;
async function worker() {
  while (cursor < list.length) {
    const entry = list[cursor++];
    const result = await probe(entry);
    results.push({ ...entry, probe: result });
    console.error(
      `${result.status ?? 'ERR'} ${entry.skill} ${entry.url}${result.redirected ? ' -> ' + result.finalUrl : ''}`,
    );
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
results.sort((a, b) => (a.skill + a.url).localeCompare(b.skill + b.url));
writeFileSync(new URL('./stale-probe.json', import.meta.url), JSON.stringify(results, null, 2) + '\n');
const ok = results.filter((r) => r.probe.status === 200 && !r.probe.redirected).length;
console.log(
  JSON.stringify(
    {
      probed: results.length,
      ok200NoRedirect: ok,
      redirected: results.filter((r) => r.probe.redirected).length,
      notFound: results.filter((r) => r.probe.status === 404).length,
      errors: results.filter((r) => r.probe.error).length,
      other: results.filter((r) => r.probe.status && r.probe.status !== 200 && r.probe.status !== 404).map((r) => `${r.probe.status} ${r.url}`),
    },
    null,
    2,
  ),
);
