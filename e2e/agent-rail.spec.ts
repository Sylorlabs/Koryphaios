import { test, expect } from '@playwright/test';
import { createAuthSession, injectAuthIntoPage } from './helpers/auth';
import { ApiClient } from './helpers/api';
import { E2E_BACKEND_URL as BACKEND_URL } from './helpers/urls';

/**
 * The sub-agent rail is a horizontal strip of one-row tiles. It only has a real
 * layout in a browser, so every geometry assertion here is measured against
 * getBoundingClientRect, never against the class list.
 *
 * Real sub-agents need a live provider, which e2e deliberately does not have.
 * The agent-threads response is intercepted instead, so the app's own
 * loadAgentThreads() populates its real store with synthetic agents. The
 * components, store, transitions and CSS are all real — only the agent data is
 * fabricated.
 */

interface SyntheticAgent {
  agent: {
    id: string;
    name: string;
    role: string;
    domain: string;
    model: string;
    provider: string;
    glowColor: string;
  };
  status: string;
  kind: string;
  updatedAt: number;
}

function threadsFor(names: Array<[string, string, string]>, statuses: string[]): SyntheticAgent[] {
  return names.map(([id, name, domain], i) => ({
    agent: {
      id,
      name,
      role: 'worker',
      domain,
      model: 'xiaomi/mimo-v2.6-pro',
      provider: 'commandcode',
      glowColor: 'rgba(255,215,0,0.6)',
    },
    status: statuses[i] ?? 'thinking',
    kind: 'worker',
    updatedAt: Date.now() - i * 1000,
  }));
}

/**
 * Loads the app with the rail expanded and `threads` returned for any
 * agent-thread request, then opens `sessionId` so the rail's sessionId filter
 * matches.
 */
async function openRail(
  page: import('@playwright/test').Page,
  threads: SyntheticAgent[],
  sessionId?: string,
): Promise<string> {
  const auth = await createAuthSession(page.request, BACKEND_URL);
  const api = new ApiClient(page.request, BACKEND_URL, auth.bearerToken);
  const id = sessionId ?? (await api.createSession('E2E rail layout'));

  // The rail is collapsed to a summary unless the layout prefs ask for it.
  await page.addInitScript(() => {
    localStorage.setItem(
      'koryphaios-layout-prefs',
      JSON.stringify({ showSidebar: false, showAgents: true, agentsDismissed: false }),
    );
  });

  await page.route('**/api/agent/threads/*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: threads }),
    });
  });

  await injectAuthIntoPage(page, auth.bearerToken);
  await page.goto('/');
  await expect(page.locator('#main-content')).not.toBeEmpty({ timeout: 30_000 });

  await page.evaluate(async (sid) => {
    const mod = await import('/src/lib/stores/sessions.svelte.ts');
    mod.sessionStore.activeSessionId = sid;
  }, id);

  await expect(page.locator('.agent-card').first()).toBeVisible({ timeout: 20_000 });

  // Opening a session triggers competing store writes: activateSessionFeed()
  // prunes agents while loadAgentThreads() repopulates them. Settle first so the
  // spec never races its own setup.
  await waitForStableRail(page);
  await page.waitForTimeout(400);

  return id;
}

/** Waits until the rendered tile set stops changing across two consecutive polls. */
async function waitForStableRail(page: import('@playwright/test').Page): Promise<void> {
  const signature = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.agent-card')]
        .map((c) => `${c.getAttribute('aria-label')}`)
        .join('|'),
    );

  let previous = await signature();
  for (let i = 0; i < 40; i += 1) {
    await page.waitForTimeout(250);
    const current = await signature();
    if (current === previous && current.length > 0) return;
    previous = current;
  }
}

/** Measured geometry for every tile in the rail. */
async function measureTiles(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll('.agent-card')];
    return {
      count: cards.length,
      boxes: cards.map((c) => {
        const r = c.getBoundingClientRect();
        return {
          name: c.textContent?.replace(/[^A-Za-z]/g, '') ?? '',
          width: Math.round(r.width),
          height: Math.round(r.height),
          top: Math.round(r.top),
          overflowing: c.scrollWidth > c.clientWidth + 1,
        };
      }),
      mainChat: (() => {
        const b = document.querySelector('button[aria-label="Main chat"]');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { text: b.textContent?.trim(), height: Math.round(r.height) };
      })(),
    };
  });
}

