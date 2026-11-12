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
| `loadLocalFontFamilies` (`pixi/renderers/labelFont.ts`) | Sorted, de-duplicated families installed on this machine via the Local Font Access API (`queryLocalFonts`). Resolves to `null` when the API is missing or access is denied. Cached for the page lifetime; the reported names are also remembered so `isFontFamilyInstalled` accepts them. |

## Stored value

A font is stored as a plain family string (`textFontFamily`, `labelFontFamily`; see
`Specs/image-export.md`, "Font family"). The empty string is the bundled MSDF Roboto; any
other value is an installed TTF/OTF font drawn by the browser. The panel derives the font type from the value, so no extra
field exists: MSDF is `""`, TTF/OTF is every other family.

## Panel

Contents, top to bottom, in two non-collapsible sections. Each has a plain `typography.body` header
and a body indented by `indent.tree`:

- **"Preview" section** (GitHub issue #972) — first: a text input for a custom phrase, a box that
  renders the phrase (the input starts with "Lorem ipsum" in every UI language) in the highlighted font on a single
  line of constant height (48 px, text centered vertically, clipped with an ellipsis), and two color
  rows (`UnregisteredColorRow`) for the preview's text color and background color (defaults are the
  panel's own input background and primary text, so the preview matches the project style; local to the
  panel, never stored or previewed on the canvas). The text size is a fixed 32 px (`PREVIEW_FONT_SIZE`),
  independent of the size setting being edited. MSDF (`""`) renders as Roboto; TTF/OTF uses the family name. The family is set on the text element
  itself, because the global `* { font-family }` rule overrides an inherited one.

  **Preview and canvas share their font rendering.** A TTF/OTF font is shown in DOM text with the stack
  `labelFontFamilies` / `labelFontCss` (`labelFont.ts`): the chosen family, then `sans-serif`. The canvas
  `Text` and the fit measuring use the same stack, so a glyph the chosen font lacks (Cyrillic in a
  Latin-only face) falls back to the same face in both. The MSDF font cannot be shown by the DOM, so
  while it is highlighted the preview is a small pixi canvas (`MsdfFontPreview`) drawing the phrase as a
  `BitmapText` over the baked atlas, exactly like the maze canvas. It owns one pixi application for the
  lifetime of the panel and only rewrites text and colors. When a WebGL canvas cannot be created it
  falls back to DOM text in Roboto. Still different by nature: the canvas rasterizes TTF/OTF text at
  `min(devicePixelRatio, 2)` and the preview is crisp DOM text; the preview ignores the font weight
  setting and any label text transform (uppercasing).
  The preview text is not selectable. A phrase wider than the preview is cut with an ellipsis in both
  variants (CSS `text-overflow` for DOM text, the longest prefix that fits with "…", found by binary
  search over `truncateToWidth` in `pixi/ellipsisFit.ts`, for the MSDF canvas; computed when the text,
  colors or size change, not on a later panel resize).
- **"Family" section** — second. Its header carries the info button (`InfoIconButton`) opening a
  `CategoryInfoModal` that explains the practical difference between the two categories. The body holds
  the "MSDF" / "TTF/OTF" toggle buttons (`toggle` / `toggle-selected`) and the font list below. The
  panel opens on the list that holds the current family.
  A single-select listbox of the active category:
    - MSDF: the single default font, Roboto (value `""`).
    - TTF/OTF: every family installed on this machine (`loadLocalFontFamilies`). The open-time family is
      kept at the top of the list when the machine does not report it, so a project saved elsewhere
      still shows its current choice highlighted.
    - While the local query is pending the TTF/OTF list shows a loading hint.
    - When the machine's list is unavailable (no API, permission denied, or an empty answer, which is
      how some browsers report a denial) the TTF/OTF list holds the members of `WEB_SAFE_FONT_FAMILIES`
      (Arial, Verdana, Georgia, Times New Roman, Courier New and similar) that this machine actually
      has (`isFontFamilyInstalled`: a name the machine already reported through the Local Font Access API,
      or a synchronous glyph-metrics check that probes a Latin and a Cyrillic string separately, so a face
      covering only one script still counts), and a hint under the list asks
      the user to grant the permission to see the full list of local fonts. The MSDF list never
      shows the hint.
    - The list is a `SelectableList` (`components/SelectableList.tsx`, see `side-panel.md`'s "Shared list
      and bubble primitives") with `autoFocus` and the font names as its `values`: a `listbox` that keeps
      focus, `aria-activedescendant` names the highlighted option, Up/Down walk the fonts and report a
      `"keyboard"` selection (which the picker previews without the heavy per-key work). Switching the
      type remounts the list (`key={type}`) so it takes keyboard focus again.
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

Weight selection inside the panel, text layout and size warnings, user-uploaded
fonts, MSDF atlases built from TTF/OTF fonts.
