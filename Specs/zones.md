# Zones

A zone is a named set of cells with a stable id and a kind. Consumers (the zones feature renderer,
the export renderer, QC rules) reference a zone by id and ask which zones a cell belongs to
(GitHub issue #1029). UI and editing are out of scope and tracked separately; persistence is in `Specs/project-file.md`.

## Core model

Module: `maze-core/src/space/zone.rs`, generic over the tessellation's `CellId`.

- **`ZoneId(u32)`** — stable id minted by the `ZoneSet`; never reused, never renumbered when other
  zones are added or removed. `ZoneSet::from_zones` restores zones that already carry ids (a client
  snapshot), rejects a duplicate id and mints later ids above every given one.
- **`ZoneKind`** — `Auto` (derived by the application) or `Manual` (drawn by the user).
- **`ZoneCell { floor, cell }`** — `floor` is the index in the client's `floors` array (the position
  in `MultiLevelField::levels_ordered`, not a `LevelId`: zones are built before any field exists
  and wasm is stateless). It is valid only until floors are added, removed or reordered.
- **`Zone`** — id, `name`, `kind` and a deduplicated, ordered cell set. An empty zone is allowed.
- **`ZoneSet`** — zones in insertion order. Zones may overlap. `zones_of(floor, cell)` scans.
- **`ZoneIndex::build(&ZoneSet)`** — cell-to-zones lookup for repeated queries (hover, per-cell
  consumers); returns ids in zone order, empty for a cell in no zone.

## WASM API (`maze-wasm/src/zones.rs`)

