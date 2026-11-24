const invoke = window.__TAURI__.core.invoke;
const status = document.querySelector('#status');
const listen = window.__TAURI__.event.listen;
// Mirror every status line to the fixture root so the native driver reads the same text the
// person sees, without asking the accessibility server for it.
const setStatus = (text) => {
  status.textContent = text;
  invoke('kory_status', { text }).catch(() => {});
};
listen('kory-control', (event) => {
  let command = {};
  try {
    command = JSON.parse(event.payload);
  } catch {
    return;
  }
  if (command.action === 'open') {
    const start =
      typeof command.directory === 'string'
        ? invoke('kory_picker_directory', { path: command.directory })
        : Promise.resolve();
    start.catch(() => {}).then(() => document.querySelector('#choose').click());
  }
  if (command.action === 'read') document.querySelector('#read').click();
  if (command.action === 'probe') document.querySelector('#probe').click();
  if (command.action === 'place') invoke('kory_place_window').catch(() => {});
});
let chosenPath = localStorage.getItem('workspace') || '';
document.querySelector('#choose').addEventListener('click', async () => {
  const selected = await invoke('choose_workspace');
  chosenPath = selected || ''; // BUG: a cancel loses the difference between none and empty.
  localStorage.setItem('workspace', chosenPath);
  setStatus(chosenPath || 'No folder selected');
});
document.querySelector('#read').addEventListener('click', async () => {
  try {
    setStatus(await invoke('read_workspace', { path: chosenPath }));
  } catch (error) {
    setStatus(String(error));
  }
});
// A capability probe the native driver can trigger from outside the webview. The command is
// deliberately not registered, so a correct app keeps it unreachable and reports the refusal
// instead of answering it. Registering a catch-all handler would make this succeed and fail
// the check, which is exactly the boundary being measured.
document.querySelector('#probe').addEventListener('click', async () => {
  try {
    const answer = await invoke('kory_unregistered_probe');
    setStatus('unexpectedly allowed: ' + String(answer));
  } catch (error) {
    setStatus('denied: ' + String(error));
  }
});
