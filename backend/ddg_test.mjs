import { writeFileSync } from 'fs';

const resp = await fetch('https://html.duckduckgo.com/html/?q=apple+fruit', {
  headers: { 'User-Agent': 'Koryphaios/1.0' },
  redirect: 'follow'
});
const html = await resp.text();
writeFileSync('./ddg_raw.html', html);
console.log('Length:', html.length);

const idx = html.indexOf('result__body');
if (idx >= 0) {
  console.log('Found result__body at:', idx);
  console.log('Context:', html.slice(Math.max(0, idx-50), idx+500));
} else {
  const patterns = ['result__', 'result-', 'results', 'links_main', 'web-result'];
  for (const p of patterns) {
    const i = html.indexOf(p);
    if (i >= 0) {
      console.log('Found', p, 'at:', i);
      console.log('Context:', html.slice(Math.max(0, i-30), i+400));
      break;
    }
  }
  if (!html.match(/result/)) {
    console.log('No "result" in HTML at all. First 2000 chars:\n', html.slice(0, 2000));
  }
}
