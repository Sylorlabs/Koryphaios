import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { isWindows } from '../../runtime/platform';
import {
  isReactBrowserScenario,
  startReactBrowserBroker,
  type ReactBrowserBroker,
} from '../../eval/skills/skill-eval-react-browser-broker';
import { reactBrowserReadiness } from '../../eval/skills/skill-eval-react-browser-fixtures';
import { chromiumLaunchOptions } from '../../eval/skills/skill-eval-real-web-runtime';
import { browserControlTest } from './browser-runtime-test-policy';

const roots: string[] = [];
const brokers: ReactBrowserBroker[] = [];
const browserTest = browserControlTest('React inspector', reactBrowserReadiness());
const launchMocks: Array<{ mockRestore(): void }> = [];

afterEach(async () => {
  for (const broker of brokers.splice(0)) await broker.close();
  for (const launch of launchMocks.splice(0)) launch.mockRestore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// These doubles exercise only rejection/transport paths, never rendered evidence.
function mockBrowserLaunch() {
  const newContext = mock(() => { throw new Error('Unit test must not inspect a browser'); });
  launchMocks.push(spyOn(chromium, 'launch').mockResolvedValue({
    close: async () => {}, newContext,
  } as unknown as Browser));
  return newContext;
}

const REACT_FIXTURE = [
  "import React, { useEffect, useState } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  'function App() {',
  '  const [count, setCount] = useState(0);',
  "  const [text, setText] = useState('');",
  "  const [outbound, setOutbound] = useState('pending');",
  '  useEffect(() => {',
  "    fetch('https://example.com/private-attempt')",
  "      .then(() => setOutbound('network-open'))",
  "      .catch(() => setOutbound('blocked'));",
  '  }, []);',
  '  return <main>',
  '    <button id="increment" onClick={() => setCount((n) => n + 1)}>Add</button>',
  '    <p id="count">{count}</p>',
  '    <label htmlFor="draft">Draft</label>',
  '    <input id="draft" value={text} onChange={(e) => setText(e.target.value)} />',
  '    <p id="network">{outbound}</p>',
  '    <p id="rtc">{typeof RTCPeerConnection}</p>',
  '    <p id="transport">{typeof WebTransport}</p>',
  '  </main>;',
  '}',
  "createRoot(document.getElementById('root')).render(<App />);",
].join('\n');

function fixture(source = REACT_FIXTURE): string {
  const root = mkdtempSync(join(tmpdir(), 'kory-react-browser-broker-test-'));
  roots.push(root);
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'verification'));
  writeFileSync(join(root, 'src', 'main.jsx'), source);
  writeFileSync(join(root, 'design.css'), 'body{font:16px system-ui}');
  return root;
}

async function respond(root: string, request: { requestId: string; actions: unknown[] }) {
  writeFileSync(join(root, 'verification', 'react-browser-request.json'), JSON.stringify(request));
  const path = join(root, 'verification', 'react-browser-response.json');
  const start = Date.now();
  while (Date.now() - start < 35_000) {
    if (existsSync(path)) {
      // Pinned response descriptors prevent path redirects; retry during rewrites.
      let result: Record<string, unknown>;
      try {
        result = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        await Bun.sleep(100);
        continue;
      }
      if (result.requestId === request.requestId)
        return result as {
          requestId: string;
          status: string;
          browser?: string;
          scoring?: string;
          observations?: { type: string; value: unknown }[];
          pageErrors?: string[];
          error?: string;
        };
    }
    await Bun.sleep(100);
  }
  throw new Error('React browser broker did not reply in 35 seconds');
}

test('only the two declared React evaluation scenarios can use the broker', () => {
  expect(isReactBrowserScenario('react-engineering-full-task-1-individual')).toBe(true);
  expect(isReactBrowserScenario('react-engineering-full-task-2-individual')).toBe(true);
  expect(isReactBrowserScenario('svelte-engineering-full-task-1-individual')).toBe(false);
  expect(isReactBrowserScenario('react-engineering-full-task-control')).toBe(false);
});

