import { constants } from 'node:fs';
import { closeSync, fstatSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { chromium, type Browser, type BrowserContext } from 'playwright';

import { chromiumLaunchOptions } from './skill-eval-real-web-runtime';

/**
 * A candidate arm cannot launch Chromium inside the evaluation sandbox, so a
 * visual task that asks for measured render evidence is unsatisfiable unless the
 * evaluator offers a measurement channel. This broker is that channel: the
 * candidate writes a bounded request, the evaluator renders the candidate's own
 * source in real Chromium, and the response carries the measurement it asked
 * for. Nothing here scores anything; the independent scorer still decides.
 */

// Only the browser dashboard task needs the measurer. The native AppKit task is
// rendered by its own evaluator-owned capture tool, which candidates run directly.
export const VISUAL_BROWSER_SCENARIOS = new Set(['visual-verification-full-task-1']);

export function isVisualBrowserScenario(scenarioId: string): boolean {
  return VISUAL_BROWSER_SCENARIOS.has(scenarioId);
}

const MAX_REQUESTS = 12;
const MAX_CELLS = 24;
const REQUEST_FILE = 'visual-browser-request.json';
const RESPONSE_FILE = 'visual-browser-response.json';
const TIMEOUT_MS = 20_000;

export const VISUAL_BROKER_INSTRUCTIONS = [
  'This fixture has an evaluator-owned real Chromium measurer. You cannot launch a browser inside the sandbox, and you do not need to.',
  `Write ${REQUEST_FILE} under verification/ as JSON with a unique requestId and either "cells" (up to ${MAX_CELLS}) or a single "cell" object.`,
  'Example: {"requestId":"m1","cells":[{"theme":"light","state":"normal","width":1440,"height":900}]}',
  'Each cell object takes theme (light|dark), state (loading|empty|normal|dense), width and height. The response returns, for every cell, captureId, the five measured layout booleans, and the environment readings for that render.',
  `Wait for valid JSON in verification/${RESPONSE_FILE} with your requestId. A new requestId is required for every request; you have at most ${MAX_REQUESTS}.`,
  'Add "screenshot": true to a cell to have a JPEG written to verification/captures/<captureId>.jpg and its path returned.',
  'The response is measurement, not a verdict: decide from it what failed, and record only failures you actually measured.',
  'Mark verification artifacts as measured only for cells you requested. Report unmeasured cells as unverified.',
].join('\n');

interface CellRequest {
  theme?: string;
  state?: string;
  width?: number;
  height?: number;
  screenshot?: boolean;
}

interface BrokerRequest {
  requestId: string;
  cell?: CellRequest;
  cells?: CellRequest[];
}

function safeStaticFile(root: string, pathname: string): string | undefined {
  const decoded = decodeURIComponent(pathname);
  const target = normalize(join(root, decoded));
  const base = resolve(root);
  if (target !== base && !target.startsWith(base + sep)) return undefined;
  try {
    return statSync(target).isFile() ? target : undefined;
  } catch {
    return undefined;
  }
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

async function serveFixture<T>(root: string, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/favicon.ico') {
      response.writeHead(204, { 'cache-control': 'no-store' });
      response.end();
      return;
    }
    const file = safeStaticFile(root, url.pathname === '/' ? '/index.html' : url.pathname);
    if (!file) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(readFileSync(file));
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('visual broker fixture server did not bind a TCP port');
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}

const LAYOUT_EXPRESSION = `(() => {
  const header = document.querySelector('.topbar')?.getBoundingClientRect();
  const content = document.querySelector('.content')?.getBoundingClientRect();
  const chartPanel = document.querySelector('.chart-panel');
  const chart = document.querySelector('.chart');
  const legend = document.querySelector('.legend');
  const primary = document.querySelector('.primary-action');
  const secondary = document.querySelector('.secondary-action');
  const primaryStyle = primary ? getComputedStyle(primary) : null;
  const secondaryStyle = secondary ? getComputedStyle(secondary) : null;
  return {
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    chartClipped: !!chartPanel && !!chart && chart.scrollWidth > chartPanel.clientWidth + 1,
    legendClipped: !!legend && legend.scrollWidth > legend.clientWidth + 1,
    stickyOverlap: !!header && !!content && content.top < header.bottom - 1,
    primaryActionDistinct:
      !!primaryStyle &&
      !!secondaryStyle &&
      [primaryStyle.backgroundColor, primaryStyle.color, primaryStyle.borderColor].join('|') !==
        [secondaryStyle.backgroundColor, secondaryStyle.color, secondaryStyle.borderColor].join('|'),
  };
})()`;

async function measureCell(
  context: BrowserContext,
  base: string,
  root: string,
  cell: CellRequest,
): Promise<Record<string, unknown>> {
  const theme = cell.theme === 'dark' ? 'dark' : 'light';
  const state = ['loading', 'empty', 'normal', 'dense'].includes(cell.state ?? '')
    ? (cell.state as string)
    : 'normal';
  const width = Number.isFinite(cell.width) ? Math.trunc(cell.width as number) : 1440;
  const height = Number.isFinite(cell.height) ? Math.trunc(cell.height as number) : 900;
  const captureId = `${width}x${height}-${theme}-${state}`;
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width, height });
    await page.goto(`${base}/?theme=${theme}&state=${state}`, {
      waitUntil: 'load',
      timeout: TIMEOUT_MS,
    });
    await page.evaluate(() => document.fonts.ready);
    const layout = (await page.evaluate(LAYOUT_EXPRESSION)) as Record<string, boolean>;
    const environment = (await page.evaluate(() => ({
      dpr: window.devicePixelRatio,
      fontFamily: getComputedStyle(document.body).fontFamily,
      animations: document.getAnimations().length,
      dataset: document.body.innerText.includes('Dataset: fixture-v1'),
      browserVersion: navigator.userAgent,
    }))) as Record<string, unknown>;
    const row: Record<string, unknown> = { captureId, width, height, theme, state, ...layout, environment };
    if (cell.screenshot === true) {
      const relative = `verification/captures/${captureId}.jpg`;
      const absolute = join(root, relative);
      mkdirSync(join(root, 'verification/captures'), { recursive: true });
      await page.screenshot({ path: absolute, type: 'jpeg', quality: 80, animations: 'disabled' });
      row.screenshot = relative;
    }
    return row;
  } catch (error) {
    return {
      captureId,
      error: error instanceof Error ? error.message.slice(0, 300) : String(error),
    };
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function inspect(
  root: string,
  request: BrokerRequest,
  browser: Browser,
): Promise<Record<string, unknown>> {
  const requested = request.cell ? [request.cell] : (request.cells ?? []);
  if (!requested.length) return { requestId: request.requestId, status: 'error', error: 'no cells' };
  if (requested.length > MAX_CELLS)
    return { requestId: request.requestId, status: 'error', error: 'too many cells' };
  const result = await serveFixture(root, async (base) => {
    const context = await browser.newContext({
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
    });
    try {
      const rows: Array<Record<string, unknown>> = [];
      for (const cell of requested) rows.push(await measureCell(context, base, root, cell));
      return rows;
    } finally {
      await context.close().catch(() => undefined);
    }
  });
  return { requestId: request.requestId, status: 'ok', measured: result };
}

function writeResponse(fd: number, payload: Record<string, unknown>): void {
  const body = JSON.stringify(payload);
  const buffer = Buffer.from(body, 'utf8');
  writeFileSync(fd, buffer.subarray(0, 32_768));
}

function parseRequest(raw: string): BrokerRequest {
  const parsed = JSON.parse(raw) as BrokerRequest;
  if (!parsed || typeof parsed !== 'object') throw new Error('request must be an object');
  if (typeof parsed.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,48}$/u.test(parsed.requestId))
    throw new Error('requestId must be 1-48 characters of [a-zA-Z0-9_-]');
  const cells = parsed.cells ?? (parsed.cell ? [parsed.cell] : []);
  if (!Array.isArray(cells) || cells.length < 1) throw new Error('cells must be a non-empty array');
  for (const cell of cells) {
    if (!cell || typeof cell !== 'object') throw new Error('each cell must be an object');
    for (const key of ['width', 'height'] as const) {
      if (cell[key] !== undefined && !Number.isFinite(cell[key]))
        throw new Error(`cell.${key} must be a number`);
    }
  }
  return parsed;
}

