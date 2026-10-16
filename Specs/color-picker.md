# Color Picker

Custom color-selection UI that replaces the browser-native `<input type="color">` for every color
parameter in the editor. Tracked as epic (GitHub issue #498). This spec covers the **shell**
(sub-issue #499), the **model switcher and RGB model** (sub-issue #500), the **HSL model**
(sub-issue #501), the **OKLCH model** (sub-issue #502), **live canvas preview** (issue #513), the
**project-colors block** (sub-issue #503), the **Tools block** (sub-issues #504 and #505,
merged into one section — see "Tools block" below), and the **recently-used-colors block**
(sub-issue #506), the **canvas eyedropper** (sub-issue #507), and is extended as later sub-issues
land (more color models, practicality checks, presets).

## Components

| Component | Role |
|---|---|
| `ColorSwatch` (`components/ColorSwatch.tsx`) | The visible color cell. A plain `div` (not a native input — that renders browser chrome that won't clip to `border-radius`). `role="button"`, keyboard-activatable (Enter / Space). Props: `color: number` (packed 24-bit RGB) + `onChange: (color: number) => void` + `disabled?` + optional `onPreview?: (color: number) => void` (#513 live canvas preview, defaults to `onChange`) + optional `onOpen?: () => void` / `onCancel?: () => void` (#666, see "Cancel and parameter links" below). Clicking / activating opens `ColorPickerPanel`. |
| `ColorRow` (`components/ColorRow.tsx`) | Labeled row: `label` + `ColorSwatch` + optional trailing `resetButton` (the issue #322 per-field Shared-Style reset). Unchanged by #499. #503 adds an optional `priorityColors?: ProjectColorEntry[]` threaded straight through to `ColorSwatch` → `ColorPickerPanel` (the call site's own "these sibling colors matter for this decision" list). `onOpen?` / `onCancel?` (#666) forward straight through to `ColorSwatch`. |
| `projectColorsSelector.ts` (`pixi/selectors/projectColorsSelector.ts`) | #503. `ProjectColorEntry = { key: string; name: string; color: number }` (`key` = the stable `ColorField.key`, GitHub issue #717). `selectActiveProfileColors(state): ProjectColorEntry[]` — every color field of the export profile the picker was opened from (`state.openRenderModeSettings`: `vector_by_walls` / `vector_by_corridors`, `[]` when null), including subsections and indexed / dynamic fields (split-node slots via `maxSplitNodeCount`, `teleportGroupOverrides` fill/border). Each row's `name` is `Section: Role` (colon-joined, `Section: Sub: Role`) — the word "color" is left out. Names come from the `PC` registry (`PC.<key>.name()` / `PC.<key>.at(color)`, `PC.splitNode(i)` for slots); call sites build matching `priorityColors` / `field` from the same `PC` keys, never a hand-written string. One color used by N fields is N rows. |
| `ColorPickerPanel` (`components/ColorPickerPanel.tsx`) | The picker itself. Rendered only while open (`ColorSwatch` holds the `pickerOpen` flag). Streams the working color to `onPreview` live (#513), throttled to one call per animation frame; restores the open-time color (captured via `useRef`) through it on Cancel / close / Escape, then calls `onCancel?.()` (#666) before `onClose()`. |
| `colorFormat.ts` (`components/colorFormat.ts`) | `colorToHex` / `hexToColor` / `HEX_COLOR_RE` — the number ↔ `#rrggbb` conversions shared by `ColorSwatch` and `ColorPickerPanel`. Also `colorToRgb` / `rgbToColor` — packed number ↔ `{ r, g, b }` (0-255, clamped + rounded on pack) for the RGB model. Also `colorToHsl` / `hslToColor` — packed number ↔ `{ h, s, l }` (h 0-360, s/l 0-100) for the HSL model; exact sRGB HSL ⇄ RGB, hue wraps mod 360, s/l clamp, achromatic colors report `h = 0`. Also `colorToOklch` / `oklchToColor` — packed number ↔ `{ l, c, h }` (l 0-100, c 0-`OKLCH_MAX_CHROMA` (0.4), h 0-360) for the OKLCH model (#502); conversion is OKLCH ↔ OKLab ↔ linear sRGB ↔ sRGB per CSS Color 4 / Bjorn Ottosson. `oklchToColor` is gamut-clamped (linear channels clamped to [0,1], then to sRGB 0-255), `l` clamps, `c` floors at 0, `h` wraps mod 360, achromatic colors report `h = 0`. `oklchInSrgb(oklch)` — whether the color is inside the sRGB gamut. `oklchMaxChroma(l, h)` — largest in-gamut chroma for an L/H pair (bisection), used to mark the C slider's out-of-gamut region. `oklchToSrgbSample(oklch)` — gamut-clamped sRGB bytes for one OKLCH triple, feeds the 2D area's per-pixel paint. `distributeOklchHues(base, count)` (`store/colorMath.ts`, GitHub issue #728) — `count` colors sharing the base's OKLCH lightness/chroma with hue spread evenly over 360° from the base's own hue (first = base); chroma capped per color at `oklchMaxChroma` so out-of-gamut hues keep exact lightness/hue, used by the teleport group "Auto fills"/"Auto borders" buttons. |
| `RgbModelEditor.tsx` (`components/RgbModelEditor.tsx`) | The RGB editing model (#500): three channel sliders (0-255) with per-channel gradient tracks + paired numeric inputs. Reads the working color, calls `onChange` with the new packed color on every edit. |
| `HslModelEditor.tsx` (`components/HslModelEditor.tsx`) | The HSL editing model (#501): a 2D saturation/lightness area with a draggable crosshair, a vertical hue strip with a draggable marker, three `GradientSlider`s (H 0-360, S 0-100, L 0-100), and three numeric inputs. Reads the working color (HSL reconstructed from the stored RGB), calls `onChange` with the new packed color on every edit. Drag plumbing and area geometry are shared with `OklchModelEditor` via `usePickerDrag` / `pickerAreaStyles`. |
| `OklchModelEditor.tsx` (`components/OklchModelEditor.tsx`) | The OKLCH editing model (#502): a 2D chroma/lightness area (X = C, Y = L inverted) with a draggable crosshair, painted per-pixel from a small `<canvas>` bitmap (every cell its gamut-clamped sRGB color, area not marked; repainted on hue change), a vertical hue strip with a draggable marker, three `GradientSlider`s (L 0-100%, C 0-`OKLCH_MAX_CHROMA`, H 0-360°) with per-channel gradient tracks + paired numeric inputs (C shown to 4 decimals). The C track hatches/dims the region past the sRGB gamut for the current L and H; a centered badge below the sliders is always mounted and swaps between "Converts to sRGB precisely" and "Converts to sRGB imprecisely" (no show/hide reflow) depending on whether the current OKLCH is inside the gamut. OKLCH is held in local state as the source of truth (re-seeded from `color` only on an outside change via `useChannelInputs`); the committed value is always the gamut-clamped sRGB color, so reopening reconstructs OKLCH from the stored RGB and channels may shift slightly after a clamp. Drag plumbing and area geometry are shared with `HslModelEditor` via `usePickerDrag` / `pickerAreaStyles`. |
| `usePickerDrag.ts` (`components/usePickerDrag.ts`) | Shared pointer-drag plumbing for the `HslModelEditor` / `OklchModelEditor` 2D area + vertical hue strip. `usePickerDrag(onMove)` returns a `ref` to attach and an `onPointerDown` handler that captures the pointer, reports the initial position, and tracks the drag on `window` so it continues outside the element and ends on pointer-up anywhere. `onMove` receives the clamped 0-1 `{ x, y }` fraction along each axis; the editor maps that to its own channel ranges. Keyboard nudging stays per-editor (step sizes differ per model). |
| `pickerAreaStyles.ts` (`components/pickerAreaStyles.ts`) | Shared geometry (`pickerAreaStyles`, `PICKER_AREA_HEIGHT`) for the two 2D-area editors: the `pickers` row, the `area` box, the `crosshair` disc, the `hueStrip`, the `hueMarker`. Each editor spreads it into its own `styles` and supplies the area / track backgrounds inline (`OklchModelEditor` also adds `overflow: hidden` on `area` to clip its canvas). |
| `useChannelInputs.ts` (`components/useChannelInputs.ts`) | Shared hook behind every model editor's numeric inputs: per-channel text buffers (`buffers` / `setBuffer` / `clearBuffer`) so an emptied / in-progress field isn't forced back to a number, plus `markSelfEdit(color)` + an optional `onExternalChange(color)` — a `color` prop change the editor didn't cause clears the buffers and runs `onExternalChange` (e.g. HSL re-seeds its derived state). `parseChannelInput(raw, max)` returns the structured `{ raw, value, reason }` normalization result; empty/non-numeric drafts have `value: null`, while range clamps carry their boundary reason. `ColorChannelInput` shows that reason as a field hint on blur (GitHub issue #770). |
| `GradientSlider.tsx` (`components/GradientSlider.tsx`) | Reusable `<input type="range">` with a gradient track (`trackBackground`) and a disc thumb whose centre fill is `thumbColor`. Geometry lives in `.gradient-slider` (`global.css`): 8px track / 4px radius; 18px thumb = 10px coloured centre + 2px white ring + 2px panel-colored (`#1b1b1b`) outer edge (a `box-shadow`, since an element has only one `border`). No hover / focus / drag styling — the thumb looks identical in every state; only `:disabled` dims the whole control. `thumbColor` is passed to CSS as the `--thumb-color` custom property. Used for the RGB channel sliders; reusable for any gradient-along-an-axis control. |

`ColorSwatch` / `ColorRow` do **not** know whether `onChange` writes a plain store value or a
Shared-Style override patch — that stays entirely in the call site (issue #322 mechanism, the
`resetButton` prop). The picker reads `color` on open, streams the working color to `onPreview`
while open, and commits via `onChange` exactly once (on Apply with a distinct `onPreview`, or
through the live stream when `onPreview` defaults to `onChange`) — see "Live canvas preview" (#513).

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

## Live canvas preview (#513)

While the picker is open, every working-color change (hex field, any model editor, keyboard nudge in
a 2D area / hue strip) is pushed to the canvas through `ColorPickerPanel`'s
`onPreview?: (color: number) => void` prop, so the maze renders the color in context (geometry,
neighbours, background) as the user drags. **Cancel**, the header close button, and **Escape** call
`onPreview` once more with the color that was in effect when the picker opened — captured on mount
(`useRef`), because the `color` prop itself tracks each previewed change when `onPreview` defaults to
`onChange` (the call site's setter also writes the store). This restores the pre-open state exactly
no matter how many intermediate edits were made.

The stream is **throttled to one `onPreview` call per animation frame** (same rAF-coalescing pattern
as `StepSlider`): a pointer drag on a model slider / 2D area fires far more often than once a frame,
and a call site's handler may re-render a whole preview canvas per call. The latest color always
wins. **Cancel and Apply flush any queued frame synchronously** before `onClose` / `onApply`, so a
pending color is never lost to the unmount; a still-pending frame is also cancelled on unmount.

**Commit timing depends on whether `onPreview` is a distinct channel:**

- `ColorSwatch` is given a distinct `onPreview` — the single `onChange` commit fires on **Apply**
  (`onApply` → `onChange(working)`). `onPreview` is a lighter render-only handler; a mid-drag
  preview is never recorded as a real edit. Required for a call site whose `onChange` marks the
  maze dirty or pushes a post-edit history entry.
- `onPreview` is omitted — `ColorSwatch` defaults it to `onChange`, so the live stream *is* the
  commit. **Apply then only closes** (it flushes the last queued frame, but does not re-fire
  `onChange`, which would double a history-pushing setter's entry); with no edits `onChange` is
  never called. **Cancel / Escape** restore via `onChange(originalColor)`. Right when `onChange`
  only updates a render — all current call sites (the image-export settings panels) just write a
  `settings.*` value.

**Note:** that last assumption no longer holds for a linked field (#652) — the image-export
setters also disable the field's incoming link as a side effect of writing its value (an
override). See "Cancel and parameter links" below for how Cancel undoes that side effect too.

## Cancel and parameter links (#666)

For a field wired into a render mode's parameter-link graph (#644/#652), the call site's
`onChange` setter (e.g. `setVectorByWallsBackground`) always disables the field's incoming link as
a side effect of writing its value — correct for a real edit, including the live-stream-is-commit
mode where every preview tick already is a commit. But the final restoring call that `cancel()`
makes (`onPreview`/`onChange` with `originalColor`) is not a real edit — Cancel means "undo this
whole session" — so it must not leave the link disabled, even though, mechanically, it goes
through the very same setter and disables it one more time.

`ColorPickerPanel` exposes `onCancel?: () => void`, called once in `cancel()` right after the
restoring preview call and before `onClose()`. `ColorSwatch` / `ColorRow` forward it unchanged.
`LinkedColorRow` (`components/features/LinkedRows.tsx`) is the only place that uses it: it also
takes a new `onOpen?: () => void` (same forwarding chain), and on open snapshots whether
`linkTarget`'s incoming link was enabled (`wasLinkEnabledRef`, a plain `useRef` — not `useMemo`/
state, since it must survive every render during the session without resetting). On `onCancel`, if
that snapshot was `true`, it calls `onSetLinkEnabled(linkTarget, true)` — the same re-enable path
`LinkStatusIcon` itself uses — which re-propagates the target's value from the link's `source`,
landing back on the same value the plain value-restore already produced (the source didn't move
during the session). If the link was already disabled (or didn't exist) before open, Cancel is a
no-op on link state, same as before #666.

This only applies to `LinkedColorRow`; `LinkedSelectRow` / `LinkedSliderRow` / `LinkedToggleRow` /
`LinkedTextFieldRow` have no live-preview concept at all (no `onPreview` on their underlying rows),
so they have nothing to restore on cancel — every edit there is a direct, final commit.

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
changes from outside this editor (the hex field, or another channel) — the shared `useChannelInputs`
hook tells the editor's own commits (`markSelfEdit`) apart from outside changes so an in-progress
value isn't wiped. Applying commits the working color exactly as in #499.

Other models each add their own button and editor in their own #498 sub-issue.

## HSL model (#501)

Selected via its own toggle button next to **RGB**. `HslModelEditor` renders, top to bottom:

- **2D area** — saturation on X (0 → 100 left → right), lightness on Y (100 → 0 top → bottom),
  painted as a white-to-hue horizontal gradient under a transparent-to-black vertical gradient. A
  crosshair (filled with the working color) sits at `(s, 100 − l)`. Pointer-down anywhere in the
  area jumps the crosshair there and starts a drag; dragging sets S and L together. The drag is
  tracked on `window` so it continues outside the area bounds and clamps to its edges. The area is
  focusable (`role="slider"`, `tabIndex 0`): arrow keys nudge S (← →) and L (↑ ↓) by 1, or 10 with
  Shift, clamped to 0-100.
- **Vertical hue strip** — beside the area, same height, full-spectrum top (0°) to bottom (360°),
  with a horizontal marker at `h / 360`. Pointer-down / drag sets H only; it is focusable too, with
  ↑ / ↓ nudging H by 1 (10 with Shift), clamped to 0-360.
- **Three sliders** — `GradientSlider` for H, S, L. The H slider (0-360) always shows a fixed
  full-spectrum track (hue swept at S 100 / L 50) so it stays readable even when the working color
  is achromatic; the S track (0-100) sweeps grey → fully saturated; the L track (0-100) is a
  three-stop black → working color → white.
- **Three numeric inputs** — H 0-360, S 0-100, L 0-100, paired with the sliders. Same
  `useChannelInputs` text-buffer behavior as the RGB inputs (emptied field not forced back mid-edit;
  buffer dropped on blur and on an outside color change). Values are clamped to range; a typed
  range clamp gets a field-anchored hint on blur. Slider and gamut clamps do not show hints.

HSL is held in `HslModelEditor`'s own state as the source of truth — packing to RGB and reading it
back would lose hue at an achromatic S/L edge and jitter the other channels through 8-bit rounding,
so moving one control never disturbs the others. On an outside `color` change (shared hex field,
model switch) `useChannelInputs`'s `onExternalChange` re-seeds that state from the packed RGB; the
editor's own commits call `markSelfEdit` so they aren't mistaken for outside changes. Every control — the area, the hue strip, each slider, each input, and the
shared hex field — stays in sync on every change. Conversion is exact sRGB HSL ⇄ RGB (`colorToHsl`
/ `hslToColor`, hue wraps mod 360 on pack, s/l clamp); reopening the picker reconstructs HSL from
the stored RGB (an achromatic color comes back with `h = 0`). Applying commits the working color
exactly as in #499.

## OKLCH model (#502)

Selected via its own toggle button next to **HSL**. `OklchModelEditor` renders, top to bottom:

- **2D area** — chroma on X (0 → `OKLCH_MAX_CHROMA` left → right), lightness on Y (100 → 0 top →
  bottom), at the current hue. Painted per-pixel onto a small `<canvas>` (`AREA_COLS`×`AREA_ROWS`,
  CSS-scaled up) via `oklchToSrgbSample` — every cell is just its gamut-clamped sRGB color, the
  area is not marked (the C slider track carries the gamut boundary). Repainted whenever the hue
  changes. A crosshair (filled with the working color) sits at `(c / OKLCH_MAX_CHROMA, 100 − l)`.
  Pointer-down jumps there and starts a drag (tracked on `window`, clamps to the edges). Focusable
  (`role="slider"`, `tabIndex 0`): arrow keys nudge C (← →, ±0.005 / ±0.05 with Shift) and L
  (↑ ↓, ±1 / ±10 with Shift), clamped.
- **Vertical hue strip** — beside the area, same height, full hue sweep (0° top to 360° bottom) at
  a fixed high L / C, with a horizontal marker at `h / 360`. Pointer-down / drag sets H only;
  focusable, ↑ / ↓ nudge H by 1 (10 with Shift), clamped to 0-360.
- **Three sliders** — `GradientSlider` for L (0-100%), C (0-`OKLCH_MAX_CHROMA`), H (0-360°), each with a
  per-channel gradient track (that channel swept across its range, the other two fixed), each
  paired with a numeric input of the same range (C to 4 decimals).

Every control stays in sync on every change; Applying commits the working color exactly as in
#499.

Because OKLCH can express colors outside the sRGB gamut, the C slider track marks the
out-of-gamut region (hatched + dimmed past the sRGB limit for the current L and H, computed by
`oklchMaxChroma`) and a persistent centered badge below the sliders reads "Converts to sRGB
precisely" or "Converts to sRGB imprecisely" per `oklchInSrgb` (always mounted so it never
reflows the panel). The 2D area itself is not marked — every cell is just its clamped sRGB color.
The committed value
is always the gamut-clamped sRGB color (`oklchToColor`); reopening the picker reconstructs OKLCH
from that stored RGB, so channels may shift slightly after a clamp.

OKLCH is held in `OklchModelEditor`'s own state as the source of truth — the committed color is
the gamut-clamped sRGB value, so packing to RGB and reading it back would drift the other
channels after a clamp. On an outside `color` change (shared hex field, model switch)
`useChannelInputs`'s `onExternalChange` re-seeds that state from the packed RGB; the editor's own
commits call `markSelfEdit`. Conversion is OKLCH ↔ OKLab ↔ linear sRGB ↔ sRGB per the CSS
Color 4 / Bjorn Ottosson definitions.

## Project colors block (#503)

The last section in `ColorPickerPanel`'s content, below the active model editor, recently-used
colors, and Tools block. A collapsible
section (`SectionHeader`, same as the export panels), **collapsed by default**, titled
"Project colors (N)" / "Цвета проекта (N)" where N is the total row count.

Rows come from two sources, shown as two groups split by a divider:

- **Top group** — an optional **"Default" row** followed by the call site's `priorityColors`.
  - The "Default" row (label from `color_picker.project_colors_default`, generic — no field name)
    is this field's factory default, threaded as `ColorRow` → `ColorSwatch` → `ColorPickerPanel`'s
    `defaultColor?: number` (subsections pass `defaultColors` / `*Default` props). Read from
    `DEFAULT_VECTOR_BY_WALLS_SETTINGS` / `DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS`. Always first,
    always unique (its generic name never collides with a profile row's `Section: Role` name, so
    it survives de-dup even when its color equals a profile row's). Omitted when the field has no
    meaningful default (`defaultColor` unset).
  - Then `priorityColors` (threaded as `priorityColors?: ProjectColorEntry[]`), in the given
    order — the sibling colors that matter for *that* color decision (e.g. the other marker's
    fill/border, the floor or corridor color). May be empty.
- **Bottom group** — the color fields of the currently active export profile
  (`selectActiveProfileColors`), i.e. the profile the picker was opened from.

**Inactive fields are absent, not greyed.** The field registry is the single source of truth for
what a color field *is* (GitHub issue #717): `pixi/selectors/colorFieldRegistry.ts` (i18n-free)
holds `STATIC_FIELD_DEFS: Record<StaticColorFieldKey, ColorFieldDef>` — for every field its
`visible(ctx)` predicate, `get(settings)` value reader and `set(settings, color)` writer. Because it
is a `Record` over the key union, a field without a predicate, getter or setter does not compile.
`PC.*` (`projectColorsSelector.ts`) adds only the localized names and `ColorField.isVisible(ctx)`
(delegating to the registry). `ctx` is a `ColorVisibilityContext` from
`buildColorVisibility({ nodes, edges, floors }, settings)`, built from the *unscoped* project graph
(a floor switch never changes the answer) plus the settings that gate rows. Predicates cover: mode
(`tilesFloor`/`tilesWall`/`innerGrid`/decorative fields exist only in Vector by walls, `corridorFill`
only in Vector by corridors); grid color when `showGrid` off; `Ячейки: Стена` when
`randomWallColorMode !== "off"`; one-way indicator color with no directional edge; every teleport
color when no `teleport` edge; connector color when `teleportConnectorStyle === "none"`; floor-badge
colors without a cross-floor teleport; split slot `i` when `i >= slotCount`; per-group teleport
overrides unless `teleportGroupCustomization`; vertical colors per two-way/one-way/elevator presence
and `verticalStyle`; start/finish text when `textEnabled === false`; elevator floor-badge colors
unless `elevatorBadges.enabled`; the marker-index section when the maze has no teleport / vertical passage / elevator edge (`markerIndexAvailable`, GitHub issue #730 — independent of coverage) or the layer is off, its border when
`borderColorFromMarker` is on.

**Every consumer goes through the registry, and bypassing it does not compile:**

- **Export warnings** read colors only as `VisibleColor` — a branded `{ value, field }` that
  `visibleColor(ctx, key)` mints, returning `null` for a hidden field or one with no value. The
  contrast `ContrastEntry`/`ContrastPair` accept nothing but `VisibleColor | null`, and an entry with a
  `null` side is dropped, so a warning about a hidden color cannot be written (raw `settings.xColor`
  numbers do not type-check). The brand also carries the field key, so a warning's fields are always
  the fields of the colors it compared. `unownedColor(value)` is the single explicit escape for a color
  no field edits (a split passage without a slot); it has no field and is never hidden. Warnings use a
  context built from the *unscoped* graph (`warningVisibility`) — a floor-scoped edge list cannot tell
  a two-way passage from a one-way one.
- **Settings panels** wrap their content in `ColorVisibilityProvider`; `ColorRow`/`LinkedColorRow`
  take a required `field` and render disabled when `!field.isVisible(ctx)`, so a call site cannot
  decide a color's state itself. A color that is not a project field uses `UnregisteredColorRow`
  (background-image auto-fill color). Section gates (`hasOneWays`, `hasTeleports`,
  `hasCrossFloorTeleports`, `hasTwoWayPassages`, `hasOneWayPassages`, `hasElevators`) are read from the
  one `colorVisibility` memo; the wall-color/palette switch and the teleport connector block ask the
  field predicate directly. Layout blocks that hold color rows next to other controls (the decorative /
  abstract vertical-style sections) are wrapped in `LayoutGate gate="…"`; `LAYOUT_GATES` in the registry
  defines each gate once and the color predicates build on the same entries, so a block and its colors
  cannot disagree. Panels never test `settings.verticalStyle` themselves. The own enable toggles of
  marker indices / elevator badges stay as the controls' state; the renderers read settings directly
  to draw (not forbiddable by type), but visibility questions go through the registry.
  Dynamic keys (`splitNode:<i>`, `teleportGroup:<i>:<role>`) are decoded in one place,
  `parseColorFieldKey` (`pixi/colorFieldKeys.ts`).
- **The list and the live preview**: `selectActiveProfileColors` walks `STATIC_FIELD_ORDER`
  (three key tables around the two dynamic groups: per-group teleport overrides and split-node
  slots; a test checks every static key appears exactly once) and keeps `visibleColor !== null`.
  `overrideActiveProfileColor` writes through the same registry (`writeColorField`).

**Priority list is filtered to the active set too.** `ColorPickerPanel` drops any `priorityColors`
entry whose field `key` is not in the bottom group's active-key set — one filter covers all call
sites, so a call site may pass a sibling color that turns out inactive without leaking it.

**Progressive disclosure.** Initially only the top group shows, plus a `Показать все` /
`Show all` secondary button (standard `Button` style, like Analytics' "Подробный отчёт"). Click
reveals the divider + bottom group + a `Скрыть не связанные цвета` / `Hide unrelated colors`
button at the end that collapses it again. Button absent when the bottom group is empty.

**Entry names.** Every row name is `Section: Role` (or `Section: Sub-section: Role`) — the word
"color" is left out, since every row is a color. Both sides are built from one registry in
`projectColorsSelector.ts`:

```ts
export const PC = { bgFill, bgGrid, corridorFill, tilesFloor, tilesWall, startFill, startBorder,
  teleportEdge, elevatorBadgeText, markerIndexFill, /* … ~40 keys … */ splitNode(i) };
// each field:  PC.<key>.key: ColorFieldKey         -> stable, never translated (the property name;
//                                                     `splitNode:<i>`, `teleportGroup:<i>:<fill|border>`)
//              PC.<key>.name(): string            -> localized "Section: Role"
//              PC.<key>.at(color): ProjectColorEntry  ({ key, name, color })
// resolveColorField(key): ColorField | null        -> registry lookup by key
```

Field **identity is the `key`** (GitHub issue #717): self-row exclusion, between-group de-dup,
priority-list filtering, the live warning preview and the warnings' field references all use it —
never the translated name, which exists only for display. The keys live in `pixi/colorFieldKeys.ts`
(no i18n dependency) so the renderer-agnostic `exportWarnings.ts` can name fields by key too.

Section/role labels are `color_picker.entry.section.*` / `color_picker.entry.role.*` messages
(e.g. `Фон` / `Заливка`). The one section label that is *not* an `entry.section.*` key is
`splits`, which reuses the settings panel's own `image_export.vector_by_walls.section_splits`
("Разделения" / "Splits") so the color name can't drift from the panel heading.
`selectActiveProfileColors` builds every
bottom-group row via `PC`; each call site builds its `priorityColors` entries (`PC.<key>.at(v)`)
and its `field` (the `PC.<key>` object) from the same registry, so a call site never hand-assembles
a `Section: Role` string and the names always match. The dynamic
split-node slots are `PC.splitNode(i)` (0-based). A per-teleport-group override color is
`PC.teleportGroup(index, role)` — the group's internal `key` (an unstable coordinate-pair string)
isn't a human-facing name, so the row is named by the group's 1-based *display* order instead
(`Телепорты: Группа 1 заливка` / `… рамка`) — the selector sorts `teleportGroupOverrides`' keys by
the same `key.localeCompare` `buildTeleportGroups` uses for the settings panel's own group list, so
a color's "Группа N" always matches the row numbered N there. GitHub issue #503 follow-up.

**Mode-gated members within one section** (GitHub issue #668) — `PC.verticalFill`/`PC.verticalArrow`/
`PC.verticalDecorLine` (`vertical` section, label "Верт. общий стиль" / "Vert. shared style") are the
"Vertical connections" section's own vertical-"Shared style" colors (see `image-export.md`'s "Vertical
'Shared style' group"). Unlike every other section above, whether a *specific* member shows isn't
just "is the section visible" — `verticalSharedStyleColors` additionally branches on the settings'
own `verticalStyle` ("Vector by corridors" has none, so it's always treated as abstract): the fill/
arrow pair shows only for `"abstract"`, the line color only for `"decorative"`, mirroring the panel's
own per-field visibility inside that subsection rather than listing every member whenever the section
itself is on.

De-duplication is **only between groups**: a bottom row whose exact field `key` + `color` pair already
appears in the top group is dropped. Never dedup by color value alone. Divider shown only when
both groups are non-empty and the bottom group is expanded.

Clicking (or Enter / Space on) any row sets the working color — `setWorking` + hex-input sync +
`preview` — it does **not** commit (Apply still commits, per #499/#513). Rows are lightweight
`role="button"` divs (`ProjectColorRow`), not nested `ColorSwatch` (which would open another
picker); the `.project-color-row` class (`global.css`) gives them a pointer cursor, a hover
background and a focus-visible outline, since inline styles can't express `:hover`.

The panel's preview block is `flex-shrink: 0`, so expanding the list scrolls the panel content
(the `content` div is `overflow-y: auto`) rather than compressing the preview.

**Edited field awareness.** The panel knows the name of the field it was opened for
(`field?: ColorField`, threaded `ColorRow` → `ColorSwatch` → `ColorPickerPanel`; a color outside the
registry passes none and the header falls back to the row's `label` via `fallbackName`). It is used
three ways:

- **Header** — the picker title is `field.name()` (e.g. "Фон: Заливка") when set, else `fallbackName`,
  else the plain `color_picker.title`.
- **Self-row exclusion** — a project-color row that *is* the edited field (`entry.key === field.key`)
  is dropped from both groups, so the field can't list its own current value. Runs before the
  "Default" row is prepended and before between-group de-dup.
- **Export warnings** — see below.

**Export color warnings.** When `showColorWarnings` is enabled, the picker also shows warnings for
the edited field's current working color. The active export renderer (`Vector by walls` or `Vector
by corridors`) is evaluated with the working value applied to a cloned settings object, so changing
either color updates the warning immediately without changing the store before Apply. Warnings use
the renderer's existing applicable rules. Each `ExportWarning` carries `fields: ColorFieldKey[]` —
the keys of every color field it concerns — and the picker keeps a warning iff `fields` contains the
edited field's key (GitHub issue #717; no role tables, no name matching, no color-value matching).
The live preview is `overrideActiveProfileColor(state, field.key, working)`, which matches the field
by key too. A field can appear in several warnings: start/finish/elevator-badge fill is both a marker
fill (against the surface) and the background of its caption (`label_low_contrast`), so its picker
shows both.

**Which field a warning attaches to** (GitHub issue #717): always the field whose value is
*effectively drawn*. A colour reached through a parameter link is attributed to the receiving field
(the one the renderer reads), not to the link source. A per-group teleport override colour is
attributed to that group's override field (`teleportGroup:<i>:<role>`) while the group overrides
that role, and to the shared teleport field otherwise. A split colour is attributed to its slot
(`splitNode:<i>`). Warnings are grouped per (kind, foreground field, background field) — never per
colour value alone — so two fields sharing a hex stay separate warnings, and the same pair on several
floors merges into one. The one exception is `split_colors_low_contrast_each_other`, a single warning
for the whole split palette that lists every offending slot field. A colour with no owning field
(a split passage without a slot) yields a warning with no `fields`, shown in the export panel only.

The warnings panel's explanation ("The colour X is too close to Y") builds X and Y from
`ColorField.name()` of `colorFields` (the compared foreground/background), so it names fields exactly
as the picker does.
Start/finish caption colors (`PC.startText`/`PC.finishText`) are listed in "Project colors" only while the caption is drawn (`textEnabled !== false`); they are priority colors of the marker's own fill/border and of each other, and the elevator badge text lists the badge fill and border. The entries reuse the export settings panel's warning
bubble appearance, but omit the info button and are not clickable (there is no details modal). This
block is separate from the export settings panel's Problems section; its visibility follows
`showColorWarnings` and it supports both vector renderers.

When enabled, the picker renders this content in its own collapsible "Warnings (N)" section. The
section remains visible with `N = 0`, uses the warning attention color when `N > 0`, starts collapsed,
and indents its bubbles like other section content. When `showColorWarnings` is disabled, the whole
section is hidden.

If the active profile has no color fields (`openRenderModeSettings` null, or an empty list) and
`priorityColors` is empty, the section is omitted.

`ColorPickerPanel` selects the raw store inputs (`openRenderModeSettings`,
`vectorByWallsSettings`, `vectorByCorridorsSettings`, `nodes`, `edges`, `floors`) individually and
rebuilds the list in a `useMemo` — `selectActiveProfileColors` allocates fresh objects each call,
so subscribing to it directly would break `useSyncExternalStore`'s identity check (infinite render
loop).

**Call sites** pass their own priority lists: `VectorByWallsSettingsPanel`,
`VectorByCorridorsSettingsPanel`, and the shared subsection components
(`TeleportSettingsSection`, `MarkerSettingsGroup`, `MarkerIndexSection`,
`ElevatorBadgesSubsection`, `DecorativeLineStyleGroup`) — each takes typed priority props, factory
defaults, and per-row `*Field` registry fields (`PC.<key>`) for its `ColorRow`s. The compact per-teleport-group
override swatches (`ColorSwatch` in `TeleportGroupRow`) are not wired. Guiding rule for the lists: `floorColor` (walls mode) / `color` (corridors mode) is
the near-universal neighbor; `background` only where geometry actually touches it (outer walls in
walls mode; corridor stroke + one-ways in corridors mode); `wallColor` where a marker abuts a wall.

## Recently used colors (#506)

Below the active model editor, above the Tools block, separated from the model editor by the same
divider style as the other sections. **Not collapsible** — a single row of swatches, titled
"Recently used" / "Недавно использованные" (`color_picker.recent_colors`). Omitted entirely when
the list is empty (no localStorage entry yet, or storage unavailable).

The list holds the last `MAX_RECENT_COLORS` (12) colors committed via **Apply**, from *any*
swatch across the app, most-recent-first, de-duplicated (re-applying an already-listed color moves
it to the front instead of adding a second entry). Managed by
`components/recentColorsStore.ts`: `pushRecentColor(color)` (called from `apply()` in
`ColorPickerPanel`, after the queued preview frame is flushed but before `onApply`) and
`loadRecentColors()`, both wrapped in try/catch — a read/write failure (storage unavailable, quota,
corrupt JSON) degrades to an empty list rather than throwing. Same imperative-store +
`useSyncExternalStore` pattern as `pixi/imageExport/screenCalibration.ts`, so a color applied in
one picker session shows up immediately in a picker still open in the same tab; not synced across
browser tabs.

Stored in `localStorage` under `colorPicker.recentColors`, **global to the app, not per project**
— it's a session convenience, not project data, so the project file is untouched.

Clicking a swatch sets the picker's working color only (same path as a project-color row or a
Tools swatch) — it does not commit; Apply still commits as in #499.

## Tools block (#504, #505)

`ToolsSection` (`components/ToolsSection.tsx`) sits below the active model editor and the
recently-used-colors row (above the Project colors section) in `ColorPickerPanel`, separated from
what's above by the same divider style as the project-colors groups. A
collapsible section (`SectionHeader`, collapsed by default), titled "Tools" / "Инструменты".
Originally two separate sections — "Harmony" (#504) and "Tonal ramp" (#505) — merged into one
"Tools" section with a single type dropdown, then generalized (see "Type selector" below) so the
old Analogous/Monochromatic/Tonal-ramp special cases collapse into two universal, scale-driven
tools.

**Base color.** The section keeps its own base color, seeded from the color the panel opened with
(`seedColor`) and otherwise independent of the working color — editing the type selector or any
slider never touches it. **Expanding the section** re-seeds the base from the picker's *current*
working color (not the stale open-time `seedColor`), so reopening a section that was left expanded
from a prior tweak still starts from what's on screen. A **"Rebuild from current color"** button
(bottom of the section, same `Button variant="secondary"` full-width style as project-colors' "Show
all") does the same thing on demand, for any tool type — editing sliders / hex never rebuilds.

**Type selector.** A `SelectRow` (label "Type" / "Тип") picks the tool type, in this order:
Divergence, Range split, Complementary, Split-complementary, Triadic, Tetradic. Every type derives
swatches from the base color's OKLCH triple (`colorToOklch`):

- **Complementary / Split-complementary / Triadic / Tetradic** — the classic fixed-offset
  color-wheel rules: fixed hue offsets from the base (180°; 150°/210°; 120°/240°; 90°/180°/270°),
  lightness and chroma otherwise unchanged (`fixedOffsets`). Rendered as a single row, base color
  first, `data-testid="color-picker-tools-swatches"`.
- **Divergence** ("Divergence (OKLCH)" / "Расхождение (OKLCH)") — generalizes the old Analogous
  (Hue) and Monochromatic (Lightness) tools, adding Chroma as a third case. A `SelectRow` picks the
  **scale** (Hue / Lightness / Chroma — `color_picker.tools.scale.*`), the other two OKLCH channels
  stay fixed at the base's own values. Two independent rows, labeled "+" / "-", each with its own
  shared `count` (1-10) and `step` slider (range and format depend on the scale: degrees for Hue,
  0-50 for Lightness, `0..OKLCH_MAX_CHROMA/2` to 3 decimals for Chroma). Row *N* holds `count`
  swatches at `step, 2*step, … count*step` off the base on that row's side of the chosen scale
  (`divergenceOffsets`); the base itself is not a swatch in either row. Hue only gets an auto-fit
  button (`Maximize2` icon, in the step slider's `resetButton` slot) that sets
  `step = min(60, 180 / count)` — the largest step that still fits `count` steps within 180° from
  the base, capped at the slider's own max (`autoFitHueStep`); Lightness and Chroma have no natural
  full-span target the way Hue's 180°-opposite point does, so they have no auto-fit control.
- **Range split** ("Range split (OKLCH)" / "Разбиение диапазона (OKLCH)") — generalizes the old
  Tonal ramp (Lightness only). A `SelectRow` picks the **scale**; a `count` slider (3-12, default 7)
  and, for Lightness/Chroma, **min/max sliders** (each with a `RotateCcw`-icon reset-to-auto
  button, `color_picker.tools.reset_auto`) set the split range — defaulting to an auto range per
  scale (`RANGE_SPLIT_AUTO_MIN`/`MAX`: L 15-95, C 0-`OKLCH_MAX_CHROMA`). Hue has no min/max
  sliders — its range is always the full 0-360° circle starting at the base hue (wrapping), so the
  base's own hue is implicitly one endpoint. `count` swatches are spaced evenly across
  `[min, max]` inclusive (`rangeSteps`) — the base's own value isn't necessarily one of them.
  Rendered as a single row, `data-testid="color-picker-range-split-swatches"`.

**Gamut safety.** Rotating hue or shifting lightness can push the base's chroma out of the sRGB
gamut at the new `(l, h)`; `oklchToColor`'s per-channel clamp would then shift the *hue* as a side
effect instead of just desaturating. Every Hue/Lightness-scale swatch instead goes through a
gamut-safe helper (`gamutSafeSwatch`) that scales the base chroma down by the ratio of the sRGB
gamut's chroma ceiling (`oklchMaxChroma`) at the swatch's `(l, h)` to the ceiling at the base's own
`(l, h)` — fading chroma out gradually as a swatch approaches the gamut edge, rather than an abrupt
cut right at the boundary, while always keeping hue exact. A Chroma-scale swatch bypasses this
ratio scaling (it *is* the chroma being swept) and is instead clamped directly to
`[0, oklchMaxChroma(baseL, baseH)]` so an explicit chroma value isn't silently rescaled
(`swatchAt`).

**Persistence.** The picked type and each type's own tuning (Divergence's per-scale count/step,
Range split's per-scale count/min/max) are kept in a module-level object outside the component, so
they survive the section remounting on every picker open/close — switching type (or scale) and
back restores that combination's last-used values. Not backed by `localStorage`; lives only for
the page's lifetime, shared across every field's picker (a single global "last used tool setup",
not per-field).

Clicking any swatch sets the picker's working color only (same path as a project-color row) — it
never commits and never rebuilds the row(s).

## Canvas eyedropper (#507)

A `Pipette`-icon button sits in the hex field's `resetButton` slot (`ColorPickerPanel`), toggling
**sampling mode** — local `sampling` React state, no store involvement. While active:

- `ColorEyedropperOverlay` portals a full-viewport capture `div` (`z-index` above everything) to
  `document.body` — above the whole app, not just the side-panel slot, since the canvas sits
  outside it.
- The cursor becomes a crosshair over the Pixi canvas (plain cursor elsewhere).
- A loupe follows the pointer: a small `<canvas>` paints a magnified region read via the same
  bridge's `sampleRegion` (`extract.pixels()` on a small odd-sized square centered on the sampled
  pixel, scaled up nearest-neighbor onto the loupe canvas at `LOUPE_ZOOM = 12`), plus a crosshair
  mark and the sampled pixel's hex — both derived from that same `sampleRegion` read (via
  `colorAtCenter`, exported from `ColorEyedropperOverlay.tsx`), not a second `sampleAt` call, so
  each pointer move costs one `extract.pixels()` GPU readback, not two. The live Pixi canvas
  element itself is never `drawImage`'d directly — it isn't `preserveDrawingBuffer`, so its buffer
  reads back blank/black outside the render tick.
- Clicking inside the canvas reads the color and sets the picker's working color (same path as a
  project-color row or Tools swatch — does not commit; Apply still commits). Escape or a click
  outside the canvas cancels with no change. The picker panel stays open throughout either way.

**`colorSampleBridge.ts`** — same tiny imperative-bridge shape as `viewportScaleBridge.ts`: the
picker has no scene access of its own (reached through `ColorRow` → `ColorSwatch` →
`ColorPickerPanel` with no props for it), so `App.tsx` registers a `ColorSampler` (`{ canvas,
sampleAt, sampleRegion }`) once `MazeScene` is ready, and tears it down on unmount.
`sampleAt(clientX, clientY)` and `sampleRegion(clientX, clientY, radiusPx)` both convert client
coordinates into the canvas's own pixel space (canvas rect + device pixel ratio) and call
`MazeScene.sampleColorAt` / `sampleRegionAt`, which read via the renderer's
`extract.pixels({ target: app.stage, frame })` — the actual on-screen stage, not the maze model, so
they pick up backgrounds, grid, and everything else drawn. `sampleColorAt` reads a 1×1 region and
packs it to 24-bit RGB; `sampleRegionAt` reads a `2*radiusPx + 1` square of raw RGBA (clamped to
the canvas bounds near an edge) for the loupe to paint — an odd side length so the sampled pixel
(the same one `sampleColorAt` would return) sits at a single, unambiguous index in the region, not
on a boundary between two pixels (which an even-width region has no single center pixel for). The
returned `PixelRegion` carries that index as `centerX`/`centerY` (equal to `radiusPx` unless the
region was clamped near a canvas edge, in which case it shifts with the clamp) — the loupe reads
the sampled color straight out of the region at that index instead of issuing a second
`extract.pixels()` call. Both `sampleAt`/`sampleRegion` return `null` for a point outside the
canvas.

## Shared row primitive

`TextFieldRow` (`components/TextFieldRow.tsx`) is a labeled single-line text input row, mirroring
`ColorRow` / `SelectRow` / `ToggleRow` (label `flex: 1` + fixed-width control + optional
`resetButton`). Its field is sized to `controlRowHeight` via `sharedStyles.textFieldSm`. `invalid`
renders an error border + `aria-invalid`. Introduced for the picker's hex field; usable for any
free-text param.

## Not yet implemented (later #498 sub-issues)

Further color models, palette generation,
contrast / distinguishability / color-blindness checks, presets.