test('a Playwright launch timeout retries once and closes the successful browser', async () => {
  const root = fixture();
  const close = mock(async () => {});
  const launch = spyOn(chromium, 'launch')
    .mockRejectedValueOnce(new Error('browserType.launch: Timeout 20000ms exceeded.'))
    .mockResolvedValueOnce({ close } as unknown as Browser);
  try {
    const broker = await startReactBrowserBroker(root);
    brokers.push(broker);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(launch.mock.calls[0]?.[0]).toMatchObject({
      ...chromiumLaunchOptions(),
      chromiumSandbox: true,
      timeout: 20_000,
    });
    expect(readFileSync(join(root, 'verification', 'react-browser-response.json'), 'utf8')).toBe(
      '',
    );
    await broker.close();
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    launch.mockRestore();
  }
});

test('a broken Chromium write pipe retries once without weakening launch options', async () => {
  const root = fixture();
  const close = mock(async () => {});
  const launch = spyOn(chromium, 'launch')
    .mockRejectedValueOnce(new Error('Could not write into pipe'))
    .mockResolvedValueOnce({ close } as unknown as Browser);
  try {
    brokers.push(await startReactBrowserBroker(root));
    expect(launch).toHaveBeenCalledTimes(2);
    expect(launch.mock.calls[1]?.[0]).toEqual(launch.mock.calls[0]?.[0]);
  } finally {
    launch.mockRestore();
  }
});

test('two failed Chromium launches fail setup with evidence and no browser response', async () => {
  const root = fixture();
  const launch = spyOn(chromium, 'launch')
    .mockRejectedValueOnce(new Error('browserType.launch: Timeout 20000ms exceeded.'))
    .mockRejectedValueOnce(new Error('Could not write into pipe'));
  try {
    await expect(startReactBrowserBroker(root)).rejects.toThrow(
      /failed both launch attempts:.*Timeout 20000ms exceeded.*Could not write into pipe/u,
    );
    expect(launch).toHaveBeenCalledTimes(2);
    expect(existsSync(join(root, 'verification', 'react-browser-response.json'))).toBe(false);
  } finally {
    launch.mockRestore();
  }
});

test('an unsettled launch fails closed and disposes of a browser that arrives late', async () => {
  const root = fixture();
  const close = mock(async () => {});
  let finishLaunch!: (browser: Browser) => void;
  const launch = spyOn(chromium, 'launch').mockImplementation(
    () =>
      new Promise<Browser>((resolve) => {
        finishLaunch = resolve;
      }),
  );
  try {
    await expect(startReactBrowserBroker(root)).rejects.toThrow(
      'Chromium inspector launch stalled after 25000ms',
    );
    expect(launch).toHaveBeenCalledTimes(1);
    expect(existsSync(join(root, 'verification', 'react-browser-response.json'))).toBe(false);
    finishLaunch({ close } as unknown as Browser);
    await Bun.sleep(100);
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    launch.mockRestore();
  }
}, 30_000);

test('disconnected Chromium during teardown does not make broker.close fail', async () => {
  const root = fixture();
  const close = mock(async () => {
    throw new Error('Connection terminated while reading from pipe');
  });
  const launch = spyOn(chromium, 'launch').mockResolvedValue({ close } as unknown as Browser);
  const warning = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const broker = await startReactBrowserBroker(root);
    brokers.push(broker);
    await broker.close();
    await broker.close();
    expect(close).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      'React browser inspector Chromium cleanup failed:',
      expect.any(Error),
    );
    expect(readFileSync(join(root, 'verification', 'react-browser-response.json'), 'utf8')).toBe(
      '',
    );
  } finally {
    warning.mockRestore();
    launch.mockRestore();
  }
});

