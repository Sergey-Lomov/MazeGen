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
resolveFieldAt)` (`pixi/fieldValidity.ts`) removes cells whose point is not a cell of their floor's
field or whose floor no longer exists. Zone ids, names, kinds and order are kept; a zone left with
no cells stays, so its id remains stable.

## Zones card (GitHub issue #1028)

Feature card `zones` (`FeatureId`), placed after Field and before Presets.

- Status: `unavailable` until a field is set (same condition as Presets), otherwise always `set`
  (green), even with no zones. Subtitle: number of manual zones.
- Store (`zonesSlice`): `zones`, `showAutoZones`, `showManualZones` (both default on). The toggles are
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
- Zone card: a rounded colour square sized to the font (`1em`, thin neutral border) with the zone's
  canvas colour (`EntityColorSwatch`, shared with the glue cards) after the name (`#id` while
  unnamed), "Cells: n" (a fixed label, so no plural forms), and `L{n}` floor badges of the floors the zone occupies
  (`FloorBadgeRow`, standard blue info `Bubble`s, click to go to the floor; only on a multi-floor maze).
- A third line lists the zone's groups ("Groups: A, B", "No groups" when none).
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
target through `pixi/fieldEditTarget.ts` (`editFieldOf`, `fieldToolsActive`, `zoneEditActive`), which hands them
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
  smoothing and "Show other zones". Intersections: shown only while the zone shares cells with others, one line
  per zone and floor of the overlap (a `Bubble` with the zone name; when the edited zone spans several floors,
  then ` - ` and an `L{n}` floor badge, so a zone overlapping on two floors has two lines); hovering a line highlights that zone and the edited one stops being highlighted
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
- Hover: a group card highlights all its zones together (`hoveredZoneIds`, drawn like `hoveredZoneId`); a zone's
  bubble highlights only that zone (`hoveredZoneId` wins over `hoveredZoneIds`). Both clear when the panel closes.
- The pencil opens `ZoneGroupEditPanel` over the list. Top: the name input. Then two collapsible sections with the
  count in brackets, built of `ZoneCell` (the zones list's cell, exported from `ZonesPanel`):
  "Zones (n)", the group's zones, each with a trash (`onRemove`) and a placeholder when empty; "Candidates (n)", the
  zones outside the group, each with a flat `+` (`onAdd`), with one placeholder when every zone is already in the
  group and another when no zone exists at all. An existing group opens with Zones expanded and Candidates
  collapsed, a new one the other way round.
- Below, a primary "Done" button, disabled with an explaining tooltip while the group has no zones. "Done"
  commits the draft (`commitZoneGroupEdit`). The name, the zones and the candidates act on a working copy
  (`zoneGroupEditDraft`) and `zoneGroups` takes it only then, so the list never shows a half-edited or unconfirmed
  group. The close cross drops the draft (`cancelZoneGroupEdit`): a new group (`zoneGroupEditIsNew`) never reaches
  the list. Closing the groups list, "Add group" again or the pencil of another group drop an unconfirmed draft too.
- Zone editor, section "Groups" above Intersections: every group the draft zone is in, plus the groups still to be created (name and a trash that
  takes the zone out of it, "No groups" when none) and a `+` at the end of the header. The `+` opens
  `ZoneGroupPickerDialog`: the groups list as `GroupCell`s (`onPick`: no actions, hover highlight or bubble
  reactions; a click hands the group over to the draft and closes), without the groups the zone is already in, a placeholder when
  empty, and a "New group" button that closes it and opens `ZoneGroupNameDialog` (a name field, Cancel / OK; OK
  adds the name to the draft's groups to create). Both dialogs are generic (`excludeIds` / `onPick` / `onConfirm`).
- Placeholders keep the body font and only use the lower-contrast disabled colour; a list that shows a placeholder has
  no top separator. The picker dialog has no separators and a full-width "New group" button. The zone editor's
  Intersections bubbles use the same zone colours as the group cards' (`zoneChipColors`).
- Deleting a zone drops its id from every group and from the group draft (`withoutZone`).

## Web mirror

`maze-web/src/wasm/mazeService.ts`: `Zone`, `ZoneKind`, `ZoneCellWire`, `normalizeZones`,
`getZonesOfCells`.