test.describe('sub-agent rail tile layout', () => {
  test('tiles are a single short row showing only name, status icon and close', async ({
    page,
  }) => {
    test.setTimeout(90_000);

    await openRail(
      page,
      threadsFor(
        [
          ['a1', 'Backend', 'backend'],
          ['a2', 'Frontend', 'ui'],
          ['a3', 'Tester', 'test'],
        ],
        ['thinking', 'tool_calling', 'searching'],
      ),
    );

    const m = await measureTiles(page);
    expect(m.count).toBe(3);

    // One fixed row — the regression this locks in is tiles growing back into
    // multi-line cards that push agents off-screen.
    for (const box of m.boxes) {
      expect(box.height, `${box.name} should be one 24px row`).toBe(24);
      expect(box.width, `${box.name} should stay a glanceable chip`).toBeLessThanOrEqual(220);
      expect(box.overflowing, `${box.name} content must not overflow its tile`).toBe(false);
    }
    expect(new Set(m.boxes.map((b) => b.top)).size).toBe(1);

    // Only the agent name — no provider, model, task, context or tool text.
    // Surrounding whitespace is inter-element spacing, not visible content.
    for (const name of ['Backend', 'Frontend', 'Tester']) {
      await expect(page.locator('.agent-card').filter({ hasText: name })).toHaveText(
        new RegExp(`^\\s*${name}\\s*$`),
      );
    }

    await expect(page.locator('.agent-card').first().getByRole('button')).toHaveCount(1);
  });

  test('main chat is a single label with no sub-lines', async ({ page }) => {
    test.setTimeout(90_000);

    await openRail(page, threadsFor([['c1', 'Backend', 'backend']], ['thinking']));

    const m = await measureTiles(page);
    expect(m.mainChat?.text).toBe('Main chat');
    expect(m.mainChat?.height).toBeLessThanOrEqual(32);
  });

  test('a long agent name truncates instead of widening the tile', async ({ page }) => {
    test.setTimeout(90_000);

    await openRail(
      page,
      threadsFor(
        [['d1', 'SecurityReviewerForTheEntireAuthenticationSubsystem', 'security']],
        ['thinking'],
      ),
    );

    const box = (await measureTiles(page)).boxes[0];
    expect(box.height).toBe(24);
    expect(box.width).toBeLessThanOrEqual(220);
    expect(box.overflowing).toBe(false);
  });

  test('many agents stay one row tall and wrap rather than growing downward', async ({ page }) => {
    test.setTimeout(90_000);

    const names = Array.from(
      { length: 12 },
      (_, i) => [`m${i}`, `Agent${i}`, 'backend'] as [string, string, string],
    );
    await openRail(
      page,
      threadsFor(
        names,
        names.map(() => 'thinking'),
      ),
    );

    const m = await measureTiles(page);
    expect(m.count).toBe(12);
    for (const box of m.boxes) expect(box.height).toBe(24);

    const rows = [...new Set(m.boxes.map((b) => b.top))].sort((a, b) => a - b);
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i] - rows[i - 1]).toBeGreaterThanOrEqual(24);
    }
  });
});

