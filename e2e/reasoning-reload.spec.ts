import { test, expect } from '@playwright/test';
import { createAuthSession } from './helpers/auth';
import { ApiClient } from './helpers/api';
import { E2E_BACKEND_URL as BACKEND_URL } from './helpers/urls';
import { moveAndReadDbPath } from './helpers/db-path';

const PERSISTED_ERROR_TEXT =
  'Provider failed while generating this response. This error must survive reload.';

/**
 * Reasoning-trace and error retention across app relaunch.
 *
 * Every reasoning chunk is broadcast as a `stream.thinking` WebSocket
 * event and durably persisted in `ordered_session_events`. On reload the
 * client replays those events from the SQLite log. This test seeds a
 * session with rich thinking events, loads the real UI, reloads it, and
 * asserts the reasoning trace is still visible.
 */
test('reasoning traces and errors survive a full app reload', async ({ page, request }) => {
  test.setTimeout(120_000);

  const auth = await createAuthSession(request, BACKEND_URL);
  const api = new ApiClient(request, BACKEND_URL, auth.bearerToken);

  // Real session via the API.
  const sessionId = await api.createSession('Reasoning persistence E2E');
  const messageHistoryPath = `/api/messages/${sessionId}`;
  let countReloadHistoryRequests = false;
  let reloadHistoryRequestCount = 0;
  page.on('request', (outgoing) => {
    if (
      countReloadHistoryRequests &&
      outgoing.method() === 'GET' &&
      new URL(outgoing.url()).pathname === messageHistoryPath
    ) {
      reloadHistoryRequestCount++;
    }
  });

  // Resolve the live Playwright DB path BEFORE opening it from a side
  // process so the test fails fast if the webServer didn't actually start.
  const dbPath = await moveAndReadDbPath();
  console.log('E2E reasoning-reload: DB at', dbPath);

  // The history API loads the persisted `messages` table and walks the
  // session's `active_message_id` chain. We seed that chain directly via
  // SQL because the public `POST /api/messages/` triggers an agent run
  // (which we don't want for a pure history test) and there's no other
  // admin endpoint that just inserts rows.
  await seedMessageLineage(dbPath, sessionId);

  // Seed thinking events directly into the ordered-event-log. The
  // connection is closed before the page makes any HTTP request so the
  // SQLite WAL checkpoint never collides with the backend's live
  // connection.
  await seedOrderedThinking(dbPath, sessionId);

  // Auth token must survive reload — install it via addInitScript
  // before the first navigation, then the same script runs on reload.
  await page.addInitScript((token) => {
    localStorage.setItem('koryphaios-local-auth-token', token);
  }, auth.bearerToken);
  await page.goto('/');
  await expect(page.locator('#main-content')).not.toBeEmpty({ timeout: 40_000 });

  // Click into the seeded session. The sidebar card uses a transparent
  // overlay button (aria-label "Open session …") to capture the click;
  // clicking the visible title text bypasses the handler and leaves the
  // active session unchanged.
  const openSeeded = page.getByRole('button', {
    name: 'Open session Reasoning persistence E2E',
  });
  await expect(openSeeded).toBeVisible({ timeout: 15_000 });
  // Wait until the first selection load has actually finished before enabling
  // reload accounting. `click()` can resolve while Svelte's queued effect is
  // only beginning its fetch; counting from that point made the pre-reload GET
  // race into the reload window and produced a false duplicate.
  const initialHistory = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname === messageHistoryPath,
  );
  await openSeeded.click();
  await initialHistory;

  // Reload the whole app — the situation that previously lost
  // reasoning. After reload the WS subscription replays the
  // ordered-event-log rows and the history API returns the seeded turn;
  // both arrive in parallel.
  reloadHistoryRequestCount = 0;
  countReloadHistoryRequests = true;
  await page.reload();
  await expect(page.locator('#main-content')).not.toBeEmpty({ timeout: 40_000 });

  // Re-select the seeded session after reload so the feed-store
  // activates it. The active session is persisted in localStorage by the
  // app, but seed timing can race the first activation.
  const reopenSeeded = page.getByRole('button', {
    name: 'Open session Reasoning persistence E2E',
  });
  await expect(reopenSeeded).toBeVisible({ timeout: 15_000 });
  await reopenSeeded.click();

  // The persisted thinking block renders a collapsed "Thought for Xs"
  // row; expanded, it shows the full text. The block exists when the
  // page has merged the WS-replayed `stream.thinking` events into the
  // feed. We poll because the replay arrives a few ticks after the page
  // becomes interactive and the click selects the seeded session.
  await expect
    .poll(
      async () => {
        const visible = await page.locator('.thinking-row').count();
        const assistantRows = await page.locator('.feed-assistant-message').count();
        const messageCount = await page
          .locator('button[aria-label*="Reasoning persistence E2E"]')
          .count();
        console.log(
          `  poll: thinking=${visible} assistant=${assistantRows} seededCard=${messageCount}`,
        );
        return visible;
      },
      { timeout: 30_000, intervals: [500, 1_000, 2_000] },
    )
    .toBeGreaterThan(0);

  const durableErrorCard = page
    .locator('section')
    .filter({ hasText: PERSISTED_ERROR_TEXT })
    .first();
  await expect(durableErrorCard).toContainText('System error', { timeout: 10_000 });
  await expect(durableErrorCard).toContainText(PERSISTED_ERROR_TEXT);

  const thoughtRow = page.locator('.thinking-row').first();
  const thoughtText = page.locator('.thinking-full-text').first();
  await thoughtRow.click();
  await expect(thoughtText).toBeVisible({ timeout: 10_000 });
  const text = (await thoughtText.textContent()) ?? '';
  console.log('E2E reasoning-reload: expanded thinking text =', text.slice(0, 120));
  expect(text).toContain('deeply before answering');

  // Replayed terminal statuses are historical transcript evidence. They must
  // not each trigger another history refresh after the one activation load.
  expect(
    reloadHistoryRequestCount,
    'relaunch should load seeded message history once, not once per replayed terminal status',
  ).toBe(1);
});

