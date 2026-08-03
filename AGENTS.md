# Koryphaios Agent Guidance

## UI controls

- Never introduce native HTML `<select>` controls in Koryphaios product UI.
- Use the shared `KorySelect.svelte` component for dropdowns so styling, keyboard behavior, focus handling, and theming remain consistent.
- Use Koryphaios-native switches and steppers instead of browser-default checkboxes and numeric spinner controls.
- New reusable controls must use theme tokens rather than hard-coded light/dark surfaces.

## Rich responses

- Use standard GitHub-flavored Markdown tables for structured comparisons; never imitate tables with spaces or ASCII art.
- Koryphaios renders fenced `chart` JSON blocks as native charts. Supported types are `bar`, `line`, and `pie`, using `labels` plus Chart.js-style `datasets` containing `label` and numeric `data` arrays.
- Koryphaios renders fenced `color` (or `kory-color`) blocks as themed swatch chips. Accept one color per line (`<value>[ <label>]`) or JSON (`{ "value": ..., "label": ... }`, arrays, or `{ "colors": [...] }`). Supported value forms: `#hex`, `rgb()/rgba()`, `hsl()/hsla()`, and named colors. Values are validated and escaped before entering the `style` attribute.
- Koryphaios renders fenced `html` (or `kory-html` / `html-sandbox`) blocks as sandboxed iframes so agents can show arbitrary HTML + CSS layouts (grids, diagrams, styled cards). The iframe uses `sandbox=""` (no scripts, no same-origin, no forms) and a strict CSP (`default-src 'none'`; `style-src 'unsafe-inline'`; `img-src data: blob:`). Never rely on JavaScript inside these blocks — it will not execute.
