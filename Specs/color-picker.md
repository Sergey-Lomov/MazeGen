# Color Picker

Custom color-selection UI that replaces the browser-native `<input type="color">` for every color
parameter in the editor. Tracked as epic (GitHub issue #498); this spec describes the **shell**
delivered in sub-issue #499 and is extended as later sub-issues land (per-model editing controls,
palette tools, practicality checks, presets/history).

## Components

| Component | Role |
|---|---|
| `ColorSwatch` (`components/ColorSwatch.tsx`) | The visible color cell. A plain `div` (not a native input — that renders browser chrome that won't clip to `border-radius`). `role="button"`, keyboard-activatable (Enter / Space). Public props are exactly `color: number` (packed 24-bit RGB) + `onChange: (color: number) => void` + `disabled?`. Clicking / activating opens `ColorPickerPanel`; the swatch value only changes when the panel commits. |
| `ColorRow` (`components/ColorRow.tsx`) | Labeled row: `label` + `ColorSwatch` + optional trailing `resetButton` (the issue #322 per-field Shared-Style reset). Unchanged by #499. |
| `ColorPickerPanel` (`components/ColorPickerPanel.tsx`) | The picker itself. Rendered only while open (`ColorSwatch` holds the `pickerOpen` flag). |
| `colorFormat.ts` (`components/colorFormat.ts`) | `colorToHex` / `hexToColor` / `HEX_COLOR_RE` — the number ↔ `#rrggbb` conversions shared by `ColorSwatch` and `ColorPickerPanel`. |

`ColorSwatch` / `ColorRow` do **not** know whether `onChange` writes a plain store value or a
Shared-Style override patch — that stays entirely in the call site (issue #322 mechanism, the
`resetButton` prop). The picker only reads `color` on open and calls `onChange` once on Apply.

## Panel

`ColorPickerPanel` renders a `SidePanel` in **overlay mode** (`overlay` prop). Instead of docking
beside the canvas in flow, an overlay `SidePanel` is `position: absolute; inset: 0` inside
`#side-panel-slot` (which `App.tsx` gives `position: relative`), fully covering whatever `SidePanel`
content is already shown there and restoring it when the picker closes. Overlay mode hides the
resize handle (it stretches to the slot, so there is no width to drag).

Contents (top to bottom):

- **Preview** — a large block filled with the current *working* color, updated live on every change.
- **Hex field** — a `TextFieldRow` (`label` = "Hex", `value` = working color as `#rrggbb`). Typing a
  string matching `HEX_COLOR_RE` updates the working color and preview immediately; an invalid
  string is kept in the field (so the user can finish typing) but does not move the working color,
  shows an error message, and disables **Apply**.
- **Footer** — **Cancel** and **Apply**, each half-width. Cancel (also the header close button, also
  Escape) closes without calling `onChange`. Apply calls `onChange(workingColor)` and closes,
  revealing the previously shown panel.

Working color is local state seeded from the swatch's `color` on open; the picker is remounted on
each open, so it always re-seeds.

## Shared row primitive

`TextFieldRow` (`components/TextFieldRow.tsx`) is a labeled single-line text input row, mirroring
`ColorRow` / `SelectRow` / `ToggleRow` (label `flex: 1` + fixed-width control + optional
`resetButton`). Its field is sized to `controlRowHeight` via `sharedStyles.textFieldSm`. `invalid`
renders an error border + `aria-invalid`. Introduced for the picker's hex field; usable for any
free-text param.

## Not yet implemented (later #498 sub-issues)

Per-model editing (OKLCH / RGB toggles, square, hue strip, channel sliders), palette generation,
contrast / distinguishability / color-blindness checks, presets and history, awareness of colors
already assigned elsewhere in the maze.
