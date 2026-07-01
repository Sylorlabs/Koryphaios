// Headless browser probe of the Koryphaios dev frontend.
// Logs console messages and any thrown errors, then takes a screenshot
// and prints DOM-level information about model selectors, session list,
// and any "X new messages" indicators.

import { chromium } from "playwright";

const URL = "http://127.0.0.1:3003";
const NAV_TIMEOUT = 30_000;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();

  const consoleMsgs = [];
  const pageErrors = [];
  const requestFails = [];

  page.on("console", (msg) => {
    consoleMsgs.push({
      type: msg.type(),
      text: msg.text(),
      location: msg.location(),
    });
  });
  page.on("pageerror", (err) => {
    pageErrors.push({
      name: err.name,
      message: err.message,
      stack: err.stack?.split("\n").slice(0, 8).join("\n"),
    });
  });
  page.on("requestfailed", (req) => {
    requestFails.push({ url: req.url(), failure: req.failure()?.errorText });
  });

  try {
    await page.goto(URL, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT,
    });
    // Wait for the SvelteKit hydration to settle
    await page.waitForTimeout(3000);
  } catch (e) {
    console.error("NAVIGATION FAILED:", e.message);
  }

  // --- Snapshot 1: initial state ---
  const initial = await page.evaluate(() => {
    const txt = (sel) =>
      Array.from(document.querySelectorAll(sel))
        .map((n) => n.textContent?.trim())
        .filter(Boolean);
    return {
      title: document.title,
      url: location.href,
      h1: txt("h1"),
      h2: txt("h2"),
      buttons: Array.from(document.querySelectorAll("button"))
        .slice(0, 20)
        .map((b) => b.textContent?.trim() || b.getAttribute("aria-label") || "")
        .filter(Boolean),
      allText: document.body.innerText.slice(0, 4000),
      modelSelectors: Array.from(
        document.querySelectorAll('[class*="model" i], [data-model], select'),
      )
        .slice(0, 10)
        .map((n) => ({
          tag: n.tagName,
          cls: n.className?.toString().slice(0, 100),
          text: n.textContent?.trim().slice(0, 200),
        })),
      anyNewMessageIndicators: txt('[class*="new" i], [class*="unseen" i]'),
      sessionList: txt('[class*="session" i]').slice(0, 30),
    };
  });

  console.log("=== INITIAL STATE ===");
  console.log(JSON.stringify(initial, null, 2));

  // --- Try to find a session in the sidebar and click it ---
  const sessionClicked = await page.evaluate(() => {
    const candidates = Array.from(
      document.querySelectorAll('button, a, [role="button"]'),
    ).filter(
      (n) =>
        /session|chat|resume/i.test(n.textContent || "") ||
        /session/i.test(n.className || ""),
    );
    if (candidates.length > 0) {
      const target = candidates[0];
      target.click();
      return {
        clicked: true,
        text: target.textContent?.trim(),
        cls: target.className?.toString(),
      };
    }
    return { clicked: false };
  });
  console.log("=== SESSION CLICK ATTEMPT ===", sessionClicked);

  await page.waitForTimeout(2000);

  // --- Snapshot 2: after clicking session ---
  const afterSession = await page.evaluate(() => {
    const txt = (sel) =>
      Array.from(document.querySelectorAll(sel))
        .map((n) => n.textContent?.trim())
        .filter(Boolean);
    return {
      bodyText: document.body.innerText.slice(0, 4000),
      newMessageButtons: txt("button").filter((t) =>
        /new message|jump to bottom|\d+ new/i.test(t || ""),
      ),
      buttons: txt("button").slice(0, 30),
      selectElements: Array.from(
        document.querySelectorAll(
          'select, [role="combobox"], [role="listbox"]',
        ),
      )
        .slice(0, 10)
        .map((n) => ({
          tag: n.tagName,
          role: n.getAttribute("role"),
          text: n.textContent?.trim().slice(0, 200),
        })),
    };
  });
  console.log("=== AFTER SESSION CLICK ===");
  console.log(JSON.stringify(afterSession, null, 2));

  // --- Wait a bit and snapshot again to see if anything is firing ---
  await page.waitForTimeout(5000);

  const afterWait = await page.evaluate(() => {
    const txt = (sel) =>
      Array.from(document.querySelectorAll(sel))
        .map((n) => n.textContent?.trim())
        .filter(Boolean);
    return {
      bodyText: document.body.innerText.slice(0, 4000),
      newMessageButtons: txt("button").filter((t) =>
        /new message|jump to bottom|\d+ new/i.test(t || ""),
      ),
      feedCount: document.querySelectorAll(
        '[class*="feed" i] [class*="entry" i], [class*="feed" i] > div > div',
      ).length,
    };
  });
  console.log("=== AFTER 5s WAIT ===");
  console.log(JSON.stringify(afterWait, null, 2));

  await page.screenshot({ path: "/tmp/koryphaios-probe.png", fullPage: false });

  console.log("\n=== CONSOLE MESSAGES ===");
  for (const m of consoleMsgs) {
    console.log(`[${m.type}] ${m.text}`);
  }
  console.log("\n=== PAGE ERRORS ===");
  for (const e of pageErrors) {
    console.log(`[${e.name}] ${e.message}\n${e.stack}\n`);
  }
  console.log("\n=== REQUEST FAILURES ===");
  for (const r of requestFails) {
    console.log(`[fail] ${r.url} - ${r.failure}`);
  }

  await browser.close();
})();
