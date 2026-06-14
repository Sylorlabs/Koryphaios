import { chromium } from 'playwright';
const URL = process.env.KORY_URL ?? 'http://localhost:5173/';
const log = (...a: unknown[]) => console.log('•', ...a);
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 940 } })).newPage();
await page.goto(URL, { waitUntil: 'networkidle', timeout: 30_000 });
await page.waitForTimeout(1200);

// Exercise the assignments PUT + GET round-trip from the page's authed fetch context.
const result = await page.evaluate(async () => {
  const token = localStorage.getItem('koryphaios-local-auth-token') ?? '';
  const h = { 'Content-Type': 'application/json', Authorization: token };
  const put = await fetch('/api/agent/assignments', {
    method: 'PUT',
    headers: h,
    body: JSON.stringify({ assignments: { critic: 'claude-sonnet-4-6' } }),
  });
  const putBody = await put.json();
  const get = await fetch('/api/agent/assignments', { headers: { Authorization: token } });
  const getBody = await get.json();
  // Also confirm an invalid model is rejected.
  const bad = await fetch('/api/agent/assignments', {
    method: 'PUT',
    headers: h,
    body: JSON.stringify({ assignments: { critic: 'not-a-real-model-xyz' } }),
  });
  const badBody = await bad.json();
  // Cleanup: reset critic back to auto.
  await fetch('/api/agent/assignments', {
    method: 'PUT',
    headers: h,
    body: JSON.stringify({ assignments: {} }),
  });
  const get2 = await fetch('/api/agent/assignments', { headers: { Authorization: token } });
  const getBody2 = await get2.json();
  return {
    putOk: putBody?.ok,
    putAssign: putBody?.data?.assignments,
    getCriticValue: (getBody?.data?.categories ?? []).find((c: any) => c.id === 'critic')?.value,
    badRejected: badBody?.ok === false,
    afterResetCriticValue: (getBody2?.data?.categories ?? []).find((c: any) => c.id === 'critic')?.value,
  };
});
log('PUT ok:', result.putOk);
log('PUT echoed assignments:', JSON.stringify(result.putAssign));
log('GET critic value after pin:', JSON.stringify(result.getCriticValue));
log('Invalid model rejected (expect true):', result.badRejected);
log('GET critic value after reset (expect ""):', JSON.stringify(result.afterResetCriticValue));
await browser.close();
