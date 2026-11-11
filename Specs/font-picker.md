# Font Picker

Side panel for choosing a canvas label font, the counterpart of the color picker
(`Specs/color-picker.md`). Part of the font picker epic (GitHub issue #969); this spec covers the
**base panel** (issue #970). Weight selection, font previews, layout warnings and further font
sources are separate tickets of the epic.

## Components

| Component | Role |
|---|---|
| `FontPickerPanel` (`components/FontPickerPanel.tsx`) | The panel. An overlay `SidePanel` (same overlay mode as `ColorPickerPanel`). Holds the working family in local state. Props: `family`, `onApply`, `onClose`, `onPreview?`, `onCancel?`, `title?`. |
| `FontButton` (`components/FontButton.tsx`) | The visible control: a button showing the current font name (`Roboto` for the default family). Opens the panel. Same `onChange` / `onPreview` / `onOpen` / `onCancel` contract as `ColorSwatch`. |
| `FontRow` (`components/FontRow.tsx`) | Label + `FontButton` + optional trailing `resetButton`, mirrors `ColorRow`. |
| `LinkedFontRow` (`components/features/LinkedRows.tsx`) | `FontRow` with the link-status icon. Like `LinkedColorRow`, it snapshots whether the incoming link was enabled on open and re-enables it on Cancel. |
| `FontFamilyRow` (`components/features/FontFamilyRow.tsx`) | The one font control every text settings group renders (markers, badges, marker index, floor labels, Shared style). Call sites pass only `value`, `onChange`, `linkTarget`; loading, stale-request guarding and cancel ordering live here, so no call site duplicates them. |
| `loadLocalFontFamilies` (`pixi/renderers/labelFont.ts`) | Sorted, de-duplicated families installed on this machine via the Local Font Access API (`queryLocalFonts`). Resolves to `null` when the API is missing or access is denied. Cached for the page lifetime. |

## Stored value

A font is stored as a plain family string (`textFontFamily`, `labelFontFamily`; see
`Specs/image-export.md`, "Font family"). The empty string is the bundled MSDF Roboto (vector); any
other value is a browser (raster) font. The panel derives the font type from the value, so no extra
field exists: vector is `""`, raster is every other family.

## Panel

Contents, top to bottom:

- **Type toggle** — "Vector" / "Raster" toggle buttons (`toggle` / `toggle-selected`), plus an info
  button (`InfoIconButton`) opening a `CategoryInfoModal` that explains the practical difference
  between the two categories. The panel opens on the list that holds the current family.
- **Font list** — a single-select listbox of the active category:
  - Vector: the single default font, Roboto (value `""`).
  - Raster: every family installed on this machine (`loadLocalFontFamilies`). The open-time family is
    kept at the top of the list when the machine does not report it, so a project saved elsewhere
    still shows its current choice highlighted.
  - While the local query is pending the raster list shows a loading hint.
  - When the machine's list is unavailable (no API, permission denied, or an empty answer, which is
    how some browsers report a denial) the raster list holds the members of `WEB_SAFE_FONT_FAMILIES`
    (Arial, Verdana, Georgia, Times New Roman, Courier New and similar) that this machine actually
    has (`isFontFamilyInstalled`, a synchronous glyph-metrics check), and a hint under the list asks
    the user to grant the permission to see the full list of local fonts. The vector list never
    shows the hint.
  - The list is a `listbox` that keeps focus; `aria-activedescendant` names the highlighted option.
    Switching the type remounts the list so it takes keyboard focus again.
  - The hint comes with a **"Grant access"** button when the browser has the API: it calls
    `loadLocalFontFamilies(true)` (a retry from a user gesture), which re-prompts if the browser still
    allows it and replaces the list with the full local one on success. If the retry still gives no
    list the browser has blocked the site, no second prompt can appear, and the hint changes to ask the
    user to allow local fonts in the site settings and reload (a page cannot open browser settings).
    A browser without the API shows a plain "cannot list local fonts" note and no button.
- **Footer** — Cancel and Apply, each half-width.

Switching the type only changes which list is shown; the highlighted font is unchanged until the user
picks one.

### Keyboard

The listbox takes focus on mount. Up / Down arrows move the highlight to the previous / next font,
clamped at both ends (with nothing highlighted, Down selects the first and Up the last font). Every
move previews the font like a click, except that the canvas preview is coalesced: the highlight follows every key press (including auto-repeat), but `onPreview` fires once after the moves pause for `KEYBOARD_PREVIEW_DELAY_MS` (100 ms), and Apply flushes a still queued one first, so holding an arrow key does not rebuild the canvas per repeat. List rows are memoized, so a move re-renders only the two rows whose selection changed. Escape cancels, same as the Cancel button.

## Preview and commit

Same model as the color picker's live preview. Every highlight change calls `onPreview`, so the canvas
shows the font before confirmation. Cancel, the header close button and Escape call `onPreview` once
more with the open-time family, then `onCancel`, then `onClose`.

`FontButton` defaults `onPreview` to `onChange`: the live stream is the commit and Apply only closes
the panel. With a distinct `onPreview`, Apply is the single `onChange` commit.

`FontFamilyRow` supplies `onChange` and handles font loading:

- the default, already-loaded and open-time fonts (`FontFamilyRow` records the open-time one through
  `onOpen`, so a project font this machine lacks is restored by Cancel too, rendering as Roboto
  until it loads) apply synchronously, so Cancel's restore lands before
  `onCancel` re-enables a link (the link must not be re-disabled by a late restore);
- a font that still has to load applies once `loadLabelFontFamily` settles, and only the latest
  request is applied, so a fast arrow-key sequence cannot leave an older font on the canvas.

## Not yet implemented (later epic tickets)

Weight selection inside the panel, a preview area, text layout and size warnings, user-uploaded
fonts, MSDF atlases built from raster fonts.
