# Native desktop evaluation

Tauri v2 Rust command + native picker; enforce canonical root at use time and typed cancellation.

The scorer starts a real desktop process and requires independent native window, renderer and security-boundary observations. Do not edit .kory-eval/desktop-fixture.json.

The native driver presses every button in the window by name, so keep the three button labels and the status paragraph as they are. Closing the window must not terminate the application, and a relaunch of the bundle must show the canonical empty state, never the previous selection. Reading must stay confined to the folder the user chose, even when that folder is replaced by a link to another directory after it was chosen. The Probe capability button invokes a command that is not registered, and that command must stay unanswerable.
