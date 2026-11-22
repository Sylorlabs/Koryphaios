import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const DECISIONS = {
  verify: 'verify',
  replace: 'replace',
};

// Explicit decision table. Nothing is refreshed implicitly.
const REWRITES = {
  'https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-cloud-providers':
    'https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-cloud-providers',
  'https://freertos.org/RTOS_Task_Notification_As_Event_Group.html':
    'https://freertos.org/Documentation/02-Kernel/02-Kernel-features/03-Direct-to-task-notifications/04-As-event-group',
  'https://docs.stripe.com/webhooks/signature': 'https://docs.stripe.com/events/manage-webhook-endpoints',
  'https://docs.swift.org/swift-book/documentation/the-swift-programming-language/automaticreferencecounting/':
    'https://docs.swift.org/latest/documentation/the-swift-programming-language/automaticreferencecounting/',
  'https://docs.swift.org/swift-book/documentation/the-swift-programming-language/concurrency/':
    'https://docs.swift.org/latest/documentation/the-swift-programming-language/concurrency/',
  'https://www.php.net/manual/en/language.exceptions.php':
    'https://www.php.net/manual/en/control-structures.finally.php',
};

// The Android page only negotiates a locale prefix; the canonical URL is stable.
const KEEP_ORIGINAL = new Set(['https://developer.android.com/guide/topics/ui/accessibility/testing']);

// Not retrievable by an automated client (bot protection). Left unverified.
const UNVERIFIABLE = new Set(['https://openai.com/index/trustworthy-third-party-evaluations-foundations/']);

const STOP = new Set(
  'the a an and or of for to in on with by is are be this that current documentation docs page section guide official inspected checked scope use notes source target specific version reference as available adopted verify verified'.split(
    ' ',
  ),
);

const list = JSON.parse(readFileSync(new URL('./stale-sources.json', import.meta.url), 'utf8'));

function plainText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function keywords(entry) {
  const raw = `${entry.versionScope} ${entry.notes}`.toLowerCase();
  const words = raw.match(/[a-z][a-z0-9.+#-]{3,}/g) ?? [];
  return [...new Set(words)].filter((word) => !STOP.has(word) && !/^20\d\d$/.test(word));
}

async function verify(entry) {
  const target = REWRITES[entry.url] ?? entry.url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(target, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    const body = await response.text();
    const text = plainText(body).toLowerCase();
    const candidates = keywords(entry);
    const hits = candidates.filter((word) => text.includes(word));
    const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return {
      skill: entry.skill,
      originalUrl: entry.url,
      checkedUrl: target,
      finalUrl: response.url,
      rewrote: target !== entry.url,
      status: response.status,
      bytes: Buffer.byteLength(body, 'utf8'),
      sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
      title: titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim().slice(0, 200) : null,
      keywordCandidates: candidates.length,
      keywordHits: hits.length,
      keywordCoverage: candidates.length ? Number((hits.length / candidates.length).toFixed(3)) : 0,
      missingKeywords: candidates.filter((word) => !text.includes(word)).slice(0, 12),
      verifiedAt: new Date().toISOString().slice(0, 10),
    };
  } catch (error) {
    return {
      skill: entry.skill,
      originalUrl: entry.url,
      checkedUrl: target,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

const queue = list.filter(
  (entry) => !UNVERIFIABLE.has(entry.url) && !KEEP_ORIGINAL.has(entry.url),
);
const keep = list.filter((entry) => KEEP_ORIGINAL.has(entry.url) || UNVERIFIABLE.has(entry.url));

const results = [];
let cursor = 0;
async function worker() {
  while (cursor < queue.length) {
    const entry = queue[cursor++];
    const result = await verify(entry);
    results.push(result);
    console.error(
      `${result.status ?? 'ERR'} cov=${result.keywordCoverage ?? '-'} ${entry.skill} ${(result.title ?? '').slice(0, 60)}`,
    );
  }
}
await Promise.all(Array.from({ length: 5 }, worker));
results.sort((a, b) => (a.skill + a.originalUrl).localeCompare(b.skill + b.originalUrl));
writeFileSync(new URL('./source-verification.json', import.meta.url), JSON.stringify(results, null, 2) + '\n');

const accepted = results.filter(
  (r) => r.status === 200 && r.keywordCoverage >= 0.4 && !/not found|404/i.test(r.title ?? ''),
);
const lowCoverage = results.filter((r) => r.status === 200 && r.keywordCoverage < 0.4);
const failed = results.filter((r) => r.status !== 200);
console.log(
  JSON.stringify(
    {
      candidates: results.length,
      accepted: accepted.length,
      lowCoverage: lowCoverage.map((r) => `${r.skill} cov=${r.keywordCoverage} ${r.checkedUrl}`),
      failed: failed.map((r) => `${r.skill} ${r.status ?? r.error} ${r.checkedUrl}`),
      skipped: keep.map((r) => `${r.skill} ${r.url}`),
    },
    null,
    2,
  ),
);
