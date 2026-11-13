# Font Picker

Side panel for choosing a canvas label font, the counterpart of the color picker
(`Specs/color-picker.md`). Part of the font picker epic (GitHub issue #969); this spec covers the
**base panel** (issue #970), the **preview** (issue #972), the **weight selection** (issue #973) and the
**text warnings** (issue #971). Further font sources are separate tickets of the epic.

## Components

| Component | Role |
|---|---|
| `FontPickerPanel` (`components/FontPickerPanel.tsx`) | The panel. An overlay `SidePanel` (same overlay mode as `ColorPickerPanel`). Holds the working font (family and weight) in local state. Props: `font`, `onApply`, `onClose`, `onPreview?`, `onCancel?`, `title?`. |
| `FontButton` (`components/FontButton.tsx`) | The visible control: a button showing the current font name and weight (`Roboto, Bold` for the default font; `formatLabelFont`). Opens the panel. Same `onChange` / `onPreview` / `onOpen` / `onCancel` contract as `ColorSwatch`. The button is at least 140 px wide, grows with its text toward the row label up to 65% of the row, and cuts a longer name with an ellipsis. |
| `FontRow` (`components/FontRow.tsx`) | Label + `FontButton` + optional trailing `resetButton`, mirrors `ColorRow`. |
| `LinkedFontRow` (`components/features/LinkedRows.tsx`) | `FontRow` with the link-status icon. Like `LinkedColorRow`, it snapshots whether the incoming link was enabled on open and re-enables it on Cancel. |
| `LabelFontRow` (`components/features/LabelFontRow.tsx`) | The one font control every text settings group renders (markers, badges, marker index, floor labels, Shared style). Call sites pass only `value` (a `LabelFont`), `onChange`, `linkTarget`; loading, stale-request guarding and cancel ordering live here, so no call site duplicates them. |
| `loadLocalFontFamilies` (`pixi/renderers/labelFont.ts`) | Sorted, de-duplicated families installed on this machine via the Local Font Access API (`queryLocalFonts`). Resolves to `null` when the API is missing or access is denied. Cached for the page lifetime; the reported names are also remembered so `isFontFamilyInstalled` accepts them. |

## Stored value

A font is stored as one `LabelFont` value, `{ family, weight }` (`textFont`, `labelFont`;
`pixi/renderers/fontChoice.ts`; see `Specs/image-export.md`, "Font"), because the weights a
font offers depend on the font. `family` is the key of a baked MSDF font (`MSDF_FONTS`; the empty
string is the bundled Roboto) or the name of an installed TTF/OTF font drawn by the browser; `weight`
is a CSS weight, 100..900. The panel derives the font type from the family, so no extra field exists.
Old projects stored the family and the weight separately; they are not migrated and read as the
default font.

## MSDF font loading (GitHub issue #982)

`MSDF_FONTS` is a catalog (font name plus the atlas files of its weights) and costs nothing by itself.
An atlas is downloaded and decoded only when its font is first needed (`loadMsdfFamily`,
`pixi/renderers/msdfLoader.ts`): picked in a font picker, highlighted in the picker preview, or referenced
by the export settings. The last case is `installLabelFontSync` (`store/labelFontSync.ts`): it watches
`vectorByWallsSettings`, `vectorByCorridorsSettings` and `pngExportSettings`, and any `LabelFont` in them
(found at any depth) that names a non-default catalog font starts its download once. It covers every way
settings arrive (project load, visual preset, shared-style link, picker) without needing a font row on
screen. A font referenced by a project therefore loads on open, and the labels switch from Roboto when
it lands. Only the
default Roboto is loaded at startup (`loadMsdfFont`, awaited in `App.tsx`), because every other font falls
back to it. Loaded fonts are cached and a request for the same font shares one download.

- While a font is loading, or after its download failed, `msdfFace` returns the default font's face, so
  labels keep the default font and nothing blocks the UI. `LabelFontRow` applies a picked font once
  `loadLabelFont` settles (a failed load applies the pick and it renders as the default font; a later
  request retries the download).
- A loaded font fires `LABEL_FONT_LOADED_EVENT` (`mazegen:label-font-loaded`, `fontChoice.ts`), like a browser font, so the vector exporters re-render.
- Stored value: `family` is the catalog key, the empty string for Roboto and `msdf:<id>` for every other
  bundled MSDF font (`MSDF_FAMILY_PREFIX` in `fontChoice.ts`), so a locally installed font with the same
  display name is never taken for the bundled one.

## Panel

Contents, top to bottom, in two non-collapsible sections and a weight row. Each section has a plain `typography.body` header
and a body indented by `indent.tree`; the weight row is a single label and select:

- **"Preview" section** (GitHub issue #972) — first: a text input for a custom phrase, a box that
  renders the phrase (the input starts with "Lorem ipsum" in every UI language) in the highlighted font on a single
  line of constant height (48 px, text centered vertically, clipped with an ellipsis), and two color
  rows (`UnregisteredColorRow`) for the preview's text color and background color (defaults are the
  panel's own input background and primary text, so the preview matches the project style; local to the
  panel, never stored or previewed on the canvas). The text size is a fixed 32 px (`PREVIEW_FONT_SIZE`),
  independent of the size setting being edited. MSDF (`""`) renders as Roboto; TTF/OTF uses the family name. The highlighted weight is applied too:
  as the `fontWeight` of the DOM text, and as the baked atlas nearest to the weight for the MSDF
  canvas. The family is set on the text element itself, because the global `* { font-family }` rule overrides an inherited one.

  **Preview and canvas share their font rendering.** A TTF/OTF font is shown in DOM text with the stack
  `labelFontFamilies` / `labelFontCss` (`labelFont.ts`): the chosen family, then `sans-serif`. The canvas
  `Text` and the fit measuring use the same stack, so a glyph the chosen font lacks (Cyrillic in a
  Latin-only face) falls back to the same face in both. The MSDF font cannot be shown by the DOM, so
  while it is highlighted the preview is a small pixi canvas (`MsdfFontPreview`) drawing the phrase as a
  `BitmapText` over the baked atlas, exactly like the maze canvas. It owns one pixi application for the
  lifetime of the panel and only rewrites text and colors. When a WebGL canvas cannot be created it
  falls back to DOM text in Roboto. Still different by nature: the canvas rasterizes TTF/OTF text at
  `min(devicePixelRatio, 2)` and the preview is crisp DOM text; the preview ignores any label
  text transform (uppercasing).
  The preview text is not selectable. A phrase wider than the preview is cut with an ellipsis in both
  variants (CSS `text-overflow` for DOM text, the longest prefix that fits with "…", found by binary
  search over `truncateToWidth` in `pixi/ellipsisFit.ts`, for the MSDF canvas; computed when the text,
  colors or size change, not on a later panel resize).
- **"Family" section** — second. Its header carries the info button (`InfoIconButton`) opening a
  `CategoryInfoModal` that explains the practical difference between the two categories. While the MSDF
  list is shown it also carries a copyright button (`InfoIconButton` with a lucide `Copyright` icon as `symbol`, GitHub issue #982)
  opening `FontLicensesModal`: for every bundled MSDF font its name, copyright line, license name and
  source link (`FONT_NOTICES`, `components/fontLicenses.ts`), then the full texts of the licenses in use
  (SIL OFL 1.1, Apache 2.0) in collapsed sections. The texts are static assets
  (`public/licenses/*.txt`, `LICENSE_TEXT_URLS`) fetched when the dialog opens; a failed fetch shows a
  note in that section only. The copyright lines are English in every UI language. Browser fonts have no
  entry (they are not bundled), and licenses of other dependencies are not listed here (GitHub issue
  #990). Every font added to `MSDF_FONTS` needs a `FONT_NOTICES` entry (a test enforces it). The body holds
  the "MSDF" / "TTF/OTF" toggle buttons (`toggle` / `toggle-selected`) and the font list below. The
  panel opens on the list that holds the current family.
  A single-select listbox of the active category:
    - MSDF: every baked font of `MSDF_FONTS`: Roboto (value `""`), Noto Sans, Noto Sans Condensed, Noto Serif, Fira Sans, Fira Mono, Arimo, Tinos, Cousine and Open Sans (keys `msdf:<id>`, the prefix keeps them apart from browser font names). Each offers Regular and Bold and covers Latin and Cyrillic.
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
- **Weight row** (GitHub issue #973) — below the family list, outside the list's own scroll area: a
  "Weight" label and a native select (`SelectRow`, `font-picker-weight`) of the weights the highlighted
  family offers, named by `fontWeightName` ("Regular", "Bold", ...). It takes a fixed height, so the
  family list above shrinks to fit and the panel itself never scrolls. Picking a weight updates the
  working font and the live preview like a family pick. The select is disabled when the family offers
  one weight, and it also shows the open-time weight when the family lacks it. The offered weights come from the family:
    - MSDF: the weights the font was baked with (`msdfFontWeights`, from the `MSDF_FONTS` entry;
      Roboto offers 400 and 700). A font baked with other weights only needs another registry entry.
    - TTF/OTF: `rasterFontWeights`. With the Local Font Access API these are exactly the weights of
      the family's installed normal-style faces (`weightFromStyleName` maps the `style` names;
      italic, oblique and non-regular-width styles are skipped). Without the API, or for a family the
      machine did not report, only regular is offered, plus bold when a canvas metrics probe shows
      the family has a real bold face. The list refreshes when the local font query resolves.
  Picking a family keeps the working weight when the family offers it and otherwise snaps to the
  nearest weight it offers (`nearestWeight`, the heavier on a tie).
- **"Warnings (N)" section** (GitHub issue #971) — below the weight row, the counterpart of the color
  picker's one (`Specs/color-picker.md`, "Export color warnings"): the shared `PickerWarningsSection`
  (`components/PickerWarningsSection.tsx`), a collapsible section that starts collapsed, stays visible
  with `N = 0` (with a "No warnings" note when opened), takes the warning attention color when `N > 0`,
  and lists the export warnings as non-interactive `ExportWarningBubble`s. The warnings are the text
  overflow ones (`TEXT_OVERFLOW_WARNING_ID`: `marker_text_overflow`, `elevator_badge_text_overflow`,
  `teleport_badge_text_overflow`, `marker_index_text_overflow`, `floor_label_text_overflow`; a label
  that does not fit its plate, see `Specs/export-warnings.md`) of the text kinds the edited font
  drives. The call site names them through `warningKinds` (`TextFitKind[]`, threaded `LabelFontRow` →
  `LinkedFontRow` → `FontRow` → `FontButton` → `FontPickerPanel`): a text style group passes its own
  kind (`TextStyleRows` reuses its `autoFitKind`; start and finish are separate kinds, both raise
  `marker_text_overflow`), the floor label group `floorLabel`, and the Shared style font every kind its
  text-size Auto-fit covers (start, finish, elevator, teleport, marker index; not floor labels). No
  `warningKinds`, or no open export settings panel (`openRenderModeSettings` null), means no section.
  The list comes from `computeActiveModeTextOverflowWarnings` (`pixi/selectors/activeModeWarnings.ts`, next to
  `computeActiveModeWarnings` the color picker uses) over the store settings of the open render mode. It
  runs only the `textOverflow` warning group (`computeTextOverflowWarningsAcrossFloors`, through the same
  per-group cache as the full pass), not every group; the picker keys its memo on the content of
  `warningKinds`, since call sites build the array anew on each render. Unlike the color picker it needs no
  settings override: the live preview already keeps the store on the highlighted font, links included,
  so a Shared style font reaches exactly the texts that are linked to it. The check runs when the
  store changes. The family list keeps a minimum height (`FAMILY_LIST_MIN_HEIGHT`, 150 px): an opened
  warnings list or a tall preview scrolls the panel content instead of squeezing the list. A font that still has to load is judged once `LabelFontRow` applies it (until then
  the list still describes the previous font). The section is not gated by `showColorWarnings`: that
  switch hides only the contrast warnings.
- **Footer** — Cancel and Apply, each half-width.

Switching the type only changes which list is shown; the highlighted font is unchanged until the user
picks one.

### Keyboard

The listbox takes focus on mount. Up / Down arrows move the highlight to the previous / next font,
clamped at both ends (with nothing highlighted, Down selects the first and Up the last font). Every
move previews the font like a click, except that the canvas preview is coalesced: the highlight follows every key press (including auto-repeat), but `onPreview` fires once after the moves pause for `KEYBOARD_PREVIEW_DELAY_MS` (100 ms), and Apply flushes a still queued one first, so holding an arrow key does not rebuild the canvas per repeat. List rows are memoized, so a move re-renders only the two rows whose selection changed. Escape cancels, same as the Cancel button; Escape pressed inside a dialog opened from the panel (the font types info, the font licenses) closes only that dialog, because the panel ignores key events that come from outside its own DOM subtree.

## Preview and commit

Same model as the color picker's live preview. Every highlight change calls `onPreview`, so the canvas
shows the font before confirmation. Cancel, the header close button and Escape call `onPreview` once
more with the open-time font (family and weight), then `onCancel`, then `onClose`.

`FontButton` defaults `onPreview` to `onChange`: the live stream is the commit and Apply only closes
the panel. With a distinct `onPreview`, Apply is the single `onChange` commit.

`LabelFontRow` supplies `onChange` and handles font loading:

- the default, already-loaded and open-time fonts (`LabelFontRow` records the open-time one through
  `onOpen`, so a project font this machine lacks is restored by Cancel too, rendering as Roboto
  until it loads) apply synchronously, so Cancel's restore lands before
  `onCancel` re-enables a link (the link must not be re-disabled by a late restore);
- a font that still has to load applies once `loadLabelFont` settles (it loads the chosen face, family and weight), and only the latest
  request is applied, so a fast arrow-key sequence cannot leave an older font on the canvas.

## Not yet implemented (later epic tickets)

User-uploaded fonts, MSDF atlases built from TTF/OTF fonts.