test('stalled Chromium shutdown leaves an unfinished inspection unverified', async () => {
  const root = fixture();
  const close = mock(() => new Promise<void>(() => {}));
  let inspectStarted!: () => void;
  const inspecting = new Promise<void>((resolve) => {
    inspectStarted = resolve;
  });
  let failInspection!: (error: Error) => void;
  const pendingInspection = new Promise<never>((_, reject) => {
    failInspection = reject;
  });
  const inspect = mock(() => {
    inspectStarted();
    return pendingInspection;
  });
  const launch = spyOn(chromium, 'launch').mockResolvedValue({
    close,
  } as unknown as Browser);
  const warning = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const broker = await startReactBrowserBroker(root, inspect);
    brokers.push(broker);
    writeFileSync(
      join(root, 'verification', 'react-browser-request.json'),
      JSON.stringify({ requestId: 'unfinished', actions: [{ type: 'text', selector: '#count' }] }),
    );
    await Promise.race([
      inspecting,
      Bun.sleep(8_000).then(() => {
        throw new Error('Browser inspection did not start');
      }),
    ]);
    await broker.close();
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith('React browser inspector cleanup timed out after 15000ms');
    expect(readFileSync(join(root, 'verification', 'react-browser-response.json'), 'utf8')).toBe(
      '',
    );
    failInspection(new Error('Chromium pipe disconnected during inspection'));
    await Bun.sleep(100);
    expect(readFileSync(join(root, 'verification', 'react-browser-response.json'), 'utf8')).toBe(
      '',
    );
  } finally {
    warning.mockRestore();
    launch.mockRestore();
  }
}, 30_000);

browserTest('trusted Chromium actually renders React and returns DOM, focus, route, and blocked network observations', async () => {
  const root = fixture();
  brokers.push(await startReactBrowserBroker(root));
  const result = await respond(root, {
    requestId: 'rendered-1',
    actions: [
      { type: 'wait', selector: '#increment' },
      { type: 'click', selector: '#increment' },
      { type: 'text', selector: '#count' },
      { type: 'fill', selector: '#draft', value: 'edited in Chromium' },
      { type: 'value', selector: '#draft' },
      { type: 'focused', selector: '#draft' },
      { type: 'wait', selector: '#network' },
      { type: 'pause', ms: 200 },
      { type: 'text', selector: '#network' },
      { type: 'navigate', path: '/?q=route' },
      { type: 'url' },
      { type: 'text', selector: '#rtc' },
      { type: 'text', selector: '#transport' },
      { type: 'layout' },
      { type: 'metrics', source: 'search' },
    ],
  });
  if (result.status !== 'ok') console.error(result.error);
  expect(result.status).toBe('ok');
  expect(result.browser).toMatch(/^Chromium \d/u);
  expect(result.observations?.[2]?.value).toBe('1');
  expect(result.observations?.[4]?.value).toBe('edited in Chromium');
  expect(result.observations?.[5]?.value).toBe(true);
  expect(result.observations?.[8]?.value).toBe('blocked');
  expect(result.observations?.[10]?.value).toContain('/?q=route');
  expect(result.observations?.[11]?.value).toBe('undefined');
  expect(result.observations?.[12]?.value).toBe('undefined');
  expect(result.observations?.[13]?.value).toMatchObject({ viewportWidth: 900 });
  expect(result.observations?.[14]?.value).toBeNull();
  expect(result.scoring).toContain('unscored');
  expect(result.pageErrors).toEqual([]);
}, 90_000);

browserTest('each request builds a fresh browser context from changed candidate App source', async () => {
  const root = fixture(
    [
      "import React from 'react';",
      "import { createRoot } from 'react-dom/client';",
      "import App from './App.jsx';",
      "createRoot(document.getElementById('root')).render(<App />);",
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'src', 'App.jsx'),
    "import React from 'react'; export default function App() { return <p id='candidate'>original</p> }",
  );
  brokers.push(await startReactBrowserBroker(root));
  const first = await respond(root, {
    requestId: 'candidate-before',
    actions: [{ type: 'text', selector: '#candidate' }],
  });
  expect(first.status).toBe('ok');
  expect(first.observations?.[0]?.value).toBe('original');

  writeFileSync(
    join(root, 'src', 'App.jsx'),
    "import React from 'react'; export default function App() { return <p id='candidate'>updated</p> }",
  );
  const second = await respond(root, {
    requestId: 'candidate-after',
    actions: [{ type: 'text', selector: '#candidate' }],
  });
  expect(second.status).toBe('ok');
  expect(second.observations?.[0]?.value).toBe('updated');
}, 90_000);

