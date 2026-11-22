const invoke = window.__TAURI__.core.invoke;
const status = document.querySelector('#status');
const listen = window.__TAURI__.event.listen;
const EMPTY_STATE = 'No folder selected';
// Mirror every status line to the fixture root so the native driver reads the same text the
// person sees, without asking the accessibility server for it.
const setStatus = (text) => { status.textContent = text; invoke('kory_status', { text }).catch(() => {}); };
listen('kory-control', (event) => {
  let command = {};
  try { command = JSON.parse(event.payload); } catch { return; }
  if (command.action === 'open') {
    const start = typeof command.directory === 'string' ? invoke('kory_picker_directory', { path: command.directory }) : Promise.resolve();
    start.catch(() => {}).then(() => document.querySelector('#choose').click());
  }
  if (command.action === 'read') document.querySelector('#read').click();
  if (command.action === 'probe') document.querySelector('#probe').click();
  if (command.action === 'place') invoke('kory_place_window').catch(() => {});
});
// The selected folder lives in the privileged side, not here: the webview never sends a path
// back and nothing is persisted between launches. A relaunch therefore starts empty, and a
// remembered path can never outlive the process that was allowed to read it.
document.querySelector('#choose').addEventListener('click', async () => {
  let selection;
  try { selection = await invoke('choose_workspace'); }
  catch (error) { setStatus('Could not open the folder picker: ' + String(error)); return; }
  // Cancellation is its own answer. It is not an empty path, so it cannot be read as "no value"
  // and fall through to some default directory.
  if (!selection || selection.status === 'cancelled') {
    setStatus(EMPTY_STATE);
    return;
  }
  if (selection.status === 'selected' && typeof selection.root === 'string') {
    setStatus(selection.root);
    return;
  }
  setStatus(EMPTY_STATE);
});
document.querySelector('#read').addEventListener('click', async () => {
  try { setStatus(await invoke('read_workspace')); }
  catch (error) { setStatus(String(error)); }
});
// A capability probe the native driver can trigger from outside the webview. The command is
// deliberately not registered, so a correct app keeps it unreachable and reports the refusal
// instead of answering it. Registering a catch-all handler would make this succeed and fail
// the check, which is exactly the boundary being measured.
document.querySelector('#probe').addEventListener('click', async () => {
  try {
    const answer = await invoke('kory_unregistered_probe');
    setStatus('unexpectedly allowed: ' + String(answer));
  } catch (error) { setStatus('denied: ' + String(error)); }
});
// Start from the canonical empty state so the mirrored status matches the window even before
// anyone touches a button.
setStatus(EMPTY_STATE);
