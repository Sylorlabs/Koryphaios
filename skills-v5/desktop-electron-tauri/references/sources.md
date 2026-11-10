# Source map

Source curation for `desktop-electron-tauri`. Routing fixtures and eval IDs remain in `kory.json`. This revision does not claim paired skill/no skill or blind qualification.

## Adopted primary guidance

- **Electron context isolation**: https://www.electronjs.org/docs/latest/tutorial/context-isolation
  - Adopted: keep renderer and preload contexts isolated and expose narrow operations rather than raw `ipcRenderer` authority.
  - Conditional: the bridge shape applies to Electron preload architecture, not Tauri commands.
  - Limit: context isolation reduces renderer authority but does not validate IPC arguments or senders by itself.
- **Electron security guidance**: https://www.electronjs.org/docs/latest/tutorial/security
  - Adopted: keep web security enabled, validate privileged IPC senders, sandbox where the application model supports it, and avoid broad Electron API exposure to untrusted renderer content.
  - Conditional: apply the relevant controls to the application's actual content and privilege topology. A local-only UI and a remote-content UI have different threat surfaces.
  - Limit: the checklist is not proof that a packaged application is secure.
- **Electron IPC guide**: https://www.electronjs.org/docs/latest/tutorial/ipc
  - Adopted: treat renderer-to-main communication as an explicit request boundary with handler ownership and response semantics.
  - Conditional: use the IPC pattern already established by the application unless a concrete defect requires changing it.
  - Limit: documentation examples do not substitute for denial-path testing in the packaged app.
- **Tauri v2 permissions**: https://v2.tauri.app/security/permissions/
  - Adopted: scope command privileges with capabilities and allow or deny resource scopes at the Tauri enforcement boundary.
  - Conditional: this applies to Tauri v2 applications using the capability system.
  - Limit: Electron preload guidance must not be copied onto Tauri as though the privilege model were identical.
- **Electron documentation index**: https://www.electronjs.org/docs/latest/
  - Preserved use: current Electron API and lifecycle discovery.
- **Tauri v2 documentation index**: https://v2.tauri.app/
  - Preserved use: current Tauri v2 architecture and API discovery.

Packaged runtime evidence outranks dev-server behavior for filesystem paths, signing, capabilities, update, and native lifecycle claims.