test('broker rejects arbitrary scripts and external navigation without browser assets', async () => {
  const newContext = mockBrowserLaunch();
  const root = fixture();
  brokers.push(await startReactBrowserBroker(root));
  const blocked = await respond(root, {
    requestId: 'unsafe-1',
    actions: [{ type: 'evaluate', source: "require('node:fs').readFileSync('/etc/passwd')" }],
  });
  expect(blocked.status).toBe('error');
  expect(blocked.error).toContain('does not permit');

  const shortcut = await respond(root, {
    requestId: 'unsafe-shortcut',
    actions: [{ type: 'press', selector: '#increment', value: 'Control+L' }],
  });
  expect(shortcut.status).toBe('error');
  expect(shortcut.error).toContain('ordinary browser keys');

  const external = await respond(root, {
    requestId: 'unsafe-2',
    actions: [{ type: 'navigate', path: 'https://example.com' }],
  });
  expect(external.status).toBe('error');
  expect(external.error).toContain('local browser paths');
  expect(newContext).not.toHaveBeenCalled();
});

browserTest('broker rejects unsafe source imports in the real build', async () => {
  const badRoot = fixture("import x from '/etc/passwd'; document.body.textContent = x;");
  brokers.push(await startReactBrowserBroker(badRoot));
  const importResult = await respond(badRoot, {
    requestId: 'unsafe-3',
    actions: [{ type: 'text', selector: 'body' }],
  });
  expect(importResult.status).toBe('error');
  expect(importResult.error).toContain('rejected import');
}, 90_000);

test('broker refuses symlinks in candidate source', async () => {
  const newContext = mockBrowserLaunch();
  const root = fixture();
  symlinkSync('/etc/hosts', join(root, 'src', 'host-file'));
  brokers.push(await startReactBrowserBroker(root));
  const blocked = await respond(root, {
    requestId: 'symlink-1',
    actions: [{ type: 'text', selector: 'body' }],
  });
  expect(blocked.status).toBe('error');
  expect(blocked.error).toContain('symlink');
  expect(newContext).not.toHaveBeenCalled();
}, 90_000);

test.skipIf(isWindows())('replacement of verification directory cannot redirect evaluator browser responses', async () => {
  const newContext = mockBrowserLaunch();
  const root = fixture();
  const other = fixture();
  brokers.push(await startReactBrowserBroker(root));
  const original = join(root, 'verification');
  const moved = join(root, 'verification-original');
  renameSync(original, moved);
  symlinkSync(join(other, 'verification'), original);
  const externalResponse = join(other, 'verification', 'react-browser-response.json');
  expect(existsSync(externalResponse)).toBe(false);
  writeFileSync(
    join(moved, 'react-browser-request.json'),
    JSON.stringify({
      requestId: 'pinned-fd',
      actions: [{ type: 'evaluate', source: 'forbidden' }],
    }),
  );
  const responsePath = join(moved, 'react-browser-response.json');
  let result: Record<string, unknown> | undefined;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      result = JSON.parse(readFileSync(responsePath, 'utf8'));
      if (result?.requestId === 'pinned-fd') break;
    } catch {
      /* The response may still be in transit. */
    }
    await Bun.sleep(100);
  }
  expect(result?.status).toBe('error');
  expect(result?.error).toContain('does not permit');
  expect(existsSync(externalResponse)).toBe(false);
  expect(newContext).not.toHaveBeenCalled();
}, 60_000);

test.skipIf(isWindows())('broker refuses candidate hard links pointing outside the evaluator fixture', async () => {
  const newContext = mockBrowserLaunch();
  const root = fixture();
  const other = fixture();
  linkSync(join(other, 'src', 'main.jsx'), join(root, 'src', 'linked-source.jsx'));
  brokers.push(await startReactBrowserBroker(root));
  const blocked = await respond(root, {
    requestId: 'hard-link-1',
    actions: [{ type: 'text', selector: 'body' }],
  });
  expect(blocked.status).toBe('error');
  expect(blocked.error).toContain('hard link');
  expect(newContext).not.toHaveBeenCalled();
}, 90_000);

test('broker detects changed trusted React fixture before it can return browser observations', async () => {
  const newContext = mockBrowserLaunch();
  const root = fixture();
  brokers.push(await startReactBrowserBroker(root));
  writeFileSync(join(root, 'src', 'main.jsx'), 'document.body.textContent = "forged";');
  const result = await respond(root, {
    requestId: 'changed-harness',
    actions: [{ type: 'text', selector: 'body' }],
  });
  expect(result.status).toBe('error');
  expect(result.error).toContain('modified immutable fixture');
  expect(newContext).not.toHaveBeenCalled();
}, 90_000);
