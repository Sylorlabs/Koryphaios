import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startVisualBrowserBroker } from '../../backend/src/kory/skill-eval-visual-browser-broker.ts';
import { BROWSER_SKILL_EVAL_MATERIALIZERS } from '../../backend/src/kory/skill-eval-browser-fixtures.ts';

const dir = mkdtempSync(join(tmpdir(), 'vv-broker-'));
const scenarioId = 'visual-verification-full-task-1';
const m = BROWSER_SKILL_EVAL_MATERIALIZERS.find((x) => x.matches({ id: scenarioId } as any))!;
m.materialize(dir);
const broker = await startVisualBrowserBroker(dir);
const cells = [];
for (const [w, h] of [[1440, 900], [900, 900], [390, 844]]) {
  for (const theme of ['light', 'dark']) {
    for (const state of ['loading', 'empty', 'normal', 'dense']) {
      cells.push({ theme, state, width: w, height: h, screenshot: true });
    }
  }
}
writeFileSync(join(dir, 'verification/visual-browser-request.json'), JSON.stringify({ requestId: 'p1', cells }));
let response: any;
for (let i = 0; i < 120; i += 1) {
  await Bun.sleep(500);
  try {
    response = JSON.parse(readFileSync(join(dir, 'verification/visual-browser-response.json'), 'utf8'));
    if (response.requestId === 'p1') break;
  } catch { /* still writing */ }
}
await broker.close();
console.log("status", response?.status, "err", response?.error, "rows", response?.measured?.length);
const failing = (response?.measured ?? []).filter((r: any) =>
  r.horizontalOverflow || r.chartClipped || r.legendClipped || r.stickyOverlap || r.primaryActionDistinct === false);
console.log('measured failures', failing.map((r: any) => r.captureId).join(', ') || 'none');
console.log('sample', JSON.stringify(response?.measured?.[0]));
console.log('screenshot exists', existsSync(join(dir, 'verification/captures/390x844-dark-dense.jpg')));
