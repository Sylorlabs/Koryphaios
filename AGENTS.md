# Koryphaios Agent Guidance

## UI controls

- Never introduce native HTML `<select>` controls in Koryphaios product UI.
- Use the shared `KorySelect.svelte` component for dropdowns so styling, keyboard behavior, focus handling, and theming remain consistent.
- Use Koryphaios-native switches and steppers instead of browser-default checkboxes and numeric spinner controls.
- New reusable controls must use theme tokens rather than hard-coded light/dark surfaces.
