/* Packaged WebView only. All privileged operations travel over Tauri IPC. */
const invoke = window.__TAURI__.core.invoke;
const status = document.getElementById('status');

async function call(command, args) {
  try {
    const value = await invoke(command, args || {});
    status.textContent = JSON.stringify(value);
  } catch (error) {
    status.textContent = 'Denied: ' + String(error);
  }
}
document.getElementById('pick').addEventListener('click', () => call('choose_workspace'));
document.getElementById('allowed').addEventListener('click', () => call('read_relative', { relative: 'marker.txt' }));
document.getElementById('denied').addEventListener('click', () => call('read_relative', { relative: 'linked.txt' }));
document.getElementById('reopen').addEventListener('click', () => call('choose_workspace'));
// A disposable, noninteractive packaged smoke. Each call crosses WKWebView
// IPC into the genuine Rust command handler; no folder-picker event is claimed.
void (async () => {
  await call('get_workspace');
  for (const relative of ['marker.txt', 'linked.txt']) {
    try { await invoke('read_relative', { relative }); }
    catch { /* The Rust command logs the denied read. */ }
  }
})();