/**
 * Seed `ordered_session_events` with thinking, answer, terminal-status, and
 * error events for a session. We do NOT bump the cursor until every row is
 * present; afterward `next_sequence` must be exactly one past the final seed
 * or the backend will believe there is nothing to replay.
 */
async function seedOrderedThinking(dbPath: string, sessionId: string): Promise<void> {
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    const now = Date.now();
    db.prepare(
      `INSERT OR IGNORE INTO session_event_cursors(session_id, epoch, next_sequence, updated_at)
       VALUES (?, 1, 1, ?)`,
    ).run(sessionId, now);

    const thinkingParts = [
      'Let me think about this problem',
      ' deeply before answering.',
      ' I need to consider the architecture carefully.',
      ' There is a subtle tradeoff here.',
    ];
    let seq = 1;
    for (const part of thinkingParts) {
      db.prepare(
        `INSERT INTO ordered_session_events(
           event_id, session_id, epoch, sequence, timestamp, type, agent_id,
           parent_sequence, payload, dispatched, created_at)
         VALUES (?, ?, 1, ?, ?, 'stream.thinking', 'kory-manager', NULL, ?, 0, ?)`,
      ).run(
        `seed-think-${sessionId}-${seq}`,
        sessionId,
        seq,
        now,
        JSON.stringify({ agentId: 'kory-manager', thinking: part }),
        now,
      );
      seq++;
    }
    db.prepare(
      `INSERT INTO ordered_session_events(
         event_id, session_id, epoch, sequence, timestamp, type, agent_id,
         parent_sequence, payload, dispatched, created_at)
       VALUES (?, ?, 1, ?, ?, 'stream.delta', 'kory-manager', NULL, ?, 0, ?)`,
    ).run(
      `seed-delta-${sessionId}`,
      sessionId,
      seq,
      now + 300,
      JSON.stringify({ agentId: 'kory-manager', content: 'Final answer.' }),
      now + 300,
    );
    seq++;

    for (const [index, status] of ['done', 'idle'].entries()) {
      db.prepare(
        `INSERT INTO ordered_session_events(
           event_id, session_id, epoch, sequence, timestamp, type, agent_id,
           parent_sequence, payload, dispatched, created_at)
         VALUES (?, ?, 1, ?, ?, 'agent.status', 'kory-manager', NULL, ?, 0, ?)`,
      ).run(
        `seed-terminal-${sessionId}-${status}`,
        sessionId,
        seq,
        now + 325 + index,
        JSON.stringify({ agentId: 'kory-manager', status }),
        now + 325 + index,
      );
      seq++;
    }

    db.prepare(
      `INSERT INTO ordered_session_events(
         event_id, session_id, epoch, sequence, timestamp, type, agent_id,
         parent_sequence, payload, dispatched, created_at)
       VALUES (?, ?, 1, ?, ?, 'system.error', 'kory-manager', NULL, ?, 0, ?)`,
    ).run(
      `seed-error-${sessionId}`,
      sessionId,
      seq,
      now + 400,
      JSON.stringify({ error: PERSISTED_ERROR_TEXT }),
      now + 400,
    );
    seq++;

    db.prepare(
      `UPDATE session_event_cursors
       SET next_sequence = ?, updated_at = ?
       WHERE session_id = ?`,
    ).run(seq, now + 400, sessionId);
  } finally {
    db.close();
  }
}

/**
 * Seed the `messages` table with a user→assistant pair so the history
 * API has a real turn to return. The session's `active_message_id` is
 * updated to the assistant message so the `active_lineage` CTE walks
 * the new chain from root to leaf.
 */
async function seedMessageLineage(dbPath: string, sessionId: string): Promise<void> {
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    const now = Date.now();
    const userId = `seed-user-${sessionId}`;
    const asstId = `seed-asst-${sessionId}`;

    // Wipe any prior seed for this session so the test is rerunnable.
    db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sessionId);

    db.prepare(
      `INSERT INTO messages(id, session_id, role, content, model, provider,
         tokens_in, tokens_out, cost, created_at, variant_index,
         context_revision, parent_message_id)
       VALUES (?, ?, 'user', ?, NULL, NULL, NULL, NULL, 0, ?, 0, 0, NULL)`,
    ).run(userId, sessionId, JSON.stringify([{ type: 'text', text: 'test' }]), now - 2000);

    db.prepare(
      `INSERT INTO messages(id, session_id, role, content, model, provider,
         tokens_in, tokens_out, cost, created_at, variant_index,
         context_revision, parent_message_id)
       VALUES (?, ?, 'assistant', ?, NULL, NULL, NULL, NULL, 0, ?, 0, 0, ?)`,
    ).run(
      asstId,
      sessionId,
      JSON.stringify([{ type: 'text', text: 'Final answer.' }]),
      now,
      userId,
    );

    // Update session counters so the sidebar / list view shows it as a
    // real turn, and point the lineage at the new assistant message.
    db.prepare(
      `UPDATE sessions
       SET message_count = COALESCE(message_count, 0) + 2,
           updated_at = ?,
           active_message_id = ?
       WHERE id = ?`,
    ).run(now, asstId, sessionId);
  } finally {
    db.close();
  }
}
