# Font Picker

Side panel for choosing a canvas label font, the counterpart of the color picker
(`Specs/color-picker.md`). Part of the font picker epic (GitHub issue #969); this spec covers the
**base panel** (issue #970), the **preview** (issue #972), the **weight selection** (issue #973) and the
**text warnings** (issue #971) and the **single font list with badges, search, filters and per-font license icons** (issue #984). Further font sources are separate tickets of the epic.

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
`vectorByWallsSettings`, `vectorByCorridorsSettings` and the maze graph (`nodes`, `edges`, `floors`), and any drawn
`LabelFont` (see "Drawn fonts") that names a non-default catalog font starts its download once. It covers every way
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
  falls back to DOM text in Roboto. The preview ignores any label text transform (uppercasing). The line is centred on the ink of a fixed sample (`Hx`), not of the phrase or the font's line box, in both variants (`domInkCentreOffset` shifts the DOM line, using the font's own ascent and descent that a CSS line box centres by, GitHub issue #1016; the line box is taller than the preview, so the ellipsis clip of the line does not cut glyphs that overshoot a font's ascent or descent, and the preview box clips them; the offset does not depend on the line height; the sample's pivot the MSDF canvas), so it does not move with the phrase, the font or the weight.
  The preview text is not selectable. A phrase wider than the preview is cut with an ellipsis in both
  variants (CSS `text-overflow` for DOM text, the longest prefix that fits with "…", found by binary
  search over `truncateToWidth` in `pixi/ellipsisFit.ts`, for the MSDF canvas; computed when the text,
  colors or size change, not on a later panel resize).
- **"Family" section** (GitHub issue #984) — second. Its header carries the info button (`InfoIconButton`) opening a
  `CategoryInfoModal` that explains the practical difference between the two formats (MSDF, TTF/OTF) and what "Uploaded by user" fonts are and how long they live. The body holds, top to
  bottom, a search field, a filter row and one list of every font. There is no format switch and no
  global license button.
  - **List.** A single-select `SelectableList` (`components/SelectableList.tsx`, see `side-panel.md`'s "Shared list
    and bubble primitives") with `autoFocus` and the visible fonts' names as its `values`: a `listbox` that keeps
    focus, `aria-activedescendant` names the highlighted option, Up/Down walk the visible fonts and report a
    `"keyboard"` selection (which the picker previews without the heavy per-key work). Order: the baked MSDF fonts
    (`MSDF_FONTS`: Roboto with value `""`, Noto Sans, Noto Sans Condensed, Noto Serif, Fira Sans, Fira Mono, Arimo, Tinos,
    Cousine, Open Sans, keys `msdf:<id>`; each offers Regular and Bold and covers Latin and Cyrillic), then the browser
    fonts:
    - every family installed on this machine (`loadLocalFontFamilies`). The open-time family is kept in the browser
      part when the machine does not report it, so a project saved elsewhere still shows its current choice highlighted;
    - while the local query is pending the MSDF fonts are listed and a loading hint sits in the list footer;
    - uploaded families (see "Raster fonts as dynamic MSDF atlases");
    - when the machine's list is unavailable (no API, permission denied, or an empty answer, which is how some browsers
      report a denial) only uploaded families and the saved one are listed, and a hint in the list footer asks the user to
      grant the permission to see the full list of local fonts. The bundled fonts stay listed above it.
    - The hint comes with a **"Grant access"** button when the browser has the API: it calls
      `loadLocalFontFamilies(true)` (a retry from a user gesture), which re-prompts if the browser still
      allows it and replaces the list with the full local one on success. If the retry still gives no
      list the browser has blocked the site, no second prompt can appear, and the hint changes to ask the
      user to allow local fonts in the site settings and reload (a page cannot open browser settings).
      A browser without the API shows a plain "cannot list local fonts" note and no button.
    - When the search and filters leave no font, the note says so, centered in the list body (`SelectableList`'s `centerFooter`). All notes of the list (empty, loading, permission) are muted disabled-colored captions like the embedded hotkey hints. The permission note is not shown while the format filter is MSDF, since the bundled fonts need no permission.
  - **Row.** The font name (cut with an ellipsis), then the indicators, then the format bubble last (`FontOption`, memoized, so a move re-renders
    only the two rows whose selection changed). Indicators, in order: **in project** (lucide `CircleDot`, `FontUsedIcon`; the family is
    named by a drawn `LabelFont` of `vectorByWallsSettings` or `vectorByCorridorsSettings`, found by
    `collectDrawnLabelFontFamilies`, `store/labelFontSync.ts`, see "Drawn fonts"; read once when the panel opens, because the live preview keeps the
    store on the highlighted font and would mark every browsed font; the default Roboto counts while any drawn text uses it),
    **uploaded by user** (`Upload`; an uploaded font file, hint "Uploaded by user"; a typed name has none), **locale support** (`Languages`; the font draws the script of the current UI locale; the hint reads "Supports the interface language"; never shown for a locale that needs only Latin, English) and the **copyright icon** below. All status icons share one size, `FONT_STATUS_ICON_SIZE` (14 px, `components/FontStatusIcons.tsx`, which also holds `FontUsedIcon`, reused by the delete dialog). The two status icons are muted
    with a `Tooltip` hint and an `aria-label` (not tab stops: the tooltip is `focusable={false}` so the list keeps keyboard focus). Every hint of the panel (indicators, format bubbles, filter chips, copyright icon) goes through the shared `Tooltip`, never a native `title`. The **format** is a `Bubble` (the shared chip) in one of two neutral hues
    that carry no status meaning (`ui.fontFormat`): violet `MSDF` for a baked font, teal `Vec` for a browser TTF/OTF font, each with a
    tooltip hint, both of one fixed width so they line up.
  - **Locale support check** (`components/fontLocaleSupport.ts`). `LOCALE_FONT_SCRIPT` is a `Record<Locale, FontScript | null>`:
    every locale must declare the script besides Latin its text needs, or `null` when Latin suffices. A locale added to the
    inlang project without an entry does not compile, and `fontLocaleSupport.test.ts` guards the declaration at test time.
    `FontScript` (`fontChoice.ts`) is `"cyrillic"` today; adding a script needs its probe sample (`SCRIPT_SAMPLES`, a `Record<FontScript, ...>`). A baked font declares the scripts it covers in its `MSDF_FONTS` entry
    (`scripts`); a browser font is probed by `fontCoversSample` (`labelFont.ts`): it covers a sample when the browser's glyph metrics
    for it differ from every generic fallback, since a missing script falls back to one of them. Results are cached per family.
  - **Search and filters.** The search field filters by name, case-insensitive substring. Down in the field moves keyboard focus to the
    list. Under it a single row of toggle chips (`FilterChip`, a `Bubble` of the look of the row's indicators, the chips of equal width sharing the row evenly so together they are as wide as the list; an off chip is
    dimmed, an on chip is full, `aria-pressed`, the hint as a `Tooltip` and `aria-label`): the **MSDF** and **Vec** format chips, **in project**\1(`CircleCheck`), **uploaded by user** (`Upload`) and **supports the locale's script** (`Languages`, not shown for English). The two format chips exclude each other:
    picking one drops the other, and picking the active one again clears the format filter (both formats shown). The other chips combine with each other and with the format by AND. The highlighted font stays highlighted when a filter hides it, and the arrow keys walk the visible
    fonts only.
  - **Copyright icon.** Every bundled MSDF font's row carries a lucide `Copyright` `InfoIconButton` (`inList`, no hover highlight, with the tooltip "View copyright"), always visible,
    next to the badges; browser fonts have none (they are not bundled). A click opens `FontLicensesModal` scoped to that font
    (`findFontNotice`, `components/fontLicenses.ts`): the font name as title, its copyright line, license name, source link,
    and the full text of its license (fetched when the dialog opens from `public/licenses/*.txt`, `LICENSE_TEXT_URLS`; a failed fetch
    shows a note). The click does not select the row and does not take focus off the list. Keyboard: focus stays on the listbox, so
    the icon is not a tab stop (`tabIndex -1`); pressing **I** on the list opens the notice of the highlighted font (nothing for a
    browser font). The copyright lines are English in every UI language. Licenses of other dependencies are not listed here
    (GitHub issue #990). `FONT_NOTICES` and the static license texts stay the data source, and every font added to `MSDF_FONTS`
    needs a `FONT_NOTICES` entry (a test enforces it, and that `findFontNotice` reaches every catalog font).
- **Weight row** (GitHub issue #973) — below the family list, outside the list's own scroll area: a
  "Weight" label and a native select (`SelectRow`, `font-picker-weight`) of the weights the highlighted
  family offers, named by `fontWeightName` ("Regular", "Bold", ...). It takes a fixed height, so the
  family list above shrinks to fit and the panel itself never scrolls. Picking a weight updates the
  working font and the live preview like a family pick. The select is disabled when the family offers
  one weight, and it also shows the open-time weight when the family lacks it. The offered weights come from the family:
    - MSDF: the weights the font was baked with (`msdfFontWeights`, from the `MSDF_FONTS` entry;
      Roboto offers 400 and 700). A font baked with other weights only needs another registry entry.
    - TTF/OTF: `rasterFontWeights` (`knownRasterWeights`): the weights of the family's uploaded faces,
      else of its installed normal-style faces (`weightFromStyleName` maps the `style` names;
      italic, oblique and non-regular-width styles are skipped). A family with no readable source
      offers regular only. The list refreshes when the local font query resolves.
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

Searching and filtering only change which fonts are shown; the highlighted font is unchanged until the user
picks one.

### Keyboard

The listbox takes focus on mount. Up / Down arrows move the highlight to the previous / next visible font,
clamped at both ends (with nothing highlighted, Down selects the first and Up the last font). Every
move previews the font like a click, except that the canvas preview is coalesced: the highlight follows every key press (including auto-repeat), but `onPreview` fires once after the moves pause for `KEYBOARD_PREVIEW_DELAY_MS` (100 ms), and Apply flushes a still queued one first, so holding an arrow key does not rebuild the canvas per repeat. List rows are memoized, so a move re-renders only the two rows whose selection changed. Escape cancels, same as the Cancel button; "I" opens the license dialog of the highlighted bundled font. Escape pressed inside a dialog opened from the panel (the font types info, the font license) closes only that dialog, because the panel ignores key events that come from outside its own DOM subtree.

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

## Raster fonts: canvas preview, MSDF after Apply (GitHub issue #966)

A raster font (an installed TTF/OTF face from the Local Font Access API, or a file the user uploads) goes
through two renderings. Browsing never converts anything; the MSDF atlas is built after the font is applied.

- **Source.** `rasterFontStore.ts`: installed faces (`registerLocalFaces`, normal-style faces by weight)
  and uploaded files (`addUploadedFont`: TTF, OTF or WOFF 1.0, parsed by `sfnt.ts`; italic faces, WOFF2
  and font collections are refused with a message in the picker). Uploads live for the session and in
  IndexedDB (`mazegen-fonts`), never in the project file. Memory holds only each face's identity (family, weight, the file's
  fingerprint) and its file as a `Blob`; the file is read when the font is used (`ensureUploadedFace`: the highlighted font's
  browser face, a font applied to the canvas, its atlas conversion), never just because it is listed. The "supports the
  interface language" check of an uploaded font needs its loaded face, so it is measured once and remembered per file
  fingerprint in `localStorage` (`mazegen-uploaded-coverage`); a font not measured yet is read once to measure it
  (`loadUnmeasuredUploadedFonts`). Records of an earlier version (raw bytes) are converted when read. A project that names a font this machine
  lacks reads Roboto and says so (see "Restoring project fonts").
- **Preview (canvas text).** While a picker is open (`pickerSession.ts`, set by `FontPickerPanel`) every
  highlighted font reaches the settings as a preview and its labels are pixi `Text` objects over a canvas
  texture (`makeLabelText` in `labelFont.ts`, once the browser face has loaded, `loadLabelFont`). The texture
  density is `canvasLabelResolution.ts` (GitHub issue #1003). Every canvas label is built at the cheap base
  level (the device pixel ratio) and registered (`registerCanvasLabel`). `SETTLE_MS` (150 ms) after the last
  view change (zoom, pan, resize) or font selection, `applyQuality` raises only the labels that intersect the
  screen to zoom times device pixel ratio, snapped up to the levels `1, 1.5, 2, 3, 4` (then geometrically),
  plus the exact zoom at the moment the font was selected as one more level (a 344% zoom is rasterized at
  3.44, not 4); labels off screen go back to the base level. The resolution of the existing `Text` is
  changed, no label is rebuilt. A texture is bounded by `MAX_TEXTURE_SIDE`, `MAX_TEXTURE_PIXELS` and the
  screen size in device pixels (a label never needs more pixels than the viewport), and all canvas label
  textures share `MAX_TOTAL_PIXELS`: when it runs out, the remaining visible labels get a lower density
  (never below the base level) instead of more memory. Only labels under the live scene stage are managed
  (`setCanvasLabelView`, called from `MazeScene.syncLayersToViewport`); an export's labels keep the export
  scale and a preview's labels stay at the base level. Nothing is applied before the first view sync, and a
  label detached from the stage for a while (a hidden layer) stays registered until it is destroyed.
  Canvas text is ink-centred like an MSDF label (`canvasInkCentreOffset`), so a label does not move when
  the atlas replaces it. Stale results are dropped: only the latest font request is applied
  (`LabelFontRow`).
- **Conversion (after Apply).** When the picker closes (applied, or the open-time font restored) or a
  project loads, `labelFontSync` calls `loadRasterFont` for each project font (never while a picker is
  open). `rasterMsdf.ts` builds one atlas per family and weight: a dedicated worker (`msdfWorker.ts`,
  `@playcanvas/msdfgen-wasm`, msdfgen + FreeType; a font with no Unicode `cmap` record (platform 0, or 3 with encoding 1 or 10) first gets one built from its Symbol
  or Mac Roman subtable, `withUnicodeCmap` in `unicodeCmap.ts`, or msdfgen would find no glyphs in it) generates glyphs at the baked Roboto scale (54 px/em,
  range 8 px). Other weights of the family are built when first used. The atlas replaces the canvas text
  when it is ready (`LABEL_FONT_LOADED_EVENT` redraw); on failure the canvas text stays.
- **Character set** (`glyphCharset.ts`): the union of base Latin `A-Z a-z`, common symbols (digits,
  punctuation, signs) and the sets the locales declare in `i18n/localeCharsets.ts`
  (`LOCALE_MSDF_CHARSETS`, typed over `Locale`: a new locale does not compile until it declares its
  set). Every locale counts, so switching the interface language never rebuilds an atlas. The generator
  knows no alphabet of its own. Code points, not UTF-16 units; no whole Unicode, no characters of the
  current text. The set has a content version (`charsetVersion`); an atlas built with an older set is
  completed with the missing characters.
- **Rare characters.** A character outside the set is generated on demand (`rasterCoversText`). Until it
  lands the label stays canvas text, so no character vanishes. A character the font lacks is drawn in
  Roboto and counts as covered.
- **Atlas.** `DynamicMsdfFont`: a pixi `BitmapFont` in pixi's cache, glyphs shelf-packed into RGBA 1024 px
  pages (max 4 pages; beyond that Roboto glyphs stand in). One atlas serves every label of the family and
  weight; zoom never rebuilds it. Layout and measuring refresh when glyphs are added
  (`rasterAtlasSignature` is part of `textMetricsKey`).
- **Cache.** Atlases are identified by family, weight, the file's identity (`rasterFaceSource`: the
  fingerprint of an upload, `local` for an installed font), the generation parameters and the charset
  version. A replaced upload frees its atlas; concurrent requests share one build. Atlases of fonts the
  project uses are kept; idle ones are evicted least-recently-used beyond `MAX_IDLE_RASTER_FONTS` (4),
  freeing pages and the worker's font. Canvas textures are freed with their labels.
- **Export.** `PngExporter` awaits `whenRasterFontsSettled` first, and renders canvas text of a font still
  without an atlas at the export scale (`beginCanvasLabelScale`).
- **UX.** No conversion button, no per-weight or per-atlas status. After Apply a small "Preparing fonts: <names>"
  note (`FontPreparingIndicator`, GitHub issue #974) appears top-right of the canvas only when conversion takes longer
  than `INDICATOR_DELAY_MS`.
- **Picker.** The browser list is installed + uploaded + typed families (+ the saved one); the web-safe list is
  gone. An upload icon (`Upload`, `font-picker-upload`) in the Family section header adds a font and selects it; next to it a trash icon (`Trash2`, `font-picker-remove`, inert while nothing is uploaded) opens the delete dialog. Both are header actions, not list rows: the list holds information only. The format info says vector fonts can be built from
  raster fonts.
- **Manual fonts (GitHub issue #985).** A font the user added by hand is an uploaded file or an installed
  font typed in by name. Only an **uploaded** font is marked: its row carries an `Upload` badge "Uploaded by user"
  (`font-badge-uploaded`), and a filter chip of the same icon (`font-picker-filter-uploaded`) shows only those; it
  combines with the other filters by AND. A typed name has no badge.
  - **Typed name.** While the machine's font list is unavailable (no API, denied, or empty), a text field with an
    "Add" button (Enter also adds) sits under the list. The name must be a font the browser has
    (`isFontFamilyInstalled`), else a `warning` toast (`fonts.manual_not_found`) is raised and nothing is added. An added name is listed,
    highlighted and applied like any family.
  - **Permission state.** The picker reads the `local-fonts` permission on open (`navigator.permissions`); a state
    already `denied` shows the "blocked, allow in site settings" note at once, without a "Grant access" button.
  - **Lifetime.** Neither kind is ever stored in the project file. Uploaded files live in IndexedDB
    (`mazegen-fonts`), typed names in `localStorage` (`mazegen-manual-fonts`, `addManualFontName`,
    `manualFontNames`); both survive reloads in the same browser and are lost with the site data. Opening the
    project in another browser or device reads the default font and raises the usual `fonts.unavailable` toast for an
    upload (see "Restoring project fonts"). The info dialog of the Family section (`font_picker.info_uploaded`)
    states this.
  - **No conversion.** A typed name has no font file (`knownRasterWeights` is empty), so it cannot become an MSDF
    atlas: picking it stores `msdf: false` and the convert switch is disabled, with a tooltip saying the font file
    cannot be read without permission to local fonts; its labels are canvas text
    (browser-drawn) and no "unavailable" toast is raised for it. If the machine's list later provides the file,
    picking the family again re-enables conversion.
- **Not supported.** WOFF2, uploaded TTC files, italic faces, variable-font axes. An installed font that lives in a TTC (Sitka on Windows) is supported: the face is cut out of the collection by the PostScript name (else the full name) the Local Font Access API reports (`toSfnt` with a `FaceHint`, GitHub issue #974).
- **Style names.** `weightFromStyleName` ignores optical size words (`Small`, `Text`, `Subheading`, `Heading`, `Display`, `Banner`, `Caption`): Sitka Small reports `Small` and `Small Bold`. Layout features other than pair kerning
  (ligatures, contextual forms) are not applied to MSDF text.
- **Convert to MSDF switch.** Under the weight select, always shown (so the panel does not jump), a switch (on by
  default for a raster font) with an info button. It is disabled with a tooltip when conversion is impossible: "The
  font is already MSDF" for a bundled font, and "Conversion is unavailable without permission to access fonts" for a
  font without a readable file. The info dialog is plain body text under the dialog title. `LabelFont.msdf === false` (stored only when off, `withMsdfConversion`; kept by the project
  validator) means the font is never converted: `labelFontSync` skips `loadRasterFont` and treats its
  atlas as idle (kept only among the `MAX_IDLE_RASTER_FONTS` most recent, so switching back is cheap), and `usesCanvasText` keeps its labels canvas text (zoom-aware, export-scale). The info says the
  automatic conversion can give artifacts on some fonts with thin lines, which is the reason to turn it off.
  Two texts naming one font, one with and one without conversion, keep the atlas. Choosing a bundled font drops
  the flag, so it never lingers hidden.
- **Kerning.** `kerning.ts` reads the pair kerning of the font file (OpenType `GPOS` `kern` pair lookups,
  else the legacy `kern` table; `cmap` formats 4 and 12) and `DynamicMsdfFont` stores it per atlas
  character (`chars[second].kerning[first]`, atlas pixels), so MSDF text keeps the width canvas text had.
  Pairs form as glyphs arrive (charset completion, on-demand); a character drawn from the Roboto fallback
  is not kerned.

## Drawn fonts (GitHub issue #1012)

A font counts as used by the project only while its text is drawn. `collectDrawnLabelFonts` (`store/labelFontSync.ts`)
walks the `labelFont` fields of `LINK_SCHEMA` (`textFont` of start and finish captions, teleport floor badges, elevator
badges, marker indices and floor labels; the "Shared style" source `labelFont` is skipped, since it draws nothing
itself) in both render modes and keeps a field's font only while its settings row is active
(`isSchemaPathActive` over `buildProjectActivity`, `pixi/selectors/projectActivity.ts`, shared with the color field registry): the maze has the element
(teleports, elevators, several floors) and the settings keep the text on (caption switch, floor label switch, badges,
marker indices). A font a hidden text still names is therefore not marked "in project" in the picker, and the font sync
does not download, convert, prune-protect or report it as unavailable. `installLabelFontSync` re-runs when the maze graph
changes too, since that decides what is drawn. `pngExportSettings` holds no font and is not read.

## Restoring project fonts (GitHub issue #974)

Atlases are never stored: not in the project file, not in browser storage. A reloaded project gets its atlases back
by regenerating them (`labelFontSync` calls `loadRasterFont` for each project font) from the font file, which comes
from the uploaded fonts in IndexedDB or from the installed fonts (Local Font Access). Nothing falls back silently:
every case where a project font cannot be drawn from its own atlas is a toast (`notifications/fontNotifications.ts`,
source `fonts`) and, for the permission, a dialog.

- **Sources settle first.** A font is judged missing only after the uploaded fonts are restored and, when the
  permission is already granted, the installed ones are read (`sourcesSettled` in `installLabelFontSync`). The
  reported permission state is not trusted alone, so the dialog does not ask for a permission already given: the font
  list is queried when the state is `granted` or `unknown` (the browser could not tell, `queryLocalFontPermission`),
  and a list that loads counts as access. An undecided `prompt` is never queried at startup: without a click the
  browser refuses, and a query inside a fresh click would show its own prompt past the dialog. A refused query under
  `granted` is tried once more once the page is visible (a background tab may refuse it); only a second refusal falls
  back to the dialog.
- **Preparing.** No toast: a running conversion is shown by the "Preparing fonts" indicator, which names the fonts
  being converted (`rasterWorkLabels`).
- **Toasts end with their cause.** A font problem that is resolved (the font arrives, the permission is granted, the
  missing set changes) withdraws its error from the screen (`clearFontProblem`, `retractErrorOccurrence`), not only
  its once-per-key guard.
- **Fonts without a source.** One `error` toast (`fonts.unavailable`) names all of them. When the permission is
  blocked it is `fonts.permission_denied` instead. It is raised once per set of missing fonts and re-armed when none
  is missing.
- **Permission dialog.** When the browser can still prompt (`prompt`) and the user has not answered for the current
  missing fonts, no toast is raised yet: `LocalFontPermissionDialog` (state in `fontPermissionRequest.ts`) opens with
  Cancel and Grant permission. The prompt only appears from a user gesture, so the button starts
  `queryLocalFonts()` synchronously in its click handler and the dialog stays open until the browser answers (closing
  earlier would let the sync read the undecided permission and raise the error). The dialog is narrow; two or more
  fonts are listed as bullets. Cancel (or a dismissed prompt) leaves the fonts missing and `fonts.permission_denied`
  follows ("access not granted", also for a permission still at `prompt`). The answer is kept per set of missing
  fonts: another missing font is a new question. It is forgotten once no project font is missing, so the next project
  load asks again.
- **Weights.** A weight is generated from the family's file for exactly that weight. A family without that file
  raises an `error` toast (`fonts.weight_unavailable`) and uses the nearest weight; it is re-armed once the file
  arrives.
- **Failures.** A failed conversion (unreadable or unusable file, generator error) or a failed atlas extension raises
  an `error` toast (`fonts.conversion_failed`, the reason in its details); the labels keep canvas text. A failed face
  is not rebuilt until a source changes (`failedSources`).
- **Glyphs.** A character of a label that the font lacks raises a `warning` (`fonts.glyphs_missing`, once per
  character and atlas, raised outside the render that measured the text), and Roboto draws it. An atlas that reaches its page limit raises a `warning`
  (`fonts.atlas_full`, once per atlas).
- **Export.** `PngExporter` calls `reportProjectFontProblems` after the conversions settle: a font still unavailable
  raises the same error again, without opening the dialog. Export itself is not blocked.

## Upload limits and deleting uploaded fonts (GitHub issue #985)

- **Limits** (`rasterFontStore.ts`): at most `MAX_UPLOADED_FACES` (50) font files, `MAX_UPLOADED_BYTES` (100 MB) in total,
  and `MAX_UPLOAD_FILE_BYTES` (20 MB) per file. A face of the same family and weight replaces the old one, which frees its own
  share first. When the count or the total size is already used up, the upload icon raises the toast at once and does not open
  the file picker (`uploadCapacityExhausted`). A refused upload (`file-too-large`, `too-many-fonts`, `storage-full`) stores nothing and raises a `warning`
  toast (`fonts.upload_refused`, `reportUploadRefused`); an unusable file keeps its inline message under the list.
  Typed names have no limit.
- **Delete dialog** (`RemoveUploadedFontsDialog`): lists every uploaded family with a switch each and the "in project" icon
  for those a project font names (the set read when the panel opened). Deleting asks for nothing, except when a chosen font
  is used in the project: then a second confirmation (`ConfirmModal`) says its text will be drawn in the default font.
  Delete is disabled until something is chosen. `removeUploadedFont` forgets the family in memory and IndexedDB; a
  highlighted font that goes is replaced by the default one, and the font sync reports a project font left without a source
  as the usual `fonts.unavailable` error.