export interface VisualBrowserBroker {
  close(): Promise<void>;
}

/** Fail before the candidate runs if the evaluator itself cannot open Chromium. */
export async function startVisualBrowserBroker(root: string): Promise<VisualBrowserBroker> {
  const directory = join(root, 'verification');
  // The broker owns its browser for the whole candidate run, so it must not take a
  // pooled lease: the pool closes an idle browser a few seconds after the last user
  // returns and every later request would fail with a protocol error.
  const browser = await chromium.launch({ ...chromiumLaunchOptions(), timeout: 30_000 });
  let requestFd: number | undefined;
  let responseFd: number | undefined;
  try {
    const flags =
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0);
    requestFd = openSync(join(directory, REQUEST_FILE), flags, 0o600);
    responseFd = openSync(join(directory, RESPONSE_FILE), flags, 0o600);
  } catch (error) {
    if (requestFd !== undefined) closeSync(requestFd);
    if (responseFd !== undefined) closeSync(responseFd);
    throw error;
  }
  const requestFile = requestFd;
  const responseFile = responseFd;
  let closed = false;
  let active: Promise<void> | undefined;
  let handled = 0;
  let lastId: string | undefined;
  let closeTask: Promise<void> | undefined;
  const poll = async () => {
    if (closed || active || handled >= MAX_REQUESTS) return;
    let raw: string;
    try {
      const stat = fstatSync(requestFile);
      if (!stat.isFile() || stat.size < 1 || stat.size > 16_384) return;
      const buffer = Buffer.alloc(stat.size);
      if (readSync(requestFile, buffer, 0, buffer.length, 0) !== buffer.length) return;
      raw = buffer.toString('utf8');
    } catch {
      return;
    }
    let request: BrokerRequest;
    try {
      request = parseRequest(raw);
    } catch (error) {
      let invalidId: string | undefined;
      try {
        const parsed = JSON.parse(raw) as { requestId?: unknown };
        if (typeof parsed?.requestId === 'string' && /^[a-zA-Z0-9_-]{1,48}$/u.test(parsed.requestId))
          invalidId = parsed.requestId;
      } catch {
        return;
      }
      if (invalidId && invalidId !== lastId) {
        lastId = invalidId;
        handled += 1;
        writeResponse(responseFile, {
          requestId: invalidId,
          status: 'error',
          error: error instanceof Error ? error.message : 'Invalid request',
        });
      }
      return;
    }
    if (request.requestId === lastId) return;
    lastId = request.requestId;
    handled += 1;
    active = (async () => {
      let result: Record<string, unknown>;
      try {
        result = await inspect(root, request, browser);
      } catch (error) {
        result = {
          requestId: request.requestId,
          status: 'error',
          error: error instanceof Error ? error.message.slice(0, 1_000) : String(error),
        };
      }
      if (!closed) writeResponse(responseFile, result);
    })().finally(() => {
      active = undefined;
    });
    await active;
  };
  const timer = setInterval(() => void poll(), 150);
  return {
    close: () =>
      (closeTask ??= (async () => {
        closed = true;
        clearInterval(timer);
        await active?.catch(() => undefined);
        await browser.close().catch(() => undefined);
        try {
          closeSync(requestFile);
        } finally {
          closeSync(responseFile);
        }
      })()),
  };
}
