export const MOBILE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#111116"><title>Link device · Koryphaios</title><style>
:root{color-scheme:dark;--background:#111116;--surface:#1b1b23;--line:#353542;--text:#f4f4f5;--muted:#a3a3b3;--accent:#dba9c4;--on-accent:#24151f;--error:#ffa4a4}*{box-sizing:border-box}body{margin:0;background:var(--background);color:var(--text);font:14px system-ui,-apple-system,sans-serif}#app{max-width:780px;margin:auto;padding:22px 18px calc(22px + env(safe-area-inset-bottom))}header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-bottom:20px;border-bottom:1px solid var(--line);margin-bottom:24px}h1{font-size:19px;margin:0}h2{font-size:21px;margin:12px 0}h3{font-size:15px;margin:16px 0 10px}p{line-height:1.65;color:var(--muted);margin:10px 0 18px}input,textarea{width:100%;font:inherit;background:var(--surface);border:1px solid var(--line);border-radius:10px;color:var(--text);padding:13px;margin:8px 0 12px}textarea{min-height:110px;resize:vertical}button{font:600 13px system-ui;min-height:42px;padding:11px 14px;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--text);cursor:pointer}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:3px}button:disabled{opacity:.45;cursor:not-allowed}.primary{background:var(--accent);color:var(--on-accent);border-color:transparent}.stack{display:grid;gap:10px}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.card{border:1px solid var(--line);border-radius:16px;padding:18px;margin:16px 0;background:var(--surface)}.device{display:grid;text-align:left;gap:5px;padding:16px}.device span,.muted{color:var(--muted);font-size:12px}.check{font:600 34px ui-monospace,monospace;letter-spacing:.14em;margin:20px 0}.message{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.75;margin-bottom:20px}.message small{display:block;color:var(--accent);margin-bottom:6px}.error{color:var(--error)}.composer{position:sticky;bottom:0;background:var(--background);padding-top:10px;border-top:1px solid var(--line)}.pill{font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:var(--accent)}footer{font-size:11px;color:var(--muted);padding-top:20px}a{color:var(--accent)}
</style></head><body><div id="app"><header><h1>Koryphaios mobile</h1><span class="pill">Device controller</span></header><main id="view"><p>Loading secure device controller…</p></main><p id="error" class="error" role="alert"></p><footer>Encrypted device-to-device. Each desktop keeps its own files and permissions.</footer></div><script type="module" src="/device-client.js"></script></body></html>`;

let built: Promise<string> | null = null;
export function mobileBundle(): Promise<string> {
  built ??= Bun.build({
    entrypoints: [new URL('./mobile-client.ts', import.meta.url).pathname],
    target: 'browser',
    minify: true,
  }).then(async (result) => {
    if (!result.success) throw new Error('Mobile controller bundle failed to build');
    return result.outputs[0]!.text();
  });
  return built;
}
