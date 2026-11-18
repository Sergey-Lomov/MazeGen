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
  "Manual zones (n)", `n` the number of zones of that kind. The manual section ends with an "Add zone"
  button (appends an empty manual zone; real editing is tracked separately). Ids come from a store
  counter (`nextZoneId`) that only grows, so the id of a deleted zone is never reused.
- Zone card: a rounded colour square sized to the font (`1em`, thin neutral border) with the zone's
  canvas colour (`EntityColorSwatch`, shared with the glue cards) after the name (`#id` while
  unnamed), the number of cells, and `L{n}` floor badges of the floors the zone occupies
  (`FloorBadgeRow`, standard blue info `Bubble`s, click to go to the floor; only on a multi-floor maze).
- Eye icon (open/closed) in the card's top right corner toggles the zone's visibility on the canvas
  (`hiddenZoneIds`); it applies on top of the two kind toggles. Manual cards also have edit (disabled
  until the editor exists) and delete (with a confirmation dialog) icon buttons.
- Hover: the hovered card's zone (`hoveredZoneId`) is drawn by `ZonesRenderer` on its own layer over
  the other zones, fully opaque (a hover change redraws only that layer), regardless of the kind
  toggles and the zone's visibility, only if it has cells on the active floor. The active floor never
  changes. The hover is cleared when the panel closes or unmounts, or the section switches.
- All of the above state is transient, like the rest of the zones state.

## Web mirror

`maze-web/src/wasm/mazeService.ts`: `Zone`, `ZoneKind`, `ZoneCellWire`, `normalizeZones`,
`getZonesOfCells`.