Stateless: the web store owns the zones and sends them with every call. Cells are `[floor, x, y]`
(`[x, y]` is the tessellation's wire point); every `[x, y]` must be a cell of the tessellation.

- `zones_normalize({ tessellation, zones })` → zones with cells deduplicated and in core order.
  Errors: `zone <id>: invalid cell [x, y]`, `invalid floor <n>`, `duplicate zone id <id>`.
- `zones_of_cells({ tessellation, zones, cells })` → `number[][]`, entry `i` the zone ids of
  `cells[i]` in zone order.

## Field filtering

Core rejects a cell outside the field, so the web drops such cells before sending zones, the same
approach as the preset filters (`buildValidPresetConnections`): `filterZonesToField(zones,
resolveFieldAt)` (`domain/fieldValidity.ts`) removes cells whose point is not a cell of their floor's
field or whose floor no longer exists. Zone ids, names, kinds and order are kept; a zone left with
no cells stays, so its id remains stable.

## Zones card (GitHub issue #1028)

Feature card `zones` (`FeatureId`), placed after Field and before Presets.

- Status: `unavailable` until a field is set (same condition as Presets), otherwise always `set`
  (green), even with no zones. Subtitle: number of manual zones.
- Store (`zonesSlice`): `zones`, `showAutoZones`, `showManualZones` (both on; the auto zones are hidden per zone, see below). The toggles are
  transient; zones are saved with the project (`Specs/project-file.md`, "Zones").
- Two toggles, "Show auto zones" and "Show manual zones".
- `ZonesRenderer` (feature renderer, visible only while the card is open) draws the active floor's
  field with the cell grid (faint inner walls) and the outer walls, as the presets renderer does, and
  over them each zone passing the toggles as a region (`RegionHighlightRenderer`). Zones are first
  cut to the field (`filterZonesToField`), so no cell outside it is drawn. A zone's colour comes from
  its position in the full zone list (`zoneColors`), so toggling never recolours. The scheme is the
  glues' one (`distributeHueGroups` from `AUTO_HUE_BASE_COLOR`).
- Hover: the cell inspector text (`resolveCellInspection`) lists every zone holding the cell, in zone
  order, regardless of the toggles (`x:1, y:2 | Zone A, Zone B`; an unnamed zone shows as `#id`). A
  cell outside the field shows bare coordinates.
- `ui.openCard` in a project file accepts `zones`.

## Zones list (GitHub issue #1030)

A "Zones list" button on the zones card opens the `ZonesPanel` side panel (`zonesPanelOpen`).

- Top switch, as "Gluings" / "Folds" in the topology panel (`zonesListMode`): "Auto zones (n)" and
  "Manual zones (n)", `n` the number of zones of that kind. The "Add zone" button is on the feature card and
  at the end of the manual list (opens the manual list and the editor of a new empty manual zone over it; the zone is only a draft until "Done"). Ids come from a store
  counter (`nextZoneId`) that only grows, so the id of a deleted zone is never reused.
- Zones are ordered by the lowest floor they touch, ascending (`sortZones`, `store/zoneListSort.ts`; a zone without
  cells last, ties keep the order they were computed or added in). The type of an auto zone is read back from its id.
- "Grouping" dropdown under the switch (`zonesGrouping`, kept per section: None, By floors, By types for auto zones only, and By groups; default None). A grouping
  folds the shown zones into collapsible sections (`groupZones`, `SectionHeader`, "Title (n)"): by floors, one per
  floor in ascending order (titled like the floor; a zone is in the section of every floor it has cells on, zones without cells in a last "No floor" section), by
  types, one per type in alphabetical order. Zones inside a section keep the floor order. Sections start collapsed,
  and every grouping change collapses them all; the expanded set is local to the open panel. A section header has an eye
  that hides all its zones, or shows them all when any is hidden (`setZonesVisible`).
- Zone card: a rounded colour square sized to the font (`1em`, thin neutral border) with the zone's
  canvas colour (`EntityColorSwatch`, shared with the glue cards) after the name (`#id` while
  unnamed), "Cells: n" (a fixed label, so no plural forms), and `L{n}` floor badges of the floors the zone occupies
  (`FloorBadgeRow`, standard blue info `Bubble`s, click to go to the floor; only on a multi-floor maze).
- A third line shows the zone's groups as neutral (blue) `Bubble`s, "No groups" when none (GitHub issue #1036). Groups have no colour. A click on a bubble calls `showZonesOfGroup`.
- Grouping "By groups" (`ZonesGrouping` `group`, offered in both sections): one section per group holding a shown zone, in the groups' order, a zone in every group it is in; zones in no group share a last "No groups" section (`groupZones`, keys `group:<id>`).
- `showZonesOfGroup(id)` (a group bubble on a zone card, or a click on a group cell in the groups list, which opens the zones list) switches to the list section that holds the group's zones (the current one when it does), sets its grouping to "By groups" and leaves a request (`zonesFocusedGroupId`, transient). The open zones list consumes it (`clearZonesFocusedGroup`; a list opened afterwards still honours it): it collapses every section, expands the group's and scrolls it into view when the list can scroll. Deleting the requested group drops the request.
- Eye icon (open/closed) in the card's top right corner toggles the zone's visibility on the canvas
  (`hiddenZoneIds`); it applies on top of the two kind toggles. Manual cards also have edit (opens the zone editor) and
  delete (with a confirmation dialog) icon buttons.
- Hover: the hovered card's zone (`hoveredZoneId`) is drawn by `ZonesRenderer` on its own layer over
  the other zones, fully opaque (a hover change redraws only that layer), regardless of the kind
  toggles and the zone's visibility, only if it has cells on the active floor. The active floor never
  changes. The hover is cleared when the panel closes or unmounts, or the section switches.
- Hidden zones, the mode and the hover are transient (reset on load); the zones themselves are saved.

## Zone editor (GitHub issue #1031)

Editing a manual zone (the edit button of its card, or "Add zone" on the zones feature card, which opens
the manual list and a new zone's editor together) opens `ZoneEditPanel` (the zone being edited is the draft `zoneEditDraft`; there is no separate edit id) over the list ("Done"
closes it, the list stays). Closing the list, deleting the zone or
leaving the zones card (`ZonesFeature` unmounting drops the unconfirmed zone and group drafts) ends editing. The panel offers every shape tool of the custom field editor, through the
same components (`FieldToolsSection`, `SmoothingToggleRow`): Add / Remove / Select modes, point, shapes, polygon,
parallelogram, connected area, mirror, copy and paste, smoothing, with the same hotkeys and gestures. The tools
are not duplicated: `FieldEditController`, `FieldEditorOverlay`, the mirror panel and the scene read the edit
target through `store/fieldEditTarget.ts` (`editFieldOf`, `fieldToolsActive`, `zoneEditActive`), which hands them
either the floor's custom field or a view of it whose `fieldPoints` are the edited zone's cells on the active
floor. Tool state (`fieldOperation`, `fieldPrimitive`) is the floor's, shared with the field editor.

- Every change goes into a draft, not the zone list: `zoneEditDraft` is a working copy of the zone (a new zone
  exists only as its draft) and `zoneEditDraftColor` its explicit colour (`null`: automatic). The shape tools
  (`addZoneCells`, `removeZoneCells`, `moveZoneCells`, the mirror through `applyMirror`), the name and the colour
  write there. `zones` and `zoneColorOverrides` take the draft only on "Done" (`commitZoneEdit`; a new zone is
  appended), so a list never shows a half-edited or unconfirmed zone. `editedZoneOf` returns the draft, and
  `zonesWithDraft` / `overridesWithDraft` give the canvas and the editor panel the zones as edited. Zones are not
  part of generation, so no edit asks for confirmation or invalidates results.
- Edits act on the active floor's cells of the zone; cells on other floors are kept. Switching floors switches
  the floor being edited. Opening an existing zone for editing (`setZoneEditId`) moves to its lowest floor, unless the
  active floor already holds some of its cells (GitHub issue #1032).
- A zone holds only cells of the active floor's field: Add, point, shapes, connected area, paste and mirror drop
  cells outside the field (`cellsInActiveField`), and a smoothing preview does not mark them as excluded. Connected
  area in Add mode fills the field cells outside the zone connected to the clicked cell. A move that would leave
  the field is refused as a whole (the preview keeps its last valid position).
- The zone being edited is drawn by `ZonesRenderer` like a hovered one (opaque, whatever the toggles say). While
  a selection move is pending, the overlay shows the moved cells, and the source cells stay drawn.
- The panel is split into plain (not collapsible) sections, content indented by `indent.tree`. Properties: the zone name input (`setZoneName(name)`, on the draft only; shows the default
  name of an unnamed zone) and the colour row with a counter-clockwise-arrow reset `FlatIconButton` (tooltip "Automatic color";
  disabled with the second tooltip line "Already applied" while the colour is automatic). Editing: Modes, Tools,
  smoothing and "Show other zones". Intersections: always shown, even with no overlap, so its switch stays reachable. The switch "Show automatic zones"
  (`zones.intersections_show_auto`, off by default, local to the open panel) decides whether automatic zones are listed
  (`zoneIntersections` `includeAuto`). Then one line per zone and floor of the overlap (a `Bubble` with the zone name; when the edited zone spans several floors,
  then ` - ` and an `L{n}` floor badge, so a zone overlapping on two floors has two lines); the hover area of a line is the bubble
  with its floor badge, not the full row width, and keeps its vertical padding so adjacent lines touch; hovering a line highlights that zone and the edited one stops being highlighted
  (`hoveredZoneId` wins over the edited zone). An explicit colour
  (`zoneColorOverrides`, by zone id, the editor's `setZoneColor(color)` writes `zoneEditDraftColor`, `null` is automatic; "Done" moves it here) always wins over the
  automatic one. Automatic colours come from a fixed round of `AUTO_COLOR_COUNT` (8) colours shared with the
  glues (`glueColor`): a zone takes the colour at its position in the list; every further round of 8 is a group
  of the glues' hue scheme (`hueGroupColors`, positions 0, +1, -1, +2, ...: lightness and hue shifted), so no two
  zones share a colour. Whatever the number of zones, adding a zone or colouring another one never moves the rest. Deleting the zone drops its override.
  Overrides are saved with the project like the zones.
- "Show other zones" (`showOtherZones`, default on), under Smoothing, off hides every zone but the edited one while editing.
- The mirror panel shows an Add / Remove toggle (the floor's `fieldOperation`) only while a zone is edited; the
  field editor keeps it in its Modes section.
- Highlights are limited to what the tool can act on: Add highlights only field cells (nothing outside the field
  can be added), while Remove and Select also highlight the zone's own cells that stick out of a field that was
  shrunk after the zone was made.
- Smoothing in the zone editor has its own switch (`zoneSmoothing`, off by default, `smoothingOf`), apart from
  the field's `smoothPrimitives`; hold `S` still inverts it for the shape in progress.
- The zones card draws the grid over the field fill, so it runs through the field as thin lines like the
  grid outside it, in the more visible `canvas.wall.undecided` colour (a second `GridRenderer` over the field cells). A region is inset from its boundary by half the gap plus half its border width (the stroke is
  centred), so the borders of two regions on either side of a cell side are 2 px apart. The border colour is the
  region colour made bright (`brightColor`: same hue, high lightness and chroma), so it stands out on a dark region.
- An unnamed zone is called "Zone #id" everywhere (`zones.default_name`).
- The zones layer sits below the field editor overlay and tool previews, so highlights and shapes draw over it.
- The close cross cancels (`cancelZoneEdit`): the draft is dropped, so a new zone (`zoneEditIsNew`) never reaches the
  list and an existing one stays as it was. "Done" commits the draft. Any other way out discards it too: closing the
  list, or the edit button of another zone. The Groups section is part of the draft too (`zoneEditDraftGroupIds`, the
  ids of the existing groups holding the zone, and `zoneEditDraftNewGroups`, names of groups to create): `Done`
  applies the links to `zoneGroups` (and to an open group draft, so that its "Done" does not write the old members back) and creates the new groups holding the zone, the cancel leaves `zoneGroups`
  untouched. "Add zone" while a new zone is still being edited adds nothing; both "Add zone" buttons (the card's
  and the manual list's) go through `startNewZone` (`zoneEditorActions.ts`), which also raises the editor over the
  list, so the button works whichever of the two panels is on top.
- "Show other zones" off is applied again when a zone starts or stops being edited (`hidesOtherZones`).
- The hover highlight follows the tool's reach (`zoneToolReaches`): Add highlights field cells only; Remove and
  Select the zone's own cells, even outside the field. A right-click gesture does not change a later hover.
- Above "Done" a destructive "Clear" button (disabled while the zone has no cells) asks for confirmation, then removes every cell of the draft on every floor (`clearZoneCells`); the group links, name and colour stay. It is still a draft change: "Done" commits it, the close cross drops it.
- The panel ends with a caption-styled info line "Size: N cells" (all the zone's cells, on every floor). The zones
  sharing a cell with it on any floor (`zoneIntersections`) are the Intersections section.
- The mirror preview marks every symmetric cell, but the cells the tool cannot change (Add outside the field, Remove
  outside the zone) are drawn dim (`MIRROR_DIM_ALPHA`, as the cells smoothing leaves out of a shape).

## Zone combination (GitHub issue #1032)

A combine tool button (two overlapping circles, hotkey `C`, no modifier; `ZONE_COMBINE_SHORTCUT`) sits at the end of the Tools row of
the zone editor only (`FieldToolsSection`, `FieldEditController`). It toggles `ZoneCombinePanel` (`zoneCombine { op, otherId }`,
`null` while closed; transient; `toggleZoneCombine`, stack key `zone-combine`), a side panel over the zone editor, in plain
sections (header, content indented by `indent.tree`), the confirm button right after them:

- Mode: "Union", "Intersection", "Subtraction" (`ZoneCombineOp`, `setZoneCombineOp`; the chosen zone is kept).
- Zone: the other zones (every zone but the draft; `ListCell`s). A click picks the zone (`setZoneCombineOther`): the
  picked cell has the 3 px `current` bar on its left. Hovering a cell highlights that zone on the canvas. Deleting the
  picked zone clears the choice. The list takes the height the other sections leave and scrolls only when it does not fit.
- Result: with no zone chosen, a low-contrast "Choose a zone"; with one, a line per floor the operation changes:
  `L{n}` badge and a colon (only on a multi-floor maze), then `+N` (add colour) or `-N` (remove colour), then the zone's
  cell count on that floor after the operation in brackets with the word "cells". When nothing changes, a warning
  bubble inside the section says the edited zone will not change; another says it will become empty.
- "Apply" (disabled until a zone is chosen) writes the result to the draft (`applyZoneCombine`) and closes the panel, so
  the result is committed or cancelled with the zone ("Done" / close cross). The close cross of the panel (`cancelZoneCombine`)
  closes it without applying. Ending the editor drops it too.

The result is computed on cells of every floor (`combineZoneCells`): union adds the other zone's cells, intersection keeps
the shared ones, subtraction drops the other's. The other zone is taken as stored, the current one as its draft.
Preview (`previewZoneCombine`): `ZonesRenderer` draws the active floor's cells that would be added and removed (both zones first
cut to the field, like every zone it draws) on a layer over the hover layer, redrawn alone when only the panel's choice changes, so the per-floor report is where changes on other floors are visible.

## Zone groups (GitHub issue #1035)

A group is a named set of zones (`ZoneGroup { id, name, zoneIds }`, `zonesTypes.ts`). State: `zoneGroups` and `nextZoneGroupId` (only grows, an id is never reused) are saved with the project; `zoneGroupsPanelOpen`, `zoneGroupEditId`,
`zoneGroupEditDraft`, `zoneGroupEditIsNew` are transient.

- The zones card buttons are, in order, "Add zone", "Zones list", "Groups list". "Groups list" opens `ZoneGroupsPanel`
  (stack key `zone-groups`). A group cell shows the name (`Group #id` while unnamed, `#` in every language), the zone
  "Zones: n, cells: m" (distinct cells of all its zones) and `L{n}` badges of the floors its zones occupy
  (`FloorBadgeRow`, only on a multi-floor maze), a pencil
  (opens the group) and a trash (delete with a confirmation). Under them one bubble per zone of the group
  (`zoneChipColors`: border and text the zone's region border colour, background its region fill over the floor),
  spaced by `spacing.elementsGap`. Clicking a bubble goes to the zone's first floor when it has no cell on the
  active one.
  "Add group" at the bottom (`startNewGroup`, `zoneEditorActions.ts`) opens an empty group as a draft: it joins the list on "Done". While a new group is still being edited it adds nothing, but raises its editor over the list again.
- Hover: a group card, and its zone bubbles, highlight nothing on the canvas (GitHub issue #1036).
- The pencil opens `ZoneGroupEditPanel` over the list. Top: the name input. Then two collapsible sections with the
  count in brackets, built of `ZoneCell` (the zones list's cell, exported from `ZonesPanel`):
  "Zones (n)", the group's zones, each with a trash (`onRemove`) and a placeholder when empty; "Candidates (n)", the
  zones outside the group, each with a flat `+` (`onAdd`), with one placeholder when every zone is already in the
  group and another when no zone exists at all. Under the Candidates header sit a search field (`SearchInput`, by
  the zone's display name, case-insensitive) and a "Show automatic" switch (off by default, local to the open panel):
  automatic zones are candidates only while it is on, and the count in the header follows both. A candidate list that
  the search or the switch emptied shows "No matching zones". An existing group opens with Zones expanded and Candidates
  collapsed, a new one the other way round.
- Below, a primary "Done" button, disabled with an explaining tooltip while the group has no zones. "Done"
  commits the draft (`commitZoneGroupEdit`). The name, the zones and the candidates act on a working copy
  (`zoneGroupEditDraft`) and `zoneGroups` takes it only then, so the list never shows a half-edited or unconfirmed
  group. The close cross drops the draft (`cancelZoneGroupEdit`): a new group (`zoneGroupEditIsNew`) never reaches
  the list. Closing the groups list, "Add group" again or the pencil of another group drop an unconfirmed draft too.
- Under the panel header, a switch between the automatic and the manual groups (`zoneGroupsListMode`, transient, default auto, "Auto groups (n)" / "Manual groups (n)", as in the zones list), each with its own empty placeholder. "Add group" is shown in the manual section only.
- Zone editor, section "Groups" above Intersections: every group the draft zone is in, plus the groups still to be created (name and a trash that
  takes the zone out of it, "No groups" when none) and a `+` at the end of the header. The `+` opens
  `ZoneGroupPickerDialog`: the groups list as `GroupCell`s (`onPick`: no actions or bubble
  reactions; a click hands the group over to the draft and closes), without the groups the zone is already in, a placeholder when
  empty, and a "New group" button that closes it and opens `ZoneGroupNameDialog` (a name field, Cancel / OK; OK
  adds the name to the draft's groups to create). Both dialogs are generic (`excludeIds` / `onPick` / `onConfirm`).
- Placeholders keep the body font and only use the lower-contrast disabled colour; a list that shows a placeholder has
  no top separator. The picker dialog has no separators and a full-width "New group" button. The zone editor's
  Intersections bubbles use the same zone colours as the group cards' (`zoneChipColors`).
- Deleting a zone drops its id from every group and from the group draft (`withoutZone`).
- Automatic groups (see "Automatic zones") sit first in the list as plain cards: no pencil or trash, and the zone picker
  dialog leaves them out. Zone and group cards share `CardDetails` (`ZonesPanel.tsx`): the sizes, then the `L{n}` floor
  badges on the same line when they fit, else on their own line, wrapping over several lines when still too narrow.
  Sizes use `ui.text.tertiary`.
- A group card outside the picker is clickable: a click (not one on its pencil, trash or a zone bubble, which stop it) calls `showZonesOfGroup`, opening the zones list grouped by groups on that group's section. A zone bubble on the card goes to the zone's floor.

## Automatic zones (GitHub issue #1033)

Zones of kind `Auto` are computed from the field, never drawn or saved. Core: `compute_auto_zones(tessellation, floors)`
(`maze-core/src/space/auto_zones.rs`); each `AutoZoneFloor` carries the floor's cells, its crease segments (world units)
and `folded` (the topology has folds). A zone with no cells is not produced. Per-key rules, in output order:

- `Maze`: every cell of every floor.
- per floor, in order: `Floor(f)` (only on a multi-floor maze), `CellType { f, t }` (one per cell type `t`, its position in
  `Tessellation::cell_types`, on floor `f`; only when the tessellation has several types, is not irregular
  (`cells_vary_in_size`) and the floor holds cells of more than one type, since a floor of one type would make the zone
  equal to the floor; no zone spans floors, and it is built on a single-floor maze too), `FieldEdge(f)`, `Face { f, i }` (only on a folded floor
  that has more than one face), `Region { f, i }` (only on a floor that has more than one region).
- `FieldEdge`: cells with a tessellation neighbor outside the field. A face with no neighbor at all (the rim of a
  finite tessellation) counts as outside. Folds are ignored: the neighbor is geometric.
- `Region`: components of the floor over tessellation neighbors inside the field; folds and teleports are not links.
  A floor with one region makes no zone (the floor or the maze is that zone).
- `Face`: components over tessellation neighbors, not crossing a face whose contact point lies on a crease
  (`CREASE_EPS` = 1e-6). Seams are polyhedron edges, so folds are not links either. A folded floor with no creases is
  one face, which makes no zone (the floor is that zone); a floor with no folds has no faces, so a plain multi-floor
  maze gets no face zones.
- `i` is the component's position when ordered by its smallest cell.

WASM `zones_compute_auto({ tessellation, floors: [{ count, creases: [[x, y], [x, y]][], folded }] }, cells)`: `cells`
is every floor's field cells as one flat `Int32Array` (`x0, y0, x1, y1, ...`, floors one after another, `count` cells
each). It returns `[key, Int32Array][]`, the array holding the zone's cells as `floor, x, y` triples; keys are `maze`,
`floor:F`, `type:F:T`, `edge:F`, `face:F:I`, `region:F:I`. Cells cross the boundary as flat typed arrays in both directions
because serde marshalling of tens of thousands of small arrays took more time than the core computation. Errors:
`floor <n>: invalid cell [x, y]`, and a mismatch between `cells` and the announced counts. `computeAutoZones`
(`wasm/mazeService.ts`) packs and unpacks, so the store still sees `{ key, cells: [floor, x, y][] }[]`.

Web (`store/autoZones.ts`, `store/autoZoneSync.ts`):

- The id of an automatic zone comes from its key alone (`autoZoneIdOf`): `2^30 + kind * 2^22 + floor * 2^14 + index`
  (floor below 256, index below 16384), so ids never meet manual ones (`isAutoZoneId`) and survive a recomputation.
  Groups, colour overrides and visibility that name an auto zone therefore stay valid.
- An auto zone stores no name (`name` is empty): the key is the id, so `autoZoneName` (`domain/autoZones.ts`) builds the
  name from it when it is shown (`zoneDisplayName(zone, floors)`), and it follows the language and the floor titles
  without a recomputation: "Whole maze", the floor ("Floor N" localized, or the title the user gave it: the stored
  default title is English), "Field edge", "Face n", "Region n", with the floor in brackets on a multi-floor maze.
  A cell type zone (`type:F:T`; the id holds the index `T` in the index bits, floor 0) is the exception: its `name` keeps
  the type's key (`autoZonesFromWire` reads it from `getTessellationCellTypes`, asked only when such a zone exists) and
  `autoZoneName` shows `cellTypeLabel(key)`. `sameAutoZones` therefore compares names too.
  The id codec (`autoZoneIdOf`, `autoZoneKindOf`, `isAutoZoneId`) lives in the same domain module.
- Auto zones are hidden by default per zone: `refreshAutoZones` adds the id of every newly appeared auto zone to `hiddenZoneIds`, so the card eyes show the real state and work; `showAutoZones` stays a master switch that starts on.
- `installAutoZoneSync` recomputes on the main thread 0.15 s after the last change of the floors, field, topology,
  creases, tessellation or smoothing (`AUTO_ZONES_DEBOUNCE_MS`), and once at start. A result equal to the current one
  writes nothing; the computation does not fail in normal use (wasm is loaded before the store exists, and the tessellation, floors and fields change in one store update), so an error is not caught. Auto zones sit first in `zones`, manual ones after.
  Only a change of the cells, creases, folds or tessellation of a floor counts: the tool, the operation and the edit
  flags of `floorFields` do not. `computeAutoZones` keeps the last request and its zones and answers an equal request
  without calling wasm (the returned zones are shared, read-only).
- Automatic groups (GitHub issue #1037), computed with the auto zones by `autoGroupsOf` and written to `zoneGroups`
  first (manual groups after): "Floors", "Field edges", "Regions", "Faces" (every zone of that kind) and one group per
  cell type (all zones of that type across floors, named by the type). The whole maze zone has no group. A group exists
  only while it has a zone to collect, so a tessellation with no cell type zones has no cell type groups. Group ids use
  the auto id range (`autoGroupIdOf`, `isAutoGroupId`: `2^30 + kind * 2^22 + index`), names are built from the id
  (`autoGroupName`, a cell type group keeps the type key as `name`). They cannot be deleted or edited (the store actions
  ignore them, the cards have no pencil or trash), a manual zone cannot join one, and they are neither saved nor loaded.
- Auto zones are not written to the project file and are dropped on load; group members and colour overrides naming
  an auto id are kept by the validator.
- A zone's automatic colour is its position among the zones of its kind, so the changing set of auto zones never
  recolours manual ones. The auto zones are all known at once, so their palette is fitted to their number
  (`autoColorAmong`): up to three rounds of eight it is the plain glue palette; beyond that the rounds' lightness step
  shrinks (the farthest round stays within 30 lightness points of the base, so no zone turns white or black) and their
  hue shift shrinks (no two rounds share hues). Manual zones keep the plain palette.
- The list's grouping is kept per section (`zonesGrouping: { auto, manual }`), so the two sections group independently.
  Auto zones offer none / by floors / by types, manual zones none / by floors; both start at none.
- Performance: the cells cross the wasm boundary as flat `Int32Array`s (marshalling small arrays cost more than the
  computation), core hashes cells with a fast non-cryptographic hasher and sorts each floor once. Still on the main
  thread; measured on a dev-profile wasm, a release build is expected to be several times faster. Further options from
  the issue: changed cells only, a worker, skipping zones nobody uses.

## Generation overrides (GitHub issue #1038)

Zones and groups can scope per-zone generation parameter overrides; see `Specs/generation.md`. Deleting a zone
(`removeZone`) or a group (`removeZoneGroup`) removes its id from every override. Automatic zones that vanish are not
scrubbed: their ids are stable and an override naming one simply has no zones until it reappears.

## Quality rule scopes (GitHub issue #1039)

A zone or a group can scope one QC rule; see `Specs/quality-feature.md`, "Zone scope". Deleting a zone (`removeZone`) or a
group (`removeZoneGroup`) leaves the rules alone: a rule bound to it keeps the vanished id, warns and is not sent to core.
The target picker (`ZoneTargetPicker`) is shared by the rule dialog and the generation overrides' side panel.

## Web mirror

`maze-web/src/wasm/mazeService.ts`: `Zone`, `ZoneKind`, `ZoneCellWire`, `normalizeZones`,
`getZonesOfCells`.