test.describe('sub-agent rail status reactivity', () => {
  /**
   * Regression guard for the stale-status bug: AgentState objects in the store's
   * Map are not reactive proxies, so updateAgentStatus() mutates `.status` in
   * place and republishes the Map. The keyed #each hands WorkerCard the *same*
   * object reference, which Svelte treats as an unchanged prop, so a $derived
   * reading `agent.status` never re-evaluated and the tile kept a stale icon and
   * a stale "Stop and close" label forever. The fix threads `status` in as a
   * primitive prop. This asserts the label actually flips.
   */
  test('a finished worker switches its control from Stop-and-close to Close', async ({ page }) => {
    test.setTimeout(90_000);

    await openRail(page, threadsFor([['e1', 'Worker', 'backend']], ['thinking']));

    await expect(
      page.getByRole('button', { name: 'Stop and close Worker', exact: true }),
    ).toBeVisible();

    await page.evaluate(async () => {
      const ws = await import('/src/lib/stores/websocket.svelte.ts');
      ws.agentStore.updateAgentStatus('e1', 'done');
    });

    await expect(page.getByRole('button', { name: 'Close Worker', exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByRole('button', { name: 'Stop and close Worker', exact: true }),
    ).toHaveCount(0);
  });

  /**
   * Regression guard for the pruning bug: clearNonManagerAgents() runs from
   * activateSessionFeed()/loadSessionMessages() on every chat switch and used to
   * keep only live agents. A worker that had already finished was therefore
   * deleted the moment you changed chats, so it could never be reviewed or
   * closed. It must now survive the switch.
   */
  test('a completed worker survives a chat switch and stays closable', async ({ page }) => {
    test.setTimeout(90_000);

    await openRail(
      page,
      threadsFor(
        [
          ['k1', 'Completed', 'backend'],
          ['k2', 'Running', 'backend'],
        ],
        ['done', 'thinking'],
      ),
    );

    // The switch is what used to erase it, so this asserts post-switch state.
    await expect(page.locator('.agent-card').filter({ hasText: 'Completed' })).toHaveCount(1, {
      timeout: 10_000,
    });
    await expect(page.getByRole('button', { name: 'Close Completed', exact: true })).toBeVisible();

    await page.locator('.agent-card').filter({ hasText: 'Completed' }).getByRole('button').click();
    await expect(page.locator('.agent-card').filter({ hasText: 'Completed' })).toHaveCount(0, {
      timeout: 10_000,
    });
  });
});

test.describe('sub-agent rail close', () => {
  test('closing a running worker cancels it on the backend and removes the tile', async ({
    page,
  }) => {
    test.setTimeout(90_000);

    const cancels: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/cancel')) cancels.push(`${r.method()} ${r.url()}`);
    });

    await openRail(page, threadsFor([['f1', 'Backend', 'backend']], ['thinking']));

    // The real backend has no worker f1, so answer the cancel locally and assert
    // on what the frontend actually asked for.
    await page.route('**/api/agent/*/cancel', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, message: 'Agent cancelled' }),
      });
    });

    await page.locator('.agent-card').filter({ hasText: 'Backend' }).getByRole('button').click();

    await expect(page.locator('.agent-card').filter({ hasText: 'Backend' })).toHaveCount(0, {
      timeout: 10_000,
    });

    expect(cancels, 'the X must issue exactly one cancel request').toHaveLength(1);
    expect(cancels[0]).toMatch(/^POST /);
    expect(new URL(cancels[0].split(' ')[1]).pathname).toBe('/api/agent/f1/cancel');

    // NOTE ON SCOPE: this cannot detect the original relative-URL bug. In a
    // browser the app is served from the Vite dev origin, which proxies /api to
    // the backend, so `apiUrl('/api/…')` and a bare relative '/api/…' resolve to
    // an identical request. The absolute-URL guarantee is asserted in
    // frontend/src/lib/components/shell/useAgentRail.test.ts, where apiUrl is
    // mocked. What matters here is that the click reaches the cancel endpoint
    // and the tile is removed.
  });

  test('closing a finished worker does not call the backend at all', async ({ page }) => {
    test.setTimeout(90_000);

    const cancels: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/cancel')) cancels.push(r.url());
    });

    await openRail(page, threadsFor([['g1', 'Finished', 'backend']], ['done']));

    await page.locator('.agent-card').filter({ hasText: 'Finished' }).getByRole('button').click();

    await expect(page.locator('.agent-card').filter({ hasText: 'Finished' })).toHaveCount(0, {
      timeout: 10_000,
    });
    expect(cancels, 'a terminal agent needs no cancel request').toHaveLength(0);
  });

  test('a failed cancel keeps the tile so live work stays visible', async ({ page }) => {
    test.setTimeout(90_000);

    await openRail(page, threadsFor([['h1', 'Backend', 'backend']], ['thinking']));

    await page.route('**/api/agent/*/cancel', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: 'worker is not cancellable' }),
      });
    });

    await page.locator('.agent-card').filter({ hasText: 'Backend' }).getByRole('button').click();

    // Dropping a tile whose worker is still live would hide running work.
    await expect(page.locator('.agent-card').filter({ hasText: 'Backend' })).toBeVisible({
      timeout: 10_000,
    });
  });
});
