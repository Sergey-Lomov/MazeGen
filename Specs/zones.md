# Zones

A zone is a named set of cells with a stable id and a kind. Consumers (the zones feature renderer,
the export renderer, QC rules) reference a zone by id and ask which zones a cell belongs to
(GitHub issue #1029). UI, editing and persistence are out of scope and tracked separately.

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
- Store (`zonesSlice`): `zones`, `showAutoZones`, `showManualZones` (both default on). All three are
  transient: zones are not persisted yet, so loading a project resets them.
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
  at the end of the manual list (appends an empty manual zone, opens the manual list and the zone editor over it). Ids come from a store
  counter (`nextZoneId`) that only grows, so the id of a deleted zone is never reused.
- Zone card: a rounded colour square sized to the font (`1em`, thin neutral border) with the zone's
  canvas colour (`EntityColorSwatch`, shared with the glue cards) after the name (`#id` while
  unnamed), the number of cells, and `L{n}` floor badges of the floors the zone occupies
  (`FloorBadgeRow`, standard blue info `Bubble`s, click to go to the floor; only on a multi-floor maze).
- Eye icon (open/closed) in the card's top right corner toggles the zone's visibility on the canvas
  (`hiddenZoneIds`); it applies on top of the two kind toggles. Manual cards also have edit (opens the zone editor) and
  delete (with a confirmation dialog) icon buttons.
- Hover: the hovered card's zone (`hoveredZoneId`) is drawn by `ZonesRenderer` on its own layer over
  the other zones, fully opaque (a hover change redraws only that layer), regardless of the kind
  toggles and the zone's visibility, only if it has cells on the active floor. The active floor never
  changes. The hover is cleared when the panel closes or unmounts, or the section switches.
- All of the above state is transient, like the rest of the zones state.

## Zone editor (GitHub issue #1031)

Editing a manual zone (the edit button of its card, or "Add zone" on the zones feature card, which opens
the manual list and a new zone's editor together) opens `ZoneEditPanel` (`zoneEditId`) over the list ("Done"
closes it, the list stays). Closing the list, deleting the zone or
leaving the zones card ends editing. The panel offers every shape tool of the custom field editor, through the
same components (`FieldToolsSection`, `SmoothingToggleRow`): Add / Remove / Select modes, point, shapes, polygon,
parallelogram, connected area, mirror, copy and paste, smoothing, with the same hotkeys and gestures. The tools
are not duplicated: `FieldEditController`, `FieldEditorOverlay`, the mirror panel and the scene read the edit
target through `pixi/fieldEditTarget.ts` (`editFieldOf`, `fieldToolsActive`, `zoneEditActive`), which hands them
either the floor's custom field or a view of it whose `fieldPoints` are the edited zone's cells on the active
floor. Tool state (`fieldOperation`, `fieldPrimitive`) is the floor's, shared with the field editor.

- Every change goes straight into the zone (`addZoneCells`, `removeZoneCells`, `moveZoneCells`, the mirror
  through `applyMirror`); there is no draft. Zones are not part of generation, so no edit asks for confirmation or
  invalidates results.
- Edits act on the active floor's cells of the zone; cells on other floors are kept. Switching floors switches
  the floor being edited.
- A zone holds only cells of the active floor's field: Add, point, shapes, connected area, paste and mirror drop
  cells outside the field (`cellsInActiveField`), and a smoothing preview does not mark them as excluded. Connected
  area in Add mode fills the field cells outside the zone connected to the clicked cell. A move that would leave
  the field is refused as a whole (the preview keeps its last valid position).
- The zone being edited is drawn by `ZonesRenderer` like a hovered one (opaque, whatever the toggles say). While
  a selection move is pending, the overlay shows the moved cells, and the source cells stay drawn.
- The panel is split into plain (not collapsible) sections, content indented by `indent.tree`. Properties: the zone name input (`setZoneName`, shows the default
  name of an unnamed zone) and the colour row with a counter-clockwise-arrow reset `FlatIconButton` (tooltip "Automatic color";
  disabled with the second tooltip line "Already applied" while the colour is automatic). Editing: Modes, Tools,
  smoothing and "Show other zones". Intersections: shown only while the zone shares cells with others, one line
  per zone and floor of the overlap (a `Bubble` with the zone name; when the edited zone spans several floors,
  then ` - ` and an `L{n}` floor badge, so a zone overlapping on two floors has two lines); hovering a line highlights that zone and the edited one stops being highlighted
  (`hoveredZoneId` wins over `zoneEditId`). An explicit colour
  (`zoneColorOverrides`, by zone id, set with `setZoneColor`, reset to automatic by `null`) always wins over the
  automatic one. Automatic colours come from a fixed round of `AUTO_COLOR_COUNT` (8) colours shared with the
  glues (`glueColor`): a zone takes the colour at its position in the list; every further round of 8 is a group
  of the glues' hue scheme (`hueGroupColors`, positions 0, +1, -1, +2, ...: lightness and hue shifted), so no two
  zones share a colour. Whatever the number of zones, adding a zone or colouring another one never moves the rest. Deleting the zone drops its override.
  Overrides are transient like the zones.
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
- The close cross cancels (`cancelZoneEdit`): a zone added in this session (`zoneEditIsNew`) is deleted, an
  existing one stays as edited. "Done" keeps the zone. Any other way out of an unconfirmed new zone discards it
  too: closing the list, "Add zone" again, or the edit button of another zone.
- "Show other zones" off is applied again when a zone starts or stops being edited (`hidesOtherZones`).
- The hover highlight follows the tool's reach (`zoneToolReaches`): Add highlights field cells only; Remove and
  Select the zone's own cells, even outside the field. A right-click gesture does not change a later hover.
- The panel ends with a caption-styled info line "Size: N cells" (all the zone's cells, on every floor). The zones
  sharing a cell with it on any floor (`zoneIntersections`) are the Intersections section.
- The mirror preview marks every symmetric cell, but the cells the tool cannot change (Add outside the field, Remove
  outside the zone) are drawn dim (`MIRROR_DIM_ALPHA`, as the cells smoothing leaves out of a shape).

## Web mirror

`maze-web/src/wasm/mazeService.ts`: `Zone`, `ZoneKind`, `ZoneCellWire`, `normalizeZones`,
`getZonesOfCells`.
