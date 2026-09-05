# Color Picker

Custom color-selection UI that replaces the browser-native `<input type="color">` for every color
parameter in the editor. Tracked as epic (GitHub issue #498). This spec covers the **shell**
(sub-issue #499) plus the **model switcher and RGB model** (sub-issue #500), and is extended as
later sub-issues land (more color models, palette tools, practicality checks, presets/history).

## Components

| Component | Role |
|---|---|
| `ColorSwatch` (`components/ColorSwatch.tsx`) | The visible color cell. A plain `div` (not a native input — that renders browser chrome that won't clip to `border-radius`). `role="button"`, keyboard-activatable (Enter / Space). Public props are exactly `color: number` (packed 24-bit RGB) + `onChange: (color: number) => void` + `disabled?`. Clicking / activating opens `ColorPickerPanel`; the swatch value only changes when the panel commits. |
| `ColorRow` (`components/ColorRow.tsx`) | Labeled row: `label` + `ColorSwatch` + optional trailing `resetButton` (the issue #322 per-field Shared-Style reset). Unchanged by #499. |
| `ColorPickerPanel` (`components/ColorPickerPanel.tsx`) | The picker itself. Rendered only while open (`ColorSwatch` holds the `pickerOpen` flag). |
| `colorFormat.ts` (`components/colorFormat.ts`) | `colorToHex` / `hexToColor` / `HEX_COLOR_RE` — the number ↔ `#rrggbb` conversions shared by `ColorSwatch` and `ColorPickerPanel`. Also `colorToRgb` / `rgbToColor` — packed number ↔ `{ r, g, b }` (0-255, clamped + rounded on pack) for the RGB model. |
| `RgbModelEditor.tsx` (`components/RgbModelEditor.tsx`) | The RGB editing model (#500): three channel sliders (0-255) with per-channel gradient tracks + paired numeric inputs. Reads the working color, calls `onChange` with the new packed color on every edit. |
| `GradientSlider.tsx` (`components/GradientSlider.tsx`) | Reusable `<input type="range">` with a gradient track (`trackBackground`) and a disc thumb whose centre fill is `thumbColor`. Geometry lives in `.gradient-slider` (`global.css`): 8px track / 4px radius; 18px thumb = 10px coloured centre + 2px white ring + 2px panel-colored (`#1b1b1b`) outer edge (a `box-shadow`, since an element has only one `border`). No hover / focus / drag styling — the thumb looks identical in every state; only `:disabled` dims the whole control. `thumbColor` is passed to CSS as the `--thumb-color` custom property. Used for the RGB channel sliders; reusable for any gradient-along-an-axis control. |

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

## Model switcher and editing area (#500)

Below the hex field, a row of toggle buttons (`Inline` + `Button variant="toggle"/"toggle-selected"`,
the `FieldSetupFeature` Default/Custom pattern) selects the active color **model**. One button per
model; selecting one swaps the editing controls rendered below it. The shared preview and hex field
stay in place and in sync with every edit.

Only the **RGB** model ships in #500 (`RgbModelEditor`): three `GradientSlider`s (R, G, B, 0-255),
each with a two-stop gradient track (the working color with that one channel swept 0 → 255) and a
thumb centre showing the whole working color, paired with a `<input type="number">` (0-255). Editing
any slider, number input, or the shared hex field updates the working color and refreshes every
other control. Values written through a number input are clamped to 0-255; `rgbToColor` clamps and
rounds again on pack.

Each number input keeps a local text buffer so an emptied field isn't immediately forced back to a
number while the user is retyping. The buffer is dropped when the field blurs, and when the color
changes from outside this editor (the hex field, or another channel) — tracked via an
`expectedColor` ref so the editor's *own* edits don't wipe an in-progress value. Applying commits
the working color exactly as in #499.

Other models (OKLCH, …) each add their own button and editor in their own #498 sub-issue.

## Shared row primitive

`TextFieldRow` (`components/TextFieldRow.tsx`) is a labeled single-line text input row, mirroring
`ColorRow` / `SelectRow` / `ToggleRow` (label `flex: 1` + fixed-width control + optional
`resetButton`). Its field is sized to `controlRowHeight` via `sharedStyles.textFieldSm`. `invalid`
renders an error border + `aria-invalid`. Introduced for the picker's hex field; usable for any
free-text param.

## Not yet implemented (later #498 sub-issues)

Non-RGB models (OKLCH toggle, square, hue strip), palette generation,
contrast / distinguishability / color-blindness checks, presets and history, awareness of colors
already assigned elsewhere in the maze.
